import { hasInsufficientPointsError } from "@/lib/creative-generation-status";
import { readProviderError } from "@/lib/server/provider-task-config";
import { GenerationSubmissionUncertainError } from "@/lib/server/generation-submission-error";

export const DEFAULT_CHANNEL_CONNECT_ERROR = "生成渠道暂时无法连接，请稍后重试或联系管理员。";
export const UNKNOWN_SUBMISSION_REVIEW_ERROR = "上游提交结果不确定，未取得可查询的任务 ID；为避免重复生成和扣费，系统已停止自动重试。";
export const MODEL_NOT_CONFIGURED_ERROR = "当前没有可用模型，请管理员检查默认模型和渠道配置。";
export const IMAGE_DIMENSION_ERROR = "当前图片尺寸超过模型限制，请把宽高调整到 1024×1024 或更小后重试。";
export const UPSTREAM_MEDIA_ACCESS_ERROR = "参考图片暂时无法被上游模型读取，请重新上传图片，或使用公网可访问的图片地址后重试。";

export function toSafeGenerationErrorMessage(error: unknown, fallback: string) {
    const message = generationErrorMessage(error);
    if (isUpstreamQuotaOrRateLimit(message)) return "上游模型额度不足或请求过于频繁，请检查模型服务账号余额、Key 权限或稍后重试。";
    if (isModelNotConfigured(message)) return MODEL_NOT_CONFIGURED_ERROR;
    if (isImageDimensionError(message)) return IMAGE_DIMENSION_ERROR;
    if (isUpstreamMediaAccessError(message)) return UPSTREAM_MEDIA_ACCESS_ERROR;
    if (isContentReviewError(message)) return "内容未通过模型安全审核，请调整提示词或参考素材后重试。";
    if (isPayloadTooLargeError(message)) return "上传素材过大，请压缩图片或减少参考素材后重试。";
    if (isInvalidImageError(message)) return "参考图片格式暂不支持，请换成 PNG 或 JPG 后重试。";
    if (hasInsufficientPointsError(error)) return "积分不足";
    if (isTimeoutError(error, message)) return "生成接口响应超时，请稍后重试或检查模型服务。";
    if (isFetchNetworkError(error, message)) return DEFAULT_CHANNEL_CONNECT_ERROR;
    if (isHtmlGatewayError(message)) return DEFAULT_CHANNEL_CONNECT_ERROR;
    if (containsInfrastructureDetails(message)) return /参考|素材|公网/i.test(message) ? "参考素材暂时无法提交给当前生成渠道，请重新上传或稍后重试。" : DEFAULT_CHANNEL_CONNECT_ERROR;
    return message || fallback;
}

export function toSafeGenerationReviewReason(error: unknown, fallback: string) {
    if (error instanceof GenerationSubmissionUncertainError) return UNKNOWN_SUBMISSION_REVIEW_ERROR;
    return toSafeGenerationErrorMessage(error, fallback);
}

function generationErrorMessage(error: unknown) {
    const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
    if (!raw.trim().startsWith("{")) return raw;
    try {
        return readProviderError(JSON.parse(raw)) || raw;
    } catch {
        return raw;
    }
}

function isHtmlGatewayError(message: string) {
    return /<!doctype\s+html|<html\b|<head>\s*<title>\s*\d{3}\b|<center>\s*<h1>\s*\d{3}\b|\bnginx\b/i.test(message);
}

function isUpstreamQuotaOrRateLimit(message: string) {
    return /HTTP\s*429|请求过于频繁|rate\s*limit|too\s*many\s*requests|额度不足|余额不足|insufficient\s+(?:balance|quota|credits?)/i.test(message) && !/积分不足/.test(message);
}

function containsInfrastructureDetails(message: string) {
    return /https?:\/\/|\blocalhost\b|\b127\.0\.0\.1\b|next_public_site_url|base\s*url|api\s*key|\bdns\b|\beconn\w*\b|\benotfound\b|服务器网络|https\s*证书|代理配置/i.test(message);
}

function isModelNotConfigured(message: string) {
    return /后台尚未配置可用的默认(?:图片|文本|视频)?模型|没有可用模型|未配置可用.*模型|no available .*model|model (?:does not exist|not found)|unknown model/i.test(message);
}

function isImageDimensionError(message: string) {
    return /(?:width|height)\s+should\s+be\s+less\s+than\s+2048|图片尺寸超过|尺寸(?:过大|不支持)|分辨率(?:过大|不支持)/i.test(message);
}

function isUpstreamMediaAccessError(message: string) {
    return /上游图片无法通过授权媒体路径读取|当前渠道无法读取站内参考素材|authorized media path|media path.*read|无法读取.*参考(?:图|图片|素材)|参考(?:图|图片|素材).*无法(?:读取|访问)/i.test(message);
}

function isContentReviewError(message: string) {
    return /content\s*(?:policy|moderation|safety)|sensitive|nsfw|安全审核|内容审核|内容违规|违规内容/i.test(message);
}

function isPayloadTooLargeError(message: string) {
    return /request entity too large|payload too large|body exceeded|文件过大|素材过大|图片过大/i.test(message);
}

function isInvalidImageError(message: string) {
    return /unsupported image format|invalid image|图片格式(?:不支持|错误)|无效图片|无法解析图片/i.test(message);
}

function isTimeoutError(error: unknown, message: string) {
    const lower = message.toLowerCase();
    if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("aborted due to timeout")) return true;
    if (!(error instanceof Error)) return false;
    return error.name === "TimeoutError";
}

function isFetchNetworkError(error: unknown, message: string) {
    if (message.toLowerCase() === "fetch failed") return true;
    if (!(error instanceof TypeError)) return false;
    const cause = "cause" in error ? error.cause : undefined;
    if (!cause || typeof cause !== "object") return false;
    const code = "code" in cause ? String(cause.code) : "";
    return ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(code);
}
