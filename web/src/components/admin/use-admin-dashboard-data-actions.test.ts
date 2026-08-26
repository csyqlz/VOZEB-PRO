import { afterEach, describe, expect, it, vi } from "vitest";

import { useAdminDashboardDataActions } from "./use-admin-dashboard-data-actions";
import type { AdminDashboardState } from "./use-admin-dashboard-state";

vi.mock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    return { ...actual, useRef: vi.fn((initialValue: unknown) => ({ current: initialValue })) };
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((next) => {
        resolve = next;
    });
    return { promise, resolve };
}

function jsonResponse(body: unknown) {
    return {
        ok: true,
        json: async () => body,
    } as Response;
}

describe("useAdminDashboardDataActions", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("ignores an older CDK response that arrives after the latest request", async () => {
        const first = deferred<Response>();
        const second = deferred<Response>();
        const fetchMock = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        vi.stubGlobal("fetch", fetchMock);

        const setCdkCodes = vi.fn();
        const setCdkTotal = vi.fn();
        const setCdkStats = vi.fn();
        const setCdkPage = vi.fn();
        const setSelectedCdkIds = vi.fn();
        const setCdkLoading = vi.fn();
        const messageError = vi.fn();
        const state = {
            cdkPage: 1,
            debouncedCdkSearch: "",
            cdkFilter: "all",
            cdkStats: { total: 0, redeemed: 0, unused: 0, expired: 0 },
            setCdkCodes,
            setCdkTotal,
            setCdkStats,
            setCdkPage,
            setSelectedCdkIds,
            setCdkLoading,
            message: { error: messageError },
        } as unknown as AdminDashboardState;
        const { loadCdkCodes } = useAdminDashboardDataActions({ state });

        const olderRequest = loadCdkCodes({ page: 1 });
        const latestRequest = loadCdkCodes({ page: 2 });
        const latestCodes = [{ id: "latest" }];
        const latestStats = { total: 1, redeemed: 0, unused: 1, expired: 0 };

        second.resolve(jsonResponse({ codes: latestCodes, total: 1, page: 2, stats: latestStats }));
        await latestRequest;
        first.resolve(jsonResponse({ codes: [{ id: "older" }], total: 7, page: 1 }));
        await olderRequest;

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(setCdkCodes).toHaveBeenCalledOnce();
        expect(setCdkCodes).toHaveBeenCalledWith(latestCodes);
        expect(setCdkTotal).toHaveBeenCalledWith(1);
        expect(setCdkStats).toHaveBeenCalledWith(latestStats);
        expect(setCdkPage).toHaveBeenCalledWith(2);
        expect(setSelectedCdkIds).toHaveBeenCalledOnce();
        expect(setCdkLoading.mock.calls).toEqual([[true], [true], [false]]);
        expect(messageError).not.toHaveBeenCalled();
    });
});
