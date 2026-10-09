import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Canvas layer output persistence", () => {
    it("validates the persisted transparent result without uploading a second copy", async () => {
        const source = await readFile(resolve(process.cwd(), "src/app/(user)/canvas/[id]/use-canvas-task-runtime.tsx"), "utf8");
        const validation = source.slice(source.indexOf('if (options?.outputBackground === "transparent"'), source.indexOf("let preserveUnmaskedPixels"));

        expect(validation).toContain("validateCanvasTransparentLayer");
        expect(validation).not.toContain("uploadCanvasImage");
    });

    it("uses native sub2api mask output while retaining local compositing for legacy providers", async () => {
        const actions = await readFile(resolve(process.cwd(), "src/app/(user)/canvas/[id]/use-canvas-node-media-actions.tsx"), "utf8");
        const runtime = await readFile(resolve(process.cwd(), "src/app/(user)/canvas/[id]/use-canvas-task-runtime.tsx"), "utf8");
        const maskedEdit = actions.slice(actions.indexOf("const maskEditImageNode"), actions.indexOf("const emotionEditImageNode"));
        const completion = runtime.slice(runtime.indexOf("const completeImageTask"), runtime.indexOf("const startAndCompleteImageTask"));

        expect(maskedEdit).toContain("const storedMask = await uploadCanvasImage(payload.maskDataUrl)");
        expect(maskedEdit).toContain("imageEditMask:");
        expect(maskedEdit).toContain("shouldCompositeCanvasMaskEdit(generationConfig)");
        expect(maskedEdit).toContain("...(preserveUnmaskedPixels ? { preserveUnmaskedPixels: { source, mask } } : {})");
        expect(completion).toContain("compositeCanvasImageEditResult(");
        expect(completion).toContain("preserveUnmaskedPixels.source.dataUrl");
        expect(completion).toContain("preserveUnmaskedPixels.mask.dataUrl");
        expect(completion).toContain("return uploadCanvasImage(composite)");
    });
});
