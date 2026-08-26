import { describe, expect, it } from "vitest";

import { creativeAgentModelCapabilities, groupCreativeAgentModels, resolveCreativeAgentModelCapabilities, type CreativeAgentModelOption } from "./creative-agent-controls";

describe("creative agent model categories", () => {
    it("keeps all selectable categories in a stable order and groups available models", () => {
        const models: CreativeAgentModelOption[] = [
            { id: "text-one", name: "文本一", capability: "text" },
            { id: "video-one", name: "视频一", capability: "video" },
            { id: "image-one", name: "图片一", capability: "image" },
            { id: "video-two", name: "视频二", capability: "video" },
        ];

        expect(creativeAgentModelCapabilities).toEqual(["text", "image", "video", "audio"]);
        expect(groupCreativeAgentModels(models)).toEqual({ text: [models[0]], image: [models[2]], video: [models[1], models[3]], audio: [] });
    });

    it("limits workbench model categories while keeping the shared default", () => {
        const availableModels: CreativeAgentModelOption[] = [
            { id: "text-one", name: "文本一", capability: "text" },
            { id: "image-one", name: "图片一", capability: "image" },
            { id: "video-one", name: "视频一", capability: "video" },
        ];
        expect(resolveCreativeAgentModelCapabilities(["image"])).toEqual(["image"]);
        expect(resolveCreativeAgentModelCapabilities(["video"])).toEqual(["video"]);
        expect(resolveCreativeAgentModelCapabilities(["video", "audio"])).toEqual(["video", "audio"]);
        expect(resolveCreativeAgentModelCapabilities([])).toEqual(["text", "image", "video", "audio"]);
        expect(resolveCreativeAgentModelCapabilities()).toEqual(["text", "image", "video", "audio"]);
        expect(resolveCreativeAgentModelCapabilities(undefined, availableModels)).toEqual(["text", "image", "video"]);
    });
});
