import { describe, expect, it } from "vitest";

import { buildCanvasEmotionPrompt } from "./canvas-emotion-prompt";

describe("Canvas 表情提示词", () => {
    it("包含目标人物、具体表情、强度和二维情绪", () => {
        const prompt = buildCanvasEmotionPrompt({
            face: { x: 0.2, y: 0.1, width: 0.2, height: 0.2 },
            expressionId: "angry",
            intensity: "strong",
            excitement: 0.88,
            affinity: 0.18,
        });

        expect(prompt).toContain("约 30% 横向、20% 纵向");
        expect(prompt).toContain("强烈地");
        expect(prompt).toContain("愤怒");
        expect(prompt).toContain("更激动、更疏离");
    });
});
