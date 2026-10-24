import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const factsFile = new URL("../../docs/progress/model-pricing-byteplus-official-facts-2026-10-19.json", import.meta.url);
const defaultOutput = new URL("../../docs/progress/model-pricing-byteplus-observation-import-2026-10-19.json", import.meta.url);
const manufacturer = "ByteDance / Volcengine";

function priceItem(key, value, condition, unit = "token", per = "1000000") {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`Invalid official rate: ${key}`);
    return { key, unit, per, price: String(value), currency: "USD", condition };
}

function textVariants(model) {
    const fields = {
        standard: [
            ["inputNonAudioUsdPerMTokens", "inputTokens"],
            ["inputAudioUsdPerMTokens", "inputAudioTokens"],
            ["cacheStorageUsdPerMTokensHour", "cacheStorageTokens", "token-hour"],
            ["cacheHitNonAudioUsdPerMTokens", "cachedInputTokens"],
            ["cacheHitAudioUsdPerMTokens", "cachedInputAudioTokens"],
            ["outputUsdPerMTokens", "outputTokens"],
        ],
        flex: [
            ["inputNonAudioUsdPerMTokens", "inputTokens"],
            ["inputAudioUsdPerMTokens", "inputAudioTokens"],
            ["cacheHitNonAudioUsdPerMTokens", "cachedInputTokens"],
            ["cacheHitAudioUsdPerMTokens", "cachedInputAudioTokens"],
            ["outputUsdPerMTokens", "outputTokens"],
        ],
        batch: [
            ["inputUsdPerMTokens", "inputTokens"],
            ["cacheHitUsdPerMTokens", "cachedInputTokens"],
            ["outputUsdPerMTokens", "outputTokens"],
        ],
    };
    return Object.entries(model.rates).flatMap(([mode, rows]) => {
        if (!fields[mode] || !Array.isArray(rows)) throw new Error(`Unsupported text pricing mode: ${mode}`);
        return rows.map((row) => {
            const conditions = `${mode.toUpperCase()} · Prompt length ${row.promptLengthK} K tokens`;
            const items = fields[mode].filter(([field]) => row[field] !== null && row[field] !== undefined).map(([field, key, unit]) => priceItem(key, row[field], conditions, unit || "token"));
            return { conditions, items };
        });
    });
}

function videoVariants(model) {
    return Object.entries(model.rates).flatMap(([mode, rows]) => {
        if (!mode.endsWith("UsdPerMCompletionTokens")) throw new Error(`Unsupported video pricing mode: ${mode}`);
        if (rows === null) return [];
        const modeName = mode.startsWith("online") ? "Online" : "Offline";
        if (typeof rows === "number") return [{ conditions: modeName, items: [priceItem("outputTokens", rows, modeName)] }];
        if (!Array.isArray(rows)) throw new Error(`Invalid video pricing: ${mode}`);
        return rows.flatMap((row) => {
            if (row.outputResolution)
                return [
                    { conditions: `${modeName} · ${row.outputResolution} · without input video`, items: [priceItem("outputTokens", row.withoutInputVideo, `${row.outputResolution} · without input video`)] },
                    { conditions: `${modeName} · ${row.outputResolution} · with input video`, items: [priceItem("outputTokens", row.withInputVideo, `${row.outputResolution} · with input video`)] },
                ];
            if (typeof row.outputAudio === "boolean") {
                const conditions = `${modeName} · output audio ${row.outputAudio ? "on" : "off"}`;
                return [{ conditions, items: [priceItem("outputTokens", row.price, conditions)] }];
            }
            throw new Error(`Unsupported video rate: ${model.sku}`);
        });
    });
}

function imageVariants(model) {
    const rates = model.rates;
    const items = [];
    if (rates.inputImages) {
        items.push(priceItem("firstInputImage", rates.inputImages.firstImageUsd, "first input image", "image", "1"));
        items.push(priceItem("additionalInputImages", rates.inputImages.eachAdditionalImageUsd, "each input image from the second", "image", "1"));
        for (const row of rates.singleOutputImage) items.push(priceItem(`outputImage_${row.pixels === "<=2610000" ? "low" : "high"}`, row.usdPerImage, `single output image · ${row.pixels} pixels`, "image", "1"));
        for (const row of rates.layerDecompositionOutput) items.push(priceItem(`outputLayer_${row.pixels === "<=2610000" ? "low" : "high"}`, row.usdPerLayer, `layer decomposition · ${row.pixels} pixels`, "layer", "1"));
    } else {
        items.push(priceItem("inputImages", rates.inputImageUsdPerImage, "input image", "image", "1"));
        items.push(priceItem("outputImages", rates.outputImageUsdPerImage, "successful output image", "image", "1"));
    }
    return [{ conditions: "official image generation pricing; each item retains its own condition", items }];
}

export function buildBytePlusObservationImport(facts, observedAt = new Date().toISOString()) {
    if (facts.manufacturer !== manufacturer || facts.currency !== "USD" || !Array.isArray(facts.models)) throw new Error("Unexpected BytePlus facts format");
    if (!Number.isFinite(Date.parse(observedAt))) throw new Error("Invalid observedAt");
    const observations = facts.models.map((model) => {
        const variants = model.capability === "text" ? textVariants(model) : model.capability === "video" ? videoVariants(model) : model.capability === "image" ? imageVariants(model) : null;
        if (!variants?.length || !model.sku || !model.pricingUrl) throw new Error(`Incomplete official facts: ${model.sku}`);
        const priceVariants = variants.map(({ conditions, items }) => ({
            conditions,
            items,
            evidence: `${model.sku} | ${conditions} | ${items.map((item) => `${item.key}: ${item.price} USD / ${item.per} ${item.unit}${item.condition ? ` (${item.condition})` : ""}`).join("; ")}`,
            suggestedSeries: model.family,
            suggestedVersion: model.sku,
            suggestedTier: "paid",
        }));
        const evidence = priceVariants.map((variant) => variant.evidence).join("\n");
        return {
            manufacturer,
            officialModelId: model.sku,
            sourceUrl: model.pricingUrl,
            sourceDigest: createHash("sha256").update(evidence).digest("hex"),
            sourceMode: "admin-excerpt",
            observedAt,
            evidence,
            sourceRowIds: [],
            conditions: "",
            items: [],
            priceVariants,
            suggestedSeries: model.family,
            suggestedVersion: model.sku,
            suggestedTier: "paid",
            extractionIssue: "按官网价目结构化转录；需人工核对原文及逻辑模型关系，未形成正式价目候选。",
        };
    });
    if (new Set(observations.map((item) => item.officialModelId)).size !== observations.length) throw new Error("Duplicate official SKU");
    return { schemaVersion: 1, sourceFacts: fileURLToPath(factsFile), sourcePageLastUpdated: facts.sourcePageLastUpdated, observations };
}

async function api(baseUrl, cookie, method, path, body) {
    const response = await fetch(new URL(path, baseUrl), {
        method,
        headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json();
    if (!response.ok || result.code !== 0) throw new Error(`${method} ${path}: ${result.msg || response.status}`);
    return result.data;
}

async function main() {
    const args = process.argv.slice(2);
    const value = (name) => args[args.indexOf(name) + 1];
    const facts = JSON.parse(await readFile(factsFile, "utf8"));
    const bundle = buildBytePlusObservationImport(facts);
    const output = args.includes("--output") ? value("--output") : fileURLToPath(defaultOutput);
    await writeFile(output, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    console.log(`Prepared ${bundle.observations.length} unlinked BytePlus official-price observations: ${output}`);
    if (!args.includes("--apply")) return;
    const baseUrl = value("--base-url");
    const cookieFile = value("--cookie-file");
    if (!baseUrl || !cookieFile || new URL(baseUrl).protocol !== "https:") throw new Error("--apply requires --base-url https://... and --cookie-file");
    if (((await stat(cookieFile)).mode & 0o077) !== 0) throw new Error("Cookie file permissions must be 600");
    const cookie = (await readFile(cookieFile, "utf8")).trim();
    if (!cookie) throw new Error("Cookie file is empty");
    const path = "/api/admin/model-pricing/observations";
    const existing = new Map();
    for (let page = 1; ; page++) {
        const batch = await api(baseUrl, cookie, "GET", `${path}?manufacturer=${encodeURIComponent(manufacturer)}&status=all&page=${page}`);
        batch.observations.forEach((item) => existing.set(item.officialModelId.toLowerCase(), item));
        if (page * batch.pageSize >= batch.total) break;
    }
    let imported = 0;
    let resumed = 0;
    let skipped = 0;
    for (const observation of bundle.observations) {
        const prior = existing.get(observation.officialModelId.toLowerCase());
        if (prior && (prior.reviewStatus !== "pending" || prior.sourceDigest !== observation.sourceDigest)) {
            skipped++;
            continue;
        }
        const saved = prior || (await api(baseUrl, cookie, "POST", path, observation));
        await api(baseUrl, cookie, "PATCH", path, {
            action: "review",
            id: saved.id,
            status: "confirmed",
            expectedRevision: 0,
            note: `依据 ${facts.sourcePageLastUpdated} 更新的 BytePlus 国际区官网价目结构化转录确认；逻辑模型关系及正式价目仍待人工审核。`,
        });
        if (prior) resumed++;
        else imported++;
    }
    console.log(`Imported ${imported}, resumed ${resumed}, skipped ${skipped} existing SKUs. New records are in the pending-price preparation list, unlinked and not formal price candidates.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
