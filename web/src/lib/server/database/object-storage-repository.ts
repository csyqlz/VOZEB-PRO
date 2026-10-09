import { DEFAULT_OBJECT_STORAGE_CDN_BASE_URL } from "@/lib/object-storage-contract";
import { readJsonDataFile, writeJsonDataFile } from "@/lib/server/data-adapter";
import { ensurePostgresSchema, getDatabaseProvider, postgresQuery } from "@/lib/server/database/postgres";

export type StoredObjectStorageSettings = {
    id: "default";
    enabled: boolean;
    endpoint: string;
    region: string;
    bucket: string;
    prefix: string;
    cdnBaseUrl: string;
    accessKeyIdCiphertext: string;
    secretAccessKeyCiphertext: string;
    forcePathStyle: boolean;
    createdAt: string;
    updatedAt: string;
};

const FILE_NAME = "object-storage-settings.json";
let mutationQueue = Promise.resolve();

export async function readObjectStorageSettings() {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery("SELECT * FROM object_storage_settings WHERE id = 'default'");
        return result.rows[0] ? mapRow(result.rows[0]) : defaultSettings();
    }
    return normalizeSettings(await readJsonDataFile<unknown>(FILE_NAME, {}));
}

export async function writeObjectStorageSettings(input: StoredObjectStorageSettings) {
    const value = normalizeSettings(input);
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery(
            `INSERT INTO object_storage_settings (
                id, enabled, endpoint, region, bucket, prefix, access_key_id_ciphertext,
                secret_access_key_ciphertext, force_path_style, created_at, updated_at, cdn_base_url
             ) VALUES ('default',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT (id) DO UPDATE SET
                enabled = EXCLUDED.enabled, endpoint = EXCLUDED.endpoint, region = EXCLUDED.region,
                bucket = EXCLUDED.bucket, prefix = EXCLUDED.prefix,
                access_key_id_ciphertext = EXCLUDED.access_key_id_ciphertext,
                secret_access_key_ciphertext = EXCLUDED.secret_access_key_ciphertext,
                force_path_style = EXCLUDED.force_path_style, updated_at = EXCLUDED.updated_at,
                cdn_base_url = EXCLUDED.cdn_base_url
             RETURNING *`,
            [value.enabled, value.endpoint, value.region, value.bucket, value.prefix, value.accessKeyIdCiphertext, value.secretAccessKeyCiphertext, value.forcePathStyle, new Date(value.createdAt), new Date(value.updatedAt), value.cdnBaseUrl],
        );
        return mapRow(result.rows[0]);
    }
    const operation = mutationQueue.then(async () => {
        await writeJsonDataFile(FILE_NAME, value);
        return value;
    });
    mutationQueue = operation.then(
        () => undefined,
        () => undefined,
    );
    return operation;
}

function defaultSettings(): StoredObjectStorageSettings {
    const now = new Date().toISOString();
    return {
        id: "default",
        enabled: false,
        endpoint: "",
        region: "us-east-1",
        bucket: "",
        prefix: "vozeb-pro",
        cdnBaseUrl: DEFAULT_OBJECT_STORAGE_CDN_BASE_URL,
        accessKeyIdCiphertext: "",
        secretAccessKeyCiphertext: "",
        forcePathStyle: false,
        createdAt: now,
        updatedAt: now,
    };
}

function normalizeSettings(value: unknown): StoredObjectStorageSettings {
    const source = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    const defaults = defaultSettings();
    return {
        id: "default",
        enabled: source.enabled === true,
        endpoint: text(source.endpoint, 2000),
        region: text(source.region, 160) || defaults.region,
        bucket: text(source.bucket, 255),
        prefix: text(source.prefix, 700) || defaults.prefix,
        cdnBaseUrl: typeof (source.cdnBaseUrl ?? source.cdn_base_url) === "string" ? String(source.cdnBaseUrl ?? source.cdn_base_url).trim() : defaults.cdnBaseUrl,
        accessKeyIdCiphertext: text(source.accessKeyIdCiphertext ?? source.access_key_id_ciphertext, 4000),
        secretAccessKeyCiphertext: text(source.secretAccessKeyCiphertext ?? source.secret_access_key_ciphertext, 4000),
        forcePathStyle: source.forcePathStyle === true || source.force_path_style === true,
        createdAt: iso(source.createdAt ?? source.created_at) || defaults.createdAt,
        updatedAt: iso(source.updatedAt ?? source.updated_at) || defaults.updatedAt,
    };
}

function mapRow(row: Record<string, unknown>) {
    return normalizeSettings(row);
}

function text(value: unknown, maxLength: number) {
    return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function iso(value: unknown) {
    const date = value instanceof Date ? value : new Date(String(value || ""));
    return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}
