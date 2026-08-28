import { describe, expect, it, vi } from "vitest";

import type { SystemUpdateInfo } from "@/lib/system-update-contract";
import { pollSystemUpdateUntilResponse } from "./use-admin-system-update";

describe("admin system update polling", () => {
    it("keeps polling through transient app downtime and stops on the next response", async () => {
        const refresh = vi
            .fn<() => Promise<SystemUpdateInfo | undefined>>()
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce({} as SystemUpdateInfo);
        const wait = vi.fn(async () => true);

        await pollSystemUpdateUntilResponse(2_000, refresh, new AbortController().signal, wait);

        expect(wait).toHaveBeenCalledTimes(3);
        expect(wait).toHaveBeenCalledWith(2_000, expect.any(AbortSignal));
        expect(refresh).toHaveBeenCalledTimes(3);
    });

    it("stops without refreshing after the page cancels observation", async () => {
        const controller = new AbortController();
        const refresh = vi.fn<() => Promise<SystemUpdateInfo | undefined>>();
        const wait = vi.fn(async () => {
            controller.abort();
            return false;
        });

        await pollSystemUpdateUntilResponse(2_000, refresh, controller.signal, wait);

        expect(wait).toHaveBeenCalledOnce();
        expect(refresh).not.toHaveBeenCalled();
    });
});
