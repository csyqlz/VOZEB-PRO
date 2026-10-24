import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SYSTEM_AI_LOGICAL_MODEL_HEADER = "x-vozeb-pro-logical-model";
export const SYSTEM_AI_POINTS_IDEMPOTENCY_HEADER = "x-vozeb-pro-points-idempotency-key";
export const SYSTEM_AI_POINTS_SIGNATURE_HEADER = "x-vozeb-pro-points-signature";
export const SYSTEM_AI_UPSTREAM_MODEL_HEADER = "x-vozeb-pro-upstream-model";
export const SYSTEM_AI_AUDIO_TASK_HEADER = "x-vozeb-pro-audio-task";
export const SYSTEM_AI_VIDEO_TASK_HEADER = "x-vozeb-pro-video-task";
export const SYSTEM_AI_IMAGE_TASK_HEADER = "x-vozeb-pro-image-task";
export const SYSTEM_AI_TEXT_TASK_HEADER = "x-vozeb-pro-text-task";
export const SYSTEM_AI_PRICING_STATE_HEADER = "x-vozeb-pro-pricing-state";
export type SystemAiTextTaskReference = { taskId: string; attemptNo: number };

const SYSTEM_AI_POINTS_SIGNATURE_VERSION = "v2";
const SYSTEM_AI_POINTS_PROCESS_SECRET = "__vozebProSystemAiPointsProcessSecret" as const;

export type SystemAiBilling = {
    pointsCost?: number;
    pointsRecordId?: string;
};

export function systemAiBillingHeaders(
    logicalModel: string,
    idempotencyKey?: string,
    upstreamModel?: string,
    textTask?: SystemAiTextTaskReference,
    imageTask?: SystemAiTextTaskReference,
    videoTask?: SystemAiTextTaskReference,
    audioTask?: SystemAiTextTaskReference,
) {
    const normalizedLogicalModel = logicalModel.trim();
    const normalizedIdempotencyKey = idempotencyKey?.trim();
    const normalizedUpstreamModel = upstreamModel?.trim();
    if (textTask && (!normalizedIdempotencyKey || !validTextTaskReference(textTask))) throw new Error("文本任务计费身份无效");
    if (imageTask && (textTask || !normalizedIdempotencyKey || !validTextTaskReference(imageTask))) throw new Error("图片任务计费身份无效");
    if (videoTask && (textTask || imageTask || !normalizedIdempotencyKey || !validTextTaskReference(videoTask))) throw new Error("视频任务计费身份无效");
    if (audioTask && (textTask || imageTask || videoTask || !normalizedIdempotencyKey || !validTextTaskReference(audioTask))) throw new Error("音频任务计费身份无效");
    const audioReference = audioTask ? Buffer.from(JSON.stringify(audioTask)).toString("base64url") : "";
    const videoReference = videoTask ? Buffer.from(JSON.stringify(videoTask)).toString("base64url") : "";
    const imageReference = imageTask ? Buffer.from(JSON.stringify(imageTask)).toString("base64url") : "";
    const taskReference = textTask ? Buffer.from(JSON.stringify(textTask)).toString("base64url") : "";
    return {
        ...(normalizedLogicalModel ? { [SYSTEM_AI_LOGICAL_MODEL_HEADER]: normalizedLogicalModel } : {}),
        ...(normalizedIdempotencyKey
            ? {
                  [SYSTEM_AI_POINTS_IDEMPOTENCY_HEADER]: normalizedIdempotencyKey,
                  [SYSTEM_AI_POINTS_SIGNATURE_HEADER]: signSystemAiBusinessRequest(
                      normalizedLogicalModel,
                      normalizedIdempotencyKey,
                      normalizedUpstreamModel || "",
                      audioReference ? `audio:${audioReference}` : videoReference ? `video:${videoReference}` : imageReference ? `image:${imageReference}` : taskReference,
                  ),
              }
            : {}),
        ...(normalizedUpstreamModel ? { [SYSTEM_AI_UPSTREAM_MODEL_HEADER]: normalizedUpstreamModel } : {}),
        ...(taskReference ? { [SYSTEM_AI_TEXT_TASK_HEADER]: taskReference } : {}),
        ...(imageReference ? { [SYSTEM_AI_IMAGE_TASK_HEADER]: imageReference } : {}),
        ...(videoReference ? { [SYSTEM_AI_VIDEO_TASK_HEADER]: videoReference } : {}),
        ...(audioReference ? { [SYSTEM_AI_AUDIO_TASK_HEADER]: audioReference } : {}),
    };
}

export function readVerifiedSystemAiBusinessRequestId(headers: Headers, logicalModel: string, upstreamModel: string) {
    return readVerifiedSystemAiBillingRequest(headers, logicalModel, upstreamModel)?.businessRequestId;
}

export function readVerifiedSystemAiBillingRequest(
    headers: Headers,
    logicalModel: string,
    upstreamModel: string,
): { businessRequestId: string; textTask?: SystemAiTextTaskReference; imageTask?: SystemAiTextTaskReference; videoTask?: SystemAiTextTaskReference; audioTask?: SystemAiTextTaskReference } | undefined {
    const businessRequestId = headers.get(SYSTEM_AI_POINTS_IDEMPOTENCY_HEADER)?.trim().slice(0, 200) || "";
    const signature = headers.get(SYSTEM_AI_POINTS_SIGNATURE_HEADER)?.trim() || "";
    if (!businessRequestId || !signature) return undefined;
    const taskReference = headers.get(SYSTEM_AI_TEXT_TASK_HEADER) || "";
    const imageReference = headers.get(SYSTEM_AI_IMAGE_TASK_HEADER) || "";
    const videoReference = headers.get(SYSTEM_AI_VIDEO_TASK_HEADER) || "";
    const audioReference = headers.get(SYSTEM_AI_AUDIO_TASK_HEADER) || "";
    if ([taskReference, imageReference, videoReference, audioReference].filter(Boolean).length > 1) return undefined;
    const expected = signSystemAiBusinessRequest(
        logicalModel.trim(),
        businessRequestId,
        upstreamModel.trim(),
        audioReference ? `audio:${audioReference}` : videoReference ? `video:${videoReference}` : imageReference ? `image:${imageReference}` : taskReference,
    );
    const receivedBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
    if (receivedBytes.length !== expectedBytes.length || !timingSafeEqual(receivedBytes, expectedBytes)) return undefined;
    let textTask: SystemAiTextTaskReference | undefined;
    if (taskReference || imageReference || videoReference || audioReference) {
        try {
            const value: unknown = JSON.parse(Buffer.from(taskReference || imageReference || videoReference || audioReference, "base64url").toString("utf8"));
            if (!validTextTaskReference(value)) return undefined;
            textTask = { taskId: value.taskId, attemptNo: value.attemptNo };
        } catch {
            return undefined;
        }
    }
    return { businessRequestId, ...(textTask ? (audioReference ? { audioTask: textTask } : videoReference ? { videoTask: textTask } : imageReference ? { imageTask: textTask } : { textTask }) : {}) };
}

function validTextTaskReference(value: unknown): value is SystemAiTextTaskReference {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const task = value as SystemAiTextTaskReference;
    return typeof task.taskId === "string" && Boolean(task.taskId.trim()) && task.taskId === task.taskId.trim() && Number.isSafeInteger(task.attemptNo) && task.attemptNo > 0;
}

export function systemAiPointsIdempotencyKey(input: { userId: string; businessRequestId: string; logicalModel: string; channelId: string; upstreamModel: string; callType: string }) {
    return `system-ai:${stableDigest([input.userId, input.businessRequestId, input.logicalModel, input.channelId, input.upstreamModel, input.callType])}`;
}

export function systemAiRequestFingerprint(input: { method: string; callType: string; logicalModel: string; channelId: string; upstreamModel: string; usageKind: string; amount: number; bodyDigest: string }) {
    return stableDigest([input.method.toUpperCase(), input.callType, input.logicalModel, input.channelId, input.upstreamModel, input.usageKind, String(input.amount), input.bodyDigest]);
}

export function systemAiIdempotencyKey(scope: string, ...parts: string[]) {
    const prefix =
        scope
            .trim()
            .replace(/[^a-zA-Z0-9._-]+/g, "-")
            .slice(0, 40) || "system-ai";
    const digest = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
    return `${prefix}:${digest}`;
}

function signSystemAiBusinessRequest(logicalModel: string, businessRequestId: string, upstreamModel: string, taskReference = "") {
    return createHmac("sha256", systemAiPointsSigningSecret())
        .update([SYSTEM_AI_POINTS_SIGNATURE_VERSION, normalizeBillingModel(logicalModel), businessRequestId, normalizeBillingModel(upstreamModel), taskReference].join("\0"))
        .digest("base64url");
}

function stableDigest(parts: string[]) {
    return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function normalizeBillingModel(value: string) {
    return value
        .trim()
        .replace(/^models\//i, "")
        .toLowerCase();
}

function systemAiPointsSigningSecret() {
    const configured = process.env.VOZEB_PRO_ENCRYPTION_KEY?.trim();
    if (configured) return configured;
    const scope = globalThis as typeof globalThis & { __vozebProSystemAiPointsProcessSecret?: Buffer };
    scope[SYSTEM_AI_POINTS_PROCESS_SECRET] ||= randomBytes(32);
    return scope[SYSTEM_AI_POINTS_PROCESS_SECRET];
}

export function readSystemAiBilling(headers: Headers): SystemAiBilling {
    const rawCost = headers.get("x-vozeb-pro-points-cost");
    const cost = rawCost === null ? undefined : Number(rawCost);
    return {
        pointsCost: cost !== undefined && Number.isFinite(cost) && cost >= 0 ? cost : undefined,
        pointsRecordId: headers.get("x-vozeb-pro-points-record-id") || undefined,
    };
}

export function hasSystemAiCharge(billing: SystemAiBilling): billing is Required<SystemAiBilling> {
    return billing.pointsCost !== undefined && Boolean(billing.pointsRecordId);
}
