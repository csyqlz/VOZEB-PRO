import { DEFAULT_OBJECT_STORAGE_CDN_BASE_URL, type ObjectStorageSettings, type ObjectStorageSettingsUpdate } from "@/lib/object-storage-contract";
import { readObjectStorageSettings, writeObjectStorageSettings, type StoredObjectStorageSettings } from "@/lib/server/database/object-storage-repository";
import { decryptSecretValue, encryptSecretValue } from "@/lib/server/secret-crypto";

export type ObjectStorageRuntimeConfig = {
    id: "default";
    enabled: boolean;
    endpoint: string;
    region: string;
    bucket: string;
    prefix: string;
    cdnBaseUrl: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
};

const CACHE_MS = 3_000;
let runtimeCache: { value: ObjectStorageRuntimeConfig; expiresAt: number } | undefined;
let runtimePromise: Promise<ObjectStorageRuntimeConfig> | undefined;
let runtimeRevision = 0;

export async function getObjectStorageRuntimeConfig() {
    if (runtimeCache && runtimeCache.expiresAt > Date.now()) return runtimeCache.value;
    if (runtimePromise) return runtimePromise;
    const revision = runtimeRevision;
    const promise = readObjectStorageSettings().then(toRuntimeConfig);
    runtimePromise = promise;
    try {
        const value = await promise;
        if (revision === runtimeRevision) runtimeCache = { value, expiresAt: Date.now() + CACHE_MS };
        return value;
    } finally {
        if (runtimePromise === promise) runtimePromise = undefined;
    }
}

export async function getObjectStorageAdminSettings(): Promise<ObjectStorageSettings> {
    invalidateObjectStorageConfig();
    const revision = runtimeRevision;
    const stored = await readObjectStorageSettings();
    if (revision === runtimeRevision) runtimeCache = { value: toRuntimeConfig(stored), expiresAt: Date.now() + CACHE_MS };
    return {
        enabled: stored.enabled,
        endpoint: stored.endpoint,
        region: stored.region,
        bucket: stored.bucket,
        prefix: stored.prefix,
        cdnBaseUrl: stored.cdnBaseUrl,
        forcePathStyle: stored.forcePathStyle,
        hasAccessKeyId: Boolean(stored.accessKeyIdCiphertext),
        hasSecretAccessKey: Boolean(stored.secretAccessKeyCiphertext),
        updatedAt: stored.updatedAt,
    };
}

export async function saveObjectStorageAdminSettings(input: ObjectStorageSettingsUpdate) {
    const current = await readObjectStorageSettings();
    const endpoint = normalizeEndpoint(input.endpoint);
    const region = text(input.region, 160) || "us-east-1";
    const bucket = normalizeBucket(input.bucket);
    const prefix = normalizeObjectStoragePrefix(input.prefix);
    const cdnBaseUrl = normalizeCdnBaseUrl(input.cdnBaseUrl);
    const accessKeyIdCiphertext = resolveSecret(input.accessKeyId, input.clearAccessKeyId, current.accessKeyIdCiphertext);
    const secretAccessKeyCiphertext = resolveSecret(input.secretAccessKey, input.clearSecretAccessKey, current.secretAccessKeyCiphertext);

    if (input.enabled && (!bucket || !accessKeyIdCiphertext || !secretAccessKeyCiphertext)) throw new Error("启用外部存储前请填写 Bucket、Access Key 和 Secret Key");
    const now = new Date().toISOString();
    await writeObjectStorageSettings({
        id: "default",
        enabled: input.enabled === true,
        endpoint,
        region,
        bucket,
        prefix,
        cdnBaseUrl,
        accessKeyIdCiphertext,
        secretAccessKeyCiphertext,
        forcePathStyle: input.forcePathStyle === true,
        createdAt: current.createdAt,
        updatedAt: now,
    });
    return getObjectStorageAdminSettings();
}

export function assertObjectStorageConfigured(config: ObjectStorageRuntimeConfig) {
    if (!config.bucket || !config.accessKeyId || !config.secretAccessKey) throw new Error("外部存储配置不完整");
}

export function normalizeObjectStoragePrefix(value: unknown) {
    const segments = text(value, 700)
        .replace(/\\/g, "/")
        .split("/")
        .map((segment) => segment.trim())
        .filter(Boolean);
    if (segments.some((segment) => segment === "." || segment === "..")) throw new Error("对象路径前缀不合法");
    return segments.join("/") || "vozeb-pro";
}

function toRuntimeConfig(stored: StoredObjectStorageSettings): ObjectStorageRuntimeConfig {
    return {
        id: "default",
        enabled: stored.enabled,
        endpoint: stored.endpoint,
        region: stored.region,
        bucket: stored.bucket,
        prefix: stored.prefix,
        cdnBaseUrl: stored.cdnBaseUrl,
        accessKeyId: stored.accessKeyIdCiphertext ? decryptSecretValue(stored.accessKeyIdCiphertext) : "",
        secretAccessKey: stored.secretAccessKeyCiphertext ? decryptSecretValue(stored.secretAccessKeyCiphertext) : "",
        forcePathStyle: stored.forcePathStyle,
    };
}

function resolveSecret(value: unknown, clear: unknown, previous: string) {
    if (clear === true) return "";
    const next = text(value, 2000);
    return next ? encryptSecretValue(next) : previous;
}

function normalizeEndpoint(value: unknown) {
    const endpoint = text(value, 2000).replace(/\/+$/, "");
    if (!endpoint) return "";
    try {
        const url = new URL(endpoint);
        if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) throw new Error();
        return url.toString().replace(/\/$/, "");
    } catch {
        throw new Error("Endpoint 必须是有效的 HTTP 或 HTTPS 地址");
    }
}

function normalizeCdnBaseUrl(value: unknown) {
    if (value === undefined) return DEFAULT_OBJECT_STORAGE_CDN_BASE_URL;
    if (typeof value === "string" && !value.trim()) return "";
    try {
        if (typeof value !== "string") throw new Error();
        const url = new URL(value.trim());
        if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.href.includes("?") || url.href.includes("#")) throw new Error();
        return url.toString().replace(/\/+$/, "");
    } catch {
        throw new Error("CDN 地址前缀必须是有效的 HTTP 或 HTTPS 地址，且不能包含账号、密码、查询参数或片段");
    }
}

function normalizeBucket(value: unknown) {
    const bucket = text(value, 255);
    if (bucket.includes("/") || bucket.includes("\\")) throw new Error("Bucket 名称不能包含路径");
    return bucket;
}

function text(value: unknown, maxLength: number) {
    return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function invalidateObjectStorageConfig() {
    runtimeRevision += 1;
    runtimeCache = undefined;
    runtimePromise = undefined;
}
