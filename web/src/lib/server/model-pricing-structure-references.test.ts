import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ settings: vi.fn(), latest: vi.fn() }));
vi.mock("@/lib/auth/store", () => ({ getFreshAuthSettings: mocks.settings, getPublicUsersByIds: vi.fn() }));
vi.mock("./model-pricing-store", async (load) => ({ ...(await load<typeof import("./model-pricing-store")>()), getLatestOfficialVersionsForModels: mocks.latest }));

import { getOfficialPriceStructureReferences } from "./model-pricing-service";

beforeEach(() => {
    vi.clearAllMocks();
    mocks.settings.mockResolvedValue({
        logicalModels: [
            { id: "target", manufacturer: "Anthropic", capability: "text", series: "Claude" },
            { id: "text-source", manufacturer: "Anthropic", capability: "text", series: "Claude" },
            { id: "older-series", manufacturer: "Anthropic", capability: "text", series: "Legacy" },
            { id: "video-source", manufacturer: "Anthropic", capability: "video", series: "Claude" },
            { id: "other-vendor", manufacturer: "OpenAI", capability: "text", series: "GPT" },
        ],
    });
    mocks.latest.mockResolvedValue(
        new Map([
            ["text-source", { id: "reviewed-text", logicalModelId: "text-source", manufacturer: "Anthropic", series: "Claude", publishedAt: "2026-01-01", items: [{ key: "inputTokens" }] }],
            ["older-series", { id: "reviewed-old", logicalModelId: "older-series", manufacturer: "Anthropic", series: "Legacy", publishedAt: "2026-02-01", items: [{ key: "outputTokens" }] }],
        ]),
    );
});

it("offers only reviewed prices from the same vendor and capability, prioritizing the same series", async () => {
    expect((await getOfficialPriceStructureReferences("target")).map((item) => item.id)).toEqual(["reviewed-text", "reviewed-old"]);
    expect(mocks.latest).toHaveBeenCalledWith(["text-source", "older-series"]);
});

it("rejects unknown targets before querying price history", async () => {
    await expect(getOfficialPriceStructureReferences("missing")).rejects.toThrow("请选择已配置厂商");
    expect(mocks.latest).not.toHaveBeenCalled();
});
