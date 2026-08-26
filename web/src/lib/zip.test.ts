import { describe, expect, it } from "vitest";

import { createZip, readZip, type ZipFile } from "./zip";

describe("ZIP helpers", () => {
    it("consumes lazy files in order and creates a readable archive", async () => {
        const visited: string[] = [];
        async function* files(): AsyncGenerator<ZipFile> {
            visited.push("first");
            yield { name: "first.txt", data: "第一份" };
            visited.push("second");
            yield { name: "second.bin", data: new Uint8Array([1, 2, 3]) };
        }

        const archive = await createZip(files());
        const entries = await readZip(archive);

        expect(visited).toEqual(["first", "second"]);
        expect(new TextDecoder().decode(await entries.get("first.txt")!.arrayBuffer())).toBe("第一份");
        expect(new Uint8Array(await entries.get("second.bin")!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    });

    it("stops before reading files when the operation is cancelled", async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(createZip([{ name: "unused.txt", data: "unused" }], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    });
});
