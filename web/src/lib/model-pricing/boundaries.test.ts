import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const directory = dirname(fileURLToPath(import.meta.url));

it("keeps pricing domain modules independent of server, UI and the compatibility entry", () => {
    for (const file of ["types.ts", "primitives.ts", "sources.ts", "official-price-items.ts", "price-book.ts", "rate-engine.ts", "text-price-groups.ts", "price-bindings.ts"]) {
        const source = readFileSync(join(directory, file), "utf8");
        const imports = [...source.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^;]*?\s+from\s+)?["']([^"']+)["']/g)].map((match) => match[1]);
        expect(source, file).not.toMatch(/import (?!type\b)[^;]* from ["']\.\.\/model-pricing["']/);
        expect(
            imports.filter((name) => /(?:^|\/)(?:server|database|app|components|stores)(?:\/|$)|^(?:react|next)(?:\/|$)/.test(name)),
            file,
        ).toEqual([]);
    }
});
