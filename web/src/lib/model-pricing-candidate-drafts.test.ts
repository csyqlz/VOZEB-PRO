import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { validateOfficialPriceInput } from "./model-pricing";

const draftsDirectory = new URL("../../../docs/progress/", import.meta.url);

describe("local official price drafts", () => {
    it("keeps every pending model price input valid and uniquely identified", () => {
        const files = readdirSync(draftsDirectory).filter((name) => /^model-pricing-.*-candidate-drafts?-.*\.json$/.test(name));
        expect(files.length).toBeGreaterThan(0);
        const identities = new Set<string>();
        for (const file of files) {
            const draft = JSON.parse(readFileSync(new URL(file, draftsDirectory), "utf8"));
            expect(draft.productionChanged, file).toBe(false);
            expect(draft.status, file).toMatch(/^draft-/);
            expect(draft.candidateInputs.length, file).toBeGreaterThan(0);
            for (const input of draft.candidateInputs) {
                const price = validateOfficialPriceInput(input);
                const identity = `${price.logicalModelId}/${price.officialVersion}/${price.sku}`;
                expect(identities.has(identity), `${file}: ${identity}`).toBe(false);
                identities.add(identity);
            }
        }
    });
});
