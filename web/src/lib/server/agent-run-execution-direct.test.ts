import { describe, expect, it } from "vitest";

import { directAgentPlan, directGenerationPreferences, normalizeTasks, planToOps, readFunctionCallResult, taskResultOps } from "./agent-run-execution";
import { agentSurfaceImageSize, normalizeCanvasPlanForSelection, resolveAgentTaskRatio } from "./agent-run-task-input";

describe("directAgentPlan", () => {
    it("使用用户指定的媒体模型创建单任务计划", () => {
        const plan = directAgentPlan([{ id: "image-pro", name: "专业图片模型", capability: "image", capabilityProfile: undefined }], "生成商品主图", ["asset-one"]);

        expect(plan.deliverables).toEqual([
            expect.objectContaining({
                id: "direct-model-task-1",
                type: "image",
                model: "image-pro",
                prompt: "生成商品主图",
                assetIds: ["asset-one"],
            }),
        ]);
        expect(plan.decisions?.[0]).toMatchObject({ label: "模型", value: "专业图片模型" });
    });

    it("拒绝把文本规划模型作为直接媒体模型", () => {
        expect(() => directAgentPlan([{ id: "planner", name: "规划模型", capability: "text", capabilityProfile: undefined }], "你好", [])).toThrow("当前模型不支持直接生成媒体");
    });

    it("把多模型图片数量按本轮总数分配而不是逐模型倍增", () => {
        const models = [
            { id: "image-a", name: "模型 A", capability: "image" as const, capabilityProfile: undefined },
            { id: "image-b", name: "模型 B", capability: "image" as const, capabilityProfile: undefined },
        ];
        const plan = directAgentPlan(models, "生成两张竖图", [], { mode: "image", image: { count: 2, size: "9:16" } });

        expect(plan.deliverables.map((item) => ({ model: item.model, count: item.count }))).toEqual([
            { model: "image-a", count: 1 },
            { model: "image-b", count: 1 },
        ]);
        expect(directGenerationPreferences({ image: { count: 2, size: "9:16" } })).toEqual({ image: { count: undefined, size: "9:16" } });
    });

    it("多模型数量不足时仍保留每个模型，并按各自容量分配总量", () => {
        const models = [
            { id: "image-a", name: "模型 A", capability: "image" as const, capabilityProfile: { maxBatchSize: 2 } },
            { id: "image-b", name: "模型 B", capability: "image" as const, capabilityProfile: { maxBatchSize: 4 } },
        ];

        expect(directAgentPlan(models, "生成对比图", [], { mode: "image", image: { count: 1 } }).deliverables.map((item) => ({ model: item.model, count: item.count }))).toEqual([
            { model: "image-a", count: 1 },
            { model: "image-b", count: 1 },
        ]);
        expect(directAgentPlan(models, "生成六张对比图", [], { mode: "image", image: { count: 6 } }).deliverables.map((item) => ({ model: item.model, count: item.count }))).toEqual([
            { model: "image-a", count: 2 },
            { model: "image-b", count: 4 },
        ]);
        expect(() => directAgentPlan(models, "生成七张对比图", [], { mode: "image", image: { count: 7 } })).toThrow("无法承载当前生成总数");
    });

    it("保留零积分文本流水用于失败时撤销套餐次数", () => {
        expect(readFunctionCallResult("{}", new Headers({ "x-vozeb-pro-points-cost": "0", "x-vozeb-pro-points-record-id": "free-agent-plan" }))).toMatchObject({ pointsCost: 0, pointsRecordId: "free-agent-plan" });
    });

    it("画布本轮选中图片会覆盖模型误选的历史编辑目标", () => {
        const plan = {
            intent: "generation",
            objective: "替换人物",
            reply: "开始替换人物",
            decisions: [],
            foundation: { complexity: "simple", brief: { objective: "替换人物" }, direction: { summary: "保持当前构图" } },
            deliverables: [{ id: "edit", title: "人物替换", type: "image", model: "image-pro", prompt: "换成黑人", count: 1, ratio: "原图比例", targetNodeId: "old-dog", dependencies: [] }],
        };
        const snapshot = {
            selectedNodeIds: ["current-person"],
            nodes: [
                { id: "old-dog", type: "image", title: "上一轮泰迪犬", metadata: { url: "/api/reference-assets/old.webp" } },
                { id: "current-person", type: "image", title: "本轮上传人物", metadata: { url: "/api/reference-assets/current.webp", naturalWidth: 360, naturalHeight: 640 } },
            ],
        };

        const [task] = normalizeTasks(plan as never, [], generationSettings() as never, snapshot, "换成黑人", "canvas", []);

        expect(task).toMatchObject({ targetNodeId: "current-person", referenceUrl: "/api/reference-assets/current.webp", referenceType: "image", ratio: "9:16" });
        expect(task.optimizedPrompt).toBe("换成黑人");
        expect(task.prompt).toContain("本轮上传人物");
        expect(task.prompt).not.toContain("上一轮泰迪犬");
        const ops = planToOps(plan as never, [task], "run", snapshot);
        expect(ops).toContainEqual({ type: "connect_nodes", fromNodeId: "current-person", toNodeId: "task-run-0" });
        expect(ops).not.toContainEqual({ type: "connect_nodes", fromNodeId: "old-dog", toNodeId: "task-run-0" });
        expect(ops).toContainEqual(
            expect.objectContaining({
                type: "add_node",
                id: "output-run-0-0",
                nodeType: "image",
                metadata: expect.objectContaining({ agentRunId: "run", agentTaskId: "edit", agentTaskType: "image", size: "9:16", status: "loading" }),
            }),
        );
        expect(ops).toContainEqual({ type: "connect_nodes", fromNodeId: "task-run-0", toNodeId: "output-run-0-0" });
        expect(ops).toContainEqual({ type: "connect_nodes", fromNodeId: "current-person", toNodeId: "output-run-0-0" });
    });

    it("选中图片并要求替换主体时不会被错误规划成视频", () => {
        const plan = {
            intent: "generation",
            objective: "把猪换成狗",
            reply: "开始生成短视频",
            skillIds: ["five-second-video"],
            decisions: [],
            foundation: { complexity: "simple", brief: { objective: "把猪换成狗" }, direction: { summary: "保持农场构图" } },
            deliverables: [{ id: "video", title: "母狗与幼犬 5 秒短视频", type: "video", model: "video-pro", prompt: "生成 5 秒短视频", seconds: 5, dependencies: [] }],
        };
        const snapshot = {
            selectedNodeIds: ["pig-image"],
            nodes: [{ id: "pig-image", type: "image", title: "农场里的猪", metadata: { url: "/api/reference-assets/pig.webp", naturalWidth: 1280, naturalHeight: 720 } }],
        };

        const normalizedPlan = normalizeCanvasPlanForSelection(plan as never, snapshot, "把猪换成狗");
        const [task] = normalizeTasks(normalizedPlan, [], generationSettings() as never, snapshot, "把猪换成狗", "canvas", []);

        expect(normalizedPlan).toMatchObject({ skillIds: [], reply: "我会直接编辑当前图片，不会改成视频任务。" });
        expect(normalizedPlan.deliverables).toEqual([expect.objectContaining({ type: "image", targetNodeId: "pig-image", prompt: "把猪换成狗" })]);
        expect(task).toMatchObject({ type: "image", model: "image-pro", targetNodeId: "pig-image", referenceUrl: "/api/reference-assets/pig.webp", ratio: "16:9" });
    });

    it("统一按文字尺寸、锁定尺寸、参考图、规划和默认值排序", () => {
        const base = { type: "image" as const, configuredImageSize: "1824x1024", reference: { type: "image" as const, width: 1024, height: 1536 }, plannedRatio: "1:1", globalSize: "4:3" };

        expect(resolveAgentTaskRatio({ ...base, requestedImageSize: "1280x720" })).toBe("1280x720");
        expect(resolveAgentTaskRatio(base)).toBe("1824x1024");
        expect(resolveAgentTaskRatio({ ...base, configuredImageSize: "16:9", configuredSizeExplicit: true })).toBe("16:9");
        expect(resolveAgentTaskRatio({ ...base, configuredImageSize: undefined })).toBe("2:3");
        expect(resolveAgentTaskRatio({ ...base, configuredImageSize: undefined, reference: undefined })).toBe("1:1");
        expect(resolveAgentTaskRatio({ ...base, configuredImageSize: undefined, reference: undefined, plannedRatio: undefined })).toBe("4:3");
        expect(resolveAgentTaskRatio({ ...base, configuredImageSize: "auto", reference: undefined })).toBe("1:1");
        expect(resolveAgentTaskRatio({ ...base, configuredImageSize: "auto", reference: undefined, plannedRatio: undefined })).toBe("auto");
        expect(resolveAgentTaskRatio({ ...base, requestPrompt: "换成横屏尺寸", configuredImageSize: "auto", plannedRatio: "16:9" })).toBe("16:9");
        expect(resolveAgentTaskRatio({ ...base, requestPrompt: "换成横屏尺寸", configuredImageSize: "auto", plannedRatio: "1:1" })).toBe("auto");
        expect(resolveAgentTaskRatio({ ...base, type: "video" })).toBe("1824x1024");
        expect(agentSurfaceImageSize("canvas", { imageSize: "1824x1024" })).toBe("1824x1024");
        expect(agentSurfaceImageSize("canvas", { imageSize: "1:1" })).toBeUndefined();
        expect(
            agentSurfaceImageSize("canvas", {
                imageSize: "1:1",
                selectedNodeIds: ["reference"],
                nodes: [
                    { id: "config", type: "config", metadata: { size: "16:9" } },
                    { id: "reference", type: "image", metadata: { naturalWidth: 1024, naturalHeight: 1536 } },
                ],
            }),
        ).toBe("16:9");
        expect(
            agentSurfaceImageSize("canvas", {
                imageSize: "1024x1024",
                selectedNodeIds: ["config"],
                nodes: [{ id: "config", type: "config", metadata: { size: "1824x1024" } }],
            }),
        ).toBe("1824x1024");
    });

    it("统一 Agent 将用户选择的图片尺寸和画质写入真实任务", () => {
        const plan = {
            intent: "generation",
            objective: "生成主视觉",
            reply: "开始生成",
            decisions: [],
            foundation: { complexity: "simple", brief: { objective: "生成主视觉" }, direction: { summary: "横版构图" } },
            deliverables: [{ id: "hero", title: "主视觉", type: "image", model: "image-pro", prompt: "产品海报", count: 1, ratio: "1:1", quality: "low", dependencies: [] }],
        };

        const [task] = normalizeTasks(plan as never, [], generationSettings() as never, undefined, "产品海报", "chat", [], undefined, { mode: "image", image: { size: "16:9", quality: "high", count: 4 } });

        expect(task).toMatchObject({ type: "image", ratio: "16:9", quality: "high", count: 4 });
    });

    it("统一 Agent 的智能参数使用规划结果且不回退全局 1:1", () => {
        const plan = {
            intent: "generation",
            objective: "生成竖版海报",
            reply: "开始生成",
            decisions: [],
            foundation: { complexity: "simple", brief: { objective: "生成竖版海报" }, direction: { summary: "竖版构图" } },
            deliverables: [{ id: "poster", title: "海报", type: "image", model: "image-pro", prompt: "竖版产品海报", count: 1, ratio: "9:16", quality: "2K", dependencies: [] }],
        };

        const [task] = normalizeTasks(plan as never, [], generationSettings() as never, undefined, "生成竖版海报", "chat", [], undefined, { mode: "image", image: { size: "auto", quality: "auto" } });

        expect(task).toMatchObject({ ratio: "9:16", quality: "2K" });
    });

    it("在落库前拒绝所有候选渠道都不支持的 Agent 参数", () => {
        const plan = {
            intent: "generation",
            objective: "生成主视觉",
            reply: "开始生成",
            decisions: [],
            foundation: { complexity: "simple", brief: { objective: "生成主视觉" }, direction: { summary: "竖版构图" } },
            deliverables: [{ id: "hero", title: "主视觉", type: "image", model: "image-pro", prompt: "产品海报", count: 1, ratio: "1:1", quality: "low", dependencies: [] }],
        };
        const settings = generationSettings();
        settings.logicalModels[0].bindings[0] = { ...settings.logicalModels[0].bindings[0], capabilityProfile: { aspectRatios: ["9:16"], resolutions: ["2K"] } } as never;

        expect(() => normalizeTasks(plan as never, [], settings as never, undefined, "产品海报", "chat", [])).toThrow("不支持 1:1 比例");
    });

    it("将逐图引用别名和稳定资产 ID 一起写入真实上游提示词", () => {
        const plan = {
            intent: "generation",
            objective: "合成双图",
            reply: "开始生成",
            decisions: [],
            foundation: { complexity: "simple", brief: { objective: "合成双图" }, direction: { summary: "保持主体清晰" } },
            deliverables: [{ id: "composite", title: "合成图", type: "image", model: "image-pro", prompt: "@图片1 保持人物，@图片2 改成夜景", count: 1, assetIds: ["first", "second"], dependencies: [] }],
        };
        const assets = [
            { id: "first", type: "image", title: "人物", serverUrl: "/api/reference-assets/first.webp", metadata: {} },
            { id: "second", type: "image", title: "夜景", serverUrl: "/api/reference-assets/second.webp", metadata: {} },
        ];

        const [task] = normalizeTasks(plan as never, [], generationSettings() as never, undefined, plan.deliverables[0].prompt, "chat", assets as never);

        expect(task.prompt).toContain("引用别名：@图片1；资产 ID：first");
        expect(task.prompt).toContain("引用别名：@图片2；资产 ID：second");
        expect(task.references?.map((reference) => reference.assetId)).toEqual(["first", "second"]);
    });

    it("统一 Agent 将视频声音水印与音频语速写入真实任务快照", () => {
        const plan = {
            intent: "generation",
            objective: "生成带配音的视频和旁白",
            reply: "开始生成",
            decisions: [],
            foundation: { complexity: "simple", brief: { objective: "生成带配音的视频和旁白" }, direction: { summary: "电影感" } },
            deliverables: [
                { id: "video", title: "视频", type: "video", model: "video-pro", prompt: "产品视频", count: 1, quality: "720", seconds: 5, generateAudio: true, watermark: false, dependencies: [] },
                { id: "audio", title: "旁白", type: "audio", model: "audio-pro", prompt: "产品旁白", count: 1, voice: "alloy", format: "mp3", speed: 1, dependencies: [] },
            ],
        };

        const [video, audio] = normalizeTasks(plan as never, [], generationSettings() as never, undefined, "生成产品视频", "chat", [], undefined, {
            video: { quality: "2160", seconds: 60, generateAudio: false, watermark: true },
            audio: { voice: "nova", format: "wav", speed: 1.25 },
        });

        expect(video).toMatchObject({ type: "video", quality: "2160", seconds: 60, generateAudio: false, watermark: true });
        expect(audio).toMatchObject({ type: "audio", voice: "nova", format: "wav", speed: 1.25 });
    });

    it("即使 Planner 漏掉资产也会把用户明确选择的首尾帧注入视频任务", () => {
        const plan = {
            intent: "generation",
            objective: "生成首尾衔接视频",
            reply: "开始生成",
            decisions: [],
            foundation: { complexity: "simple", brief: { objective: "生成首尾衔接视频" }, direction: { summary: "镜头连续" } },
            deliverables: [{ id: "video", title: "首尾衔接视频", type: "video", model: "video-pro", prompt: "自然运镜", count: 1, dependencies: [], assetIds: [] }],
        };
        const assets = [
            { id: "first-image", userId: "user", conversationId: "conversation", type: "image", title: "首帧", status: "ready", serverUrl: "/api/reference-assets/first.png", createdAt: 1, updatedAt: 1 },
            { id: "last-image", userId: "user", conversationId: "conversation", type: "image", title: "尾帧", status: "ready", serverUrl: "/api/reference-assets/last.png", createdAt: 1, updatedAt: 1 },
        ];

        const [task] = normalizeTasks(plan as never, [], generationSettings() as never, undefined, "让首尾画面自然衔接", "chat", assets as never, undefined, {
            mode: "video",
            video: { count: 3, referenceMode: "first_last", firstFrameAssetId: "first-image", lastFrameAssetId: "last-image" },
        });

        expect(task).toMatchObject({
            type: "video",
            model: "video-pro",
            count: 3,
            referenceAssetId: "first-image",
            references: [
                { assetId: "first-image", type: "image", role: "first_frame", url: "/api/reference-assets/first.png" },
                { assetId: "last-image", type: "image", role: "last_frame", url: "/api/reference-assets/last.png" },
            ],
        });
    });

    it("短剧 Agent 使用项目自定义画幅覆盖规划画幅", () => {
        const plan = {
            intent: "generation",
            objective: "生成分镜",
            reply: "开始生成",
            decisions: [],
            foundation: { complexity: "simple", brief: { objective: "生成分镜" }, direction: { summary: "电影感" } },
            deliverables: [{ id: "shot", title: "分镜", type: "image", model: "image-pro", prompt: "雨夜车站", count: 1, ratio: "1:1", dependencies: [] }],
        };

        const [task] = normalizeTasks(plan as never, [], generationSettings() as never, { project: { ratio: "16:9" } }, "生成分镜", "drama", []);

        expect(task.ratio).toBe("16:9");
    });

    it("短剧 Agent 在没有精确自定义宽高时继承本轮参考图比例", () => {
        const plan = {
            intent: "generation",
            objective: "生成分镜",
            reply: "开始生成",
            decisions: [],
            foundation: { complexity: "simple", brief: { objective: "生成分镜" }, direction: { summary: "电影感" } },
            deliverables: [{ id: "shot", title: "分镜", type: "image", model: "image-pro", prompt: "雨夜车站", count: 1, ratio: "1:1", assetIds: ["reference"], dependencies: [] }],
        };
        const assets = [{ id: "reference", type: "image", title: "竖版参考图", width: 1080, height: 1920, serverUrl: "/api/generation-log-assets/reference.webp", metadata: {} }];

        const [task] = normalizeTasks(plan as never, [], generationSettings() as never, { project: { ratio: "16:9" } }, "生成分镜", "drama", assets as never);

        expect(task.ratio).toBe("9:16");
    });

    it("画布 Agent 使用当前自定义宽高覆盖规划画幅", () => {
        const plan = {
            intent: "generation",
            objective: "生成主视觉",
            reply: "开始生成",
            decisions: [],
            foundation: { complexity: "simple", brief: { objective: "生成主视觉" }, direction: { summary: "横版构图" } },
            deliverables: [{ id: "hero", title: "主视觉", type: "image", model: "image-pro", prompt: "中国辣妹", count: 1, ratio: "1:1", dependencies: [] }],
        };

        const [task] = normalizeTasks(plan as never, [], generationSettings() as never, { imageSize: "1824x1024", selectedNodeIds: [], nodes: [] }, "中国辣妹", "canvas", []);

        expect(task.ratio).toBe("1824x1024");
    });

    it("画布配置节点的自定义宽高覆盖选中参考图和规划画幅", () => {
        const plan = {
            intent: "generation",
            objective: "生成主视觉",
            reply: "开始生成",
            decisions: [],
            foundation: { complexity: "simple", brief: { objective: "生成主视觉" }, direction: { summary: "横版构图" } },
            deliverables: [{ id: "hero", title: "主视觉", type: "image", model: "image-pro", prompt: "中国辣妹", count: 1, ratio: "1:1", dependencies: [] }],
        };
        const snapshot = {
            imageSize: "1:1",
            selectedNodeIds: ["reference"],
            nodes: [
                { id: "config", type: "config", title: "生成配置", metadata: { size: "1824x1024" } },
                { id: "reference", type: "image", title: "参考图", metadata: { url: "/api/reference-assets/reference.webp", naturalWidth: 1024, naturalHeight: 1536 } },
            ],
        };

        const [task] = normalizeTasks(plan as never, [], generationSettings() as never, snapshot, "中国辣妹", "canvas", []);

        expect(task).toMatchObject({ ratio: "1824x1024", targetNodeId: "reference", referenceUrl: "/api/reference-assets/reference.webp" });
    });

    it("画布明确改成横屏时使用 Agent 横版规划并直连源图与结果", () => {
        const plan = {
            intent: "generation",
            objective: "换成横屏尺寸",
            reply: "开始调整",
            decisions: [],
            foundation: { complexity: "simple", brief: { objective: "换成横屏尺寸" }, direction: { summary: "横版构图" } },
            deliverables: [{ id: "landscape", title: "横版图片", type: "image", model: "image-pro", prompt: "保持主体并扩展为横版画面", count: 1, ratio: "16:9", dependencies: [] }],
        };
        const snapshot = {
            imageSize: "1:1",
            selectedNodeIds: ["portrait-source"],
            nodes: [{ id: "portrait-source", type: "image", title: "竖版源图", metadata: { url: "/api/reference-assets/portrait.webp", naturalWidth: 1024, naturalHeight: 1536 } }],
        };

        const [task] = normalizeTasks(plan as never, [], generationSettings() as never, snapshot, "换成横屏尺寸", "canvas", []);
        const ops = planToOps(plan as never, [task], "landscape-run", snapshot);

        expect(task).toMatchObject({ ratio: "16:9", targetNodeId: "portrait-source" });
        expect(ops).toContainEqual({ type: "connect_nodes", fromNodeId: "portrait-source", toNodeId: "output-landscape-run-0-0" });
    });

    it("选中提示词节点时原位改写且不创建图片或计划节点", () => {
        const plan = {
            intent: "generation",
            objective: "生成紫毛小狗",
            reply: "开始生图",
            decisions: [],
            foundation: { complexity: "simple", brief: { objective: "生成紫毛小狗" }, direction: { summary: "紫色毛发" } },
            deliverables: [{ id: "image", title: "紫毛小狗", type: "image", model: "image-pro", prompt: "生成紫毛小狗", count: 1, dependencies: [] }],
        };
        const snapshot = {
            selectedNodeIds: ["prompt-one"],
            nodes: [{ id: "prompt-one", type: "text", title: "紫毛小狗提示词", metadata: { content: "一只白色小狗在草地上" } }],
        };

        const normalizedPlan = normalizeCanvasPlanForSelection(plan as never, snapshot, "帮我优化一下这个提示词");
        const [task] = normalizeTasks(normalizedPlan, [], generationSettings() as never, snapshot, "帮我优化一下这个提示词", "canvas", []);

        expect(normalizedPlan.deliverables).toEqual([expect.objectContaining({ type: "text", targetNodeId: "prompt-one" })]);
        expect(task).toMatchObject({ type: "text", targetNodeId: "prompt-one" });
        expect(task.prompt).toContain("一只白色小狗在草地上");
        expect(planToOps(normalizedPlan, [task], "run", snapshot)).toEqual([]);
        expect(taskResultOps("run", 0, { ...task, status: "completed", attempts: 1, result: { content: "一只紫色毛发的小狗在草地上" } })).toEqual({
            nodeIds: ["prompt-one"],
            ops: [
                { type: "update_node", id: "prompt-one", metadata: { content: "一只紫色毛发的小狗在草地上", prompt: "一只紫色毛发的小狗在草地上", status: "success", agentRunId: "run" } },
                { type: "select_nodes", ids: ["prompt-one"] },
            ],
        });
    });
});

function generationSettings() {
    return {
        defaultModels: { textModel: "text-pro", imageModel: "image-pro", videoModel: "video-pro", audioModel: "audio-pro" },
        systemChannels: [
            { id: "image-channel", name: "图片", enabled: true, baseUrl: "https://api.example.com/v1", apiKey: "secret", models: ["vendor/image-pro"] },
            { id: "text-channel", name: "文本", enabled: true, baseUrl: "https://api.example.com/v1", apiKey: "secret", models: ["vendor/text-pro"] },
            { id: "video-channel", name: "视频", enabled: true, baseUrl: "https://api.example.com/v1", apiKey: "secret", models: ["vendor/video-pro"] },
            { id: "audio-channel", name: "音频", enabled: true, baseUrl: "https://api.example.com/v1", apiKey: "secret", models: ["vendor/audio-pro"] },
        ],
        logicalModels: [
            { id: "image-pro", name: "专业图片模型", capability: "image", enabled: true, bindings: [{ id: "binding-image", channelId: "image-channel", upstreamModel: "vendor/image-pro", enabled: true, priority: 1 }] },
            { id: "text-pro", name: "文本模型", capability: "text", enabled: true, bindings: [{ id: "binding-text", channelId: "text-channel", upstreamModel: "vendor/text-pro", enabled: true, priority: 1 }] },
            { id: "video-pro", name: "专业视频模型", capability: "video", enabled: true, bindings: [{ id: "binding-video", channelId: "video-channel", upstreamModel: "vendor/video-pro", enabled: true, priority: 1 }] },
            { id: "audio-pro", name: "专业音频模型", capability: "audio", enabled: true, bindings: [{ id: "binding-audio", channelId: "audio-channel", upstreamModel: "vendor/audio-pro", enabled: true, priority: 1 }] },
        ],
        generationDefaults: { canvasImageCount: 1, imageSize: "1:1", imageQuality: "high", videoSeconds: 5, videoQuality: "720p", audioVoice: "alloy", audioFormat: "mp3" },
    };
}
