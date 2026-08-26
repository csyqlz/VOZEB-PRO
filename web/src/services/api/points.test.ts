import { afterEach, describe, expect, it, vi } from "vitest";

import { listPointRecords, refreshUserPointsIfSystem } from "./points";
import { useUserStore, type LocalUser } from "@/stores/use-user-store";

const user = (pointsBalance: number): LocalUser => ({
    id: "user-1",
    accountId: "0001",
    username: "tester",
    displayName: "测试用户",
    bio: "",
    role: "user",
    adminPermissions: [],
    status: "active",
    planId: "free",
    planName: "免费版",
    hasActivePlan: false,
    pointsBalance,
    mfaEnabled: false,
});

describe("用户积分同步", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("coalesces overlapping refreshes and keeps the latest server balance", async () => {
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const fetchMock = vi
            .fn()
            .mockImplementationOnce(async () => {
                await firstGate;
                return Response.json({ user: user(9) });
            })
            .mockImplementationOnce(async () => Response.json({ user: user(8) }));
        vi.stubGlobal("fetch", fetchMock);
        useUserStore.getState().setUser(user(10));

        const first = refreshUserPointsIfSystem("system");
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        const second = refreshUserPointsIfSystem("system");
        releaseFirst();
        await Promise.all([first, second]);

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(useUserStore.getState().user?.pointsBalance).toBe(8);
    });

    it("requests a server-filtered debit page", async () => {
        const fetchMock = vi.fn(async () => Response.json({ records: [{ id: "record-one", type: "consume", amount: -2, balanceAfter: 8, description: "生成图片", createdAt: "2026-01-01T00:00:00.000Z" }], total: 9, page: 2, pageSize: 8 }));
        vi.stubGlobal("fetch", fetchMock);

        const result = await listPointRecords({ page: 2, pageSize: 8, direction: "debit" });

        expect(result).toMatchObject({ total: 9, page: 2, pageSize: 8 });
        expect(fetchMock).toHaveBeenCalledWith("/api/points?page=2&pageSize=8&direction=debit", { cache: "no-store" });
    });

    it("requests the structured consumption view", async () => {
        const fetchMock = vi.fn(async () => Response.json({ records: [], total: 0, page: 1, pageSize: 8 }));
        vi.stubGlobal("fetch", fetchMock);

        await listPointRecords({ page: 1, pageSize: 8, direction: "debit", view: "consumption" });

        expect(fetchMock).toHaveBeenCalledWith("/api/points?page=1&pageSize=8&direction=debit&view=consumption", { cache: "no-store" });
    });
});
