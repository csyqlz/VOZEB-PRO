import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "@/lib/auth/store-foundation";

import { agentPlannerInput, agentPlannerSystemPrompt, buildAgentPlannerInput, compactCanvasSnapshot, plannerAgentSkills, selectAgentSkills } from "./agent-run-surface-policy";
import { filterAgentPlannerModels, resolveAgentPlanningProfile } from "./agent-run-planning-profile";

describe("selectAgentSkills", () => {
    it("honors an explicitly selected compatible skill without keyword text", () => {
        const skills = selectAgentSkills(DEFAULT_SETTINGS, "chat", ["character-design"]);
        expect(skills.map((skill) => skill.id)).toContain("character-design");
    });

    it("does not allow a planner response to enable an unselected Skill", () => {
        expect(selectAgentSkills(DEFAULT_SETTINGS, "chat", [])).toEqual([]);
    });

    it("does not allow disabled or incompatible skills to be forced", () => {
        const settings = {
            ...DEFAULT_SETTINGS,
            agentSkills: DEFAULT_SETTINGS.agentSkills.map((skill) => (skill.id === "character-design" ? { ...skill, enabled: false } : skill)),
        };
        expect(selectAgentSkills(settings, "chat", ["character-design"])).toEqual([]);
        expect(selectAgentSkills(DEFAULT_SETTINGS, "canvas", ["image-motion"])).toEqual([]);
    });

    it("keeps drama skills inside drama projects", () => {
        expect(selectAgentSkills(DEFAULT_SETTINGS, "drama", ["drama-planning"]).map((skill) => skill.id)).toEqual(["drama-planning"]);
        expect(selectAgentSkills(DEFAULT_SETTINGS, "drama", ["image-motion"])).toEqual([]);
    });
});

describe("agentPlannerInput", () => {
    it("constrains drama generation to the current project snapshot", () => {
        const prompt = agentPlannerSystemPrompt("drama", "{}", DEFAULT_SETTINGS.site.title);

        expect(prompt).toContain("projectSnapshot 是本次短剧生产的权威上下文");
        expect(prompt).toContain("currentStage");
        expect(prompt).toContain("project.ratio");
        expect(prompt).toContain("currentTurnReferences");
        expect(prompt).toContain("不得把短剧入口当成脱离项目的通用图片或视频工作台");
    });

    it("uses the configured site title in the Agent identity", () => {
        const prompt = agentPlannerSystemPrompt("chat", "{}", "星河创作");

        expect(prompt).toContain("你是 星河创作 统一创作 Agent");
        expect(prompt).not.toContain("VOZEB PRO");
    });

    it("keeps selected Canvas nodes, one-hop relations and exact size while dropping unrelated nodes", () => {
        const snapshot = {
            projectId: "canvas-one",
            title: "商品画布",
            imageSize: "1:1",
            selectedNodeIds: ["selected"],
            nodes: [
                { id: "config", type: "config", title: "配置", metadata: { size: "400x600" } },
                { id: "selected", type: "image", title: "当前商品", metadata: { url: "/api/reference-assets/current", naturalWidth: 400, naturalHeight: 600 } },
                { id: "related", type: "text", title: "关联文案", metadata: { content: "红色包装" } },
                { id: "unrelated", type: "image", title: "旧图片", metadata: { url: "/api/reference-assets/old" } },
            ],
            connections: [{ id: "edge", fromNodeId: "related", toNodeId: "selected" }],
            viewport: { x: 100, y: 200, k: 0.5 },
        };

        const compact = compactCanvasSnapshot(snapshot);

        expect(compact).toMatchObject({ projectId: "canvas-one", imageSize: "1:1", selectedNodeIds: ["selected"] });
        expect(compact.nodes.map((node) => node.id)).toEqual(["config", "selected", "related"]);
        expect(compact.nodes[0]).toMatchObject({ metadata: { size: "400x600" } });
        expect(compact).not.toHaveProperty("viewport");
    });

    it("reuses a persisted normalized Canvas snapshot without exposing internal analysis", () => {
        const snapshot = {
            canvasSnapshotVersion: 1,
            projectId: "canvas-one",
            title: "画布",
            imageSize: "1824x1024",
            selectedNodeIds: ["selected"],
            nodes: [{ id: "selected", type: "image", title: "商品", metadata: { url: "/api/reference-assets/current", naturalWidth: 1824, naturalHeight: 1024 } }],
            connections: [],
            analysis: { nodeCount: 1, selectedNodeTypes: ["image"] },
        };

        const compact = compactCanvasSnapshot(snapshot);

        expect(compact).toEqual({ projectId: "canvas-one", title: "画布", imageSize: "1824x1024", selectedNodeIds: ["selected"], nodes: snapshot.nodes, connections: [] });
        expect(compact).not.toHaveProperty("analysis");
        expect(compact).not.toHaveProperty("canvasSnapshotVersion");
    });

    it("keeps the complete validated conversation, asset and Skill planning context", () => {
        const settings = {
            ...DEFAULT_SETTINGS,
            agentSkills: [
                {
                    id: "skill-one",
                    name: "商品技能",
                    description: "商品规划摘要",
                    plannerSummary: "精简规划说明".repeat(40),
                    instructions: "完整执行说明".repeat(1000),
                    enabled: true,
                    keywords: [],
                    workspaces: ["canvas" as const],
                },
            ],
        };
        const recentMessages = Array.from({ length: 10 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: String(index).repeat(1200), sequence: index + 1 }));
        const assets = Array.from({ length: 9 }, (_, index) => ({ id: `asset-${index}`, type: "text", title: `素材 ${index}`, textContent: "素材正文".repeat(500), metadata: {} }));
        const input = agentPlannerInput(
            { surface: "canvas", prompt: "生成商品图", snapshot: { selectedNodeIds: [], nodes: [], connections: [] }, selectedSkillIds: ["skill-one"] } as never,
            { summary: "长期摘要".repeat(2000), summaryThroughSequence: 0, recentMessages } as never,
            assets as never,
            "conversation-memory-candidates",
            settings.agentSkills,
            [{ id: "image", name: "图片", capability: "image" }],
            settings,
        ) as Record<string, unknown>;
        const context = input.conversationContext as { summary: string; recentMessages: Array<{ content: string; sequence: number }> };
        const skill = (input.availableSkills as Array<Record<string, unknown>>)[0];

        expect(context.summary).toBe("长期摘要".repeat(2000));
        expect(context.recentMessages).toEqual(recentMessages);
        expect(context.recentMessages.at(-1)?.sequence).toBe(10);
        expect(input.referencedAssets).toEqual(assets.map((asset) => expect.objectContaining({ id: asset.id, textContent: asset.textContent })));
        expect(skill.plannerSummary).toBe("精简规划说明".repeat(40));
        expect(skill).not.toHaveProperty("instructions");
        expect(JSON.stringify(input).length).toBeGreaterThan(12_000);
        expect(input).not.toHaveProperty("planningBudget");
    });

    it("keeps the complete capability-filtered model catalog without fixed truncation", () => {
        const tailModelId = `tail-${"x".repeat(60)}`;
        const models = Array.from({ length: 300 }, (_, index) => ({ id: index === 299 ? tailModelId : `model-${index}-${"x".repeat(60)}`, name: `模型 ${index} ${"名称".repeat(120)}`, capability: "image" }));
        const settings = { ...DEFAULT_SETTINGS, defaultModels: { ...DEFAULT_SETTINGS.defaultModels, imageModel: tailModelId } };

        const { input, summary } = buildAgentPlannerInput(
            { surface: "chat", prompt: "生成一张商品图", referencedAssetIds: [], selectedSkillIds: [], requestedModelIds: [], assetIds: [], status: "planning", tasks: [] } as never,
            { summary: "", summaryThroughSequence: 0, recentMessages: [] } as never,
            [],
            "none",
            [],
            models,
            settings,
        );
        const keptIds = (input.availableModels as Array<{ id: string }>).map((model) => model.id);

        expect(keptIds[0]).toBe(tailModelId);
        expect(keptIds).toHaveLength(models.length);
        expect(summary.kept.modelIds).toEqual(keptIds);
        expect(summary.omitted.modelIds).toEqual([]);
        expect(summary.serializedChars).toBe(JSON.stringify(input).length);
        expect(summary).not.toHaveProperty("maxInputChars");
    });

    it("keeps all current-turn and memory candidate assets without a platform character budget", () => {
        const assets = Array.from({ length: 40 }, (_, index) => ({
            id: `asset-${index}`,
            type: "image",
            title: `素材 ${index} ${"标题".repeat(80)}`,
            textContent: "素材正文".repeat(200),
            remoteUrl: `https://cdn.example.com/${index}/${"path".repeat(40)}.png`,
            metadata: {},
        }));
        const run = { surface: "chat", prompt: "根据参考图生成商品海报", referencedAssetIds: assets.map((asset) => asset.id), selectedSkillIds: [], assetIds: [], status: "planning", tasks: [] } as never;
        const common = [{ id: "image", name: "图片", capability: "image" }];
        const explicit = buildAgentPlannerInput(run, { summary: "", summaryThroughSequence: 0, recentMessages: [] } as never, assets as never, "current-turn-explicit", [], common, DEFAULT_SETTINGS);
        const memory = buildAgentPlannerInput(run, { summary: "", summaryThroughSequence: 0, recentMessages: [] } as never, assets as never, "conversation-memory-candidates", [], common, DEFAULT_SETTINGS);

        expect(explicit.summary.kept.assetIds).toEqual(assets.map((asset) => asset.id));
        expect(memory.summary.kept.assetIds).toEqual(assets.map((asset) => asset.id));
        expect(memory.summary.omitted.assetIds).toEqual([]);
        expect((memory.input.referencedAssets as Array<{ textContent: string }>).every((asset) => asset.textContent === "素材正文".repeat(200))).toBe(true);
    });

    it("maps current-turn aliases by the stable requested asset order", () => {
        const assets = [
            { id: "second", type: "image", title: "第二张", metadata: {} },
            { id: "first", type: "image", title: "第一张", metadata: {} },
        ];
        const input = agentPlannerInput(
            { surface: "chat", prompt: "@图片1 保持人物，@图片2 改成夜景", referencedAssetIds: ["first", "second"], selectedSkillIds: [] } as never,
            { summary: "", summaryThroughSequence: 0, recentMessages: [] } as never,
            assets as never,
            "current-turn-explicit",
            [],
            [{ id: "image", name: "图片", capability: "image" }],
            DEFAULT_SETTINGS,
        ) as { referencedAssets: Array<{ id: string; alias: string }> };

        expect(input.referencedAssets).toEqual([expect.objectContaining({ id: "first", alias: "@图片1" }), expect.objectContaining({ id: "second", alias: "@图片2" })]);
    });

    it("classifies planning complexity without adding input or output limits", () => {
        const multi = resolveAgentPlanningProfile({ surface: "chat", prompt: "生成四张角色图" });
        const complex = resolveAgentPlanningProfile({ surface: "drama", prompt: "继续当前项目" });
        const complexCanvas = resolveAgentPlanningProfile({
            surface: "canvas",
            prompt: "整理当前选择",
            snapshot: {
                canvasSnapshotVersion: 1,
                projectId: "canvas",
                title: "画布",
                imageSize: "1:1",
                selectedNodeIds: ["selected"],
                nodes: [{ id: "selected", type: "text", title: "选中", metadata: { content: "正文" } }],
                connections: [],
                analysis: { nodeCount: 12, selectedNodeTypes: ["text"] },
            },
        });

        expect(multi).toMatchObject({ complexity: "multi" });
        expect(complex).toMatchObject({ complexity: "complex" });
        expect(complexCanvas).toMatchObject({ complexity: "complex" });
        expect(multi).not.toHaveProperty("maxInputChars");
        expect(multi).not.toHaveProperty("maxOutputTokens");
        expect(complex).not.toHaveProperty("maxInputChars");
        expect(complex).not.toHaveProperty("maxOutputTokens");
    });

    it("keeps every explicit Canvas selection and the complete project snapshot", () => {
        const selectedNodeIds = Array.from({ length: 25 }, (_, index) => `node-${index}`);
        const canvasInput = agentPlannerInput(
            { surface: "canvas", prompt: "整理选中节点", snapshot: { selectedNodeIds, nodes: selectedNodeIds.map((id) => ({ id, type: "text", title: id, metadata: { content: "正文".repeat(400) } })), connections: [] } } as never,
            { summary: "", summaryThroughSequence: 0, recentMessages: [] } as never,
            [],
            "none",
            [],
            [{ id: "text", name: "文本", capability: "text" }],
            DEFAULT_SETTINGS,
        ) as { canvasSnapshot: { selectedNodeIds: string[]; nodes: Array<{ metadata: { content: string } }> } };
        const projectSnapshot = Object.fromEntries(Array.from({ length: 35 }, (_, index) => [`field-${index}`, { nested: [{ content: `完整内容-${index}-${"长文本".repeat(400)}` }] }]));
        const dramaInput = agentPlannerInput(
            { surface: "drama", projectId: "drama-one", prompt: "继续项目", snapshot: projectSnapshot } as never,
            { summary: "", summaryThroughSequence: 0, recentMessages: [] } as never,
            [],
            "none",
            [],
            [{ id: "text", name: "文本", capability: "text" }],
            DEFAULT_SETTINGS,
        ) as { projectSnapshot: typeof projectSnapshot };

        expect(canvasInput.canvasSnapshot.selectedNodeIds).toEqual(selectedNodeIds);
        expect(canvasInput.canvasSnapshot.nodes).toHaveLength(selectedNodeIds.length);
        expect(canvasInput.canvasSnapshot.nodes[0].metadata.content).toBe("正文".repeat(400));
        expect(dramaInput.projectSnapshot).toEqual(projectSnapshot);
    });

    it("prefilters models by request capability while preserving real text planning", () => {
        const models = ["text", "image", "video", "audio"].map((capability) => ({ id: capability, capability }));
        expect(filterAgentPlannerModels(models, { surface: "chat", prompt: "你好，你能做什么" }).map((item) => item.capability)).toEqual(["text"]);
        expect(filterAgentPlannerModels(models, { surface: "chat", prompt: "生成一张商品海报" }).map((item) => item.capability)).toEqual(["text", "image"]);
        expect(filterAgentPlannerModels(models, { surface: "chat", prompt: "让这张图动起来，生成视频" }).map((item) => item.capability)).toEqual(["text", "image", "video"]);
        expect(filterAgentPlannerModels(models, { surface: "chat", prompt: "做一个作品", generationPreferences: { mode: "audio" } }).map((item) => item.capability)).toEqual(["text", "audio"]);
    });

    it("only exposes explicitly selected Skills to the planner", () => {
        expect(plannerAgentSkills(DEFAULT_SETTINGS, { surface: "chat", selectedSkillIds: [] })).toEqual([]);
        expect(plannerAgentSkills(DEFAULT_SETTINGS, { surface: "chat", selectedSkillIds: ["image-motion"] }).map((skill) => skill.id)).toEqual(["image-motion"]);
        expect(plannerAgentSkills(DEFAULT_SETTINGS, { surface: "chat", selectedSkillIds: ["image-motion", "character-design"] }).map((skill) => skill.id)).toEqual(["image-motion", "character-design"]);
    });
});
