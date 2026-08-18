"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, RefreshCw, X } from "lucide-react";
import { nanoid } from "nanoid";

import { imageToDataUrl } from "@/services/image-storage";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasConnection, CanvasNodeData } from "../types";

export type DirectorDeskCapture = {
    dataUrl: string;
    fileName?: string;
};

const MAX_CAPTURE_COUNT = 12;
const MAX_CAPTURE_DATA_URL_LENGTH = 16_000_000;
const MAX_CAPTURE_BATCH_LENGTH = 48_000_000;
const MAX_PROJECT_MESSAGE_LENGTH = 5_000_000;
const LOAD_TIMEOUT_MS = 15_000;

export function DirectorDeskHost({
    node,
    panorama,
    onClose,
    onPanoramaRemoved,
    onCaptures,
    onProjectChange,
}: {
    node: CanvasNodeData;
    panorama: { connection: CanvasConnection; imageNode: CanvasNodeData } | null;
    onClose: () => void;
    onPanoramaRemoved: (connectionId: string) => void;
    onCaptures: (captures: DirectorDeskCapture[]) => void | Promise<void>;
    onProjectChange: (project: unknown) => void;
}) {
    const theme = useThemeStore((state) => state.theme);
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const nonceRef = useRef(nanoid());
    const initialProjectRef = useRef(node.metadata?.directorProject);
    const sessionSentRef = useRef(false);
    const [ready, setReady] = useState(false);
    const [timedOut, setTimedOut] = useState(false);
    const [frameVersion, setFrameVersion] = useState(0);

    const postSession = useCallback(() => {
        iframeRef.current?.contentWindow?.postMessage(
            {
                type: "storyai:director-desk-session",
                payload: { instanceId: node.id, theme, project: initialProjectRef.current, nonce: nonceRef.current },
            },
            "*",
        );
    }, [node.id, theme]);

    const postCaptureDelivery = useCallback((type: "storyai:director-desk-captures-accepted" | "storyai:director-desk-captures-failed", requestId: string, error?: string) => {
        iframeRef.current?.contentWindow?.postMessage({ type, payload: { requestId, error, nonce: nonceRef.current } }, "*");
    }, []);

    const postPanorama = useCallback(async () => {
        const target = iframeRef.current?.contentWindow;
        if (!target) return;
        if (!panorama) {
            target.postMessage({ type: "storyai:director-desk-panorama-clear", payload: { nonce: nonceRef.current } }, "*");
            return;
        }
        const metadata = panorama.imageNode.metadata;
        const imageUrl = await imageToDataUrl({
            url: metadata?.content,
            dataUrl: metadata?.content,
            remoteUrl: metadata?.remoteUrl,
            serverUrl: metadata?.serverUrl,
            storageKey: metadata?.storageKey,
        });
        if (!imageUrl) return;
        target.postMessage(
            {
                type: "storyai:director-desk-panorama",
                payload: {
                    edgeId: panorama.connection.id,
                    sourceNodeId: panorama.imageNode.id,
                    imageUrl,
                    fileName: `${panorama.imageNode.title || "canvas-panorama"}.png`,
                    nonce: nonceRef.current,
                },
            },
            "*",
        );
    }, [panorama]);

    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            if (event.source !== iframeRef.current?.contentWindow || (event.origin !== "null" && event.origin !== window.location.origin)) return;
            if (event.data?.type === "storyai:director-desk-ready") {
                setTimedOut(false);
                setReady(true);
                return;
            }
            if (event.data?.payload?.nonce !== nonceRef.current) return;
            if (event.data?.type === "storyai:director-desk-close") {
                onClose();
                return;
            }
            if (event.data?.type === "storyai:director-desk-panorama-removed") {
                const connectionId = typeof event.data?.payload?.edgeId === "string" ? event.data.payload.edgeId : "";
                if (connectionId && connectionId === panorama?.connection.id) onPanoramaRemoved(connectionId);
                return;
            }
            if (event.data?.type === "storyai:director-desk-project-changed") {
                const project = event.data?.payload?.project;
                if (!project || typeof project !== "object") return;
                try {
                    if (JSON.stringify(project).length <= MAX_PROJECT_MESSAGE_LENGTH) onProjectChange(project);
                } catch {
                    // Ignore malformed or cyclic payloads.
                }
                return;
            }
            if (event.data?.type === "storyai:director-desk-captures-sent") {
                const requestId = typeof event.data?.payload?.requestId === "string" ? event.data.payload.requestId.trim() : "";
                const candidates = Array.isArray(event.data?.payload?.captures) ? event.data.payload.captures.slice(0, MAX_CAPTURE_COUNT) : [];
                let batchLength = 0;
                const captures = candidates.filter((capture: unknown): capture is DirectorDeskCapture => {
                    if (!capture || typeof capture !== "object" || !("dataUrl" in capture) || typeof capture.dataUrl !== "string") return false;
                    if (!capture.dataUrl.startsWith("data:image/") || capture.dataUrl.length > MAX_CAPTURE_DATA_URL_LENGTH) return false;
                    batchLength += capture.dataUrl.length;
                    return batchLength <= MAX_CAPTURE_BATCH_LENGTH;
                });
                if (!captures.length) {
                    if (requestId) postCaptureDelivery("storyai:director-desk-captures-failed", requestId, "没有收到有效截图");
                    return;
                }
                void Promise.resolve(onCaptures(captures))
                    .then(() => {
                        if (requestId) postCaptureDelivery("storyai:director-desk-captures-accepted", requestId);
                    })
                    .catch((error: unknown) => {
                        if (requestId) postCaptureDelivery("storyai:director-desk-captures-failed", requestId, error instanceof Error ? error.message : "截图返回画布失败");
                    });
            }
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };
        window.addEventListener("message", handleMessage);
        window.addEventListener("keydown", handleKeyDown);
        return () => {
            window.removeEventListener("message", handleMessage);
            window.removeEventListener("keydown", handleKeyDown);
        };
    }, [onCaptures, onClose, onPanoramaRemoved, onProjectChange, panorama?.connection.id, postCaptureDelivery]);

    useEffect(() => {
        if (!ready || sessionSentRef.current) return;
        sessionSentRef.current = true;
        postSession();
    }, [postSession, ready]);

    useEffect(() => {
        if (ready) return;
        const timeout = window.setTimeout(() => setTimedOut(true), LOAD_TIMEOUT_MS);
        return () => window.clearTimeout(timeout);
    }, [frameVersion, ready]);

    useEffect(() => {
        if (!ready) return;
        void postPanorama();
    }, [postPanorama, ready]);

    const retryLoad = () => {
        nonceRef.current = nanoid();
        sessionSentRef.current = false;
        setReady(false);
        setTimedOut(false);
        setFrameVersion((current) => current + 1);
    };

    return (
        <div className="fixed inset-0 z-[500] bg-black" data-director-desk-host>
            {!ready ? (
                <div className={`absolute inset-0 z-10 grid place-items-center bg-[#111214] text-white/70 ${timedOut ? "" : "pointer-events-none"}`}>
                    {timedOut ? (
                        <div className="flex flex-col items-center gap-4">
                            <p className="text-sm text-white/80">3D 导演台载入超时</p>
                            <div className="flex items-center gap-2">
                                <button type="button" className="inline-flex h-9 items-center gap-2 rounded-md border border-white/15 bg-white/10 px-3 text-sm text-white hover:bg-white/15" onClick={retryLoad}>
                                    <RefreshCw className="size-4" />
                                    重试
                                </button>
                                <button type="button" className="inline-flex h-9 items-center gap-2 rounded-md border border-white/15 px-3 text-sm text-white/80 hover:bg-white/10" onClick={onClose}>
                                    <X className="size-4" />
                                    关闭
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="flex items-center gap-2 text-sm">
                            <LoaderCircle className="size-4 animate-spin" />
                            正在载入 3D 导演台
                        </div>
                    )}
                </div>
            ) : null}
            <iframe
                key={frameVersion}
                ref={iframeRef}
                src={`/director-desk/index.html?instanceId=${encodeURIComponent(node.id)}&theme=${encodeURIComponent(theme)}&hostOrigin=${encodeURIComponent(window.location.origin)}`}
                title="3D导演台"
                className="block h-full w-full border-0"
                sandbox="allow-scripts allow-downloads allow-same-origin"
                allow="fullscreen"
            />
            <button
                type="button"
                className={`absolute right-3 top-3 z-20 grid size-11 place-items-center rounded-md border border-white/15 bg-black/45 text-white/80 backdrop-blur transition hover:bg-black/70 hover:text-white ${ready ? "min-[921px]:hidden" : ""}`}
                onClick={onClose}
                title="关闭导演台"
                aria-label="关闭导演台"
            >
                <X className="size-4" />
            </button>
        </div>
    );
}
