import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

async function componentSource(name: string) {
    return readFile(resolve(process.cwd(), `src/app/(user)/canvas/components/${name}`), "utf8");
}

describe("Canvas prompt scrolling", () => {
    it("keeps node and expanded prompt editors independently scrollable", async () => {
        const source = await componentSource("canvas-node-prompt-panel.tsx");

        expect(source).toContain('data-canvas-prompt-scroll="node"');
        expect(source).toContain('data-canvas-prompt-scroll="expanded"');
        expect(source.match(/overflow-y-auto overscroll-contain/g)).toHaveLength(2);
    });

    it("bounds the config composer before enabling vertical scrolling", async () => {
        const source = await componentSource("canvas-config-composer.tsx");

        expect(source).toContain('aria-label="组装提示词"');
        expect(source).toContain('data-canvas-prompt-scroll="config"');
        expect(source).toContain("max-h-[min(42dvh,18rem)] w-full overflow-y-auto overscroll-contain");
    });
});
