import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/api/points", () => ({ refreshUserPointsIfSystem: vi.fn(), syncUserPointsFromHeaders: vi.fn() }));
vi.mock("@/stores/use-config-store", () => ({
    resolveModelRequestConfig: vi.fn((config: Record<string, unknown>, model: string) => ({ ...config, model, apiSource: "system" })),
}));

import type { AiConfig } from "@/stores/use-config-store";
import { recoverTextGenerationTask, waitForTextGenerationTask } from "./text";

describe("文本任务轮询", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("stops polling when the upstream submission needs manual review", async () => {
        const fetchMock = vi.fn(async () => Response.json({ task: { id: "text-review", status: "running", model: "text-model", needsReview: true, reviewReason: "文本提交结果无法确认" } }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(waitForTextGenerationTask({ apiSource: "system" } as AiConfig, { id: "text-review", status: "running", model: "text-model" })).rejects.toThrow("文本提交结果无法确认");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("checks the original text task without creating another task", async () => {
        const fetchMock = vi.fn(async () => Response.json({ task: { id: "text-original", status: "running", model: "text-model" } }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(recoverTextGenerationTask("text-original")).resolves.toMatchObject({ id: "text-original" });
        expect(fetchMock).toHaveBeenCalledWith("/api/text-tasks/text-original", expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "recover" }) }));
    });
});
