import { beforeEach, expect, it, vi } from "vitest";
import type { AuthSettings } from "@/lib/auth/store";
import type { OfficialPriceVersion } from "@/lib/model-pricing";

const mocks = vi.hoisted(() => ({ current: vi.fn() }));
vi.mock("./model-price-binding-store", () => ({ getCurrentModelPriceBinding: mocks.current }));

import { resolvePricingContractModel } from "./model-pricing-contract-model";

const settings = { logicalModels: [{ id: "image-model", manufacturer: "Fixture", capability: "image", enabled: true, bindings: [] }] } as unknown as AuthSettings;
const price = { id: "shared-price", logicalModelId: "", manufacturer: "Fixture", capability: "image", sku: "image-model", tier: "paid", processingTier: "standard" } as OfficialPriceVersion;

beforeEach(() => {
    vi.clearAllMocks();
    mocks.current.mockImplementation(async (_modelId: string, scope: string) => (scope === "image:generations:standard" ? { current: true, status: "active", officialVersionId: price.id } : null));
});

it("admits only the selected image operation for a shared official version", async () => {
    expect((await resolvePricingContractModel(settings, price, "image-model", ["generations", "edits"])).operations).toEqual(["generations"]);
    await expect(resolvePricingContractModel(settings, price, "image-model", ["edits"])).rejects.toThrow("选价绑定");
    expect(mocks.current).toHaveBeenCalledWith("image-model", "image:edits:standard");
});

it("uses the reviewed selection instead of the logical model name for a shared official SKU", async () => {
    expect((await resolvePricingContractModel(settings, { ...price, sku: "official-image-v2" }, "image-model", ["generations"])).operations).toEqual(["generations"]);
});

it("rejects a missing model identity, a different vendor, or a stale price binding", async () => {
    await expect(resolvePricingContractModel(settings, price, undefined, ["generations"])).rejects.toThrow("逻辑模型");
    await expect(resolvePricingContractModel(settings, { ...price, manufacturer: "Other" }, "image-model", ["generations"])).rejects.toThrow("不匹配");
    mocks.current.mockResolvedValue({ current: true, status: "active", officialVersionId: "different-price" });
    await expect(resolvePricingContractModel(settings, price, "image-model", ["generations"])).rejects.toThrow("选价绑定");
});
