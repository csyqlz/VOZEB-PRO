import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/api/points", () => ({ refreshUserPointsIfSystem: vi.fn(), syncUserPointsFromHeaders: vi.fn() }));
vi.mock("@/stores/use-config-store", () => ({
    resolveModelRequestConfig: vi.fn((config: Record<string, unknown>, model: string) => ({ ...config, model, apiSource: "system" })),
}));

import type { AiConfig } from "@/stores/use-config-store";
import { resolveModelRequestConfig } from "@/stores/use-config-store";
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

    it("reports the persisted lifecycle state while waiting", async () => {
        const onState = vi.fn();
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => Response.json({ task: { id: "text-success", status: "success", model: "text-model", executionPhase: "persisting", lastUpstreamStatus: "persisting", result: { content: "完成" } } })),
        );

        await expect(waitForTextGenerationTask({ apiSource: "system" } as AiConfig, { id: "text-success", model: "text-model" }, { onState })).resolves.toBe("完成");
        expect(onState).toHaveBeenCalledWith(expect.objectContaining({ status: "success", executionPhase: "persisting", lastUpstreamStatus: "persisting" }));
    });

    it("uses the persisted task model after the page default model changes", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => Response.json({ task: { id: "text-success", status: "success", model: "persisted-model", result: { content: "完成" } } })),
        );

        await waitForTextGenerationTask({ apiSource: "system" } as AiConfig, { id: "text-success", model: "new-page-default" });

        expect(resolveModelRequestConfig).toHaveBeenCalledWith(expect.anything(), "persisted-model");
    });
});
