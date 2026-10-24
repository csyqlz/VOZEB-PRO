import { createHash, createDecipheriv } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";

import { resolveWithin } from "./disaster-recovery-core.mjs";

const ENCRYPTED_SECRET_PREFIX = "vozeb-pro-secret:v1:";

export async function loadDisasterObjectStorageConfig({ databaseUrl, dataDir, encryptionKey }) {
    const stored = databaseUrl ? await readPostgresSettings(databaseUrl) : await readFileSettings(dataDir);
    return normalizeConfig(stored, encryptionKey);
}

export async function backupObjectStorage(config, recoveryPointDir) {
    const summary = publicConfig(config);
    if (!requiresObjectBackup(config)) return { ...summary, enabled: false, objects: [] };
    assertConfigured(config);
    const client = createClient(config);
    const objects = [];
    let continuationToken;
    try {
        do {
            const page = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: config.prefix ? `${config.prefix}/` : undefined, ContinuationToken: continuationToken, MaxKeys: 1000 }));
            for (const item of page.Contents || []) {
                if (!item.Key) continue;
                objects.push(await downloadObject(client, config, item.Key, recoveryPointDir));
            }
            continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
        } while (continuationToken);
    } finally {
        client.destroy();
    }
    objects.sort((left, right) => left.key.localeCompare(right.key));
    return { ...summary, enabled: true, objects };
}

export function requiresObjectBackup(config) {
    return config.enabled === true || config.hasReferencedObjects === true;
}

export async function restoreObjectStorage(config, expected, recoveryPointDir) {
    if (!expected?.enabled) return { restored: 0 };
    assertConfigured(config);
    assertSameStorage(config, expected);
    const client = createClient(config);
    try {
        for (const item of expected.objects || []) {
            const filePath = resolveWithin(recoveryPointDir, item.file);
            const fileStat = await stat(filePath);
            await client.send(
                new PutObjectCommand({
                    Bucket: config.bucket,
                    Key: item.key,
                    Body: createReadStream(filePath),
                    ContentLength: fileStat.size,
                    ContentType: item.contentType || undefined,
                    CacheControl: item.cacheControl || undefined,
                    ContentDisposition: item.contentDisposition || undefined,
                    Metadata: item.metadata || undefined,
                }),
            );
        }
    } finally {
        client.destroy();
    }
    return { restored: expected.objects?.length || 0 };
}

async function downloadObject(client, config, key, recoveryPointDir) {
    const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
    if (!response.Body) throw new Error(`对象没有可读取内容：${key}`);
    const file = `object-storage/objects/${createHash("sha256").update(key).digest("hex")}.blob`;
    const target = resolveWithin(recoveryPointDir, file);
    await mkdir(path.dirname(target), { recursive: true });
    const hash = createHash("sha256");
    let bytes = 0;
    await pipeline(
        response.Body,
        new Transform({
            transform(chunk, _encoding, callback) {
                bytes += chunk.length;
                hash.update(chunk);
                callback(null, chunk);
            },
        }),
        createWriteStream(target, { flags: "wx", mode: 0o600 }),
    );
    return {
        key,
        file,
        bytes,
        sha256: hash.digest("hex"),
        etag: response.ETag?.replace(/^"|"$/g, "") || undefined,
        contentType: response.ContentType || undefined,
        cacheControl: response.CacheControl || undefined,
        contentDisposition: response.ContentDisposition || undefined,
        metadata: response.Metadata && Object.keys(response.Metadata).length ? response.Metadata : undefined,
        lastModified: response.LastModified?.toISOString(),
    };
}

async function readPostgresSettings(databaseUrl) {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
        let result;
        try {
            result = await client.query("SELECT * FROM vozeb_pro_object_storage_settings WHERE id = 'default'");
        } catch (error) {
            if (error?.code === "42P01") return {};
            throw error;
        }
        const referenced = await client.query("SELECT EXISTS (SELECT 1 FROM vozeb_pro_local_media_assets WHERE storage_provider = 'object') AS present");
        return { ...(result.rows[0] || {}), hasReferencedObjects: referenced.rows[0]?.present === true };
    } finally {
        await client.end();
    }
}

async function readFileSettings(dataDir) {
    try {
        return JSON.parse(await readFile(path.join(dataDir, "object-storage-settings.json"), "utf8"));
    } catch (error) {
        if (error?.code === "ENOENT") return {};
        throw error;
    }
}

function normalizeConfig(value, encryptionKey) {
    const source = value && typeof value === "object" ? value : {};
    return {
        enabled: source.enabled === true,
        hasReferencedObjects: source.hasReferencedObjects === true,
        endpoint: text(source.endpoint),
        region: text(source.region) || "us-east-1",
        bucket: text(source.bucket),
        prefix: text(source.prefix) || "vozeb-pro",
        accessKeyId: decryptSecret(text(source.access_key_id_ciphertext ?? source.accessKeyIdCiphertext), encryptionKey),
        secretAccessKey: decryptSecret(text(source.secret_access_key_ciphertext ?? source.secretAccessKeyCiphertext), encryptionKey),
        forcePathStyle: source.force_path_style === true || source.forcePathStyle === true,
    };
}

function decryptSecret(value, rawKey) {
    if (!value || !value.startsWith(ENCRYPTED_SECRET_PREFIX)) return value;
    const key = parseEncryptionKey(rawKey);
    if (!key) throw new Error("对象存储已启用，但 VOZEB_PRO_ENCRYPTION_KEY 缺失或格式不正确");
    const [ivText, tagText, encryptedText] = value.slice(ENCRYPTED_SECRET_PREFIX.length).split(".");
    if (!ivText || !tagText || !encryptedText) throw new Error("对象存储凭据密文格式不正确");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64url")), decipher.final()]).toString("utf8");
}

function parseEncryptionKey(value) {
    const raw = text(value);
    if (/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
    if (/^[A-Za-z0-9+/]{43}=$/.test(raw)) {
        const decoded = Buffer.from(raw, "base64");
        if (decoded.length === 32) return decoded;
    }
    return null;
}

function createClient(config) {
    return new S3Client({
        region: config.region,
        endpoint: config.endpoint || undefined,
        forcePathStyle: config.forcePathStyle,
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
    });
}

function publicConfig(config) {
    return { enabled: config.enabled, endpoint: config.endpoint, region: config.region, bucket: config.bucket, prefix: config.prefix, forcePathStyle: config.forcePathStyle };
}

function assertConfigured(config) {
    if (!config.bucket || !config.accessKeyId || !config.secretAccessKey) throw new Error("外部对象存储配置不完整，不能创建完整恢复点");
}

function assertSameStorage(config, expected) {
    for (const key of ["endpoint", "region", "bucket", "prefix", "forcePathStyle"]) {
        if (config[key] !== expected[key]) throw new Error(`当前对象存储与恢复点不一致：${key}`);
    }
}

function text(value) {
    return typeof value === "string" ? value.trim() : "";
}
