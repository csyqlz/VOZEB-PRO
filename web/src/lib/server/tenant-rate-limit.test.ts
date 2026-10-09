import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ checkRateLimit: vi.fn() }));

vi.mock("@/lib/server/security", () => ({ checkRateLimit: mocks.checkRateLimit }));

import { checkTenantMutationRateLimit, type TenantMutationAction } from "./tenant-rate-limit";

describe("checkTenantMutationRateLimit", () => {
    it("scopes each tenant mutation action to the actor identity and configured window", async () => {
        const cases: ReadonlyArray<Readonly<[TenantMutationAction, string, number, number]>> = [
            ["platform-tenant-create", "platform-admin", 60, 60 * 60 * 1000],
            ["platform-tenant-rename", "platform-admin", 30, 60 * 1000],
            ["tenant-member-create", "tenant-a:owner-a", 30, 60 * 60 * 1000],
            ["tenant-member-update", "tenant-a:owner-a", 60, 60 * 1000],
        ];
        mocks.checkRateLimit.mockResolvedValue({ allowed: true, remaining: 1, resetAt: Date.now() + 60_000 });

        for (const [action, actorIdentity] of cases) await checkTenantMutationRateLimit(action, actorIdentity);

        expect(mocks.checkRateLimit).toHaveBeenCalledTimes(cases.length);
        for (const [index, [action, actorIdentity, maxRequests, windowMs]] of cases.entries()) {
            expect(mocks.checkRateLimit).toHaveBeenNthCalledWith(index + 1, `tenant-mvp:${action}:${actorIdentity}`, { maxRequests, windowMs });
        }
    });
});
