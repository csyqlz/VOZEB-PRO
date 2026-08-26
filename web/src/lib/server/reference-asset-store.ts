import { copyFile, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";

import { createDatedMediaPath, REFERENCE_MEDIA_ROOT } from "@/lib/server/local-media-storage";
import { getLocalMediaRegistration, registerLocalMediaAsset } from "@/lib/server/local-media-registry";
import { persistExternalMediaIfEnabled } from "@/lib/server/object-storage-service";

const REFERENCE_ASSET_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REFERENCE_BYTES: Record<string, number> = { image: 20 * 1024 * 1024, video: 200 * 1024 * 1024, audio: 30 * 1024 * 1024 };

type StoredReferenceAsset = {
    token: string;
    bytes: number;
    mimeType: string;
    url?: string;
    storage?: "local" | "object";
};

export type ReferenceMediaWriteContext = {
    ownerUserId: string;
    source: string;
    originalName?: string;
    conversationId?: string;
    runId?: string;
    taskId?: string;
    projectId?: string;
    maxBytes?: number;
};

export async function writeReferenceImageDataUrl(dataUrl: string, context: ReferenceMediaWriteContext): Promise<StoredReferenceAsset> {
    return writeReferenceMediaDataUrl(dataUrl, "image", context);
}

export async function writeReferenceMediaDataUrl(dataUrl: string, expectedType: "image" | "video" | "audio", context: ReferenceMediaWriteContext): Promise<StoredReferenceAsset> {
    return writeMediaDataUrl(dataUrl, expectedType, false, context);
}

export async function writePersistentMediaDataUrl(dataUrl: string, expectedType: "image" | "video" | "audio", context: ReferenceMediaWriteContext): Promise<StoredReferenceAsset> {
    return writeMediaDataUrl(dataUrl, expectedType, true, context);
}

async function writeMediaDataUrl(dataUrl: string, expectedType: "image" | "video" | "audio", persistent: boolean, context: ReferenceMediaWriteContext): Promise<StoredReferenceAsset> {
    const parsed = parseMediaDataUrl(dataUrl);
    if (!parsed || !parsed.mimeType.startsWith(`${expectedType}/`)) throw new Error("参考素材格式不正确");
    if (parsed.bytes.length > Math.min(context.maxBytes || MAX_REFERENCE_BYTES[expectedType], MAX_REFERENCE_BYTES[expectedType])) throw new Error(`参考${expectedType === "image" ? "图" : expectedType === "video" ? "视频" : "音频"}文件过大`);

    const token = createDatedMediaPath(persistent ? "permanent" : "temporary", expectedType, extensionFromMime(parsed.mimeType));
    const registration = referenceRegistration(token, persistent, expectedType, parsed.mimeType, parsed.bytes.length, context);
    const external = await persistExternalMediaIfEnabled({ registration, bytes: parsed.bytes });
    if (external) return { token, bytes: parsed.bytes.length, mimeType: parsed.mimeType, storage: "object" };
    const filePath = resolve(REFERENCE_MEDIA_ROOT, token);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, parsed.bytes);
    try {
        await registerLocalMediaAsset(registration);
    } catch (error) {
        await unlink(filePath).catch(() => undefined);
        throw error;
    }
    return { token, bytes: parsed.bytes.length, mimeType: parsed.mimeType, storage: "local" };
}

export async function writeReferenceMediaFile(sourcePath: string, expectedType: "video" | "audio", mimeType: string, persistent: boolean, context: ReferenceMediaWriteContext): Promise<StoredReferenceAsset> {
    if (!mimeType.startsWith(`${expectedType}/`)) throw new Error("媒体文件格式不正确");
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isFile() || sourceStat.size <= 0 || sourceStat.size > Math.min(context.maxBytes || MAX_REFERENCE_BYTES[expectedType], MAX_REFERENCE_BYTES[expectedType]))
        throw new Error(`生成${expectedType === "video" ? "视频" : "音频"}文件为空或过大`);
    const token = createDatedMediaPath(persistent ? "permanent" : "temporary", expectedType, extensionFromMime(mimeType));
    const registration = referenceRegistration(token, persistent, expectedType, mimeType, sourceStat.size, context);
    const external = await persistExternalMediaIfEnabled({ registration, filePath: sourcePath });
    if (external) return { token, bytes: sourceStat.size, mimeType, storage: "object" };
    const filePath = resolve(REFERENCE_MEDIA_ROOT, token);
    await mkdir(dirname(filePath), { recursive: true });
    await copyFile(sourcePath, filePath);
    try {
        await registerLocalMediaAsset(registration);
    } catch (error) {
        await unlink(filePath).catch(() => undefined);
        throw error;
    }
    return { token, bytes: sourceStat.size, mimeType, storage: "local" };
}

export async function readReferenceAsset(token: string) {
    const safeToken = (token || "").replace(/\\/g, "/");
    if (!isReferenceAssetPath(safeToken)) return null;

    const filePath = resolve(REFERENCE_MEDIA_ROOT, safeToken);
    const root = resolve(REFERENCE_MEDIA_ROOT);
    if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) return null;

    try {
        const fileStat = await stat(filePath);
        return { filePath, size: fileStat.size, mimeType: mimeTypeFromToken(basename(safeToken)), mtimeMs: fileStat.mtimeMs, registration: await getLocalMediaRegistration(safeToken) };
    } catch {
        return null;
    }
}

function referenceRegistration(token: string, persistent: boolean, type: "image" | "video" | "audio", mimeType: string, bytes: number, context: ReferenceMediaWriteContext) {
    if (!context.ownerUserId.trim()) throw new Error("媒体文件缺少用户归属");
    const createdAt = new Date().toISOString();
    return {
        storageKey: token,
        scope: "reference",
        storageClass: persistent ? "permanent" : "temporary",
        type,
        ownerUserId: context.ownerUserId,
        originalName: context.originalName,
        source: context.source,
        conversationId: context.conversationId,
        runId: context.runId,
        taskId: context.taskId,
        projectId: context.projectId,
        mimeType,
        bytes,
        createdAt,
        expiresAt: persistent ? undefined : new Date(Date.parse(createdAt) + REFERENCE_ASSET_TTL_MS).toISOString(),
    } as const;
}

function parseMediaDataUrl(dataUrl: string) {
    const separator = dataUrl.indexOf(",");
    if (separator < 0) return null;
    const header = dataUrl.slice(0, separator).match(/^data:((?:image\/(?:png|jpe?g|webp|gif))|(?:video\/(?:mp4|webm|quicktime))|(?:audio\/(?:mpeg|mp3|wav|x-wav|ogg|opus|aac|flac)));base64$/i);
    const encoded = dataUrl.slice(separator + 1).replace(/\s/g, "");
    if (!header || !encoded || encoded.length % 4 !== 0) return null;
    const mimeType = normalizeMimeType(header[1]);
    const bytes = Buffer.from(encoded, "base64");
    return bytes.length && bytes.toString("base64") === encoded ? { mimeType, bytes } : null;
}

function normalizeMimeType(value: string) {
    const mimeType = value.toLowerCase();
    return mimeType === "image/jpg" ? "image/jpeg" : mimeType;
}

function extensionFromMime(mimeType: string) {
    if (mimeType === "image/jpeg") return ".jpg";
    if (mimeType === "image/webp") return ".webp";
    if (mimeType === "image/gif") return ".gif";
    if (mimeType === "video/webm") return ".webm";
    if (mimeType === "video/quicktime") return ".mov";
    if (mimeType.startsWith("video/")) return ".mp4";
    if (mimeType === "audio/wav" || mimeType === "audio/x-wav") return ".wav";
    if (mimeType === "audio/ogg" || mimeType === "audio/opus") return ".ogg";
    if (mimeType === "audio/aac") return ".aac";
    if (mimeType === "audio/flac") return ".flac";
    if (mimeType.startsWith("audio/")) return ".mp3";
    return ".png";
}

function mimeTypeFromToken(token: string) {
    const lower = token.toLowerCase();
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
    if (lower.endsWith(".webp")) return "image/webp";
    if (lower.endsWith(".gif")) return "image/gif";
    if (lower.endsWith(".webm")) return "video/webm";
    if (lower.endsWith(".mov")) return "video/quicktime";
    if (lower.endsWith(".mp4")) return "video/mp4";
    if (lower.endsWith(".wav")) return "audio/wav";
    if (lower.endsWith(".ogg")) return "audio/ogg";
    if (lower.endsWith(".aac")) return "audio/aac";
    if (lower.endsWith(".flac")) return "audio/flac";
    if (lower.endsWith(".mp3")) return "audio/mpeg";
    return "image/png";
}

export function isReferenceAssetPath(value: string) {
    return /^(?:temporary|permanent)\/\d{4}\/\d{2}\/\d{2}\/(?:images|videos|audio)\/\d{8}-\d{6}-[0-9a-f-]{36}\.(?:png|jpg|jpeg|webp|gif|mp4|webm|mov|mp3|wav|ogg|aac|flac)$/i.test(value);
}
