import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ record: vi.fn() }));

vi.mock("@/lib/server/generation-log-task-service", () => ({ recordGenerationTaskLogResult: mocks.record }));

import { emptyAdvancedConfig } from "@/lib/channel-protocol-registry";
import type { ImageTask } from "@/lib/server/image-task-store";
import { writeImageGenerationLog } from "./image-task-runner";

describe("writeImageGenerationLog", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.record.mockResolvedValue({});
    });

    it("reuses the saved native ecommerce file without secondary size normalization", async () => {
        const task = imageTask();
        task.ecommerceExecution = {
            state: "ready",
            compilerVersion: "ecommerce-openai-image-2.5.v1",
            providerProfileId: "gpt-image-2.5-flare",
            prompt: "preserve",
            referenceRoles: [],
            parameters: { variant: "gpt-image-2.5-flare", size: "3840x2160" },
            canvas: { mode: "exact", size: { width: 3840, height: 2160 }, source: "user_text", allowReframe: false },
            modelSnapshot: { logicalRole: "image_generation", capability: "image", logicalModelId: "image", channelId: "fixture", upstreamModel: "gpt-image-2.5-flare", apiFormat: "openai" },
        };
        await writeImageGenerationLog(task, "success", [{ dataUrl: "/api/generation-log-assets/native.png", remoteUrl: "https://upstream.fixture/native.png", width: 2880, height: 2880 }], 10);
        const asset = mocks.record.mock.calls[0][0].assets[0];
        expect(asset).not.toHaveProperty("targetSize");
        expect(asset).toMatchObject({ url: "/api/generation-log-assets/native.png", width: 2880, height: 2880 });
    });

    it("does not resample validated layer assets", async () => {
        await writeImageGenerationLog(imageTask({ outputMode: "layers" }), "success", [{ dataUrl: "data:image/png;base64,AA==" }], 10);

        const asset = mocks.record.mock.calls[0][0].assets[0];
        expect(asset).not.toHaveProperty("targetSize");
    });

    it("keeps target-size normalization for ordinary image tasks", async () => {
        await writeImageGenerationLog(imageTask(), "success", [{ dataUrl: "data:image/png;base64,AA==" }], 10);

        expect(mocks.record.mock.calls[0][0].assets[0]).toMatchObject({ targetSize: "1024x1024" });
    });

    it("preserves native custom Gemini image sizes when recording the result", async () => {
        const task = imageTask({ model: "gemini-3.1-flash-image", size: "16:9", quality: "4k", advancedConfig: { ...emptyAdvancedConfig(), protocol: "custom" } });
        await writeImageGenerationLog(task, "success", [{ dataUrl: "/api/generation-log-assets/result.png", width: 4096, height: 2304 }], 10);

        expect(mocks.record.mock.calls[0][0].assets[0]).not.toHaveProperty("targetSize");
        expect(mocks.record.mock.calls[0][0].assets[0]).toMatchObject({ width: 4096, height: 2304 });
    });

    it("keeps exact custom dimensions for custom Gemini image results", async () => {
        const task = imageTask({ model: "gemini-3.1-flash-image", size: "768x512", quality: "4k", advancedConfig: { ...emptyAdvancedConfig(), protocol: "custom" } });
        await writeImageGenerationLog(task, "success", [{ dataUrl: "data:image/png;base64,AA==" }], 10);

        expect(mocks.record.mock.calls[0][0].assets[0]).toMatchObject({ targetSize: "768x512" });
    });

    it("preserves validated media metadata in the generation log", async () => {
        await writeImageGenerationLog(imageTask(), "success", [{ dataUrl: "/api/generation-log-assets/result.png", width: 64, height: 64, bytes: 128, mimeType: "image/png" }], 10);

        expect(mocks.record.mock.calls[0][0].assets[0]).toMatchObject({ width: 64, height: 64, bytes: 128, mimeType: "image/png" });
    });
});

function imageTask(config: Partial<ImageTask["config"]> = {}): ImageTask {
    return {
        id: "image-one",
        userId: "user-one",
        username: "user",
        displayName: "User",
        kind: "edit",
        source: "canvas",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
        config: {
            baseUrl: "https://provider.example",
            apiKey: "key",
            apiFormat: "openai",
            model: "image-one",
            size: "1024x1024",
            advancedConfig: { ...emptyAdvancedConfig(), protocol: "openai" },
            ...config,
        },
        prompt: "test",
        references: [],
    };
}
