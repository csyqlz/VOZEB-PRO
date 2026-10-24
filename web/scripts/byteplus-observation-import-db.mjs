import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(new URL("../package.json", import.meta.url));
const { Client } = require("pg");
const MANUFACTURER = "ByteDance / Volcengine";
const SOURCE = "https://ai.byteplus.com/ark/region:ap-southeast-1/docs/model-pricing";
const ACTOR = "system:byteplus-official-import-2026-10-19";
const TABLE = "vozeb_pro_model_official_price_observations";
const REVIEW = "vozeb_pro_model_official_price_observation_reviews";

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

export function prepareObservations(bundle, createdAt = new Date().toISOString()) {
    assert.equal(bundle.schemaVersion, 1);
    assert.equal(bundle.observations.length, 23);
    const names = new Set();
    return bundle.observations.map((input) => {
        assert.equal(input.manufacturer, MANUFACTURER);
        assert.equal(input.sourceUrl, SOURCE);
        assert.equal(input.sourceMode, "admin-excerpt");
        assert.match(input.officialModelId, /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)+$/i);
        assert.ok(!names.has(input.officialModelId.toLowerCase()));
        names.add(input.officialModelId.toLowerCase());
        assert.equal(input.sourceDigest, sha256(input.evidence));
        assert.ok(input.evidence.toLowerCase().includes(input.officialModelId.toLowerCase()));
        assert.ok(Number.isFinite(Date.parse(input.observedAt)));
        assert.deepEqual(input.items, []);
        assert.ok(Array.isArray(input.priceVariants) && input.priceVariants.length);
        for (const variant of input.priceVariants) {
            assert.ok(input.evidence.includes(variant.evidence));
            assert.ok(variant.evidence.toLowerCase().includes(input.officialModelId.toLowerCase()));
            assert.ok(Array.isArray(variant.items) && variant.items.length);
            const keys = new Set();
            for (const item of variant.items) {
                assert.ok(item.key && item.unit && item.currency === "USD");
                assert.ok(!keys.has(item.key));
                keys.add(item.key);
                assert.match(item.per, /^(?:0|[1-9]\d*)(?:\.\d+)?$/);
                assert.ok(Number(item.per) > 0);
                assert.match(item.price, /^(?:0|[1-9]\d*)(?:\.\d+)?$/);
                assert.ok(variant.evidence.includes(item.price));
            }
        }
        const { manufacturer, officialModelId, sourceUrl, sourceDigest, evidence, sourceRowIds, conditions, items, extractionIssue, suggestedSeries, suggestedVersion, suggestedTier, priceVariants } = input;
        const id = sha256(
            JSON.stringify({
                manufacturer,
                officialModelId,
                sourceUrl,
                sourceDigest,
                evidence,
                sourceRowIds,
                conditions,
                items,
                extractionIssue,
                suggestedSeries,
                suggestedVersion,
                suggestedTier,
                suggestedProcessingTier: "",
                suggestedEffectiveFrom: "",
                suggestedEffectiveTo: "",
                headerEvidence: "",
                priceVariants,
            }),
        );
        return {
            id,
            manufacturer,
            officialModelId,
            sourceUrl,
            sourceDigest,
            sourceMode: input.sourceMode,
            observedAt: input.observedAt,
            evidence,
            sourceRowIds,
            conditions,
            items,
            suggestedSeries,
            suggestedVersion,
            suggestedTier,
            priceVariants,
            extractionIssue,
            createdAt,
            createdBy: ACTOR,
            reviewStatus: "pending",
        };
    });
}

async function main() {
    const [manifestPath, mode] = process.argv.slice(2);
    if (!manifestPath || !["--dry-run", "--apply"].includes(mode)) throw new Error("Usage: node byteplus-observation-import-db.mjs /path/to/manifest.json --dry-run|--apply");
    const manifestBytes = await readFile(manifestPath);
    const observations = prepareObservations(JSON.parse(manifestBytes.toString("utf8")));
    const manifestDigest = sha256(manifestBytes);
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [ACTOR]);
        const existing = await client.query(`SELECT o.id, o.official_model_id, r.status FROM ${TABLE} o JOIN ${REVIEW} r ON r.observation_id=o.id WHERE o.manufacturer=$1 AND lower(o.official_model_id)=ANY($2::text[])`, [
            MANUFACTURER,
            observations.map((item) => item.officialModelId.toLowerCase()),
        ]);
        const bySku = new Map();
        for (const row of existing.rows) bySku.set(row.official_model_id.toLowerCase(), [...(bySku.get(row.official_model_id.toLowerCase()) || []), row]);
        const counts = { inserted: 0, resumed: 0, alreadyConfirmed: 0, existingActive: 0, rejectedSameEvidence: 0 };
        const note = `依据 BytePlus 国际区官网 2026-10-18 价目结构化转录确认；逻辑模型映射与正式价目仍待人工审核。导入包 SHA-256 ${manifestDigest}`;
        for (const observation of observations) {
            const prior = bySku.get(observation.officialModelId.toLowerCase()) || [];
            const active = prior.find((row) => row.status === "pending" || row.status === "confirmed");
            if (active && active.id !== observation.id) {
                counts.existingActive++;
                continue;
            }
            if (active?.status === "confirmed") {
                counts.alreadyConfirmed++;
                continue;
            }
            if (prior.some((row) => row.id === observation.id && row.status === "rejected")) {
                counts.rejectedSameEvidence++;
                continue;
            }
            if (mode === "--dry-run") {
                counts[active ? "resumed" : "inserted"]++;
                continue;
            }
            if (!active) {
                await client.query(`INSERT INTO ${TABLE} (id,manufacturer,official_model_id,observed_at,created_at,data) VALUES ($1,$2,$3,$4::timestamptz,$5::timestamptz,$6::jsonb)`, [
                    observation.id,
                    observation.manufacturer,
                    observation.officialModelId,
                    observation.observedAt,
                    observation.createdAt,
                    JSON.stringify(observation),
                ]);
                await client.query(`INSERT INTO ${REVIEW} (observation_id,status) VALUES ($1,'pending')`, [observation.id]);
                counts.inserted++;
            } else counts.resumed++;
            const review = await client.query(`UPDATE ${REVIEW} SET status='confirmed', reviewed_at=now(), reviewed_by=$2, review_note=$3 WHERE observation_id=$1 AND status='pending' AND jsonb_array_length(amendments)=0 RETURNING observation_id`, [
                observation.id,
                ACTOR,
                note,
            ]);
            assert.equal(review.rowCount, 1);
            await client.query("INSERT INTO vozeb_pro_audit_logs (id,action,status,actor_username,target_type,target_id,metadata) VALUES ($1,$2,'success',$3,'model_official_price_observation',$4,$5::jsonb)", [
                randomUUID(),
                "admin.model-pricing.observation-review",
                ACTOR,
                observation.id,
                JSON.stringify({ manufacturer: MANUFACTURER, officialModelId: observation.officialModelId, sourceUrl: SOURCE, manifestDigest, importMethod: "scoped-sudo-database-transaction" }),
            ]);
        }
        if (mode === "--apply") await client.query("COMMIT");
        else await client.query("ROLLBACK");
        console.log(JSON.stringify({ mode, manifestDigest, ...counts }));
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        await client.end();
    }
}

if (process.argv[1]?.endsWith("byteplus-observation-import-db.mjs"))
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
