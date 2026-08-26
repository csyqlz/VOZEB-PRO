import { describe, expect, it, vi } from "vitest";

import { withCanvasLayerAnalysisStatus } from "./canvas-image-layer-analysis-status";

describe("Canvas image layer actions", () => {
    it("shows analysis immediately and clears it as soon as analysis resolves", async () => {
        let resolveAnalysis: ((value: string) => void) | undefined;
        const analysis = new Promise<string>((resolve) => {
            resolveAnalysis = resolve;
        });
        const message = { loading: vi.fn(), destroy: vi.fn() };

        const result = withCanvasLayerAnalysisStatus(message, "analysis-key", () => analysis);

        expect(message.loading).toHaveBeenCalledWith({ key: "analysis-key", content: "正在分层分析", duration: 0 });
        expect(message.destroy).not.toHaveBeenCalled();

        resolveAnalysis?.("done");
        await expect(result).resolves.toBe("done");
        expect(message.destroy).toHaveBeenCalledWith("analysis-key");
    });

    it("clears analysis when preparation or analysis fails", async () => {
        const message = { loading: vi.fn(), destroy: vi.fn() };
        const error = new Error("analysis failed");

        await expect(withCanvasLayerAnalysisStatus(message, "analysis-key", async () => Promise.reject(error))).rejects.toBe(error);
        expect(message.destroy).toHaveBeenCalledWith("analysis-key");
    });
});
