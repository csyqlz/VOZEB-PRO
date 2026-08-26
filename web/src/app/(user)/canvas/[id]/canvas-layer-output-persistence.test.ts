import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Canvas layer output persistence", () => {
    it("validates the persisted transparent result without uploading a second copy", async () => {
        const source = await readFile(resolve(process.cwd(), "src/app/(user)/canvas/[id]/use-canvas-task-runtime.tsx"), "utf8");
        const validation = source.slice(source.indexOf('if (options?.outputBackground === "transparent"'), source.indexOf("if (target?.metadata?.preserveUnmaskedPixels)"));

        expect(validation).toContain("validateCanvasTransparentLayer");
        expect(validation).not.toContain("uploadCanvasImage");
    });
});
