import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { CanvasNodeType } from "../types";
import { assistantMessageToChatMessage, canvasRunSelectedNodeIds, compactMetadata, compactSnapshot, removeCanvasAssistantSessions } from "./canvas-assistant-elements";

describe("Canvas Agent session deletion", () => {
    const sessions = [
        { id: "active", title: "当前对话", messages: [], createdAt: "2026-08-06T00:00:00.000Z", updatedAt: "2026-08-06T00:00:00.000Z" },
        { id: "history", title: "历史对话", messages: [], createdAt: "2026-08-05T00:00:00.000Z", updatedAt: "2026-08-05T00:00:00.000Z" },
    ];

    it("keeps the current chat when deleting another history entry", () => {
        expect(removeCanvasAssistantSessions(sessions, "active", ["history"])).toMatchObject({ sessions: [{ id: "active" }], activeSessionId: "active" });
    });

    it("selects the next chat when deleting the active entry", () => {
        expect(removeCanvasAssistantSessions(sessions, "active", ["active"])).toMatchObject({ sessions: [{ id: "history" }], activeSessionId: "history" });
    });

    it("keeps a fresh active chat after deleting the final conversation", () => {
        const result = removeCanvasAssistantSessions(
            [
                {
                    id: "only-session",
                    title: "待删除对话",
                    messages: [{ id: "message", role: "user", text: "保留输入区" }],
                    createdAt: "2026-08-06T00:00:00.000Z",
                    updatedAt: "2026-08-06T00:00:00.000Z",
                },
            ],
            "only-session",
            ["only-session"],
        );

        expect(result.sessions).toHaveLength(1);
        expect(result.sessions[0]).toMatchObject({ title: "新对话", messages: [] });
        expect(result.activeSessionId).toBe(result.sessions[0].id);
    });
});

describe("Canvas Agent current-turn references", () => {
    it("renders the current-turn references before the user text", async () => {
        const item = assistantMessageToChatMessage({ id: "message", role: "user", text: "修改颜色", references: [{ id: "reference", type: CanvasNodeType.Image, title: "参考图", dataUrl: "/api/reference-assets/reference.webp" }] });
        expect(item.attachments).toEqual([{ id: "reference", name: "参考图", type: "image", url: "/api/reference-assets/reference.webp" }]);

        const source = await readFile(resolve(process.cwd(), "src/app/(user)/canvas/components/canvas-agent-chat-ui.tsx"), "utf8");
        const userMessageStart = source.indexOf("if (isUser)");
        const messageSource = source.slice(userMessageStart, source.indexOf("return (", source.indexOf("return (", userMessageStart) + 1));

        expect(messageSource.indexOf("<AgentMessageAttachments")).toBeGreaterThanOrEqual(0);
        expect(messageSource.indexOf("<AgentMessageAttachments")).toBeLessThan(messageSource.indexOf("item.text"));
        expect(messageSource.indexOf("<AgentUserAvatar")).toBeGreaterThan(messageSource.indexOf("item.text"));
    });

    it("places compact composer thumbnails above the editable prompt", async () => {
        const source = await readFile(resolve(process.cwd(), "src/app/(user)/canvas/components/canvas-agent-chat-ui.tsx"), "utf8");
        const composer = source.slice(source.indexOf("data-canvas-agent-composer"), source.indexOf("export function AgentPanelTabs"));

        expect(composer).toContain("relative size-10");
        expect(composer).toContain("max-w-[44%]");
        expect(composer).toContain('className="relative min-w-0 flex-1"');
        expect(composer.indexOf('aria-label="本轮参考素材"')).toBeLessThan(composer.indexOf("<Popover"));
        expect(composer.indexOf("<Popover")).toBeLessThan(composer.indexOf("<textarea"));
    });

    it("keeps typed @ asset mentions without rendering a dedicated mention button", async () => {
        const source = await readFile(resolve(process.cwd(), "src/app/(user)/canvas/components/canvas-agent-chat-ui.tsx"), "utf8");
        const composer = source.slice(source.indexOf("data-canvas-agent-composer"), source.indexOf("export function AgentPanelTabs"));

        expect(composer).not.toContain('aria-label="引用画布图片或视频"');
        expect(source).toContain("canvasAgentMentionAtCursor");
        expect(composer).toContain("<CanvasAgentMentionPicker");
        expect(source).toContain("onSelectReference?.(asset.id)");
    });

    it("keeps reference upload in the input row and orders Skill, planning, model, parameters before send", async () => {
        const chatSource = await readFile(resolve(process.cwd(), "src/app/(user)/canvas/components/canvas-agent-chat-ui.tsx"), "utf8");
        const controlsSource = await readFile(resolve(process.cwd(), "src/components/agent/creative-agent-controls.tsx"), "utf8");
        const assistantSource = await readFile(resolve(process.cwd(), "src/app/(user)/canvas/components/canvas-assistant-panel.tsx"), "utf8");
        const settingsSource = await readFile(resolve(process.cwd(), "src/components/agent/compact-agent-generation-settings.tsx"), "utf8");
        const inputRow = chatSource.slice(chatSource.indexOf("data-canvas-agent-input-row"), chatSource.indexOf("data-canvas-agent-toolbar"));
        const toolbar = chatSource.slice(chatSource.indexOf('className="mt-2 flex min-w-0'), chatSource.indexOf("export function AgentPanelTabs"));
        const controls = controlsSource.slice(controlsSource.indexOf("const mutedStyle"), controlsSource.indexOf("function capabilityLabel"));

        expect(inputRow).toContain('aria-label={uploading ? "正在上传图片" : attachments.length ? "继续添加参考素材" : "添加参考素材"}');
        expect(inputRow.indexOf('aria-label="本轮参考素材"')).toBeLessThan(inputRow.indexOf("<textarea"));
        expect(toolbar).toContain("data-canvas-agent-toolbar");
        expect(toolbar).not.toContain("添加参考素材");
        expect(inputRow).toContain("min-h-20");
        expect(controls).toContain('compact ? "flex w-full min-w-0 items-center gap-1"');
        expect(controls).toContain('compact && "pl-1"');
        expect(controls).not.toContain('compact && "ml-auto pl-1"');
        expect(settingsSource).toContain('triggerIcon={<SlidersHorizontal className="size-4" />}');
        expect(settingsSource).toContain("!max-w-[116px]");
        expect(settingsSource).toContain('panelClassName="!w-[280px]"');
        expect(controlsSource).toContain('data-creative-agent-model-picker={compact ? "compact" : "default"}');
        expect(controlsSource).toContain('compact ? "max-w-[280px]"');
        expect(controlsSource).toContain('compact ? "max-h-40"');
        expect(toolbar.indexOf("{left}")).toBeLessThan(toolbar.indexOf('aria-label="发送"'));
        expect(assistantSource.indexOf("middle={<CanvasAgentGenerationSettings")).toBeGreaterThan(assistantSource.indexOf("<CreativeAgentControls"));
        expect(controls.indexOf("skillOpen")).toBeLessThan(controls.indexOf("smartPlanning"));
        expect(controls.indexOf("smartPlanning")).toBeLessThan(controls.indexOf("modelOpen"));
        expect(controls.indexOf("modelOpen")).toBeLessThan(controls.indexOf("{middle}"));
    });

    it("uses the settings icon for Canvas image and video parameter triggers", async () => {
        const [imageSettings, videoSettings] = await Promise.all([
            readFile(resolve(process.cwd(), "src/app/(user)/canvas/components/canvas-image-settings-popover.tsx"), "utf8"),
            readFile(resolve(process.cwd(), "src/app/(user)/canvas/components/canvas-video-settings-popover.tsx"), "utf8"),
        ]);

        expect(imageSettings).toContain('triggerIcon={<SlidersHorizontal className="size-4" />}');
        expect(videoSettings).toContain('triggerIcon={<SlidersHorizontal className="size-4" />}');
        expect(imageSettings).toContain("canvasImagePreferenceSummary(preferences, fixedSizeLabel)");
        expect(imageSettings).toContain('triggerLabelClassName="whitespace-nowrap text-left !overflow-visible !text-clip"');
        expect(imageSettings).toContain('count > 1 ? ` · ${count}张` : ""');
        expect(videoSettings).toContain("canvasVideoPreferenceSummary(preferences)");
        expect(videoSettings).toContain('triggerLabelClassName="whitespace-nowrap text-left !overflow-visible !text-clip"');
    });

    it("clears submitted references before creating the backend run", async () => {
        const source = await readFile(resolve(process.cwd(), "src/app/(user)/canvas/components/canvas-assistant-panel.tsx"), "utf8");
        const sendSource = source.slice(source.indexOf("const sendMessage"), source.indexOf("const waitForBackendAgent"));

        expect(sendSource.indexOf("setRemovedReferenceIds")).toBeGreaterThanOrEqual(0);
        expect(sendSource.indexOf("setRemovedReferenceIds")).toBeLessThan(sendSource.indexOf("createCreativeAgentRun"));
    });

    it("uses each Canvas chat's persisted backend conversation identity", async () => {
        const source = await readFile(resolve(process.cwd(), "src/app/(user)/canvas/components/canvas-assistant-panel.tsx"), "utf8");

        expect(source).toContain("conversationId: session.conversationId");
        expect(source).toContain("preferences: generationPreferences.mode ? generationPreferences : undefined");
        expect(source).toContain("<CanvasAgentGenerationSettings preferences={generationPreferences} models={selectedModels} onChange={setGenerationPreferences}");
        expect(source).toContain("controlCreativeAgentRun(run.runId, action, session.conversationId)");
        expect(source).toContain("retryCreativeAgentTask(runId, taskId, session.conversationId)");
        expect(source).toContain("conversationId: run.conversationId");
    });

    it("keeps an uploaded canvas image as a stable Run reference URL", () => {
        expect(
            compactMetadata(CanvasNodeType.Image, {
                content: "/api/reference-assets/permanent/2026/07/28/images/person.png",
                storageKey: "permanent/2026/07/28/images/person.png",
                mimeType: "image/png",
            }),
        ).toMatchObject({ url: "/api/reference-assets/permanent/2026/07/28/images/person.png" });
    });

    it("preserves the generation-media scope instead of rebuilding the image as a reference upload", () => {
        expect(
            compactMetadata(CanvasNodeType.Image, {
                content: "/api/generation-log-assets/permanent/2026/07/28/images/person.png",
                storageKey: "permanent/2026/07/28/images/person.png",
            }),
        ).toMatchObject({ url: "/api/generation-log-assets/permanent/2026/07/28/images/person.png" });
    });

    it("keeps media prompts but never serializes data or blob media bodies", () => {
        const largePayload = `data:image/png;base64,${"canvas-binary-marker".repeat(40_000)}`;
        const large = compactMetadata(CanvasNodeType.Image, { content: largePayload, prompt: "保留人物并改成夜景", status: "success", model: "image-model" });
        const small = compactMetadata(CanvasNodeType.Image, { content: "data:image/png;base64,short", prompt: "保留人物并改成夜景", status: "success", model: "image-model" });

        expect(large).toEqual(small);
        expect(large).toEqual({ content: "保留人物并改成夜景", size: undefined, naturalWidth: undefined, naturalHeight: undefined, url: undefined });
        expect(JSON.stringify(large)).not.toContain("canvas-binary-marker");
        expect(compactMetadata(CanvasNodeType.Video, { content: "blob:http://localhost/video", prompt: "镜头缓慢推进" })).toMatchObject({ content: "镜头缓慢推进", url: undefined });
    });

    it("keeps text and exact config content while removing unused scene fields", () => {
        const snapshot = compactSnapshot({
            projectId: "canvas-one",
            title: "画布",
            imageSize: "1:1",
            nodes: [
                { id: "text", type: CanvasNodeType.Text, title: "文案", position: { x: 120, y: 240 }, width: 320, height: 180, metadata: { content: "完整文本内容", status: "success", model: "text-model" } },
                { id: "config", type: CanvasNodeType.Config, title: "生成配置", position: { x: 480, y: 240 }, width: 340, height: 220, metadata: { composerContent: "生成电影感海报", size: "1824x1024", generationMode: "image" } },
            ],
            connections: [],
            selectedNodeIds: ["text"],
            viewport: { x: 100, y: 200, k: 0.75 },
        });

        expect(snapshot.nodes).toEqual([
            { id: "text", type: CanvasNodeType.Text, title: "文案", width: 320, height: 180, metadata: { content: "完整文本内容", size: undefined, naturalWidth: undefined, naturalHeight: undefined, url: undefined } },
            { id: "config", type: CanvasNodeType.Config, title: "生成配置", width: 340, height: 220, metadata: { content: "生成电影感海报", size: "1824x1024", naturalWidth: undefined, naturalHeight: undefined, url: undefined } },
        ]);
        expect(snapshot).not.toHaveProperty("viewport");
        expect(snapshot.nodes[0]).not.toHaveProperty("position");
        expect(snapshot.nodes[0].metadata).not.toHaveProperty("status");
        expect(snapshot.nodes[0].metadata).not.toHaveProperty("model");
        expect(snapshot.nodes[1].metadata).not.toHaveProperty("generationMode");
    });

    it("keeps the current custom image dimensions in the backend Run snapshot", () => {
        expect(
            compactSnapshot({
                projectId: "canvas-one",
                title: "画布",
                imageSize: "1824x1024",
                nodes: [],
                connections: [],
                selectedNodeIds: [],
                viewport: { x: 0, y: 0, k: 1 },
            }),
        ).toMatchObject({ imageSize: "1824x1024" });
    });

    it("keeps selected config nodes while replacing stale media references", () => {
        const snapshot = {
            projectId: "canvas-one",
            title: "画布",
            nodes: [
                { id: "config", type: CanvasNodeType.Config, title: "生成配置", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { size: "1824x1024" } },
                { id: "old-image", type: CanvasNodeType.Image, title: "旧参考图", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { content: "/old.webp" } },
                { id: "current-image", type: CanvasNodeType.Image, title: "本轮参考图", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { content: "/current.webp" } },
            ],
            connections: [],
            selectedNodeIds: ["config", "old-image"],
            viewport: { x: 0, y: 0, k: 1 },
        };

        expect(canvasRunSelectedNodeIds(snapshot, new Set(["current-image"]))).toEqual(["config", "current-image"]);
    });
});
