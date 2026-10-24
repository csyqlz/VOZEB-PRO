import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import { EMPTY_PRICING_STATE } from "@/lib/model-pricing";

import { writeJsonDataFile } from "./data-adapter";
import { getCurrentModelPriceBinding, saveModelPriceBinding } from "./model-price-binding-store";
import { deletePriceCandidate, readPricingState } from "./model-pricing-store";
import { listFlatTextPriceContracts, saveFlatTextPriceContract } from "./model-pricing-token-contract-store";

const original = { provider: process.env.VOZEB_PRO_DATABASE_PROVIDER, directory: process.env.VOZEB_PRO_DATA_DIR };
let directory: string;

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "vozeb-price-reference-race-"));
    process.env.VOZEB_PRO_DATABASE_PROVIDER = "file";
    process.env.VOZEB_PRO_DATA_DIR = directory;
    await writeJsonDataFile("model-pricing.json", {
        ...EMPTY_PRICING_STATE,
        candidates: [{ id: "candidate", logicalModelId: "", status: "approved" }],
        officialVersions: [{ id: "official", candidateId: "candidate", logicalModelId: "" }],
    });
});

afterEach(async () => {
    if (original.provider === undefined) delete process.env.VOZEB_PRO_DATABASE_PROVIDER;
    else process.env.VOZEB_PRO_DATABASE_PROVIDER = original.provider;
    if (original.directory === undefined) delete process.env.VOZEB_PRO_DATA_DIR;
    else process.env.VOZEB_PRO_DATA_DIR = original.directory;
    await rm(directory, { recursive: true, force: true });
});

async function expectOneWriterToWin(saveReference: () => Promise<unknown>, readReferences: () => Promise<unknown[]>) {
    const results = await Promise.allSettled([saveReference(), deletePriceCandidate("candidate", null)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const state = await readPricingState();
    const references = await readReferences();
    expect(references).toHaveLength(state.officialVersions.length);
    expect(state.candidates).toHaveLength(state.officialVersions.length);
}

it("serializes independent selection against official price deletion", async () => {
    await expectOneWriterToWin(
        () =>
            saveModelPriceBinding(
                { logicalModelId: "logical", capability: "text", operation: "generation", processingMode: "standard", scope: "text:generation:standard", officialVersionId: "official", status: "active", evidence: "reviewed", reviewedBy: "admin" },
                null,
            ),
        async () => [await getCurrentModelPriceBinding("logical", "text:generation:standard")].filter(Boolean),
    );
});

it("serializes a metering contract against official price deletion", async () => {
    await expectOneWriterToWin(
        () =>
            saveFlatTextPriceContract(
                {
                    officialVersionId: "official",
                    channelId: "channel",
                    protocol: "openai-responses",
                    requestedModel: "model",
                    reportedModel: "model",
                    scope: "global-standard-text-flat",
                    region: "global",
                    serviceTier: "default",
                    itemMeters: { input: ["inputTokens"], output: ["outputTokens"] },
                    evidence: "reviewed",
                    reviewedAt: new Date().toISOString(),
                    reviewedBy: "admin",
                },
                null,
            ),
        () => listFlatTextPriceContracts("official", "channel", "model"),
    );
});
