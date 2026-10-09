import { ALL_ADMIN_PERMISSIONS } from "@/lib/admin-permissions";
import { POSTGRESQL_COMMERCIAL_FEATURES_SCHEMA_SQL } from "./schema-commercial-features";
import { POSTGRESQL_TRIGGER_SCHEMA_SQL } from "./schema-triggers";

const FULL_ADMIN_PERMISSIONS_JSON = JSON.stringify(ALL_ADMIN_PERMISSIONS);

export const POSTGRESQL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION vozeb_pro_set_updated_at()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TABLE IF EXISTS check_ins;

CREATE TABLE IF NOT EXISTS entitlement_plans (
    id text PRIMARY KEY,
    name text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    daily_points numeric(18, 2) NOT NULL DEFAULT 0,
    limits jsonb NOT NULL DEFAULT '{}'::jsonb,
    features jsonb NOT NULL DEFAULT '[]'::jsonb,
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO entitlement_plans (id, name, enabled, limits, features, sort_order)
VALUES (
    'free',
    '免费版',
    true,
    '{"dailyPointSpend":0,"dailyApiCalls":0,"dailyImages":0,"dailyVideos":0,"dailyAudio":0,"dailyText":0}'::jsonb,
    '["system-api","points-wallet"]'::jsonb,
    0
)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE entitlement_plans ADD COLUMN IF NOT EXISTS daily_points numeric(18, 2) NOT NULL DEFAULT 0;

INSERT INTO entitlement_plans (id, name, enabled, limits, features, sort_order)
VALUES
(
    'creator',
    '创作者版',
    true,
    '{"dailyPointSpend":800,"dailyApiCalls":0,"dailyImages":80,"dailyVideos":12,"dailyAudio":0,"dailyText":200}'::jsonb,
    '["system-api","points-wallet","image-workbench","video-workbench","prompt-library"]'::jsonb,
    10
),
(
    'pro',
    '专业版',
    true,
    '{"dailyPointSpend":4000,"dailyApiCalls":0,"dailyImages":300,"dailyVideos":50,"dailyAudio":0,"dailyText":800}'::jsonb,
    '["system-api","points-wallet","image-workbench","video-workbench","prompt-library","priority-generation"]'::jsonb,
    20
)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS app_settings (
    id text PRIMARY KEY DEFAULT 'default',
    site jsonb NOT NULL DEFAULT '{}'::jsonb,
    registration_enabled boolean NOT NULL DEFAULT true,
    email_registration_enabled boolean NOT NULL DEFAULT false,
    free_daily_points_enabled boolean NOT NULL DEFAULT true,
    free_daily_points numeric(18, 2) NOT NULL DEFAULT 0,
    mail jsonb NOT NULL DEFAULT '{}'::jsonb,
    allow_user_api_config boolean NOT NULL DEFAULT false,
    model_point_costs jsonb NOT NULL DEFAULT '{}'::jsonb,
    generation_point_multipliers jsonb NOT NULL DEFAULT '{}'::jsonb,
    generation_cost_control jsonb NOT NULL DEFAULT '{}'::jsonb,
    data_lifecycle jsonb NOT NULL DEFAULT '{}'::jsonb,
    entitlements_enabled boolean NOT NULL DEFAULT false,
    default_plan_id text NOT NULL DEFAULT 'free' REFERENCES entitlement_plans(id),
    generation_concurrency jsonb NOT NULL DEFAULT '{}'::jsonb,
    generation_defaults jsonb NOT NULL DEFAULT '{}'::jsonb,
    payment_config jsonb NOT NULL DEFAULT '{}'::jsonb,
    logical_models jsonb NOT NULL DEFAULT '[]'::jsonb,
    default_models jsonb NOT NULL DEFAULT '{}'::jsonb,
    agent_skills jsonb NOT NULL DEFAULT '[{"id":"ecommerce-image","name":"电商生图","description":"为商品主图、场景图和详情页视觉生成结构化方案。","instructions":"识别商品卖点、目标人群、平台与画幅。优先规划白底主图、核心卖点场景图、细节特写和详情页横幅；保持商品外观、材质、颜色、Logo 与包装一致。提示词必须写清主体、构图、光线、背景、镜头、商业质感、尺寸比例与禁止变形要求。","enabled":true,"keywords":["电商","商品","主图","详情页","淘宝","京东","亚马逊"]}]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT app_settings_singleton CHECK (id = 'default')
);

INSERT INTO app_settings (id)
VALUES ('default')
ON CONFLICT (id) DO NOTHING;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS agent_skills jsonb NOT NULL DEFAULT '[{"id":"ecommerce-image","name":"电商生图","description":"为商品主图、场景图和详情页视觉生成结构化方案。","instructions":"识别商品卖点、目标人群、平台与画幅。优先规划白底主图、核心卖点场景图、细节特写和详情页横幅；保持商品外观、材质、颜色、Logo 与包装一致。提示词必须写清主体、构图、光线、背景、镜头、商业质感、尺寸比例与禁止变形要求。","enabled":true,"keywords":["电商","商品","主图","详情页","淘宝","京东","亚马逊"]}]'::jsonb;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS logical_models jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS free_daily_points_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS free_daily_points numeric(18, 2) NOT NULL DEFAULT 0;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS generation_cost_control jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS data_lifecycle jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS system_model_channels (
    id text PRIMARY KEY,
    name text NOT NULL,
    base_url text NOT NULL DEFAULT '',
    api_key_ciphertext text NOT NULL DEFAULT '',
    webhook_secret_ciphertext text NOT NULL DEFAULT '',
    api_format text NOT NULL DEFAULT 'openai',
    models jsonb NOT NULL DEFAULT '[]'::jsonb,
    enabled boolean NOT NULL DEFAULT true,
    advanced_config jsonb,
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT system_model_channels_api_format CHECK (api_format IN ('openai', 'gemini'))
);
ALTER TABLE system_model_channels ADD COLUMN IF NOT EXISTS webhook_secret_ciphertext text NOT NULL DEFAULT '';

CREATE SEQUENCE IF NOT EXISTS user_account_id_seq START WITH 1;

CREATE TABLE IF NOT EXISTS users (
    id text PRIMARY KEY,
    account_id bigint NOT NULL DEFAULT nextval('user_account_id_seq'),
    username text NOT NULL,
    email text,
    display_name text NOT NULL,
    bio text NOT NULL DEFAULT '',
    avatar_storage_key text,
    role text NOT NULL DEFAULT 'user',
    admin_permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
    status text NOT NULL DEFAULT 'active',
    plan_id text NOT NULL DEFAULT 'free' REFERENCES entitlement_plans(id),
    points_balance numeric(18, 2) NOT NULL DEFAULT 0,
    password_hash text NOT NULL,
    mfa_secret_ciphertext text,
    mfa_enabled_at timestamptz,
    terms_version text,
    terms_url text,
    privacy_version text,
    privacy_url text,
    policy_accepted_at timestamptz,
    last_login_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_role CHECK (role IN ('admin', 'user')),
    CONSTRAINT users_admin_permissions_array CHECK (jsonb_typeof(admin_permissions) = 'array'),
    CONSTRAINT users_status CHECK (status IN ('active', 'disabled')),
    CONSTRAINT users_mfa_enabled_secret CHECK (mfa_enabled_at IS NULL OR mfa_secret_ciphertext IS NOT NULL),
    CONSTRAINT users_registration_consent_complete CHECK (
        (terms_version IS NULL AND terms_url IS NULL AND privacy_version IS NULL AND privacy_url IS NULL AND policy_accepted_at IS NULL)
        OR
        (terms_version IS NOT NULL AND terms_url IS NOT NULL AND privacy_version IS NOT NULL AND privacy_url IS NOT NULL AND policy_accepted_at IS NOT NULL)
    ),
    CONSTRAINT users_bio_length CHECK (char_length(bio) <= 160)
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS bio text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_storage_key text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_id bigint;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret_ciphertext text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_permissions jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_url text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_version text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_url text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS policy_accepted_at timestamptz;
UPDATE users
SET admin_permissions = '${FULL_ADMIN_PERMISSIONS_JSON}'::jsonb
WHERE id = (
    SELECT id
    FROM users
    WHERE role = 'admin'
    ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, created_at ASC, id ASC
    LIMIT 1
)
AND NOT EXISTS (
    SELECT 1
    FROM users
    WHERE role = 'admin'
      AND status = 'active'
      AND admin_permissions @> '${FULL_ADMIN_PERMISSIONS_JSON}'::jsonb
);

WITH sequence_state AS (
    SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS reserved_max FROM user_account_id_seq
), current_state AS (
    SELECT greatest(coalesce(max(account_id), 0), (SELECT reserved_max FROM sequence_state)) AS assigned_max FROM users
), missing_accounts AS (
    SELECT id, (SELECT assigned_max FROM current_state) + row_number() OVER (ORDER BY created_at ASC, id ASC) AS next_account_id
    FROM users
    WHERE account_id IS NULL
)
UPDATE users
SET account_id = missing_accounts.next_account_id
FROM missing_accounts
WHERE users.id = missing_accounts.id;

ALTER TABLE users ALTER COLUMN account_id SET DEFAULT nextval('user_account_id_seq');
ALTER TABLE users ALTER COLUMN account_id SET NOT NULL;

SELECT setval(
    'user_account_id_seq',
    greatest((SELECT last_value FROM user_account_id_seq), coalesce((SELECT max(account_id) FROM users), 1)),
    (SELECT is_called FROM user_account_id_seq) OR EXISTS (SELECT 1 FROM users)
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_bio_length') THEN
        ALTER TABLE users ADD CONSTRAINT users_bio_length CHECK (char_length(bio) <= 160);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_registration_consent_complete') THEN
        ALTER TABLE users ADD CONSTRAINT users_registration_consent_complete CHECK (
            (terms_version IS NULL AND terms_url IS NULL AND privacy_version IS NULL AND privacy_url IS NULL AND policy_accepted_at IS NULL)
            OR
            (terms_version IS NOT NULL AND terms_url IS NOT NULL AND privacy_version IS NOT NULL AND privacy_url IS NOT NULL AND policy_accepted_at IS NOT NULL)
        );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_mfa_enabled_secret') THEN
        ALTER TABLE users ADD CONSTRAINT users_mfa_enabled_secret CHECK (mfa_enabled_at IS NULL OR mfa_secret_ciphertext IS NOT NULL);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_admin_permissions_array') THEN
        ALTER TABLE users ADD CONSTRAINT users_admin_permissions_array CHECK (jsonb_typeof(admin_permissions) = 'array');
    END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email)) WHERE email IS NOT NULL AND email <> '';
CREATE UNIQUE INDEX IF NOT EXISTS users_account_id_idx ON users (account_id);
CREATE INDEX IF NOT EXISTS users_plan_id_idx ON users (plan_id);

CREATE TABLE IF NOT EXISTS tenants (
    id text PRIMARY KEY,
    slug text NOT NULL,
    name text NOT NULL,
    owner_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tenants_name_length CHECK (char_length(name) BETWEEN 1 AND 80),
    CONSTRAINT tenants_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$')
);

CREATE UNIQUE INDEX IF NOT EXISTS tenants_slug_lower_idx ON tenants (lower(slug));

CREATE TABLE IF NOT EXISTS tenant_memberships (
    tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    role text NOT NULL,
    status text NOT NULL DEFAULT 'active',
    created_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id),
    UNIQUE (user_id),
    CONSTRAINT tenant_memberships_role CHECK (role IN ('owner', 'admin', 'member')),
    CONSTRAINT tenant_memberships_status CHECK (status IN ('active', 'disabled'))
);

CREATE INDEX IF NOT EXISTS tenant_memberships_tenant_status_idx ON tenant_memberships (tenant_id, status, role, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS tenant_memberships_single_active_owner_idx ON tenant_memberships (tenant_id) WHERE role = 'owner' AND status = 'active';

CREATE TABLE IF NOT EXISTS sessions (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS account_deletion_requests (
    id text PRIMARY KEY,
    user_id text NOT NULL,
    username_snapshot text NOT NULL,
    display_name_snapshot text NOT NULL,
    email_snapshot text,
    status text NOT NULL DEFAULT 'pending',
    request_note text NOT NULL DEFAULT '',
    review_note text NOT NULL DEFAULT '',
    reviewed_by_user_id text,
    reviewed_by_username text,
    requested_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    handled_at timestamptz,
    CONSTRAINT account_deletion_requests_status CHECK (status IN ('pending', 'accepted', 'rejected', 'withdrawn'))
);

CREATE UNIQUE INDEX IF NOT EXISTS account_deletion_requests_user_pending_idx ON account_deletion_requests (user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS account_deletion_requests_user_created_idx ON account_deletion_requests (user_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS account_deletion_requests_status_created_idx ON account_deletion_requests (status, requested_at DESC);

CREATE TABLE IF NOT EXISTS rate_limits (
    key_hash text PRIMARY KEY,
    request_count integer NOT NULL DEFAULT 0,
    reset_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rate_limits_reset_idx ON rate_limits (reset_at);

CREATE TABLE IF NOT EXISTS generation_tasks (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_type text NOT NULL,
    status text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    CONSTRAINT generation_tasks_type CHECK (task_type IN ('text', 'image', 'video', 'audio', 'agent', 'render')),
    CONSTRAINT generation_tasks_status CHECK (status IN ('pending', 'running', 'success', 'error', 'paused', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS generation_tasks_user_status_idx ON generation_tasks (user_id, task_type, status, updated_at DESC);
ALTER TABLE generation_tasks DROP CONSTRAINT IF EXISTS generation_tasks_type;
ALTER TABLE generation_tasks ADD CONSTRAINT generation_tasks_type CHECK (task_type IN ('text', 'image', 'video', 'audio', 'agent', 'render'));
ALTER TABLE generation_tasks DROP CONSTRAINT IF EXISTS generation_tasks_status;
ALTER TABLE generation_tasks ADD CONSTRAINT generation_tasks_status CHECK (status IN ('pending', 'running', 'success', 'error', 'paused', 'cancelled'));
CREATE INDEX IF NOT EXISTS generation_tasks_expires_idx ON generation_tasks (expires_at);
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS conversation_id text;
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS run_id text;
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS surface text;
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS project_id text;
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS parent_task_id text;
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS attempt_no integer;
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS client_request_id text;
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS execution_phase text NOT NULL DEFAULT 'created';
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS upstream_task_id text;
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS channel_id text;
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS query_path text;
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS submitted_at timestamptz;
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS next_poll_at timestamptz;
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS last_poll_at timestamptz;
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS last_upstream_status text;
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS result_payload jsonb;
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS worker_id text;
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS lease_until timestamptz;
ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz;
ALTER TABLE generation_tasks DROP CONSTRAINT IF EXISTS generation_tasks_execution_phase;
ALTER TABLE generation_tasks ADD CONSTRAINT generation_tasks_execution_phase CHECK (execution_phase IN ('created', 'submitting', 'submitted', 'polling', 'result_ready', 'persisting', 'cancel_requested', 'cancel_polling', 'needs_review', 'review_pending', 'reviewing', 'review_unavailable', 'completed'));

DROP INDEX IF EXISTS generation_tasks_user_client_request_idx;
CREATE UNIQUE INDEX generation_tasks_user_client_request_idx ON generation_tasks (user_id, task_type, client_request_id, COALESCE(attempt_no, 0)) WHERE client_request_id IS NOT NULL AND client_request_id <> '';
CREATE UNIQUE INDEX IF NOT EXISTS generation_tasks_channel_upstream_idx ON generation_tasks (channel_id, upstream_task_id) WHERE channel_id IS NOT NULL AND channel_id <> '' AND upstream_task_id IS NOT NULL AND upstream_task_id <> '';
CREATE INDEX IF NOT EXISTS generation_tasks_conversation_idx ON generation_tasks (conversation_id, updated_at DESC) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS generation_tasks_run_idx ON generation_tasks (run_id, updated_at DESC) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS generation_tasks_user_project_idx ON generation_tasks (user_id, project_id, task_type, status) WHERE project_id IS NOT NULL;
DROP INDEX IF EXISTS generation_tasks_recovery_due_idx;
CREATE INDEX generation_tasks_recovery_due_idx ON generation_tasks (next_poll_at, lease_until, id) WHERE (status IN ('pending', 'running') AND execution_phase IN ('created', 'submitting', 'submitted', 'polling', 'result_ready', 'persisting')) OR (status = 'cancelled' AND execution_phase IN ('cancel_requested', 'cancel_polling')) OR (task_type = 'agent' AND status = 'success' AND execution_phase IN ('review_pending', 'reviewing'));

CREATE TABLE IF NOT EXISTS generation_concurrency_reservations (
    user_id text NOT NULL,
    task_type text NOT NULL,
    request_id text NOT NULL,
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (user_id, task_type, request_id),
    CONSTRAINT generation_concurrency_reservations_type CHECK (task_type IN ('text', 'image', 'video', 'audio', 'agent', 'render'))
);
CREATE INDEX IF NOT EXISTS generation_concurrency_reservations_expires_idx ON generation_concurrency_reservations (expires_at);

CREATE TABLE IF NOT EXISTS generation_worker_heartbeats (
    worker_id text PRIMARY KEY,
    last_seen_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS generation_worker_heartbeats_seen_idx ON generation_worker_heartbeats (last_seen_at DESC);

CREATE TABLE IF NOT EXISTS generation_webhook_events (
    channel_id text NOT NULL,
    event_id text NOT NULL,
    upstream_task_id text NOT NULL,
    task_id text,
    task_type text,
    payload_hash text NOT NULL,
    signature_timestamp timestamptz NOT NULL,
    status text NOT NULL DEFAULT 'received',
    conflict_count integer NOT NULL DEFAULT 0,
    last_conflict_payload_hash text,
    last_conflict_at timestamptz,
    received_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz,
    PRIMARY KEY (channel_id, event_id)
);

ALTER TABLE generation_webhook_events ADD COLUMN IF NOT EXISTS signature_timestamp timestamptz;
UPDATE generation_webhook_events SET signature_timestamp = COALESCE(signature_timestamp, received_at) WHERE signature_timestamp IS NULL;
ALTER TABLE generation_webhook_events ALTER COLUMN signature_timestamp SET NOT NULL;
ALTER TABLE generation_webhook_events ADD COLUMN IF NOT EXISTS conflict_count integer NOT NULL DEFAULT 0;
ALTER TABLE generation_webhook_events ADD COLUMN IF NOT EXISTS last_conflict_payload_hash text;
ALTER TABLE generation_webhook_events ADD COLUMN IF NOT EXISTS last_conflict_at timestamptz;

CREATE INDEX IF NOT EXISTS generation_webhook_events_received_idx ON generation_webhook_events (received_at DESC);

CREATE TABLE IF NOT EXISTS creative_conversations (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    surface text NOT NULL,
    source text NOT NULL DEFAULT 'agent',
    project_id text,
    title text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'active',
    context_summary text NOT NULL DEFAULT '',
    context_summary_through_sequence integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    last_message_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT creative_conversations_surface CHECK (surface IN ('chat', 'canvas', 'drama')),
    CONSTRAINT creative_conversations_source CHECK (source IN ('agent', 'image-workbench', 'video-workbench', 'canvas', 'drama')),
    CONSTRAINT creative_conversations_status CHECK (status IN ('active', 'archived'))
);
ALTER TABLE creative_conversations ADD COLUMN IF NOT EXISTS context_summary text NOT NULL DEFAULT '';
ALTER TABLE creative_conversations ADD COLUMN IF NOT EXISTS context_summary_through_sequence integer NOT NULL DEFAULT 0;
ALTER TABLE creative_conversations ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'agent';
UPDATE creative_conversations SET source = surface WHERE surface IN ('canvas', 'drama') AND source = 'agent';

CREATE INDEX IF NOT EXISTS creative_conversations_user_updated_idx ON creative_conversations (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS creative_conversations_user_source_idx ON creative_conversations (user_id, surface, source, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS creative_conversations_project_idx ON creative_conversations (user_id, surface, project_id, updated_at DESC) WHERE project_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS creative_messages (
    id text PRIMARY KEY,
    conversation_id text NOT NULL REFERENCES creative_conversations(id) ON DELETE CASCADE,
    sequence integer NOT NULL,
    role text NOT NULL,
    status text NOT NULL,
    content text NOT NULL DEFAULT '',
    run_id text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT creative_messages_role CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    CONSTRAINT creative_messages_status CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
    CONSTRAINT creative_messages_sequence CHECK (sequence > 0),
    UNIQUE (conversation_id, sequence)
);

CREATE INDEX IF NOT EXISTS creative_messages_conversation_sequence_idx ON creative_messages (conversation_id, sequence ASC);
CREATE INDEX IF NOT EXISTS creative_messages_run_idx ON creative_messages (run_id) WHERE run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS creative_assets (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id text NOT NULL REFERENCES creative_conversations(id) ON DELETE CASCADE,
    message_id text REFERENCES creative_messages(id) ON DELETE SET NULL,
    source_run_id text,
    source_task_id text,
    parent_asset_id text REFERENCES creative_assets(id) ON DELETE SET NULL,
    ordinal integer NOT NULL DEFAULT 0,
    type text NOT NULL,
    status text NOT NULL DEFAULT 'ready',
    title text NOT NULL DEFAULT '',
    text_content text,
    storage_kind text,
    storage_key text,
    remote_url text,
    server_url text,
    mime_type text,
    width integer,
    height integer,
    duration_ms integer,
    bytes bigint,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT creative_assets_type CHECK (type IN ('text', 'image', 'video', 'audio')),
    CONSTRAINT creative_assets_status CHECK (status IN ('ready', 'failed', 'deleted')),
    CONSTRAINT creative_assets_storage_kind CHECK (storage_kind IS NULL OR storage_kind IN ('local', 'object', 'remote')),
    UNIQUE (source_run_id, source_task_id, ordinal)
);

CREATE INDEX IF NOT EXISTS creative_assets_conversation_idx ON creative_assets (conversation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS creative_assets_run_idx ON creative_assets (source_run_id, ordinal ASC) WHERE source_run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS local_media_assets (
    storage_key text PRIMARY KEY,
    scope text NOT NULL,
    storage_class text NOT NULL,
    type text NOT NULL,
    owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    original_name text,
    source text NOT NULL DEFAULT '',
    conversation_id text,
    run_id text,
    task_id text,
    project_id text,
    mime_type text NOT NULL DEFAULT '',
    bytes bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz,
    CONSTRAINT local_media_assets_scope CHECK (scope IN ('generation', 'reference')),
    CONSTRAINT local_media_assets_class CHECK (storage_class IN ('temporary', 'permanent')),
    CONSTRAINT local_media_assets_type CHECK (type IN ('image', 'video', 'audio'))
);

CREATE INDEX IF NOT EXISTS local_media_assets_owner_created_idx ON local_media_assets (owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS local_media_assets_source_idx ON local_media_assets (source, created_at DESC);
CREATE INDEX IF NOT EXISTS local_media_assets_expires_idx ON local_media_assets (expires_at) WHERE expires_at IS NOT NULL;

ALTER TABLE local_media_assets ADD COLUMN IF NOT EXISTS storage_provider text NOT NULL DEFAULT 'local';
ALTER TABLE local_media_assets ADD COLUMN IF NOT EXISTS external_storage_id text;
ALTER TABLE local_media_assets ADD COLUMN IF NOT EXISTS external_object_key text;
ALTER TABLE local_media_assets ADD COLUMN IF NOT EXISTS external_synced_at timestamptz;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'local_media_assets_storage_provider_check') THEN
        ALTER TABLE local_media_assets ADD CONSTRAINT local_media_assets_storage_provider_check CHECK (storage_provider IN ('local', 'object'));
    END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS local_media_assets_external_object_idx ON local_media_assets (external_storage_id, external_object_key) WHERE external_object_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS local_media_assets_local_created_idx ON local_media_assets (created_at DESC) WHERE storage_provider = 'local';
CREATE INDEX IF NOT EXISTS local_media_assets_local_filter_idx ON local_media_assets (storage_class, type, created_at DESC) WHERE storage_provider = 'local';

CREATE TABLE IF NOT EXISTS object_storage_settings (
    id text PRIMARY KEY DEFAULT 'default',
    enabled boolean NOT NULL DEFAULT false,
    endpoint text NOT NULL DEFAULT '',
    region text NOT NULL DEFAULT 'us-east-1',
    bucket text NOT NULL DEFAULT '',
    prefix text NOT NULL DEFAULT 'vozeb-pro',
    access_key_id_ciphertext text NOT NULL DEFAULT '',
    secret_access_key_ciphertext text NOT NULL DEFAULT '',
    force_path_style boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT object_storage_settings_singleton CHECK (id = 'default')
);

INSERT INTO object_storage_settings (id) VALUES ('default') ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
    legacy_name text := 'local_' || 'media_assets';
    target_name text := 'vozeb_pro_' || legacy_name;
BEGIN
    IF to_regclass('public.' || legacy_name) IS NOT NULL AND to_regclass('public.' || target_name) IS NOT NULL THEN
        EXECUTE format(
            'INSERT INTO %I (storage_key, scope, storage_class, type, owner_user_id, original_name, source, conversation_id, run_id, task_id, project_id, mime_type, bytes, created_at, expires_at)
             SELECT storage_key, scope, storage_class, type, owner_user_id, original_name, source, conversation_id, run_id, task_id, project_id, mime_type, bytes, created_at, expires_at
             FROM %I
             ON CONFLICT (storage_key) DO NOTHING',
            target_name,
            legacy_name
        );
    END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS creative_run_events (
    id bigserial PRIMARY KEY,
    run_id text NOT NULL,
    type text NOT NULL,
    data jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS creative_run_events_run_id_idx ON creative_run_events (run_id, id ASC);

CREATE TABLE IF NOT EXISTS canvas_projects (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title text NOT NULL,
    project_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS canvas_projects_user_updated_idx ON canvas_projects (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS library_assets (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind text NOT NULL,
    title text NOT NULL,
    asset_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT library_assets_kind CHECK (kind IN ('text', 'image', 'video', 'audio'))
);
ALTER TABLE library_assets DROP CONSTRAINT IF EXISTS library_assets_kind;
ALTER TABLE library_assets ADD CONSTRAINT library_assets_kind CHECK (kind IN ('text', 'image', 'video', 'audio'));

CREATE INDEX IF NOT EXISTS library_assets_user_updated_idx ON library_assets (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS drama_projects (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title text NOT NULL,
    status text NOT NULL DEFAULT 'active',
    project_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT drama_projects_status CHECK (status IN ('active', 'archived'))
);

CREATE INDEX IF NOT EXISTS drama_projects_user_updated_idx ON drama_projects (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS drama_project_versions (
    id text PRIMARY KEY,
    project_id text NOT NULL REFERENCES drama_projects(id) ON DELETE CASCADE,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    version integer NOT NULL,
    reason text NOT NULL DEFAULT '',
    snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, version)
);

CREATE INDEX IF NOT EXISTS drama_project_versions_user_created_idx ON drama_project_versions (user_id, project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS email_codes (
    id text PRIMARY KEY,
    purpose text NOT NULL,
    email text NOT NULL,
    user_id text REFERENCES users(id) ON DELETE CASCADE,
    code_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    attempts integer NOT NULL DEFAULT 0,
    CONSTRAINT email_codes_purpose CHECK (purpose IN ('register', 'email-change', 'password-reset'))
);

ALTER TABLE email_codes ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS email_codes_lookup_idx ON email_codes (purpose, lower(email), expires_at);

CREATE TABLE IF NOT EXISTS quota_usage (
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date date NOT NULL,
    usage_kind text NOT NULL,
    points_spent numeric(18, 2) NOT NULL DEFAULT 0,
    units numeric(18, 2) NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, date, usage_kind),
    CONSTRAINT quota_usage_kind CHECK (usage_kind IN ('api', 'image', 'video', 'audio', 'text'))
);

CREATE INDEX IF NOT EXISTS quota_usage_date_idx ON quota_usage (date);

CREATE TABLE IF NOT EXISTS point_records (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type text NOT NULL,
    amount numeric(18, 2) NOT NULL,
    balance_after numeric(18, 2) NOT NULL,
    permanent_amount numeric(18, 2) NOT NULL DEFAULT 0,
    daily_amount numeric(18, 2) NOT NULL DEFAULT 0,
    permanent_balance_after numeric(18, 2) NOT NULL DEFAULT 0,
    daily_balance_after numeric(18, 2) NOT NULL DEFAULT 0,
    description text NOT NULL,
    model text,
    idempotency_key text,
    request_fingerprint text,
    source_record_id text,
    source_date date,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT point_records_type CHECK (type IN ('consume', 'refund', 'credit', 'admin-adjust'))
);

ALTER TABLE point_records ADD COLUMN IF NOT EXISTS permanent_amount numeric(18, 2) NOT NULL DEFAULT 0;
ALTER TABLE point_records ADD COLUMN IF NOT EXISTS daily_amount numeric(18, 2) NOT NULL DEFAULT 0;
ALTER TABLE point_records ADD COLUMN IF NOT EXISTS permanent_balance_after numeric(18, 2) NOT NULL DEFAULT 0;
ALTER TABLE point_records ADD COLUMN IF NOT EXISTS daily_balance_after numeric(18, 2) NOT NULL DEFAULT 0;
ALTER TABLE point_records ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE point_records ADD COLUMN IF NOT EXISTS request_fingerprint text;
ALTER TABLE point_records ADD COLUMN IF NOT EXISTS source_record_id text;
ALTER TABLE point_records ADD COLUMN IF NOT EXISTS source_date date;
UPDATE point_records
SET
    type = 'credit',
    permanent_amount = CASE WHEN permanent_amount = 0 THEN amount ELSE permanent_amount END,
    permanent_balance_after = CASE WHEN permanent_balance_after = 0 THEN balance_after ELSE permanent_balance_after END
WHERE type = 'check-in';
ALTER TABLE point_records DROP CONSTRAINT IF EXISTS point_records_type;
ALTER TABLE point_records ADD CONSTRAINT point_records_type CHECK (type IN ('consume', 'refund', 'credit', 'admin-adjust'));
CREATE INDEX IF NOT EXISTS point_records_user_created_idx ON point_records (user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS point_records_idempotency_idx ON point_records (idempotency_key) WHERE idempotency_key IS NOT NULL AND idempotency_key <> '';
CREATE UNIQUE INDEX IF NOT EXISTS point_records_refund_source_idx ON point_records (source_record_id) WHERE type = 'refund' AND source_record_id IS NOT NULL AND source_record_id <> '';

CREATE TABLE IF NOT EXISTS daily_plan_point_wallets (
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date date NOT NULL,
    plan_id text NOT NULL REFERENCES entitlement_plans(id),
    assignment_id text,
    granted_points numeric(18, 2) NOT NULL DEFAULT 0,
    remaining_points numeric(18, 2) NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, date),
    CONSTRAINT daily_plan_point_wallets_granted CHECK (granted_points >= 0),
    CONSTRAINT daily_plan_point_wallets_remaining CHECK (remaining_points >= 0 AND remaining_points <= granted_points)
);

CREATE INDEX IF NOT EXISTS daily_plan_point_wallets_assignment_idx ON daily_plan_point_wallets (assignment_id, date DESC);

CREATE TABLE IF NOT EXISTS billing_products (
    id text PRIMARY KEY,
    product_kind text NOT NULL DEFAULT 'plan',
    plan_id text REFERENCES entitlement_plans(id),
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    amount_cents bigint NOT NULL DEFAULT 0,
    currency text NOT NULL DEFAULT 'CNY',
    points_amount numeric(18, 2) NOT NULL DEFAULT 0,
    daily_points numeric(18, 2) NOT NULL DEFAULT 0,
    period_days integer NOT NULL DEFAULT 30,
    enabled boolean NOT NULL DEFAULT true,
    sort_order integer NOT NULL DEFAULT 0,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT billing_products_amount CHECK (amount_cents >= 0),
    CONSTRAINT billing_products_points CHECK (points_amount >= 0),
    CONSTRAINT billing_products_daily_points CHECK (daily_points >= 0),
    CONSTRAINT billing_products_kind CHECK (product_kind IN ('plan', 'points')),
    CONSTRAINT billing_products_period_days CHECK (period_days >= 0)
);

CREATE INDEX IF NOT EXISTS billing_products_plan_idx ON billing_products (plan_id, enabled, sort_order);
CREATE INDEX IF NOT EXISTS billing_products_enabled_idx ON billing_products (enabled, sort_order);

ALTER TABLE billing_products ADD COLUMN IF NOT EXISTS product_kind text NOT NULL DEFAULT 'plan';
ALTER TABLE billing_products ADD COLUMN IF NOT EXISTS daily_points numeric(18, 2) NOT NULL DEFAULT 0;
ALTER TABLE billing_products ALTER COLUMN plan_id DROP NOT NULL;
ALTER TABLE billing_products DROP CONSTRAINT IF EXISTS billing_products_kind;
ALTER TABLE billing_products ADD CONSTRAINT billing_products_kind CHECK (product_kind IN ('plan', 'points'));
ALTER TABLE billing_products DROP CONSTRAINT IF EXISTS billing_products_daily_points;
ALTER TABLE billing_products ADD CONSTRAINT billing_products_daily_points CHECK (daily_points >= 0);

INSERT INTO billing_products (id, plan_id, name, description, amount_cents, currency, points_amount, period_days, enabled, sort_order, metadata)
VALUES
(
    'creator-monthly',
    'creator',
    '创作者月卡',
    '适合个人创作者持续使用生图、视频和提示词工作流，包含创作者版权益与积分包。',
    990,
    'CNY',
    500,
    30,
    true,
    10,
    '{"highlight":"个人创作入门","recommended":true}'::jsonb
),
(
    'pro-monthly',
    'pro',
    '专业月卡',
    '适合高频创作、团队试运营和商业项目交付，包含专业版权益与更高积分包。',
    2990,
    'CNY',
    2000,
    30,
    true,
    20,
    '{"highlight":"高频商业创作"}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

${POSTGRESQL_COMMERCIAL_FEATURES_SCHEMA_SQL}

CREATE TABLE IF NOT EXISTS billing_reconciliation_runs (
    id text PRIMARY KEY,
    provider text NOT NULL,
    source text NOT NULL DEFAULT 'csv',
    status text NOT NULL DEFAULT 'completed',
    total_rows integer NOT NULL DEFAULT 0,
    matched_rows integer NOT NULL DEFAULT 0,
    ok_rows integer NOT NULL DEFAULT 0,
    issue_rows integer NOT NULL DEFAULT 0,
    statement_paid_amount_cents bigint NOT NULL DEFAULT 0,
    statement_refunded_amount_cents bigint NOT NULL DEFAULT 0,
    local_matched_amount_cents bigint NOT NULL DEFAULT 0,
    difference_amount_cents bigint NOT NULL DEFAULT 0,
    imported_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
    imported_by_username text,
    file_name text,
    file_hash text,
    note text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT billing_reconciliation_runs_status CHECK (status IN ('completed', 'failed')),
    CONSTRAINT billing_reconciliation_runs_source CHECK (source IN ('csv', 'provider-api', 'manual'))
);

CREATE INDEX IF NOT EXISTS billing_reconciliation_runs_created_idx ON billing_reconciliation_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS billing_reconciliation_runs_provider_created_idx ON billing_reconciliation_runs (provider, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS billing_reconciliation_runs_provider_file_hash_idx ON billing_reconciliation_runs (provider, file_hash) WHERE file_hash IS NOT NULL AND file_hash <> '';

CREATE TABLE IF NOT EXISTS billing_reconciliation_rows (
    id text PRIMARY KEY,
    run_id text NOT NULL REFERENCES billing_reconciliation_runs(id) ON DELETE CASCADE,
    row_number integer NOT NULL,
    row_key text NOT NULL,
    provider text NOT NULL,
    order_no text,
    provider_order_id text,
    provider_payment_id text,
    statement_status text NOT NULL DEFAULT 'unknown',
    amount_cents bigint,
    currency text,
    local_order_id text REFERENCES billing_orders(id) ON DELETE SET NULL,
    local_order_no text,
    local_order_status text,
    local_amount_cents bigint,
    local_currency text,
    issue_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
    issues jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT billing_reconciliation_rows_statement_status CHECK (statement_status IN ('paid', 'refunded', 'pending', 'failed', 'unknown'))
);

CREATE INDEX IF NOT EXISTS billing_reconciliation_rows_run_idx ON billing_reconciliation_rows (run_id, row_number ASC);
CREATE INDEX IF NOT EXISTS billing_reconciliation_rows_issue_codes_gin_idx ON billing_reconciliation_rows USING gin (issue_codes);

CREATE TABLE IF NOT EXISTS user_plan_assignments (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id text NOT NULL REFERENCES entitlement_plans(id),
    status text NOT NULL DEFAULT 'active',
    source text NOT NULL DEFAULT 'admin',
    source_id text,
    starts_at timestamptz NOT NULL DEFAULT now(),
    ends_at timestamptz,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT user_plan_assignments_status CHECK (status IN ('active', 'expired', 'canceled')),
    CONSTRAINT user_plan_assignments_source CHECK (source IN ('admin', 'order', 'cdk', 'system'))
);

CREATE INDEX IF NOT EXISTS user_plan_assignments_user_active_idx ON user_plan_assignments (user_id, status, starts_at DESC);
CREATE INDEX IF NOT EXISTS user_plan_assignments_plan_idx ON user_plan_assignments (plan_id, created_at DESC);
CREATE INDEX IF NOT EXISTS user_plan_assignments_source_idx ON user_plan_assignments (source, source_id);
CREATE UNIQUE INDEX IF NOT EXISTS user_plan_assignments_source_unique_idx ON user_plan_assignments (source, source_id) WHERE source_id IS NOT NULL AND source_id <> '';

CREATE TABLE IF NOT EXISTS payment_provider_events (
    id text PRIMARY KEY,
    provider text NOT NULL,
    event_id text,
    event_type text NOT NULL DEFAULT '',
    order_id text REFERENCES billing_orders(id) ON DELETE SET NULL,
    signature_valid boolean NOT NULL DEFAULT false,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    processing_at timestamptz,
    processed_at timestamptz,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE payment_provider_events ADD COLUMN IF NOT EXISTS processing_at timestamptz;

CREATE INDEX IF NOT EXISTS payment_provider_events_provider_created_idx ON payment_provider_events (provider, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS payment_provider_events_provider_event_idx ON payment_provider_events (provider, event_id) WHERE event_id IS NOT NULL AND event_id <> '';

CREATE TABLE IF NOT EXISTS cdk_codes (
    id text PRIMARY KEY,
    code_hash text NOT NULL UNIQUE,
    code_ciphertext text NOT NULL DEFAULT '',
    code_preview text NOT NULL,
    points numeric(18, 2) NOT NULL DEFAULT 0,
    max_redemptions integer NOT NULL DEFAULT 1,
    redeemed_count integer NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'active',
    note text NOT NULL DEFAULT '',
    expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT cdk_codes_status CHECK (status IN ('active', 'disabled')),
    CONSTRAINT cdk_codes_max_redemptions CHECK (max_redemptions >= 1)
);

CREATE INDEX IF NOT EXISTS cdk_codes_status_idx ON cdk_codes (status);
CREATE INDEX IF NOT EXISTS cdk_codes_status_created_idx ON cdk_codes (status, created_at DESC);

ALTER TABLE cdk_codes ADD COLUMN IF NOT EXISTS code_ciphertext text NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS cdk_redemptions (
    cdk_code_id text NOT NULL REFERENCES cdk_codes(id) ON DELETE CASCADE,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    redeemed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (cdk_code_id, user_id)
);

CREATE INDEX IF NOT EXISTS cdk_redemptions_user_id_idx ON cdk_redemptions (user_id);

CREATE TABLE IF NOT EXISTS announcements (
    id text PRIMARY KEY,
    title text NOT NULL,
    content text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    popup_home boolean NOT NULL DEFAULT false,
    popup_after_login boolean NOT NULL DEFAULT false,
    starts_at timestamptz,
    ends_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS announcements_visible_idx ON announcements (enabled, starts_at, ends_at);

CREATE TABLE IF NOT EXISTS prompts (
    id text PRIMARY KEY,
    scope text NOT NULL,
    owner_user_id text REFERENCES users(id) ON DELETE CASCADE,
    title text NOT NULL,
    cover_url text NOT NULL DEFAULT '',
    prompt text NOT NULL,
    tags jsonb NOT NULL DEFAULT '[]'::jsonb,
    category text NOT NULL DEFAULT '',
    preview text NOT NULL DEFAULT '',
    github_url text,
    source text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT prompts_scope CHECK (scope IN ('library', 'user'))
);

CREATE INDEX IF NOT EXISTS prompts_scope_updated_idx ON prompts (scope, updated_at DESC);
CREATE INDEX IF NOT EXISTS prompts_owner_updated_idx ON prompts (owner_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS prompts_tags_gin_idx ON prompts USING gin (tags);

CREATE TABLE IF NOT EXISTS prompt_seed_sources (
    source text PRIMARY KEY,
    imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS generation_logs (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id text REFERENCES creative_conversations(id) ON DELETE SET NULL,
    username text NOT NULL,
    display_name text NOT NULL,
    kind text NOT NULL,
    source text NOT NULL,
    status text NOT NULL,
    title text NOT NULL,
    prompt text NOT NULL,
    model text NOT NULL DEFAULT '',
    summary text NOT NULL DEFAULT '',
    duration_ms integer NOT NULL DEFAULT 0,
    count integer NOT NULL DEFAULT 1,
    success_count integer NOT NULL DEFAULT 0,
    fail_count integer NOT NULL DEFAULT 0,
    request_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    task_id text,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    CONSTRAINT generation_logs_kind CHECK (kind IN ('image', 'video')),
    CONSTRAINT generation_logs_status CHECK (status IN ('pending', 'success', 'failed'))
);
ALTER TABLE generation_logs ADD COLUMN IF NOT EXISTS conversation_id text REFERENCES creative_conversations(id) ON DELETE SET NULL;
ALTER TABLE generation_logs ADD COLUMN IF NOT EXISTS request_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;
UPDATE creative_conversations AS conversation
SET source = CASE WHEN log.source = 'video-workbench' THEN 'video-workbench' ELSE 'image-workbench' END
FROM generation_logs AS log
WHERE conversation.id = log.conversation_id
  AND conversation.surface = 'chat'
  AND conversation.source = 'agent'
  AND log.source IN ('image-workbench', 'video-workbench');

CREATE INDEX IF NOT EXISTS generation_logs_user_created_idx ON generation_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS generation_logs_created_idx ON generation_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS generation_logs_admin_filter_idx ON generation_logs (kind, source, status, created_at DESC);
CREATE INDEX IF NOT EXISTS generation_logs_conversation_idx ON generation_logs (conversation_id, created_at DESC) WHERE conversation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS generation_log_assets (
    id bigserial PRIMARY KEY,
    generation_log_id text NOT NULL REFERENCES generation_logs(id) ON DELETE CASCADE,
    type text NOT NULL,
    url text NOT NULL,
    remote_url text,
    server_url text,
    mime_type text,
    width integer,
    height integer,
    bytes bigint,
    sort_order integer NOT NULL DEFAULT 0,
    CONSTRAINT generation_log_assets_type CHECK (type IN ('image', 'video'))
);

CREATE INDEX IF NOT EXISTS generation_log_assets_log_idx ON generation_log_assets (generation_log_id, sort_order);

CREATE TABLE IF NOT EXISTS audit_logs (
    id text PRIMARY KEY,
    action text NOT NULL,
    status text NOT NULL,
    actor_user_id text,
    actor_username text,
    actor_role text,
    actor_ip text,
    actor_user_agent text,
    target_type text,
    target_id text,
    target_label text,
    metadata jsonb,
    tenant_id text REFERENCES tenants(id) ON DELETE RESTRICT,
    scope text NOT NULL DEFAULT 'platform',
    actor_tenant_role text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT audit_logs_status CHECK (status IN ('success', 'failure')),
    CONSTRAINT audit_logs_actor_role CHECK (actor_role IS NULL OR actor_role IN ('admin', 'user')),
    CONSTRAINT audit_logs_scope CHECK (scope IN ('platform', 'tenant')),
    CONSTRAINT audit_logs_actor_tenant_role CHECK (actor_tenant_role IS NULL OR actor_tenant_role IN ('owner', 'admin', 'member'))
);

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS tenant_id text REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'platform';
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_tenant_role text;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_logs_scope' AND conrelid = 'audit_logs'::regclass) THEN
        ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_scope CHECK (scope IN ('platform', 'tenant'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_logs_actor_tenant_role' AND conrelid = 'audit_logs'::regclass) THEN
        ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_actor_tenant_role CHECK (actor_tenant_role IS NULL OR actor_tenant_role IN ('owner', 'admin', 'member'));
    END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON audit_logs (action);
CREATE INDEX IF NOT EXISTS audit_logs_actor_user_idx ON audit_logs (actor_user_id);
CREATE INDEX IF NOT EXISTS audit_logs_target_idx ON audit_logs (target_type, target_id);
CREATE INDEX IF NOT EXISTS audit_logs_tenant_created_idx ON audit_logs (tenant_id, created_at DESC) WHERE tenant_id IS NOT NULL;

${POSTGRESQL_TRIGGER_SCHEMA_SQL}

INSERT INTO schema_migrations (version)
VALUES ('20260709_postgresql_commercial_base'), ('20260709_billing_foundation'), ('20260709_billing_checkout'), ('20260709_commercial_seed_products'), ('20260709_vozeb_pro_table_prefix'), ('20260711_generation_tasks'), ('20260716_billing_reconciliation'), ('20260725_account_deletion_requests'), ('20260726_promotion_coupon_commerce'), ('20260727_referral_growth_rewards'), ('20260727_work_publications'), ('20260727_work_community'), ('20260728_user_blocks'), ('20260908_tenant_mvp')
ON CONFLICT (version) DO NOTHING;
`;
