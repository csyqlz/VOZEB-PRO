import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { GenerationTaskType } from "@/lib/server/generation-task-store";

const HEADER = "x-vozeb-pro-media-authorization";
const TOKEN_VERSION = 1;
const TOKEN_TTL_MS = 10 * 60_000;

type GenerationMediaClaim = {
    v: 1;
    userId: string;
    taskType: Extract<GenerationTaskType, "image" | "video" | "audio">;
    taskId: string;
    channelId: string;
    upstreamModel: string;
    url?: string;
    urlSha256?: string;
    expiresAt: number;
};
type GenerationMediaProxyInput = Omit<GenerationMediaClaim, "v" | "expiresAt" | "url" | "urlSha256"> & { url: string };

export function generationMediaProxyHeaders(input: GenerationMediaProxyInput) {
    const claim: GenerationMediaClaim = {
        v: TOKEN_VERSION,
        userId: clean(input.userId, 160),
        taskType: input.taskType,
        taskId: clean(input.taskId, 160),
        channelId: clean(input.channelId, 160),
        upstreamModel: clean(input.upstreamModel, 300),
        urlSha256: digestUrl(input.url),
        expiresAt: Date.now() + TOKEN_TTL_MS,
    };
    if (!claim.userId || !claim.taskId || !claim.channelId || !claim.upstreamModel || !claim.urlSha256) throw new Error("生成媒体授权参数不完整");
    const payload = Buffer.from(JSON.stringify(claim), "utf8").toString("base64url");
    return { [HEADER]: `${payload}.${signature(payload)}` };
}

export function readGenerationMediaClaim(request: Request, expected: { userId: string; channelId: string; url: string }): GenerationMediaClaim | null {
    const [payload, providedSignature] = (request.headers.get(HEADER) || "").split(".");
    if (!payload || !providedSignature) return null;
    try {
        if (!safeEqual(providedSignature, signature(payload))) return null;
    } catch {
        return null;
    }
    let claim: GenerationMediaClaim;
    try {
        claim = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as GenerationMediaClaim;
    } catch {
        return null;
    }
    if (claim.v !== TOKEN_VERSION || !["image", "video", "audio"].includes(claim.taskType)) return null;
    if (claim.expiresAt < Date.now() || claim.expiresAt > Date.now() + TOKEN_TTL_MS + 5_000) return null;
    if (claim.userId !== expected.userId || claim.channelId !== expected.channelId) return null;
    if (claim.urlSha256 ? claim.urlSha256 !== digestUrl(expected.url) : claim.url !== expected.url) return null;
    return claim;
}

function digestUrl(value: string) {
    const url = value.trim();
    return url ? createHash("sha256").update(url).digest("base64url") : "";
}

function signature(payload: string) {
    return createHmac("sha256", signingSecret()).update(`vozeb-media-v1:${payload}`).digest("base64url");
}

function signingSecret() {
    const secret = process.env.VOZEB_PRO_ENCRYPTION_KEY?.trim() || "";
    if (secret.length < 32) throw new Error("生成媒体授权需要有效的服务端加密密钥");
    return secret;
}

function safeEqual(left: string, right: string) {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
}

function clean(value: string, maxLength: number) {
    return value.trim().slice(0, maxLength);
}
