import { videoFrameAssetIds, type CreativeVideoReferenceMode } from "@/lib/video-reference-contract";

export const creativeSurfaces = ["chat", "canvas", "drama"] as const;
export type CreativeSurface = (typeof creativeSurfaces)[number];
export const creativeConversationSources = ["agent", "image-workbench", "video-workbench", "canvas", "drama"] as const;
export type CreativeConversationSource = (typeof creativeConversationSources)[number];

export type CreativeConversationStatus = "active" | "archived";
export type CreativeMessageRole = "user" | "assistant" | "system" | "tool";
export type CreativeMessageStatus = "running" | "completed" | "failed" | "cancelled";
export type CreativeAssetType = "text" | "image" | "video" | "audio";
export type CreativeAssetStatus = "ready" | "failed" | "deleted";

export type CreativeConversation = {
    id: string;
    userId: string;
    surface: CreativeSurface;
    source: CreativeConversationSource;
    projectId?: string;
    title: string;
    status: CreativeConversationStatus;
    contextSummary: string;
    contextSummaryThroughSequence: number;
    createdAt: number;
    updatedAt: number;
    lastMessageAt: number;
};

export type CreativeConversationContext = {
    summary: string;
    summaryThroughSequence: number;
    recentMessages: CreativeMessage[];
};

export type CreativeMessage = {
    id: string;
    conversationId: string;
    sequence: number;
    role: CreativeMessageRole;
    status: CreativeMessageStatus;
    content: string;
    runId?: string;
    metadata: Record<string, unknown>;
    createdAt: number;
    updatedAt: number;
};

export type CreativeAsset = {
    id: string;
    userId: string;
    conversationId: string;
    messageId?: string;
    sourceRunId?: string;
    sourceTaskId?: string;
    parentAssetId?: string;
    ordinal: number;
    type: CreativeAssetType;
    status: CreativeAssetStatus;
    title: string;
    textContent?: string;
    storageKind?: "local" | "object" | "remote";
    storageKey?: string;
    remoteUrl?: string;
    serverUrl?: string;
    mimeType?: string;
    width?: number;
    height?: number;
    durationMs?: number;
    bytes?: number;
    metadata: Record<string, unknown>;
    createdAt: number;
    updatedAt: number;
};

export type CreativeProjectHandoffSurface = "canvas" | "drama";

export type CreativeProjectHandoffPlan = {
    surface: CreativeProjectHandoffSurface;
    title: string;
    summary?: string;
    style?: string;
    ratio?: "9:16" | "16:9";
    assetIds?: string[];
};

export type CreativeProjectHandoff = {
    id: string;
    sourceRunId: string;
    conversationId: string;
    surface: CreativeProjectHandoffSurface;
    title: string;
    summary: string;
    style?: string;
    ratio?: "9:16" | "16:9";
    assetIds: string[];
    assets: CreativeAsset[];
};

export function isCreativeProjectHandoff(value: unknown): value is CreativeProjectHandoff {
    if (!value || typeof value !== "object") return false;
    const handoff = value as Record<string, unknown>;
    return (
        typeof handoff.id === "string" &&
        typeof handoff.sourceRunId === "string" &&
        typeof handoff.conversationId === "string" &&
        (handoff.surface === "canvas" || handoff.surface === "drama") &&
        typeof handoff.title === "string" &&
        typeof handoff.summary === "string" &&
        Array.isArray(handoff.assetIds) &&
        Array.isArray(handoff.assets)
    );
}

export type CreativeRunEvent = {
    id: string;
    runId: string;
    type: string;
    data?: unknown;
    createdAt: number;
};

export type CreativeGenerationMode = "image" | "video" | "audio";
export type CreativeGenerationPreferences = {
    mode?: CreativeGenerationMode;
    image?: { size?: string; quality?: string; count?: number };
    video?: {
        size?: string;
        quality?: string;
        seconds?: number;
        count?: number;
        generateAudio?: boolean;
        watermark?: boolean;
        referenceMode?: CreativeVideoReferenceMode;
        firstFrameAssetId?: string;
        lastFrameAssetId?: string;
    };
    audio?: { voice?: string; format?: string; speed?: number };
};

export function agentSkillSupportsGenerationMode(workspaces: readonly string[] | undefined, mode: CreativeGenerationMode) {
    if (mode === "audio") return true;
    const supported = (workspaces || ["image"]).filter((workspace) => workspace === "image" || workspace === "video");
    return supported.length === 0 || supported.includes(mode);
}

export type CreativeRunRequest = {
    clientRequestId: string;
    surface: CreativeSurface;
    conversationId?: string;
    projectId?: string;
    prompt: string;
    publicPrompt?: string;
    snapshot?: unknown;
    assetIds: string[];
    skillIds: string[];
    modelIds: string[];
    preferences?: CreativeGenerationPreferences;
};

export class CreativeRuntimeInputError extends Error {
    constructor(
        message: string,
        public readonly status = 400,
    ) {
        super(message);
    }
}

const MAX_CLIENT_REQUEST_ID = 120;
const MAX_ID = 160;
const MAX_PROMPT = 4000;
export const CREATIVE_RUN_SKILL_LIMIT = 6;
export const CREATIVE_RUN_MODEL_LIMIT = 6;
const MAX_SNAPSHOT_BYTES = 512 * 1024;

export function normalizeCreativeRunRequest(value: unknown): CreativeRunRequest {
    const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const clientRequestId = text(input.clientRequestId, MAX_CLIENT_REQUEST_ID);
    const surface = normalizeCreativeSurface(input.surface);
    const conversationId = optionalText(input.conversationId, MAX_ID);
    const projectId = optionalText(input.projectId, MAX_ID);
    const prompt = text(input.prompt, MAX_PROMPT);
    const publicPrompt = optionalText(input.publicPrompt, MAX_PROMPT);
    const snapshot = input.snapshot;
    const assetIds = Array.from(new Set((Array.isArray(input.assetIds) ? input.assetIds : []).map((item) => optionalText(item, MAX_ID)).filter((item): item is string => Boolean(item))));
    const skillIds = Array.from(new Set((Array.isArray(input.skillIds) ? input.skillIds : []).map((item) => optionalText(item, MAX_ID)).filter((item): item is string => Boolean(item))));
    const modelIds = Array.from(new Set((Array.isArray(input.modelIds) ? input.modelIds : []).map((item) => optionalText(item, MAX_ID)).filter((item): item is string => Boolean(item))));
    const preferences = normalizeCreativeGenerationPreferences(input.preferences);
    if (!clientRequestId) throw new CreativeRuntimeInputError("请求标识不能为空");
    if (!surface) throw new CreativeRuntimeInputError("创作入口不正确");
    if (!prompt) throw new CreativeRuntimeInputError("创作需求不能为空");
    if (skillIds.length > CREATIVE_RUN_SKILL_LIMIT) throw new CreativeRuntimeInputError(`一次最多启用 ${CREATIVE_RUN_SKILL_LIMIT} 个 Skill`);
    if (modelIds.length > CREATIVE_RUN_MODEL_LIMIT) throw new CreativeRuntimeInputError(`一次最多选择 ${CREATIVE_RUN_MODEL_LIMIT} 个模型`);
    if (videoFrameAssetIds(preferences?.video).some((id) => !assetIds.includes(id))) throw new CreativeRuntimeInputError("视频首尾帧必须来自本轮已选择的图片素材");
    if (surface === "chat" && (projectId || snapshot !== undefined)) throw new CreativeRuntimeInputError("普通对话不接受项目或快照");
    if (surface !== "chat" && !projectId) throw new CreativeRuntimeInputError(surface === "canvas" ? "画布标识不能为空" : "短剧项目标识不能为空");
    if (snapshot !== undefined && !(surface === "drama" && projectId) && new TextEncoder().encode(JSON.stringify(snapshot)).length > MAX_SNAPSHOT_BYTES) throw new CreativeRuntimeInputError("当前项目快照过大", 413);

    return { clientRequestId, surface, conversationId, projectId, prompt, ...(publicPrompt && publicPrompt !== prompt ? { publicPrompt } : {}), snapshot, assetIds, skillIds, modelIds, ...(preferences ? { preferences } : {}) };
}

function normalizeCreativeGenerationPreferences(value: unknown): CreativeGenerationPreferences | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const input = value as Record<string, unknown>;
    const mode = input.mode === "image" || input.mode === "video" || input.mode === "audio" ? input.mode : undefined;
    const image = normalizeImagePreferences(input.image);
    const video = normalizeVideoPreferences(input.video);
    const audio = normalizeAudioPreferences(input.audio);
    if (!mode && !image && !video && !audio) return undefined;
    return { ...(mode ? { mode } : {}), ...(image ? { image } : {}), ...(video ? { video } : {}), ...(audio ? { audio } : {}) };
}

function normalizeImagePreferences(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const input = value as Record<string, unknown>;
    const size = normalizePreferenceSize(input.size);
    const rawQuality = optionalText(input.quality, 40);
    const quality = isCreativeAutoValue(rawQuality) ? "auto" : rawQuality;
    const count = Number(input.count);
    const normalizedCount = Number.isSafeInteger(count) && count > 0 ? count : undefined;
    return size || quality || normalizedCount ? { ...(size ? { size } : {}), ...(quality ? { quality } : {}), ...(normalizedCount ? { count: normalizedCount } : {}) } : undefined;
}

function normalizeVideoPreferences(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const input = value as Record<string, unknown>;
    const size = normalizePreferenceSize(input.size);
    const rawQuality = optionalText(input.quality, 40);
    const quality = isCreativeAutoValue(rawQuality) ? "auto" : rawQuality?.match(/^(\d+)p$/i)?.[1] || rawQuality;
    const seconds = Number(input.seconds);
    const count = Number(input.count);
    const normalizedCount = Number.isSafeInteger(count) && count > 0 ? count : undefined;
    const generateAudio = typeof input.generateAudio === "boolean" ? input.generateAudio : undefined;
    const watermark = typeof input.watermark === "boolean" ? input.watermark : undefined;
    const referenceMode: CreativeVideoReferenceMode | undefined = input.referenceMode === "reference" || input.referenceMode === "first_frame" || input.referenceMode === "first_last" ? input.referenceMode : undefined;
    const firstFrameAssetId = optionalText(input.firstFrameAssetId, MAX_ID);
    const lastFrameAssetId = optionalText(input.lastFrameAssetId, MAX_ID);
    if ((firstFrameAssetId || lastFrameAssetId) && !referenceMode) throw new CreativeRuntimeInputError("选择视频首尾帧时必须指定参考方式");
    if (referenceMode === "reference" && (firstFrameAssetId || lastFrameAssetId)) throw new CreativeRuntimeInputError("智能参考模式不能保留首尾帧角色");
    if (referenceMode === "first_frame" && !firstFrameAssetId) throw new CreativeRuntimeInputError("首帧模式需要选择首帧图片");
    if (referenceMode === "first_last" && (!firstFrameAssetId || !lastFrameAssetId)) throw new CreativeRuntimeInputError("首尾帧模式需要同时选择首帧和尾帧图片");
    if (firstFrameAssetId && lastFrameAssetId && firstFrameAssetId === lastFrameAssetId) throw new CreativeRuntimeInputError("首帧和尾帧不能使用同一张图片");
    if (input.referenceMode !== undefined && !referenceMode) throw new CreativeRuntimeInputError("视频参考方式不正确");
    return size || quality || (Number.isInteger(seconds) && seconds > 0) || normalizedCount || generateAudio !== undefined || watermark !== undefined || referenceMode || firstFrameAssetId || lastFrameAssetId
        ? {
              ...(size ? { size } : {}),
              ...(quality ? { quality } : {}),
              ...(Number.isInteger(seconds) && seconds > 0 ? { seconds } : {}),
              ...(normalizedCount ? { count: normalizedCount } : {}),
              ...(generateAudio !== undefined ? { generateAudio } : {}),
              ...(watermark !== undefined ? { watermark } : {}),
              ...(referenceMode ? { referenceMode } : {}),
              ...(firstFrameAssetId ? { firstFrameAssetId } : {}),
              ...(lastFrameAssetId ? { lastFrameAssetId } : {}),
          }
        : undefined;
}

function normalizeAudioPreferences(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const input = value as Record<string, unknown>;
    const voice = optionalText(input.voice, 40);
    const format = optionalText(input.format, 16);
    const speed = Number(input.speed);
    const normalizedSpeed = Number.isFinite(speed) && speed > 0 ? speed : undefined;
    return voice || format || normalizedSpeed ? { ...(voice ? { voice } : {}), ...(format ? { format } : {}), ...(normalizedSpeed ? { speed: normalizedSpeed } : {}) } : undefined;
}

function normalizePreferenceSize(value: unknown) {
    if (typeof value !== "string") return undefined;
    const size = value.trim().replace(/[：；;]/g, ":");
    if (!size || isCreativeAutoValue(size)) return size ? "auto" : undefined;
    const dimensions = size.match(/^(\d+)\s*[x*×]\s*(\d+)$/i);
    if (dimensions && Number(dimensions[1]) > 0 && Number(dimensions[2]) > 0) return `${Number(dimensions[1])}x${Number(dimensions[2])}`;
    const ratio = size.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
    return ratio && Number(ratio[1]) > 0 && Number(ratio[2]) > 0 ? `${ratio[1]}:${ratio[2]}` : undefined;
}

export function isCreativeAutoValue(value: unknown): value is "auto" {
    return typeof value === "string" && value.trim().toLowerCase() === "auto";
}

export function normalizeCreativeSurface(value: unknown): CreativeSurface | null {
    return typeof value === "string" && creativeSurfaces.includes(value.trim() as CreativeSurface) ? (value.trim() as CreativeSurface) : null;
}

export function normalizeCreativeConversationSource(value: unknown): CreativeConversationSource | null {
    return typeof value === "string" && creativeConversationSources.includes(value.trim() as CreativeConversationSource) ? (value.trim() as CreativeConversationSource) : null;
}

export function creativeConversationSourceForSurface(surface: CreativeSurface): CreativeConversationSource {
    return surface === "canvas" || surface === "drama" ? surface : "agent";
}

export function isCreativeConversationSourceCompatible(surface: CreativeSurface, source: CreativeConversationSource) {
    return surface === "chat" ? source === "agent" || source === "image-workbench" || source === "video-workbench" : source === surface;
}

function text(value: unknown, max: number) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function optionalText(value: unknown, max: number) {
    return text(value, max) || undefined;
}
