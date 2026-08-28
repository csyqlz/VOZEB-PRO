import { describe, expect, it } from "vitest";

import { estimateTaskPoints, resolveDramaImageModel, resolveDramaVideoModel, shotReferenceImages, storyboardReferenceImages } from "./drama-shot-generation-utils";

describe("storyboardReferenceImages", () => {
    it("marks the storyboard start and end images as explicit video frames", () => {
        const references = storyboardReferenceImages({
            id: "shot-one",
            title: "雨夜相遇",
            storyboardFrameMode: "first_last",
            storyboardImageUrl: "/api/reference-assets/start.png",
            storyboardImageWidth: 1280,
            storyboardImageHeight: 720,
            storyboardEndImageUrl: "/api/reference-assets/end.png",
            storyboardEndImageWidth: 1280,
            storyboardEndImageHeight: 720,
        } as never);

        expect(references).toMatchObject([
            { id: "storyboard-start-shot-one", videoRole: "first_frame", serverUrl: "/api/reference-assets/start.png" },
            { id: "storyboard-end-shot-one", videoRole: "last_frame", serverUrl: "/api/reference-assets/end.png" },
        ]);
    });

    it("keeps storyboard mode as a first-frame-only request", () => {
        const references = storyboardReferenceImages({
            id: "shot-two",
            title: "单帧分镜",
            storyboardFrameMode: "first_frame",
            storyboardImageUrl: "https://cdn.example.com/start.png",
            storyboardEndImageUrl: "https://cdn.example.com/end.png",
        } as never);

        expect(references).toEqual([expect.objectContaining({ id: "storyboard-start-shot-two", videoRole: "first_frame", remoteUrl: "https://cdn.example.com/start.png" })]);
    });

    it("keeps every matching project reference instead of taking the first four", () => {
        const characters = Array.from({ length: 5 }, (_, index) => ({ id: `character-${index}`, name: `角色 ${index}`, references: [{ id: `reference-${index}`, url: `/api/reference-assets/${index}.png` }], primaryReferenceId: `reference-${index}` }));
        const references = shotReferenceImages({ characters, scenes: [], props: [], sourceAssets: [] } as never, { characterIds: characters.map((item) => item.id), propIds: [] } as never);

        expect(references).toHaveLength(5);
        expect(references.at(-1)).toMatchObject({ id: "character-4", serverUrl: "/api/reference-assets/4.png" });
    });
});

describe("drama video model routing", () => {
    const config = {
        model: "image-model",
        videoModel: "video-default",
        videoModels: ["video-default", "video-project", "video-shot", "video-attempt"],
        modelPointCosts: { "video-default": 3, "video-project": 5, "video-shot": 7, "video-attempt": 11 },
        vquality: "720P",
        videoSeconds: "5",
        generationPointMultipliers: { imageQuality: {}, videoQuality: { "720P": 2 }, videoSeconds: { "5": 1, "10": 3 } },
    };

    it("resolves shot override, retry attempt, project default and configured video default in order", () => {
        const project = { videoModel: "video-project" } as never;

        expect(resolveDramaVideoModel(config as never, project, { videoModel: "video-shot", generationModel: "video-attempt" } as never)).toBe("video-shot");
        expect(resolveDramaVideoModel(config as never, project, { generationModel: "video-attempt" } as never)).toBe("video-attempt");
        expect(resolveDramaVideoModel(config as never, project)).toBe("video-project");
        expect(resolveDramaVideoModel(config as never, {} as never)).toBe("video-default");
    });

    it("blocks removed video models instead of falling back to a generic model", () => {
        expect(resolveDramaVideoModel(config as never, { videoModel: "removed-video" } as never)).toBe("");
        expect(resolveDramaVideoModel({ ...config, videoModels: [], videoModel: "" } as never, {} as never)).toBe("");
    });

    it("estimates video points with the resolved attempt model", () => {
        expect(estimateTaskPoints(config as never, "video", 10, "video-shot")).toBe(42);
        expect(estimateTaskPoints(config as never, "video", 10, "")).toBe(0);
    });
});

describe("drama image model routing", () => {
    const config = {
        imageModel: "image-default",
        imageModels: ["image-default", "image-project", "image-shot"],
    };

    it("resolves shot override, project selection and configured default", () => {
        expect(resolveDramaImageModel(config as never, { imageModel: "image-project" } as never, { imageModel: "image-shot" } as never)).toBe("image-shot");
        expect(resolveDramaImageModel(config as never, { imageModel: "image-project" } as never)).toBe("image-project");
        expect(resolveDramaImageModel(config as never, {} as never)).toBe("image-default");
    });

    it("blocks removed image models instead of falling back to a generic model", () => {
        expect(resolveDramaImageModel(config as never, { imageModel: "removed-image" } as never)).toBe("");
    });
});
