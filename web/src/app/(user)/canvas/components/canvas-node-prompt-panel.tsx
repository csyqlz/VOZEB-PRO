"use client";

import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { LoaderCircle, Maximize2, Minimize2, Square } from "lucide-react";
import { Button, Modal, Tooltip } from "antd";

import { ModelPicker } from "@/components/model-picker";
import { CreditSymbol, formatCreditAmount, requestCreditCost } from "@/constant/credits";
import { defaultConfig, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasPromptLibrary } from "./canvas-prompt-library";
import { CanvasAudioSettingsPopover } from "./canvas-audio-settings-popover";
import { CanvasResourceMentionTextarea } from "./canvas-resource-mention-textarea";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { CanvasCameraControl } from "./canvas-camera-control";
import { CanvasNodeType, isCanvasImageNodeType, type CanvasGenerationMode, type CanvasNodeData } from "../types";
import type { CanvasResourceReference } from "../utils/canvas-resource-references";
import { buildCanvasNodeConfig, canvasAudioConfigPatch, canvasVideoConfigPatch } from "../utils/canvas-node-config";
import { canvasModelConfigPatch } from "../utils/canvas-model-capabilities";
import { PANORAMA_IMAGE_SIZE } from "../utils/canvas-panorama";

export type CanvasNodeGenerationMode = CanvasGenerationMode;

const stopCanvasInteraction = (event: SyntheticEvent) => event.stopPropagation();

type CanvasNodePromptPanelProps = {
    node: CanvasNodeData;
    isRunning: boolean;
    onPromptChange: (nodeId: string, prompt: string) => void;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => void;
    onGenerate: (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => void;
    onStop: (nodeId: string) => void;
    mentionReferences?: CanvasResourceReference[];
    onImageSettingsOpenChange?: (open: boolean) => void;
};

export function CanvasNodePromptPanel({ node, isRunning, onPromptChange, onConfigChange, onGenerate, onStop, mentionReferences = [], onImageSettingsOpenChange }: CanvasNodePromptPanelProps) {
    const globalConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const mode = defaultMode(node.type);
    const config = buildNodeConfig(globalConfig, node, mode);
    const hasTextContent = node.type === CanvasNodeType.Text && Boolean(node.metadata?.content?.trim());
    const hasImageContent = isCanvasImageNodeType(node.type) && Boolean(node.metadata?.content);
    const isPanorama = node.type === CanvasNodeType.Panorama;
    const isEditingExistingContent = hasTextContent || hasImageContent;
    const [prompt, setPrompt] = useState(isEditingExistingContent ? "" : node.metadata?.prompt || "");
    const [expanded, setExpanded] = useState(false);
    const expandedEditorRef = useRef<HTMLTextAreaElement | null>(null);
    const credits = requestCreditCost({
        apiSource: config.apiSource,
        modelPointCosts: config.modelPointCosts,
        generationPointMultipliers: config.generationPointMultipliers,
        kind: mode,
        model: config.model,
        count: mode === "image" ? config.count : 1,
        quality: config.quality,
        videoQuality: config.vquality,
        videoSeconds: config.videoSeconds,
    });

    useEffect(() => {
        setPrompt(isEditingExistingContent ? "" : node.metadata?.prompt || "");
    }, [isEditingExistingContent, node.id]);

    const updatePrompt = (value: string) => {
        setPrompt(value);
        if (!isEditingExistingContent) onPromptChange(node.id, value);
    };

    const submit = () => {
        const text = prompt.trim();
        if (!text || isRunning) return false;
        onGenerate(node.id, mode, text);
        setPrompt("");
        return true;
    };

    const submitExpanded = () => {
        if (submit()) setExpanded(false);
    };

    return (
        <div
            className="rounded-2xl border p-3 shadow-2xl backdrop-blur"
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            <div className="relative">
                <CanvasResourceMentionTextarea
                    autoFocus
                    value={prompt}
                    references={mentionReferences}
                    onChange={updatePrompt}
                    onSubmit={submit}
                    aria-label="节点提示词"
                    data-canvas-prompt-scroll="node"
                    className="thin-scrollbar h-24 w-full resize-none overflow-y-auto overscroll-contain rounded-xl border px-3 py-2 pr-11 text-sm leading-5 outline-none"
                    style={{ background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text }}
                    placeholder={promptPlaceholder(mode, hasImageContent, hasTextContent, isPanorama)}
                />
                <Tooltip title="放大提示词输入" placement="top">
                    <button
                        type="button"
                        data-canvas-no-drag
                        className="absolute right-2 top-2 z-10 grid size-8 place-items-center rounded-lg border transition-opacity hover:opacity-75 focus-visible:outline-none focus-visible:ring-2"
                        style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.item }}
                        onClick={(event) => {
                            event.stopPropagation();
                            setExpanded(true);
                        }}
                        onMouseDown={stopCanvasInteraction}
                        onPointerDown={stopCanvasInteraction}
                        aria-label="放大提示词输入"
                    >
                        <Maximize2 className="size-4" aria-hidden />
                    </button>
                </Tooltip>
            </div>

            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
                <div className="canvas-composer-tools flex min-w-0 flex-1 flex-wrap items-center gap-2">
                    <CanvasPromptLibrary onSelect={updatePrompt} />
                    {mode === "image" ? (
                        <>
                            <ModelPicker
                                className="min-w-[9rem] flex-1"
                                config={config}
                                value={config.model}
                                onChange={(model) => onConfigChange(node.id, canvasModelConfigPatch(config, model, "image"))}
                                capability="image"
                                onMissingConfig={() => openConfigDialog(true)}
                            />
                            <CanvasImageSettingsPopover
                                config={config}
                                placement="topLeft"
                                buttonClassName="canvas-composer-settings !h-10 !min-w-[9rem] !max-w-full !flex-1 !justify-start !rounded-full !px-3"
                                onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value })}
                                onOpenChange={onImageSettingsOpenChange}
                                fixedSizeLabel={isPanorama ? "全景 2:1" : undefined}
                            />
                            {!isPanorama ? (
                                <CanvasCameraControl
                                    value={node.metadata?.cameraControl}
                                    onChange={(cameraControl) => onConfigChange(node.id, { cameraControl })}
                                    buttonClassName="canvas-composer-settings !h-10 !min-w-[9rem] !max-w-full !flex-1 !justify-start !rounded-full !px-3"
                                />
                            ) : null}
                        </>
                    ) : mode === "video" ? (
                        <>
                            <ModelPicker
                                className="min-w-[9rem] flex-1"
                                config={config}
                                value={config.model}
                                onChange={(model) => onConfigChange(node.id, canvasModelConfigPatch(config, model, "video"))}
                                capability="video"
                                onMissingConfig={() => openConfigDialog(true)}
                            />
                            <CanvasVideoSettingsPopover
                                config={config}
                                metadata={node.metadata}
                                references={mentionReferences}
                                buttonClassName="canvas-composer-settings !h-10 !min-w-[9rem] !max-w-full !flex-1 !justify-start !rounded-full !px-3"
                                onConfigChange={(key, value) => onConfigChange(node.id, canvasVideoConfigPatch(key, value))}
                                onMetadataChange={(patch) => onConfigChange(node.id, patch)}
                            />
                            <CanvasCameraControl
                                value={node.metadata?.cameraControl}
                                onChange={(cameraControl) => onConfigChange(node.id, { cameraControl })}
                                buttonClassName="canvas-composer-settings !h-10 !min-w-[9rem] !max-w-full !flex-1 !justify-start !rounded-full !px-3"
                            />
                        </>
                    ) : mode === "audio" ? (
                        <>
                            <ModelPicker className="min-w-[9rem] flex-1" config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="audio" onMissingConfig={() => openConfigDialog(true)} />
                            <CanvasAudioSettingsPopover
                                config={config}
                                buttonClassName="canvas-composer-settings !h-10 !min-w-[9rem] !max-w-full !flex-1 !justify-start !rounded-full !px-3"
                                onConfigChange={(key, value) => onConfigChange(node.id, canvasAudioConfigPatch(key, value))}
                            />
                        </>
                    ) : (
                        <ModelPicker className="min-w-[9rem] flex-1" config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="text" onMissingConfig={() => openConfigDialog(true)} />
                    )}
                </div>
                <Button
                    type="primary"
                    className="canvas-generate-button !h-10 !min-w-16 shrink-0 !rounded-full !px-3"
                    danger={isRunning}
                    disabled={!isRunning && !prompt.trim()}
                    onClick={() => (isRunning ? onStop(node.id) : submit())}
                    aria-label={isRunning ? "停止生成" : "生成"}
                >
                    <span className="flex items-center gap-1.5">
                        {isRunning ? (
                            <>
                                <LoaderCircle className="size-4 animate-spin" />
                                <Square className="size-3.5 fill-current" />
                                <span className="text-xs font-medium">停止</span>
                            </>
                        ) : (
                            <>
                                <span className="text-xs font-semibold">生成</span>
                                <span className="inline-flex items-center gap-1 text-xs font-medium tabular-nums">
                                    <CreditSymbol />
                                    {formatCreditAmount(credits)}
                                </span>
                            </>
                        )}
                    </span>
                </Button>
            </div>

            <div className="contents" onClick={stopCanvasInteraction} onDoubleClick={stopCanvasInteraction} onMouseDown={stopCanvasInteraction} onPointerDown={stopCanvasInteraction} onWheel={stopCanvasInteraction} onContextMenu={stopCanvasInteraction}>
                <Modal
                    className="canvas-prompt-editor-modal"
                    open={expanded}
                    title="编辑提示词"
                    centered
                    destroyOnHidden
                    mask={{ closable: false }}
                    width="min(760px, calc(100vw - 24px))"
                    onCancel={() => setExpanded(false)}
                    afterOpenChange={(open) => {
                        if (!open) return;
                        requestAnimationFrame(() => {
                            const textarea = expandedEditorRef.current;
                            textarea?.focus();
                            textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
                        });
                    }}
                    styles={{
                        container: { background: theme.node.panel, border: `1px solid ${theme.toolbar.border}`, color: theme.node.text },
                        header: { background: theme.node.panel, marginBottom: 0, paddingBottom: 8 },
                        title: { color: theme.node.text },
                        body: { background: theme.node.panel, padding: "4px 12px 12px" },
                    }}
                    footer={null}
                >
                    <div data-canvas-prompt-editor="expanded" className="min-w-0 overflow-hidden rounded-xl border" style={{ borderColor: theme.node.stroke }}>
                        <CanvasResourceMentionTextarea
                            ref={expandedEditorRef}
                            autoFocus={expanded}
                            value={prompt}
                            references={mentionReferences}
                            onChange={updatePrompt}
                            onSubmit={submitExpanded}
                            aria-label="提示词编辑器"
                            data-canvas-prompt-scroll="expanded"
                            className="thin-scrollbar h-[min(52vh,26rem)] min-h-64 w-full resize-none overflow-y-auto overscroll-contain border-0 px-4 py-3 text-sm leading-6 outline-none"
                            style={{ background: theme.node.fill, color: theme.node.text }}
                            placeholder={promptPlaceholder(mode, hasImageContent, hasTextContent, isPanorama)}
                        />
                    </div>
                    <div className="mt-3 flex items-center justify-end gap-2">
                        <Button icon={<Minimize2 className="size-4" />} onClick={() => setExpanded(false)} aria-label="收起提示词输入">
                            收起
                        </Button>
                        <Button type="primary" danger={isRunning} disabled={!isRunning && !prompt.trim()} onClick={() => (isRunning ? onStop(node.id) : submitExpanded())} aria-label={isRunning ? "停止生成" : "生成"}>
                            {isRunning ? "停止生成" : "生成"}
                        </Button>
                    </div>
                </Modal>
            </div>
        </div>
    );
}

function defaultMode(type: CanvasNodeData["type"]): CanvasNodeGenerationMode {
    return type === CanvasNodeType.Text ? "text" : type === CanvasNodeType.Video ? "video" : type === CanvasNodeType.Audio ? "audio" : "image";
}

function buildNodeConfig(globalConfig: AiConfig, node: CanvasNodeData, mode: CanvasNodeGenerationMode): AiConfig {
    const defaultModel = mode === "image" ? globalConfig.imageModel : mode === "video" ? globalConfig.videoModel : mode === "audio" ? globalConfig.audioModel : globalConfig.textModel;
    const model = node.metadata?.model || defaultModel || (mode === "audio" ? defaultConfig.audioModel : globalConfig.model || defaultConfig.model);
    const config = buildCanvasNodeConfig(globalConfig, node, mode, model);
    return node.type === CanvasNodeType.Panorama ? { ...config, size: PANORAMA_IMAGE_SIZE } : config;
}

function promptPlaceholder(mode: CanvasNodeGenerationMode, hasImageContent: boolean, hasTextContent: boolean, isPanorama: boolean) {
    if (mode === "video") return "描述要生成的视频内容";
    if (mode === "audio") return "描述要生成的音频内容";
    if (isPanorama) return hasImageContent ? "描述要如何调整这个全景环境" : "描述要生成的 360° 全景环境";
    if (mode === "image") return hasImageContent ? "请输入你想要把这张图修改成什么" : "描述要生成的图片内容";
    return hasTextContent ? "请输入你想要将本段文本修改成什么" : "请输入你想要生成的文本内容";
}
