import { beforeEach, describe, expect, it, vi } from "vitest";
import { PricingInputError } from "@/lib/model-pricing";
const mocks = vi.hoisted(() => ({ user: vi.fn(), view: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/server/model-pricing-wallet-view", () => ({ getPricingWalletView: mocks.view }));
import { GET } from "./route";

describe("GET /api/points/pricing", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.user.mockResolvedValue({ id: "owner" });
        mocks.view.mockResolvedValue({ items: [], total: 0 });
    });
    it("requires login and never accepts user identity from query parameters", async () => {
        mocks.user.mockResolvedValueOnce(null);
        expect((await GET(new Request("http://localhost/api/points/pricing"))).status).toBe(401);
        expect(mocks.view).not.toHaveBeenCalled();
        const response = await GET(new Request("http://localhost/api/points/pricing?userId=other&page=2&pageSize=8&status=settled"));
        expect(mocks.view).toHaveBeenCalledWith("owner", { page: 2, pageSize: 8, status: "settled" });
        expect(await response.json()).toEqual({ code: 0, data: { items: [], total: 0 }, msg: "ok" });
        expect(response.headers.get("cache-control")).toBe("private, no-store");
    });
    it("returns a readable validation failure and hides unexpected persistence errors", async () => {
        mocks.view.mockRejectedValueOnce(new PricingInputError("无效的计费状态"));
        const invalid = await GET(new Request("http://localhost/api/points/pricing?status=other"));
        expect(invalid.status).toBe(400);
        expect((await invalid.json()).msg).toBe("无效的计费状态");
        mocks.view.mockRejectedValueOnce(new Error("private database details"));
        const failed = await GET(new Request("http://localhost/api/points/pricing"));
        expect(failed.status).toBe(500);
        expect(JSON.stringify(await failed.json())).not.toContain("private database details");
    });
});
