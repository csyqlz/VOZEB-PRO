import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import pg from "pg";

import { isAttentionReservation, summarizePricingBaseline } from "./model-pricing-baseline-core.mjs";

const provider = process.argv[2];
if (!["file", "postgres"].includes(provider)) throw new Error("用法：node scripts/model-pricing-baseline.mjs file|postgres");

const input = provider === "postgres" ? await readPostgresBaseline() : await readFileBaseline();
process.stdout.write(`${JSON.stringify({ provider, ...summarizePricingBaseline(input) }, null, 2)}\n`);

async function readFileBaseline() {
    const dataDir = resolve(process.env.VOZEB_PRO_DATA_DIR || ".data");
    const [pricing, auth, contracts, tasks] = await Promise.all([
        readFile(resolve(dataDir, "model-pricing.json"), "utf8").then(JSON.parse),
        readFile(resolve(dataDir, "auth.json"), "utf8").then(JSON.parse),
        Promise.all(["model-pricing-token-contracts.json", "model-pricing-image-contracts.json", "model-pricing-video-contracts.json", "model-pricing-audio-contracts.json"].map((file) => readOptionalContracts(resolve(dataDir, file)))),
        readFile(resolve(dataDir, "generation-tasks.json"), "utf8")
            .then(JSON.parse)
            .catch((error) => {
                if (error.code === "ENOENT") return null;
                throw error;
            }),
    ]);
    const tasksById = new Map((tasks || []).map((task) => [task.id, task]));
    return {
        pricing: {
            currentSales: pricing.salesVersions?.at(-1) || null,
            officialVersions: pricing.officialVersions || [],
            priceBindings: pricing.priceBindings || [],
            activations: pricing.billingActivations || {},
        },
        models: auth.settings?.logicalModels || [],
        channels: auth.settings?.systemChannels || [],
        defaultModels: auth.settings?.defaultModels || {},
        modelPointCosts: auth.settings?.modelPointCosts ?? null,
        generationPointMultipliers: auth.settings?.generationPointMultipliers ?? null,
        currentContracts: contracts.flatMap((state) => (state.contracts || []).filter((contract) => contract.current)),
        reservations: (auth.pricingReservations || []).filter(isAttentionReservation).map((reservation) => {
            const taskId = reservation.preparation?.taskId;
            const task = taskId && tasksById.get(taskId);
            return {
                ...reservation,
                taskLinkage: !taskId ? "no-task-reference" : !tasks ? "task-catalog-unavailable" : !task || task.userId !== reservation.userId ? "task-not-found" : task.runId ? "run-linked" : "task-no-run",
            };
        }),
        frozenReferenceCatalog: {
            officialVersionIds: (pricing.officialVersions || []).map((item) => item.id),
            salesVersionIds: (pricing.salesVersions || []).map((item) => item.id),
            contractIds: contracts.flatMap((state) => (state.contracts || []).map((item) => item.id)),
        },
        officialInventory: {
            total: (pricing.officialVersions || []).length,
            unbound: (pricing.officialVersions || []).filter((item) => !item.logicalModelId).length,
            copiedLinks: (pricing.officialVersions || []).filter((item) => Boolean(item.linkedFromVersionId)).length,
        },
        candidateStatuses: Object.fromEntries(["pending", "approved", "rejected"].map((status) => [status, (pricing.candidates || []).filter((item) => item.status === status).length])),
    };
}

async function readOptionalContracts(path) {
    try {
        return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
        if (error.code === "ENOENT") return { contracts: [] };
        throw error;
    }
}

async function readPostgresBaseline() {
    const connectionString = process.env.DATABASE_URL?.trim() || process.env.POSTGRES_URL?.trim();
    if (!connectionString) throw new Error("缺少只读数据库连接 DATABASE_URL 或 POSTGRES_URL");
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
        await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const state = (await client.query("SELECT current_sales_version_id, billing_activations FROM vozeb_pro_model_pricing_state WHERE id = 'default'")).rows[0];
        if (!state) throw new Error("价目状态不存在；未执行任何建表或数据修改");
        const sales = state.current_sales_version_id ? (await client.query("SELECT data FROM vozeb_pro_model_sales_price_versions WHERE id = $1", [state.current_sales_version_id])).rows[0]?.data : null;
        if (state.current_sales_version_id && !sales) throw new Error("当前销售版本引用不存在");
        const selections = sales?.selectedPriceBindings || [];
        const ids = [...new Set([...Object.values(sales?.priceVersionIds || {}), ...selections.map((item) => item.officialVersionId)])];
        const [versions, bindings, settings, reservations, inventory, candidates] = await Promise.all([
            client.query("SELECT data FROM vozeb_pro_model_official_price_versions WHERE id = ANY($1::text[])", [ids]),
            selections.length
                ? client.query("SELECT data FROM vozeb_pro_model_price_bindings WHERE current AND (logical_model_id, scope) IN (SELECT model_id, scope FROM unnest($1::text[], $2::text[]) AS selected(model_id, scope))", [
                      selections.map((item) => item.logicalModelId),
                      selections.map((item) => item.scope),
                  ])
                : { rows: [] },
            client.query("SELECT logical_models, default_models, model_point_costs, generation_point_multipliers FROM vozeb_pro_app_settings WHERE id = 'default'"),
            client.query(`SELECT reservation.status, data->>'modelId' AS "modelId", data->>'usageKind' AS "usageKind",
                    COALESCE(data #>> '{frozen,text,call,channelId}', data #>> '{frozen,image,call,channelId}', data #>> '{frozen,video,call,channelId}', data #>> '{frozen,audio,call,channelId}') AS "channelId",
                    COALESCE(data #>> '{frozen,text,call,requestedModel}', data #>> '{frozen,image,call,requestedModel}', data #>> '{frozen,video,call,requestedModel}', data #>> '{frozen,audio,call,requestedModel}') AS "requestedModel",
                    COALESCE(data #>> '{frozen,text,call,operation}', data #>> '{frozen,image,call,operation}', data #>> '{frozen,video,call,operation}', data #>> '{frozen,audio,call,operation}') AS operation,
                    data #>> '{frozen,version,id}' AS "officialVersionId", data #>> '{frozen,policy,id}' AS "salesVersionId",
                    data #>> '{frozen,contractId}' AS "contractId", data #>> '{frozen,priceSelection,scope}' AS "priceScope",
                    data #>> '{frozen,priceSelection,bindingId}' AS "priceBindingId", data #>> '{frozen,priceSelection,bindingRevision}' AS "priceBindingRevision",
                    data #>> '{submission,phase}' AS "submissionPhase",
                    data #>> '{preparation,taskType}' AS "taskType",
                    CASE WHEN NULLIF(data #>> '{preparation,taskId}', '') IS NULL THEN 'no-task-reference'
                         WHEN task.id IS NULL THEN 'task-not-found'
                         WHEN NULLIF(task.run_id, '') IS NULL THEN 'task-no-run'
                         ELSE 'run-linked' END AS "taskLinkage", count(*)::int AS count
                FROM vozeb_pro_model_pricing_wallet_reservations AS reservation
                LEFT JOIN vozeb_pro_generation_tasks AS task ON task.id = (reservation.data #>> '{preparation,taskId}') AND task.user_id = reservation.user_id
                WHERE reservation.status = 'reserved' OR (reservation.status = 'settled' AND (NULLIF(data->>'unpaidAtSettlement', '')::numeric > 0 OR jsonb_array_length(COALESCE(data->'billingWarnings', '[]'::jsonb)) > 0))
                GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15 ORDER BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15`),
            client.query(`SELECT count(*)::int AS total,
                    count(*) FILTER (WHERE logical_model_id = '')::int AS unbound,
                    count(*) FILTER (WHERE data ? 'linkedFromVersionId')::int AS "copiedLinks"
                FROM vozeb_pro_model_official_price_versions`),
            client.query("SELECT status, count(*)::int AS count FROM vozeb_pro_model_price_candidates GROUP BY status"),
        ]);
        const frozenOfficialIds = [...new Set(reservations.rows.map((row) => row.officialVersionId).filter(Boolean))];
        const frozenSalesIds = [...new Set(reservations.rows.map((row) => row.salesVersionId).filter(Boolean))];
        const frozenContractIds = [...new Set(reservations.rows.map((row) => row.contractId).filter(Boolean))];
        const [frozenVersions, frozenSales, frozenContracts] = await Promise.all([
            frozenOfficialIds.length ? client.query("SELECT id FROM vozeb_pro_model_official_price_versions WHERE id = ANY($1::text[])", [frozenOfficialIds]) : { rows: [] },
            frozenSalesIds.length ? client.query("SELECT id FROM vozeb_pro_model_sales_price_versions WHERE id = ANY($1::text[])", [frozenSalesIds]) : { rows: [] },
            frozenContractIds.length
                ? client.query(
                      "SELECT id FROM vozeb_pro_model_flat_text_price_contracts WHERE id = ANY($1::text[]) UNION ALL SELECT id FROM vozeb_pro_model_image_price_contracts WHERE id = ANY($1::text[]) UNION ALL SELECT id FROM vozeb_pro_model_video_price_contracts WHERE id = ANY($1::text[]) UNION ALL SELECT id FROM vozeb_pro_model_audio_price_contracts WHERE id = ANY($1::text[])",
                      [frozenContractIds],
                  )
                : { rows: [] },
        ]);
        const logicalModels = settings.rows[0]?.logical_models || [];
        const currentCalls = logicalModels.flatMap((model) =>
            (model.bindings || []).flatMap((binding) => {
                const operations = { text: ["generation"], image: ["generations", "edits"], video: ["generation"], audio: ["generateContent", "chat/completions"] }[model.capability] || [];
                return operations.flatMap((operation) => {
                    const scope = `${model.capability}:${operation}:standard`;
                    const officialVersionId = selections.find((item) => item.logicalModelId === model.id && item.scope === scope)?.officialVersionId || sales?.priceVersionIds?.[model.id];
                    return officialVersionId ? [{ capability: model.capability, officialVersionId, channelId: binding.channelId, requestedModel: binding.upstreamModel, operation }] : [];
                });
            }),
        );
        const callsFor = (capability) => currentCalls.filter((call) => call.capability === capability);
        const textCalls = callsFor("text"),
            imageCalls = callsFor("image"),
            videoCalls = callsFor("video"),
            audioCalls = callsFor("audio");
        const [textContracts, imageContracts, videoContracts, audioContracts] = await Promise.all([
            textCalls.length
                ? client.query(
                      "SELECT id, data FROM vozeb_pro_model_flat_text_price_contracts WHERE current AND (official_version_id, channel_id, requested_model) IN (SELECT official_version_id, channel_id, requested_model FROM unnest($1::text[], $2::text[], $3::text[]) AS wanted(official_version_id, channel_id, requested_model))",
                      [textCalls.map((call) => call.officialVersionId), textCalls.map((call) => call.channelId), textCalls.map((call) => call.requestedModel)],
                  )
                : { rows: [] },
            imageCalls.length
                ? client.query(
                      "SELECT id, data FROM vozeb_pro_model_image_price_contracts WHERE current AND (official_version_id, channel_id, requested_model, operation) IN (SELECT official_version_id, channel_id, requested_model, operation FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS wanted(official_version_id, channel_id, requested_model, operation))",
                      [imageCalls.map((call) => call.officialVersionId), imageCalls.map((call) => call.channelId), imageCalls.map((call) => call.requestedModel), imageCalls.map((call) => call.operation)],
                  )
                : { rows: [] },
            videoCalls.length
                ? client.query(
                      "SELECT id, data FROM vozeb_pro_model_video_price_contracts WHERE current AND (official_version_id, channel_id, requested_model) IN (SELECT official_version_id, channel_id, requested_model FROM unnest($1::text[], $2::text[], $3::text[]) AS wanted(official_version_id, channel_id, requested_model))",
                      [videoCalls.map((call) => call.officialVersionId), videoCalls.map((call) => call.channelId), videoCalls.map((call) => call.requestedModel)],
                  )
                : { rows: [] },
            audioCalls.length
                ? client.query(
                      "SELECT id, data FROM vozeb_pro_model_audio_price_contracts WHERE current AND (official_version_id, channel_id, requested_model) IN (SELECT official_version_id, channel_id, requested_model FROM unnest($1::text[], $2::text[], $3::text[]) AS wanted(official_version_id, channel_id, requested_model))",
                      [audioCalls.map((call) => call.officialVersionId), audioCalls.map((call) => call.channelId), audioCalls.map((call) => call.requestedModel)],
                  )
                : { rows: [] },
        ]);
        const channelIds = [...new Set(logicalModels.flatMap((model) => (model.bindings || []).map((binding) => binding.channelId)).filter(Boolean))];
        const channelColumns = "id, name, enabled, api_format, models, advanced_config->>'protocol' AS protocol, advanced_config->'modelCapabilities' AS model_capabilities";
        const channels = channelIds.length
            ? await client.query(`SELECT ${channelColumns} FROM vozeb_pro_system_model_channels WHERE id = ANY($1::text[])`, [channelIds])
            : logicalModels.length
              ? { rows: [] }
              : await client.query(`SELECT ${channelColumns} FROM vozeb_pro_system_model_channels`);
        await client.query("COMMIT");
        return {
            pricing: { currentSales: sales, officialVersions: versions.rows.map((row) => row.data), priceBindings: bindings.rows.map((row) => row.data), activations: state.billing_activations || {} },
            models: logicalModels,
            channels: channels.rows.map((row) => ({ id: row.id, name: row.name, enabled: row.enabled, apiFormat: row.api_format, models: row.models, advancedConfig: { protocol: row.protocol, modelCapabilities: row.model_capabilities } })),
            defaultModels: settings.rows[0]?.default_models || {},
            modelPointCosts: settings.rows[0]?.model_point_costs ?? null,
            generationPointMultipliers: settings.rows[0]?.generation_point_multipliers ?? null,
            currentContracts: [...textContracts.rows, ...imageContracts.rows, ...videoContracts.rows, ...audioContracts.rows].map((row) => ({ ...row.data, id: row.id, current: true })),
            officialInventory: inventory.rows[0] || { total: 0, unbound: 0, copiedLinks: 0 },
            candidateStatuses: Object.fromEntries(["pending", "approved", "rejected"].map((status) => [status, candidates.rows.find((row) => row.status === status)?.count || 0])),
            frozenReferenceCatalog: { officialVersionIds: frozenVersions.rows.map((row) => row.id), salesVersionIds: frozenSales.rows.map((row) => row.id), contractIds: frozenContracts.rows.map((row) => row.id) },
            reservations: reservations.rows.map((row) => ({
                status: row.status,
                modelId: row.modelId,
                usageKind: row.usageKind,
                channelId: row.channelId,
                requestedModel: row.requestedModel,
                operation: row.operation,
                frozen: { version: { id: row.officialVersionId }, policy: { id: row.salesVersionId }, contractId: row.contractId, priceSelection: { scope: row.priceScope, bindingId: row.priceBindingId, bindingRevision: row.priceBindingRevision } },
                submission: { phase: row.submissionPhase },
                preparation: { taskType: row.taskType },
                taskLinkage: row.taskLinkage,
                count: row.count,
            })),
        };
    } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
    } finally {
        await client.end();
    }
}
