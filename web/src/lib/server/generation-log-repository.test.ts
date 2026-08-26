import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    fetchSafeOutbound: vi.fn(),
    persistExternalMediaIfEnabled: vi.fn(),
}));

vi.mock("@/lib/server/safe-outbound-fetch", () => ({ fetchSafeOutbound: mocks.fetchSafeOutbound }));
vi.mock("@/lib/server/security", () => ({ isSafeOutboundUrl: vi.fn(() => true) }));
vi.mock("@/lib/server/object-storage-service", () => ({ deleteExternalMediaObject: vi.fn(), persistExternalMediaIfEnabled: mocks.persistExternalMediaIfEnabled }));

import { normalizeStoredLog, readPostgresGenerationLogDb, writeRemoteAsset } from "./generation-log-repository";

const PNG_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+4q2JAAAAAElFTkSuQmCC", "base64");

function storedLogWithAssets(count: number) {
    return normalizeStoredLog({
        id: "image-workbench:batch",
        userId: "user-1",
        username: "user",
        displayName: "User",
        kind: "image",
        source: "image-workbench",
        status: "success",
        title: "Batch",
        prompt: "Prompt",
        model: "image-model",
        summary: "Done",
        durationMs: 100,
        count,
        successCount: count,
        failCount: 0,
        assets: Array.from({ length: count }, (_, index) => ({ type: "image" as const, url: `/api/generation-log-assets/result-${index}.png` })),
        createdAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-07-28T00:00:00.000Z",
    });
}

describe("generation log asset normalization", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.persistExternalMediaIfEnabled.mockResolvedValue({ storageKey: "permanent/result.png" });
    });

    it("accepts a real image when the upstream declares a generic content type", async () => {
        mocks.fetchSafeOutbound.mockResolvedValue(new Response(PNG_BYTES, { headers: { "content-type": "application/octet-stream" } }));

        const asset = await writeRemoteAsset("https://cdn.example.com/result", "image", { ownerUserId: "user-1", source: "canvas" });

        expect(asset).toMatchObject({ mimeType: "image/png", type: "image" });
        expect(mocks.fetchSafeOutbound).toHaveBeenCalledWith("https://cdn.example.com/result", expect.objectContaining({ redirect: "follow" }));
    });

    it("does not persist non-image bytes hidden behind an image task URL", async () => {
        mocks.fetchSafeOutbound.mockResolvedValue(new Response("<html>not an image</html>", { headers: { "content-type": "text/plain" } }));

        await expect(writeRemoteAsset("https://cdn.example.com/result", "image", { ownerUserId: "user-1", source: "drama" })).resolves.toBeNull();
        expect(mocks.persistExternalMediaIfEnabled).not.toHaveBeenCalled();
    });

    it("keeps all eight successful images in a workbench batch", () => {
        expect(storedLogWithAssets(8).assets).toHaveLength(8);
    });

    it("retains every successful asset in a large provider batch", () => {
        expect(storedLogWithAssets(205).assets).toHaveLength(205);
    });

    it("persists the public user prompt separately from task prompts", () => {
        const log = normalizeStoredLog({
            ...storedLogWithAssets(1),
            prompt: "内部执行提示词",
            requestSnapshot: {
                version: 1,
                userPrompt: "用户原始需求",
                parameters: {},
                references: [],
                slots: [{ id: "slot-1", index: 0, status: "pending", prompt: "内部执行提示词", clientRequestId: "image-workbench:conversation:slot-1", canRetry: true }],
            },
        });

        expect(log.prompt).toBe("内部执行提示词");
        expect(log.requestSnapshot).toMatchObject({ userPrompt: "用户原始需求", slots: [{ prompt: "内部执行提示词", clientRequestId: "image-workbench:conversation:slot-1", canRetry: true }] });
    });

    it("preserves long public and execution prompts at the generation contract lengths", () => {
        const publicPrompt = "原".repeat(4000);
        const executionPrompt = "执".repeat(5000);
        const log = normalizeStoredLog({
            ...storedLogWithAssets(1),
            prompt: executionPrompt,
            requestSnapshot: {
                version: 1,
                userPrompt: publicPrompt,
                parameters: {},
                references: [],
                slots: [{ id: "slot-1", index: 0, status: "pending", prompt: executionPrompt, clientRequestId: "request-slot-1" }],
            },
        });

        expect(log.prompt).toBe(executionPrompt);
        expect(log.requestSnapshot?.userPrompt).toBe(publicPrompt);
        expect(log.requestSnapshot?.slots[0]?.prompt).toBe(executionPrompt);
    });

    it("keeps every explicit reference in the request snapshot", () => {
        const references = Array.from({ length: 40 }, (_, index) => ({
            id: `reference-${index}`,
            kind: "image" as const,
            name: `reference-${index}.png`,
            mimeType: "image/png",
            url: `/api/reference-assets/reference-${index}.png`,
        }));
        const log = normalizeStoredLog({
            ...storedLogWithAssets(1),
            requestSnapshot: { version: 1, userPrompt: "生成组合图", parameters: {}, references, slots: [] },
        });

        expect(log.requestSnapshot?.references).toHaveLength(40);
    });

    it("exports the complete PostgreSQL generation log snapshot", async () => {
        const query = vi.fn().mockResolvedValue({ rows: [] });

        await readPostgresGenerationLogDb({ query } as never);

        expect(query).toHaveBeenNthCalledWith(1, "SELECT * FROM generation_logs ORDER BY created_at DESC");
        expect(String(query.mock.calls[0]?.[0])).not.toContain("LIMIT");
    });
});
