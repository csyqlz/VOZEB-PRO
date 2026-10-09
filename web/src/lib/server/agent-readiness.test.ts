import { describe, expect, it } from "vitest";
import { buildAgentReadiness } from "./agent-readiness";

describe("buildAgentReadiness", () => {
    it("requires every default model to belong to an enabled channel", () => {
        const settings = {
            defaultModels: { textModel: "t", imageModel: "i", videoModel: "v", audioModel: "a" },
            logicalModels: [],
            systemChannels: [
                {
                    id: "one",
                    name: "主渠道",
                    enabled: true,
                    baseUrl: "https://api.example.com/v1",
                    apiKey: "test",
                    models: ["t", "i", "v", "a"],
                    advancedConfig: { modelCapabilities: { t: "text", i: "image", v: "video", a: "audio" } },
                },
            ],
            agentSkills: [{ enabled: true, workspaces: ["image", "canvas"] }],
            generationDefaults: {},
            generationConcurrency: {},
        } as never;
        const result = buildAgentReadiness(settings);
        expect(result.ready).toBe(true);
        expect(result.skills).toEqual({ image: 1, video: 0, canvas: 1, drama: 0 });
        expect(result.diagnostics.summary).toBe("模型配置已就绪");
        expect(result.capabilities.find((item) => item.type === "text")?.checks.map((item) => item.key)).toContain("api-key");
    });

    it("reports missing or disabled model channels", () => {
        const settings = {
            defaultModels: { textModel: "t", imageModel: "", videoModel: "v", audioModel: "a" },
            logicalModels: [],
            systemChannels: [{ id: "one", name: "停用", enabled: false, baseUrl: "https://api.example.com/v1", apiKey: "test", models: ["t", "v", "a"] }],
            agentSkills: [],
            generationDefaults: {},
            generationConcurrency: {},
        } as never;
        const result = buildAgentReadiness(settings);
        expect(result.ready).toBe(false);
        expect(result.capabilities.filter((item) => !item.ready)).toHaveLength(4);
        expect(result.diagnostics.blockingIssues).toEqual(expect.arrayContaining(["图片：未设置默认模型", "文本：没有可用渠道"]));
    });

    it("accepts equivalent models prefixes and casing", () => {
        const settings = {
            defaultModels: { textModel: "text-v1", imageModel: "", videoModel: "", audioModel: "" },
            logicalModels: [],
            systemChannels: [{ id: "one", name: "主渠道", enabled: true, baseUrl: "https://api.example.com/v1", apiKey: "test", models: ["models/TEXT-V1"] }],
            agentSkills: [],
            generationDefaults: {},
            generationConcurrency: {},
        } as never;
        expect(buildAgentReadiness(settings).capabilities.find((item) => item.type === "text")?.ready).toBe(true);
    });

    it("warns when image defaults may exceed common upstream limits", () => {
        const settings = {
            defaultModels: { textModel: "", imageModel: "image-v1", videoModel: "", audioModel: "" },
            logicalModels: [],
            systemChannels: [{ id: "one", name: "主渠道", enabled: true, baseUrl: "https://api.example.com/v1", apiKey: "test", models: ["image-v1"], advancedConfig: { modelCapabilities: { "image-v1": "image" } } }],
            agentSkills: [],
            generationDefaults: { imageSize: "4096x4096" },
            generationConcurrency: {},
        } as never;
        const image = buildAgentReadiness(settings).capabilities.find((item) => item.type === "image");
        expect(image?.ready).toBe(true);
        expect(image?.checks.find((item) => item.key === "generation-defaults")).toMatchObject({ status: "warn", message: expect.stringContaining("1024x1024") });
    });

    it("does not block MVP readiness when video and audio are not enabled", () => {
        const settings = {
            defaultModels: { textModel: "text-v1", imageModel: "image-v1", videoModel: "", audioModel: "" },
            logicalModels: [],
            systemChannels: [
                {
                    id: "one",
                    name: "主渠道",
                    enabled: true,
                    baseUrl: "https://api.example.com/v1",
                    apiKey: "test",
                    models: ["text-v1", "image-v1"],
                    advancedConfig: { modelCapabilities: { "text-v1": "text", "image-v1": "image" } },
                },
            ],
            agentSkills: [],
            generationDefaults: { imageSize: "1024x1024" },
            generationConcurrency: {},
        } as never;
        const result = buildAgentReadiness(settings);
        const video = result.capabilities.find((item) => item.type === "video");
        const audio = result.capabilities.find((item) => item.type === "audio");
        expect(result.ready).toBe(true);
        expect(result.diagnostics.blockingIssues).toEqual([]);
        expect(result.diagnostics.summary).toContain("建议项");
        expect(video).toMatchObject({ ready: true, configured: false, message: "当前 MVP 未启用" });
        expect(audio).toMatchObject({ ready: true, configured: false, message: "当前 MVP 未启用" });
    });
});
