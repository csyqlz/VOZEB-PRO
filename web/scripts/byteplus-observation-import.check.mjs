import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { buildBytePlusObservationImport } from "./byteplus-observation-import.mjs";
import { prepareObservations } from "./byteplus-observation-import-db.mjs";

const facts = JSON.parse(await readFile(new URL("../../docs/progress/model-pricing-byteplus-official-facts-2026-10-19.json", import.meta.url), "utf8"));
const bundle = buildBytePlusObservationImport(facts, "2026-10-19T00:00:00.000Z");

test("stages all 23 BytePlus SKUs without inventing model bindings or candidate prices", () => {
    assert.equal(bundle.observations.length, 23);
    assert.equal(new Set(bundle.observations.map((item) => item.officialModelId)).size, 23);
    for (const observation of bundle.observations) {
        assert.equal(observation.manufacturer, "ByteDance / Volcengine");
        assert.equal(observation.logicalModelId, undefined);
        assert.equal(observation.reviewStatus, undefined);
        assert.equal(observation.items.length, 0);
        assert.ok(observation.priceVariants.length);
        assert.match(observation.evidence, new RegExp(observation.officialModelId));
        assert.ok(observation.priceVariants.every((variant) => variant.items.every((item) => variant.evidence.includes(item.price))));
    }
});

test("keeps unavailable rates absent while preserving genuine free input and conditional prices", () => {
    const bySku = new Map(bundle.observations.map((item) => [item.officialModelId, item]));
    const text = bySku.get("seed-2-0-pro-260328");
    assert.ok(text.priceVariants.some((variant) => variant.conditions.includes("BATCH")));
    assert.ok(text.priceVariants.every((variant) => !variant.items.some((item) => item.key === "inputAudioTokens")));
    const video = bySku.get("dreamina-seedance-2-5-260628");
    assert.equal(video.priceVariants.length, 4);
    assert.ok(video.priceVariants.every((variant) => variant.conditions.startsWith("Online")));
    const image = bySku.get("dola-seedream-5-0-pro-260628");
    assert.deepEqual(
        image.priceVariants[0].items.map((item) => item.price),
        ["0", "0.003", "0.045", "0.09", "0.0225", "0.045"],
    );
});

test("prepares deterministic, unlinked production records for the scoped database import", () => {
    const first = prepareObservations(bundle, "2026-10-19T00:00:00.000Z");
    const second = prepareObservations(bundle, "2026-10-19T00:00:00.000Z");
    assert.deepEqual(first, second);
    assert.equal(new Set(first.map((item) => item.id)).size, 23);
    assert.ok(first.every((item) => item.reviewStatus === "pending" && item.logicalModelId === undefined));
    assert.ok(first.every((item) => item.priceVariants.length > 0 && item.items.length === 0));
});
