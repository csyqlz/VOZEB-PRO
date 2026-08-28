import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Canvas image detail preview", () => {
    it("replaces the previous image instance before decoding the next image", async () => {
        const source = await readFile(resolve(process.cwd(), "src/app/(user)/canvas/[id]/canvas-client-page.tsx"), "utf8");
        expect(source).toContain("key={`${previewNode.id}:${previewNode.metadata.content}`}");
        expect(source).toContain("destroyOnHidden");
        expect(source).toContain('className={loaded ? "block" : "hidden"}');
    });
});
