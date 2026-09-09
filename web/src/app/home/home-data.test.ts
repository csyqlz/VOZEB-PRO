import { describe, expect, it } from "vitest";

import { resolveHomeAgentAvailability, resolveHomeCreationModes } from "./home-data";

describe("home creation capability visibility", () => {
    it("only exposes enabled logical media capabilities", () => {
        expect(
            resolveHomeCreationModes({
                logicalModels: [
                    { id: "image", name: "Image", capability: "image", enabled: true, bindings: [{ id: "image-binding", channelId: "image-channel", upstreamModel: "image", enabled: true, priority: 1 }] },
                    { id: "audio", name: "Audio", capability: "audio", enabled: true, bindings: [{ id: "audio-binding", channelId: "audio-channel", upstreamModel: "audio", enabled: false, priority: 1 }] },
                    { id: "video", name: "Video", capability: "video", enabled: false, bindings: [{ id: "video-binding", channelId: "video-channel", upstreamModel: "video", enabled: true, priority: 1 }] },
                ],
                defaultModels: { imageModel: "image", videoModel: "video", textModel: "text", audioModel: "audio" },
            }),
        ).toEqual(["image"]);
    });

    it("uses configured defaults for installations without a logical catalog", () => {
        expect(resolveHomeCreationModes({ logicalModels: [], defaultModels: { imageModel: "image", videoModel: "", textModel: "text", audioModel: "" } })).toEqual(["image"]);
    });

    it("only exposes intelligent mode when a text model is configured", () => {
        expect(resolveHomeAgentAvailability({ logicalModels: [], defaultModels: { imageModel: "image", videoModel: "video", textModel: "", audioModel: "" } })).toBe(false);
        expect(
            resolveHomeAgentAvailability({
                logicalModels: [{ id: "writer", name: "Writer", capability: "text", enabled: true, bindings: [{ id: "binding", channelId: "channel", upstreamModel: "writer", enabled: true, priority: 1 }] }],
                defaultModels: { imageModel: "", videoModel: "", textModel: "", audioModel: "" },
            }),
        ).toBe(true);
        expect(
            resolveHomeAgentAvailability({
                logicalModels: [{ id: "image", name: "Image", capability: "image", enabled: true, bindings: [{ id: "binding", channelId: "channel", upstreamModel: "image", enabled: true, priority: 1 }] }],
                defaultModels: { imageModel: "image", videoModel: "", textModel: "stale-text", audioModel: "" },
            }),
        ).toBe(false);
    });
});
