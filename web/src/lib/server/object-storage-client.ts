import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";

import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, type ObjectIdentifier } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { assertObjectStorageConfigured, type ObjectStorageRuntimeConfig } from "@/lib/server/object-storage-config";

export type ObjectStorageListedObject = {
    key: string;
    bytes: number;
    lastModified?: string;
    etag?: string;
};

export function createObjectStorageClient(config: ObjectStorageRuntimeConfig) {
    assertObjectStorageConfigured(config);
    return new S3Client({
        region: config.region,
        endpoint: config.endpoint || undefined,
        forcePathStyle: config.forcePathStyle,
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
    });
}

export async function testObjectStorageConnection(config: ObjectStorageRuntimeConfig) {
    const client = createObjectStorageClient(config);
    const probeKey = `${config.prefix ? `${config.prefix}/` : ""}media/.vozeb-healthcheck/${randomUUID()}.txt`;
    let uploaded = false;
    try {
        try {
            await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: config.prefix ? `${config.prefix}/` : undefined, MaxKeys: 1 }));
        } catch (error) {
            throw objectStorageOperationError("对象列表检查失败", error);
        }
        try {
            const body = Buffer.from("vozeb-pro-storage-check");
            await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: probeKey, Body: body, ContentLength: body.length, ContentType: "text/plain" }));
            uploaded = true;
        } catch (error) {
            throw objectStorageOperationError("对象写入检查失败", error);
        }
        try {
            await deleteObjectBatch(client, config.bucket, [probeKey]);
            uploaded = false;
        } catch (error) {
            throw objectStorageOperationError("对象删除检查失败", error);
        }
    } finally {
        if (uploaded) await deleteObjectBatch(client, config.bucket, [probeKey]).catch(() => undefined);
        client.destroy();
    }
}

export async function putObjectBytes(config: ObjectStorageRuntimeConfig, input: { key: string; bytes: Buffer; contentType: string; metadata?: Record<string, string> }) {
    const client = createObjectStorageClient(config);
    try {
        await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: input.key, Body: input.bytes, ContentLength: input.bytes.length, ContentType: input.contentType, Metadata: input.metadata }));
    } finally {
        client.destroy();
    }
}

export async function putObjectFile(config: ObjectStorageRuntimeConfig, input: { key: string; filePath: string; bytes: number; contentType: string; metadata?: Record<string, string> }) {
    const client = createObjectStorageClient(config);
    try {
        await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: input.key, Body: createReadStream(input.filePath), ContentLength: input.bytes, ContentType: input.contentType, Metadata: input.metadata }));
    } finally {
        client.destroy();
    }
}

export async function objectExists(config: ObjectStorageRuntimeConfig, key: string) {
    const client = createObjectStorageClient(config);
    try {
        await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
        return true;
    } catch (error) {
        if (isMissingObjectError(error)) return false;
        throw error;
    } finally {
        client.destroy();
    }
}

export async function getObjectBytes(config: ObjectStorageRuntimeConfig, key: string) {
    const client = createObjectStorageClient(config);
    try {
        const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
        if (!result.Body) throw new Error("外部存储对象没有可读取内容");
        return Buffer.from(await result.Body.transformToByteArray());
    } finally {
        client.destroy();
    }
}

export async function signObjectRead(config: ObjectStorageRuntimeConfig, input: { key: string; contentType?: string; contentDisposition?: string; expiresIn?: number }) {
    const client = createObjectStorageClient(config);
    try {
        return await getSignedUrl(client, new GetObjectCommand({ Bucket: config.bucket, Key: input.key, ResponseContentType: input.contentType, ResponseContentDisposition: input.contentDisposition }), {
            expiresIn: Math.max(60, Math.min(3600, input.expiresIn || 600)),
        });
    } finally {
        client.destroy();
    }
}

export async function listObjects(config: ObjectStorageRuntimeConfig, input: { prefix?: string; cursor?: string; limit?: number }) {
    const client = createObjectStorageClient(config);
    try {
        const result = await client.send(
            new ListObjectsV2Command({
                Bucket: config.bucket,
                Prefix: input.prefix,
                ContinuationToken: input.cursor || undefined,
                MaxKeys: Math.max(1, Math.min(100, input.limit || 30)),
            }),
        );
        return {
            items: (result.Contents || []).flatMap((item): ObjectStorageListedObject[] => (item.Key ? [{ key: item.Key, bytes: Number(item.Size) || 0, lastModified: item.LastModified?.toISOString(), etag: item.ETag?.replace(/^"|"$/g, "") }] : [])),
            nextCursor: result.IsTruncated ? result.NextContinuationToken : undefined,
        };
    } finally {
        client.destroy();
    }
}

export async function deleteObjects(config: ObjectStorageRuntimeConfig, keys: string[]) {
    const unique = Array.from(new Set(keys.map((key) => key.trim()).filter(Boolean)));
    if (!unique.length) return;
    const client = createObjectStorageClient(config);
    try {
        for (let offset = 0; offset < unique.length; offset += 1000) {
            await deleteObjectBatch(client, config.bucket, unique.slice(offset, offset + 1000));
        }
    } finally {
        client.destroy();
    }
}

export function objectStorageErrorMessage(error: unknown) {
    const value = error && typeof error === "object" ? (error as { name?: unknown; Code?: unknown; code?: unknown; message?: unknown; $metadata?: { httpStatusCode?: unknown } }) : undefined;
    const code = firstText(value?.Code, value?.code, value?.name);
    const status = Number(value?.$metadata?.httpStatusCode) || undefined;
    const marker = [code && code !== "Error" ? code : "", status ? String(status) : ""].filter(Boolean).join("/");
    if (/SignatureDoesNotMatch|InvalidAccessKeyId|AuthorizationHeaderMalformed|InvalidToken/i.test(code)) return `签名或凭据校验失败${marker ? `（${marker}）` : ""}，请检查 Access Key、Secret Key、Region、Endpoint 和服务器时间`;
    if (status === 401 || status === 403 || /AccessDenied|Forbidden|Unauthorized/i.test(code)) return `权限不足${marker ? `（${marker}）` : ""}，请确认凭据拥有当前 Bucket 的列表、读取、写入和删除权限`;
    if (status === 404 || /NoSuchBucket|NotFound/i.test(code)) return `Bucket 不存在或当前凭据无法访问${marker ? `（${marker}）` : ""}，请检查 Bucket 和 Endpoint`;
    if (/PermanentRedirect|MovedPermanently|IncorrectEndpoint/i.test(code)) return `Endpoint 或 Region 不匹配${marker ? `（${marker}）` : ""}，请检查服务商提供的 S3 Endpoint、Region 和 Path-style 设置`;
    if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|Timeout|NetworkingError/i.test(code)) return `无法连接外部存储${marker ? `（${marker}）` : ""}，请检查 Endpoint、网络、防火墙和代理配置`;
    const message = sanitizeProviderMessage(firstText(value?.message, error));
    if (marker && message && message !== code) return `${marker}：${message}`;
    return message || marker || "外部存储请求失败";
}

async function deleteObjectBatch(client: S3Client, bucket: string, keys: string[]) {
    const objects: ObjectIdentifier[] = keys.map((Key) => ({ Key }));
    const result = await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
    if (result.Errors?.length) throw new Error(result.Errors.map((error) => `${error.Key || "对象"}: ${error.Message || error.Code || "删除失败"}`).join("；"));
}

function objectStorageOperationError(operation: string, error: unknown) {
    return new Error(`${operation}：${objectStorageErrorMessage(error)}`, { cause: error });
}

function firstText(...values: unknown[]) {
    for (const value of values) {
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
}

function sanitizeProviderMessage(value: string) {
    return value
        .replace(/https?:\/\/[^\s)]+/gi, (candidate) => {
            try {
                const url = new URL(candidate);
                return `${url.protocol}//${url.host}${url.pathname}`;
            } catch {
                return "外部存储地址";
            }
        })
        .replace(/\s+/g, " ")
        .slice(0, 360);
}

function isMissingObjectError(error: unknown) {
    if (!error || typeof error !== "object") return false;
    const value = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
    return value.name === "NotFound" || value.Code === "NoSuchKey" || value.$metadata?.httpStatusCode === 404;
}
