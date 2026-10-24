-- Run through psql with ON_ERROR_STOP=1. All business reads share one read-only snapshot.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

\echo 'schema and current sale'
SELECT current_database() AS database_name,
       to_regclass('vozeb_pro_model_price_bindings') IS NOT NULL AS independent_bindings_table_exists,
       state.current_sales_version_id,
       count(*) FILTER (WHERE activation.value->>'enabled' = 'true') AS enabled_activations
FROM vozeb_pro_model_pricing_state AS state
LEFT JOIN LATERAL jsonb_each(state.billing_activations) AS activation ON true
WHERE state.id = 'default'
GROUP BY state.current_sales_version_id;

\echo 'published prices and configured routes; no channel credentials are read'
WITH current_sale AS (
    SELECT sale.data
    FROM vozeb_pro_model_pricing_state AS state
    JOIN vozeb_pro_model_sales_price_versions AS sale ON sale.id = state.current_sales_version_id
    WHERE state.id = 'default'
), published AS (
    SELECT reference.key AS model_id, reference.value AS official_version_id,
           'legacy' AS reference_kind, NULL::text AS scope,
           NULL::text AS price_binding_id, NULL::text AS price_binding_revision
    FROM current_sale, LATERAL jsonb_each_text(COALESCE(data->'priceVersionIds', '{}'::jsonb)) AS reference
    UNION ALL
    SELECT selection->>'logicalModelId', selection->>'officialVersionId',
           'selected', selection->>'scope', selection->>'bindingId', selection->>'bindingRevision'
    FROM current_sale, LATERAL jsonb_array_elements(COALESCE(data->'selectedPriceBindings', '[]'::jsonb)) AS item(selection)
), logical_models AS (
    SELECT item.model FROM vozeb_pro_app_settings AS settings,
         LATERAL jsonb_array_elements(settings.logical_models) AS item(model)
    WHERE settings.id = 'default'
)
SELECT published.model_id, published.reference_kind, published.scope,
       published.price_binding_id, published.price_binding_revision,
       model->>'capability' AS capability,
       COALESCE((model->>'enabled')::boolean, true) AS model_enabled,
       published.official_version_id,
       version.data->>'sku' AS official_sku,
       version.data->>'tier' AS price_tier,
       version.data->>'effectiveFrom' AS effective_from,
       version.data->>'effectiveTo' AS effective_to,
       route->>'id' AS channel_binding_id,
       COALESCE((route->>'enabled')::boolean, false) AS binding_enabled,
       COALESCE((route->>'acceptanceOnly')::boolean, false) AS acceptance_only,
       route->>'channelId' AS channel_id, route->>'upstreamModel' AS requested_model,
       channel.enabled AS channel_enabled, channel.api_format,
       channel.advanced_config->>'protocol' AS channel_protocol
FROM published
LEFT JOIN vozeb_pro_model_official_price_versions AS version ON version.id = published.official_version_id
LEFT JOIN logical_models ON model->>'id' = published.model_id
LEFT JOIN LATERAL jsonb_array_elements(COALESCE(model->'bindings', '[]'::jsonb)) AS item(route) ON true
LEFT JOIN vozeb_pro_system_model_channels AS channel ON channel.id = route->>'channelId'
ORDER BY published.model_id, published.scope, route->>'channelId', route->>'upstreamModel';

\echo 'active approvals; historical sale IDs are evidence for review, not a failure verdict'
WITH state AS (
    SELECT current_sales_version_id, billing_activations
    FROM vozeb_pro_model_pricing_state WHERE id = 'default'
), approvals AS (
    SELECT activation.key AS activation_key, activation.value AS approval,
           binding.key AS approved_binding_key, binding.value AS binding_evidence
    FROM state, LATERAL jsonb_each(state.billing_activations) AS activation
    LEFT JOIN LATERAL jsonb_each(COALESCE(activation.value->'bindings', '{}'::jsonb)) AS binding ON true
    WHERE activation.value->>'enabled' = 'true'
)
SELECT COALESCE(approval->>'modelId', activation_key) AS model_id, approval->>'scope' AS scope,
       approval->>'officialVersionId' AS official_version_id,
       approval->>'salesVersionId' AS activation_sales_version_id,
       state.current_sales_version_id,
       approval->>'salesVersionId' = state.current_sales_version_id AS same_sale_version_id,
       approved_binding_key,
       binding_evidence ? 'fingerprint' AS has_binding_fingerprint,
       (SELECT count(*) FROM jsonb_object_keys(COALESCE(binding_evidence->'shadowReceiptIds', '{}'::jsonb))) AS binding_shadow_receipts,
       jsonb_array_length(COALESCE(binding_evidence->'contractIds', '[]'::jsonb)) AS binding_contracts,
       approval ? 'fingerprint' AS has_activation_fingerprint
FROM approvals CROSS JOIN state
ORDER BY model_id, scope, approved_binding_key;

\echo 'fixed-point settings and default model references'
SELECT model_point_costs, generation_point_multipliers, default_models
FROM vozeb_pro_app_settings WHERE id = 'default';

\echo 'current contract identities for published prices'
WITH published AS (
    SELECT DISTINCT reference.value AS official_version_id
    FROM vozeb_pro_model_pricing_state AS state
    JOIN vozeb_pro_model_sales_price_versions AS sale ON sale.id = state.current_sales_version_id,
         LATERAL jsonb_each_text(COALESCE(sale.data->'priceVersionIds', '{}'::jsonb)) AS reference
    WHERE state.id = 'default'
    UNION
    SELECT DISTINCT selection->>'officialVersionId'
    FROM vozeb_pro_model_pricing_state AS state
    JOIN vozeb_pro_model_sales_price_versions AS sale ON sale.id = state.current_sales_version_id,
         LATERAL jsonb_array_elements(COALESCE(sale.data->'selectedPriceBindings', '[]'::jsonb)) AS item(selection)
    WHERE state.id = 'default'
), contracts AS (
    SELECT 'text' AS capability, 'generation' AS operation, id, official_version_id, channel_id, requested_model
    FROM vozeb_pro_model_flat_text_price_contracts WHERE current
    UNION ALL
    SELECT 'image', operation, id, official_version_id, channel_id, requested_model
    FROM vozeb_pro_model_image_price_contracts WHERE current
    UNION ALL
    SELECT 'video', 'generation', id, official_version_id, channel_id, requested_model
    FROM vozeb_pro_model_video_price_contracts WHERE current
    UNION ALL
    SELECT 'audio', COALESCE(data->>'operation', 'unspecified'), id, official_version_id, channel_id, requested_model
    FROM vozeb_pro_model_audio_price_contracts WHERE current
)
SELECT contracts.* FROM contracts
JOIN published USING (official_version_id)
ORDER BY capability, official_version_id, channel_id, requested_model, operation;

\echo 'unfinished or pending-billing tasks, grouped without user IDs or payloads'
SELECT task_type, status, execution_phase,
       COALESCE(payload->>'billingMode', 'unspecified') AS billing_mode,
       COALESCE(payload->>'billingPending', 'false') AS billing_pending,
       count(*) AS tasks
FROM vozeb_pro_generation_tasks
WHERE status IN ('pending', 'running', 'paused')
   OR execution_phase IN ('needs_review', 'review_pending', 'reviewing', 'review_unavailable')
   OR payload @> '{"billingMode":"official-usage","billingPending":true}'::jsonb
GROUP BY task_type, status, execution_phase, payload->>'billingMode', payload->>'billingPending'
ORDER BY task_type, status, execution_phase, billing_mode;

\echo 'cancelled review tasks and exact refund coverage'
SELECT task.task_type, COALESCE(task.last_upstream_status, 'none') AS last_upstream_status,
       count(DISTINCT task.id) AS tasks, count(reservation.request_id) AS linked_wallet_records,
       count(reservation.request_id) FILTER (WHERE reservation.status = 'settled') AS settled_wallet_records,
       count(reservation.request_id) FILTER (WHERE reservation.data->>'refundedUnits' = reservation.data->>'units'
           AND reservation.data->>'refundedExactPoints' = reservation.data #>> '{settlement,actualExactPoints}') AS fully_refunded_records
FROM vozeb_pro_generation_tasks AS task
LEFT JOIN vozeb_pro_model_pricing_wallet_reservations AS reservation
  ON reservation.user_id = task.user_id AND (reservation.data #>> '{preparation,taskId}') = task.id
WHERE task.status = 'cancelled' AND task.execution_phase = 'needs_review'
GROUP BY task.task_type, task.last_upstream_status
ORDER BY task.task_type, last_upstream_status;

\echo 'open reservations and settled exceptions, grouped without user IDs or request bodies'
SELECT reservation.status, data->>'modelId' AS model_id,
       data->>'usageKind' AS usage_kind,
       data #>> '{frozen,version,id}' AS official_version_id,
       data #>> '{frozen,policy,id}' AS sales_version_id,
       data #>> '{frozen,contractId}' AS contract_id,
       data #>> '{frozen,priceSelection,bindingId}' AS price_binding_id,
       data #>> '{submission,phase}' AS submission_phase,
       CASE WHEN NULLIF(data #>> '{preparation,taskId}', '') IS NULL THEN 'no-task-reference'
            WHEN task.id IS NULL THEN 'task-not-found'
            WHEN task.run_id IS NULL THEN 'task-no-run'
            ELSE 'run-linked' END AS task_linkage,
       count(*) AS reservations
FROM vozeb_pro_model_pricing_wallet_reservations AS reservation
LEFT JOIN vozeb_pro_generation_tasks AS task
  ON task.id = (reservation.data #>> '{preparation,taskId}') AND task.user_id = reservation.user_id
WHERE reservation.status = 'reserved'
   OR (reservation.status = 'settled' AND
       (COALESCE(NULLIF(data->>'unpaidAtSettlement', '')::numeric, 0) > 0
        OR jsonb_array_length(COALESCE(data->'billingWarnings', '[]'::jsonb)) > 0))
GROUP BY reservation.status, data->>'modelId', data->>'usageKind',
         data #>> '{frozen,version,id}', data #>> '{frozen,policy,id}',
         data #>> '{frozen,contractId}', data #>> '{frozen,priceSelection,bindingId}',
         data #>> '{submission,phase}', task_linkage
ORDER BY reservation.status, model_id, usage_kind;

COMMIT;
