import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dataDir = resolve(tmpdir(), `vozeb-pro-user-media-delete-${process.pid}-${Date.now()}`);
const previousDataDir = process.env.VOZEB_PRO_DATA_DIR;
const previousProvider = process.env.VOZEB_PRO_DATABASE_PROVIDER;
const mocks = vi.hoisted(() => ({ deleteExternalMediaObject: vi.fn() }));

vi.mock("@/lib/server/object-storage-service", () => ({ deleteExternalMediaObject: mocks.deleteExternalMediaObject }));

describe("user media cascade deletion", () => {
    beforeAll(async () => {
        process.env.VOZEB_PRO_DATA_DIR = dataDir;
        process.env.VOZEB_PRO_DATABASE_PROVIDER = "file";
        await mkdir(dataDir, { recursive: true });
        vi.resetModules();
    });

    beforeEach(() => {
        mocks.deleteExternalMediaObject.mockReset().mockResolvedValue(true);
    });

    afterAll(async () => {
        if (previousDataDir === undefined) delete process.env.VOZEB_PRO_DATA_DIR;
        else process.env.VOZEB_PRO_DATA_DIR = previousDataDir;
        if (previousProvider === undefined) delete process.env.VOZEB_PRO_DATABASE_PROVIDER;
        else process.env.VOZEB_PRO_DATABASE_PROVIDER = previousProvider;
        await rm(dataDir, { recursive: true, force: true });
    });

    it("removes every file-provider reference before deleting the OSS object", async () => {
        const storageKey = "permanent/2026/08/21/images/shared.png";
        const mediaUrl = `/api/reference-assets/${storageKey}`;
        await seedFiles(storageKey, mediaUrl);
        const { deleteUserMediaAssetsCascade } = await import("./user-media-deletion-service");

        const result = await deleteUserMediaAssetsCascade("user-one", [storageKey]);

        expect(result).toMatchObject({ deletedFiles: 1, deletedBytes: 12, blocked: [] });
        expect(result.removedReferences).toBeGreaterThanOrEqual(7);
        expect(mocks.deleteExternalMediaObject).toHaveBeenCalledWith(expect.objectContaining({ storageKey, ownerUserId: "user-one", storageProvider: "object", externalObjectKey: `vozeb-pro/media/reference/${storageKey}` }));

        const files = await Promise.all(["auth.json", "canvas-projects.json", "creative-runtime.json", "drama-projects.json", "generation-logs.json", "generation-tasks.json", "library-assets.json", "local-media-assets.json"].map(readJson));
        expect(JSON.stringify(files)).not.toContain(storageKey);
        expect(files[1]).toMatchObject({ projects: [{ project: { backgroundMode: "lines", nodes: [{ id: "text-one" }], connections: [] } }] });
    });

    it("preserves another user's references and blocks OSS deletion", async () => {
        const storageKey = "permanent/2026/08/21/images/shared-across-users.png";
        const mediaUrl = `/api/reference-assets/${storageKey}`;
        await seedFiles(storageKey, mediaUrl);
        await seedSecondUserReferences(storageKey, mediaUrl);
        const { deleteUserMediaAssetsCascade } = await import("./user-media-deletion-service");

        const result = await deleteUserMediaAssetsCascade("user-one", [storageKey]);

        expect(result.deletedFiles).toBe(0);
        expect(result.blocked).toEqual([expect.objectContaining({ storageKey, referenceCount: expect.any(Number) })]);
        expect(mocks.deleteExternalMediaObject).not.toHaveBeenCalled();
        const auth = (await readJson("auth.json")) as { users: Array<{ id: string; avatarStorageKey?: string }> };
        const canvas = (await readJson("canvas-projects.json")) as { projects: Array<{ userId: string; project: unknown }> };
        expect(auth.users.find((user) => user.id === "user-one")?.avatarStorageKey).toBeUndefined();
        expect(auth.users.find((user) => user.id === "user-two")?.avatarStorageKey).toBe(storageKey);
        expect(JSON.stringify(canvas.projects.find((record) => record.userId === "user-one"))).not.toContain(storageKey);
        expect(JSON.stringify(canvas.projects.find((record) => record.userId === "user-two"))).toContain(storageKey);
    });
});

async function seedSecondUserReferences(storageKey: string, mediaUrl: string) {
    const auth = (await readJson("auth.json")) as { users: Array<Record<string, unknown>> };
    auth.users.push({ id: "user-two", avatarStorageKey: storageKey });
    await writeJson("auth.json", auth);

    const canvas = (await readJson("canvas-projects.json")) as { projects: Array<Record<string, unknown>> };
    canvas.projects.push({
        userId: "user-two",
        project: {
            id: "canvas-two",
            nodes: [{ id: "image-two", type: "image", metadata: { content: mediaUrl, storageKey } }],
            connections: [],
        },
    });
    await writeJson("canvas-projects.json", { version: 1, projects: canvas.projects });
}

async function seedFiles(storageKey: string, mediaUrl: string) {
    const now = "2026-08-21T00:00:00.000Z";
    await Promise.all([
        writeJson("auth.json", { version: 1, users: [{ id: "user-one", avatarStorageKey: storageKey }], sessions: [], settings: {} }),
        writeJson("canvas-projects.json", {
            version: 1,
            projects: [
                {
                    userId: "user-one",
                    project: {
                        id: "canvas-one",
                        title: "画布",
                        createdAt: now,
                        updatedAt: now,
                        nodes: [
                            { id: "image-one", type: "image", title: "图片", position: { x: 0, y: 0 }, width: 320, height: 240, metadata: { content: mediaUrl, storageKey } },
                            { id: "text-one", type: "text", title: "文本", position: { x: 400, y: 0 }, width: 320, height: 160, metadata: { content: "保留" } },
                        ],
                        connections: [{ id: "line-one", fromNodeId: "image-one", toNodeId: "text-one" }],
                        chatSessions: [],
                        activeChatId: null,
                        backgroundMode: "lines",
                        showImageInfo: true,
                        viewport: { x: 0, y: 0, k: 1 },
                    },
                },
            ],
        }),
        writeJson("creative-runtime.json", {
            version: 1,
            nextEventId: 2,
            conversations: [{ id: "conversation-one", userId: "user-one" }],
            messages: [{ id: "message-one", conversationId: "conversation-one", content: "", metadata: { assetIds: ["asset-one"], previewUrl: mediaUrl } }],
            assets: [{ id: "asset-one", userId: "user-one", conversationId: "conversation-one", storageKey, serverUrl: mediaUrl }],
            events: [{ id: 1, runId: "run-one", type: "completed", data: { resultUrl: mediaUrl } }],
        }),
        writeJson("drama-projects.json", { version: 1, projects: [{ userId: "user-one", project: { id: "drama-one", title: "短剧", updatedAt: now, candidates: [{ id: "candidate-one", storageKey, url: mediaUrl }] } }] }),
        writeJson("generation-logs.json", { version: 1, logs: [{ id: "log-one", userId: "user-one", assets: [{ type: "image", url: mediaUrl, serverUrl: mediaUrl }], requestSnapshot: { previewUrl: mediaUrl } }] }),
        writeJson("generation-tasks.json", [{ id: "run-one", userId: "user-one", status: "success", executionPhase: "completed", payload: { referenceUrl: mediaUrl }, resultPayload: { storageKey } }]),
        writeJson("library-assets.json", { version: 1, assets: [{ id: "library-one", userId: "user-one", kind: "image", data: { storageKey, serverUrl: mediaUrl } }] }),
        writeJson("local-media-assets.json", {
            version: 1,
            assets: [
                {
                    storageKey,
                    scope: "reference",
                    storageClass: "permanent",
                    type: "image",
                    ownerUserId: "user-one",
                    source: "user-upload",
                    mimeType: "image/png",
                    bytes: 12,
                    storageProvider: "object",
                    externalStorageId: "default",
                    externalObjectKey: `vozeb-pro/media/reference/${storageKey}`,
                    createdAt: now,
                },
            ],
        }),
    ]);
}

async function writeJson(name: string, value: unknown) {
    await writeFile(resolve(dataDir, name), `${JSON.stringify(value)}\n`, "utf8");
}

async function readJson(name: string) {
    return JSON.parse(await readFile(resolve(dataDir, name), "utf8")) as unknown;
}
