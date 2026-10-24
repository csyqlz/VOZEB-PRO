import { beforeEach, describe, expect, it, vi } from "vitest";

const memory = vi.hoisted(() => ({ value: undefined as unknown }));

vi.mock("@/lib/server/database", () => ({
    ensurePostgresSchema: vi.fn(),
    isPostgresDatabaseEnabled: vi.fn(() => false),
    postgresQuery: vi.fn(),
    withPostgresTransaction: vi.fn(),
}));

vi.mock("@/lib/server/data-adapter", () => ({
    withJsonDataFileLock: async (_file: string, action: () => Promise<unknown>) => action(),
    readJsonDataFile: vi.fn(async (_fileName: string, fallback: unknown) => memory.value ?? fallback),
    writeJsonDataFile: vi.fn(),
}));

import { listAnnouncementsPage } from "./store";

const baseAnnouncement = {
    title: "公告",
    content: "内容",
    enabled: true,
    popupHome: false,
    popupAfterLogin: false,
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
};

describe("file announcement pagination", () => {
    beforeEach(() => {
        memory.value = {
            announcements: [
                { ...baseAnnouncement, id: "notice-a" },
                { ...baseAnnouncement, id: "notice-b" },
                { ...baseAnnouncement, id: "notice-old", createdAt: "2026-07-26T00:00:00.000Z" },
                { ...baseAnnouncement, id: "notice-disabled", enabled: false },
                { ...baseAnnouncement, id: "notice-future", startsAt: "2099-01-01T00:00:00.000Z" },
            ],
        };
    });

    it("uses the same visibility, stable ordering and page limits as PostgreSQL", async () => {
        const firstPage = await listAnnouncementsPage(false, { page: 1, pageSize: 2 });
        const secondPage = await listAnnouncementsPage(false, { page: 2, pageSize: 2 });

        expect(firstPage).toMatchObject({ total: 3, page: 1, pageSize: 2 });
        expect(firstPage.items.map((item) => item.id)).toEqual(["notice-b", "notice-a"]);
        expect(secondPage.items.map((item) => item.id)).toEqual(["notice-old"]);
    });

    it("normalizes unsafe page values and caps page size", async () => {
        const page = await listAnnouncementsPage(true, { page: Number.MAX_VALUE, pageSize: 1000 });

        expect(page.page).toBe(1);
        expect(page.pageSize).toBe(100);
        expect(page.total).toBe(5);
    });
});
