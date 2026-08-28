import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DramaProject } from "@/lib/drama-project-contract";

const mocks = vi.hoisted(() => ({
    files: new Map<string, unknown>(),
    provider: "file" as "file" | "postgres",
    postgresQuery: vi.fn(),
    withPostgresTransaction: vi.fn(),
}));

vi.mock("@/lib/server/database", () => ({
    ensurePostgresSchema: vi.fn(),
    getDatabaseProvider: vi.fn(() => mocks.provider),
    postgresQuery: mocks.postgresQuery,
    withPostgresTransaction: mocks.withPostgresTransaction,
}));
vi.mock("@/lib/server/data-adapter", () => ({
    readJsonDataFile: vi.fn(async (name: string, fallback: unknown) => structuredClone(mocks.files.has(name) ? mocks.files.get(name) : fallback)),
    writeJsonDataFile: vi.fn(async (name: string, value: unknown) => mocks.files.set(name, structuredClone(value))),
}));

import { createDramaProjectVersion, deleteDramaProjectVersion, getDramaProjectVersion, listDramaProjectVersions } from "./drama-project-version-store";

describe("drama project version file provider", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.files.clear();
        mocks.provider = "file";
    });

    it("increments versions and isolates projects by user", async () => {
        const first = await createDramaProjectVersion("user-one", "project-one", "初稿", project("project-one", "初稿"));
        const second = await createDramaProjectVersion("user-one", "project-one", "调整分镜", project("project-one", "调整"));
        await createDramaProjectVersion("user-two", "project-one", "其他用户", project("project-one", "越权"));

        expect([first.version, second.version]).toEqual([1, 2]);
        expect(await listDramaProjectVersions("user-one", "project-one")).toMatchObject([
            { version: 2, reason: "调整分镜" },
            { version: 1, reason: "初稿" },
        ]);
        expect(await getDramaProjectVersion("user-one", "project-one", second.id)).toMatchObject({ snapshot: { title: "调整" } });
        expect(await getDramaProjectVersion("user-two", "project-one", second.id)).toBeNull();
    });

    it("deletes only the owned project version and never reuses its number", async () => {
        const first = await createDramaProjectVersion("user-one", "project-one", "初稿", project("project-one", "初稿"));
        const second = await createDramaProjectVersion("user-one", "project-one", "调整", project("project-one", "调整"));

        await expect(deleteDramaProjectVersion("user-two", "project-one", second.id)).resolves.toBe(false);
        await expect(deleteDramaProjectVersion("user-one", "project-two", second.id)).resolves.toBe(false);
        await expect(deleteDramaProjectVersion("user-one", "project-one", second.id)).resolves.toBe(true);
        await expect(deleteDramaProjectVersion("user-one", "project-one", second.id)).resolves.toBe(false);
        await expect(listDramaProjectVersions("user-one", "project-one")).resolves.toMatchObject([{ id: first.id, version: 1 }]);

        const third = await createDramaProjectVersion("user-one", "project-one", "再调整", project("project-one", "再调整"));
        expect(third.version).toBe(3);
    });

    it("converges existing history and keeps only the latest three versions", async () => {
        mocks.files.set("drama-project-versions.json", {
            version: 1,
            items: Array.from({ length: 5 }, (_, index) => ({
                id: `version-${index + 1}`,
                userId: "user-one",
                projectId: "project-one",
                version: index + 1,
                reason: `版本 ${index + 1}`,
                snapshot: project("project-one", `版本 ${index + 1}`),
                createdAt: new Date(2026, 7, index + 1).toISOString(),
            })),
        });

        await expect(listDramaProjectVersions("user-one", "project-one")).resolves.toMatchObject([{ version: 5 }, { version: 4 }, { version: 3 }]);
        const stored = mocks.files.get("drama-project-versions.json") as { items: Array<{ userId: string; projectId: string; version: number }> };
        expect(stored.items.filter((item) => item.userId === "user-one" && item.projectId === "project-one").map((item) => item.version)).toEqual([3, 4, 5]);

        const next = await createDramaProjectVersion("user-one", "project-one", "新版本", project("project-one", "新版本"));
        expect(next.version).toBe(6);
        await expect(listDramaProjectVersions("user-one", "project-one")).resolves.toMatchObject([{ version: 6 }, { version: 5 }, { version: 4 }]);
    });
});

describe("drama project version postgres provider", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.provider = "postgres";
    });

    it("uses the allocated sequence after a deleted highest version", async () => {
        const query = vi
            .fn()
            .mockResolvedValueOnce({ rows: [{ version_sequence: 4 }] })
            .mockResolvedValueOnce({ rows: [{ max_version: 2 }] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] });
        mocks.withPostgresTransaction.mockImplementationOnce(async (callback: (client: { query: typeof query }) => Promise<unknown>) => callback({ query }));

        const created = await createDramaProjectVersion("user-one", "project-one", "继续编辑", project("project-one", "继续编辑"));

        expect(created.version).toBe(5);
        expect(query.mock.calls[2]).toEqual([expect.stringContaining("UPDATE drama_projects SET version_sequence = $3"), ["project-one", "user-one", 5]]);
        expect(query.mock.calls[4]).toEqual([expect.stringContaining("ORDER BY version DESC"), ["user-one", "project-one", 3]]);
    });

    it("prunes the scoped history before returning a three-row list", async () => {
        mocks.postgresQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
            rows: [
                { id: "version-five", projectId: "project-one", version: 5, reason: "版本 5", createdAt: "2026-08-05T00:00:00.000Z" },
                { id: "version-four", projectId: "project-one", version: 4, reason: "版本 4", createdAt: "2026-08-04T00:00:00.000Z" },
                { id: "version-three", projectId: "project-one", version: 3, reason: "版本 3", createdAt: "2026-08-03T00:00:00.000Z" },
            ],
        });

        await expect(listDramaProjectVersions("user-one", "project-one")).resolves.toMatchObject([{ version: 5 }, { version: 4 }, { version: 3 }]);
        expect(mocks.postgresQuery).toHaveBeenNthCalledWith(1, expect.stringContaining("id NOT IN"), ["user-one", "project-one", 3]);
        expect(mocks.postgresQuery).toHaveBeenNthCalledWith(2, expect.stringContaining("ORDER BY version DESC LIMIT $3"), ["user-one", "project-one", 3]);
    });

    it("deletes by version, user and project and reports repeated deletion", async () => {
        mocks.postgresQuery.mockResolvedValueOnce({ rows: [{ id: "version-one" }] }).mockResolvedValueOnce({ rows: [] });

        await expect(deleteDramaProjectVersion("user-one", "project-one", "version-one")).resolves.toBe(true);
        await expect(deleteDramaProjectVersion("user-one", "project-one", "version-one")).resolves.toBe(false);
        expect(mocks.postgresQuery).toHaveBeenNthCalledWith(1, expect.stringContaining("WHERE id = $1 AND user_id = $2 AND project_id = $3 RETURNING id"), ["version-one", "user-one", "project-one"]);
    });
});

function project(id: string, title: string): DramaProject {
    const now = new Date().toISOString();
    return {
        id,
        title,
        summary: "",
        style: "电影感",
        ratio: "9:16",
        status: "active",
        activeEpisodeId: "episode-one",
        characters: [],
        scenes: [],
        props: [],
        clues: [],
        defaultVideoMode: "storyboard",
        episodes: [{ id: "episode-one", title: "第 1 集", script: "", outline: "", hook: "", nextPreview: "", sourceRange: "", reviewStatus: "draft", shots: [] }],
        createdAt: now,
        updatedAt: now,
    };
}
