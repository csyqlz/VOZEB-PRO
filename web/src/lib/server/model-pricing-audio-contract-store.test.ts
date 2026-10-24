import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EMPTY_PRICING_STATE } from "@/lib/model-pricing";

import { writeJsonDataFile } from "./data-adapter";
import { initializePostgresSchema, postgresQuery } from "./database";
import type { ReviewedAudioPriceContract } from "./model-pricing-audio-contract-store";
import { listAudioPriceContracts, saveAudioPriceContract } from "./model-pricing-audio-contract-store";

const original = { provider: process.env.VOZEB_PRO_DATABASE_PROVIDER, directory: process.env.VOZEB_PRO_DATA_DIR };
for (const kind of ["gemini-tts", "openai-chat-audio"] as const)
    for (const provider of ["file", "postgres"] as const)
        describe.skipIf(provider === "postgres" && process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION !== "1")(`${kind} audio contract history on ${provider}`, () => {
            let directory: string;
            let contract: ReviewedAudioPriceContract;
            beforeEach(async () => {
                directory = await mkdtemp(join(tmpdir(), "vozeb-audio-contract-"));
                process.env.VOZEB_PRO_DATABASE_PROVIDER = provider;
                process.env.VOZEB_PRO_DATA_DIR = directory;
                contract = {
                    officialVersionId: randomUUID(),
                    channelId: "channel",
                    requestedModel: "gemini-2.5-flash-preview-tts",
                    reportedModel: "gemini-2.5-flash-preview-tts",
                    declaredProtocol: "gemini",
                    protocol: "gemini-tts",
                    scope: "global-standard-gemini-tts",
                    modelIdentity: "reviewed-request",
                    inputTextItem: "text",
                    outputAudioItem: "audio",
                    evidence: "Fixture audio contract",
                    reviewedBy: "admin",
                    reviewedAt: new Date().toISOString(),
                };
                if (kind === "openai-chat-audio")
                    contract = {
                        officialVersionId: contract.officialVersionId,
                        channelId: "channel",
                        requestedModel: "gpt-audio-1.5",
                        reportedModel: "gpt-audio-1.5",
                        declaredProtocol: "openai",
                        protocol: "openai-chat-audio",
                        scope: "global-standard-openai-chat-audio-uncached",
                        itemKeys: { inputTextTokens: "inputText", inputAudioTokens: "inputAudio", outputTextTokens: "outputText", outputAudioTokens: "outputAudio" },
                        evidence: "Fixture four ordinary rates",
                        reviewedBy: "admin",
                        reviewedAt: new Date().toISOString(),
                    };
                if (provider === "postgres") {
                    await initializePostgresSchema();
                    await postgresQuery("INSERT INTO model_official_price_versions (id, logical_model_id, published_at, data) VALUES ($1, $2, now(), $3::jsonb)", [contract.officialVersionId, "fixture", JSON.stringify({ id: contract.officialVersionId })]);
                } else await writeJsonDataFile("model-pricing.json", { ...EMPTY_PRICING_STATE, officialVersions: [{ id: contract.officialVersionId }] });
            });
            afterEach(async () => {
                if (provider === "postgres") {
                    await postgresQuery("DELETE FROM model_audio_price_contracts WHERE official_version_id = $1", [contract.officialVersionId]);
                    await postgresQuery("DELETE FROM model_official_price_versions WHERE id = $1", [contract.officialVersionId]);
                }
                if (original.provider === undefined) delete process.env.VOZEB_PRO_DATABASE_PROVIDER;
                else process.env.VOZEB_PRO_DATABASE_PROVIDER = original.provider;
                if (original.directory === undefined) delete process.env.VOZEB_PRO_DATA_DIR;
                else process.env.VOZEB_PRO_DATA_DIR = original.directory;
                await rm(directory, { force: true, recursive: true });
            });
            const list = () => listAudioPriceContracts(contract.officialVersionId, contract.channelId, contract.requestedModel);
            it("keeps immutable evidence and one winner for both first and later concurrent reviews", async () => {
                await expect(saveAudioPriceContract({ ...contract, officialVersionId: randomUUID() }, null)).rejects.toThrow("官方价版本已变化");
                const creation = await Promise.allSettled([saveAudioPriceContract(contract, null), saveAudioPriceContract({ ...contract, evidence: "alternative" }, null)]);
                expect(creation.filter((item) => item.status === "fulfilled")).toHaveLength(1);
                expect(creation.filter((item) => item.status === "rejected")).toHaveLength(1);
                const first = (await list())[0];
                const update = await Promise.allSettled([saveAudioPriceContract({ ...contract, evidence: "second review" }, first.id), saveAudioPriceContract({ ...contract, evidence: "other second review" }, first.id)]);
                expect(update.filter((item) => item.status === "fulfilled")).toHaveLength(1);
                expect(update.filter((item) => item.status === "rejected")).toHaveLength(1);
                const history = await list();
                expect(history).toHaveLength(2);
                expect(history.filter((item) => item.current)).toHaveLength(1);
                expect(history.find((item) => item.id === first.id)).toEqual({ ...first, current: false });
                await expect(saveAudioPriceContract(contract, first.id)).rejects.toThrow("刷新");
            });
            it("isolates channel, requested model and official version identities", async () => {
                await saveAudioPriceContract(contract, null);
                await saveAudioPriceContract({ ...contract, channelId: "other" }, null);
                if (contract.protocol === "gemini-tts") await saveAudioPriceContract({ ...contract, requestedModel: "gemini-3.1-flash-tts-preview" }, null);
                else expect(await listAudioPriceContracts(contract.officialVersionId, contract.channelId, "gpt-4o-audio-preview")).toEqual([]);
                expect(await list()).toHaveLength(1);
                expect(await listAudioPriceContracts("other", contract.channelId, contract.requestedModel)).toEqual([]);
            });
            it("preserves each reviewed price mapping and normal charging rule on replacement", async () => {
                const first = await saveAudioPriceContract(contract, null);
                const replacement: ReviewedAudioPriceContract =
                    contract.protocol === "gemini-tts"
                        ? { ...contract, evidence: "new proof", inputTextItem: "new-input", outputAudioItem: "new-output", declaredProtocol: "dataeyes-gemini" }
                        : { ...contract, evidence: "new proof", itemKeys: { inputTextTokens: "new-inputText", inputAudioTokens: "new-inputAudio", outputTextTokens: "new-outputText", outputAudioTokens: "new-outputAudio" } };
                const next = await saveAudioPriceContract(replacement, first.id);
                expect(await list()).toEqual([next, { ...first, current: false }]);
                expect(next).toMatchObject(replacement);
                await expect(saveAudioPriceContract(contract, first.id)).rejects.toThrow("刷新");
            });
        });
