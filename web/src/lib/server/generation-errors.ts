import { hasInsufficientPointsError } from "@/lib/creative-generation-status";
import { readProviderError } from "@/lib/server/provider-task-config";
import { GenerationSubmissionUncertainError } from "@/lib/server/generation-submission-error";

export const DEFAULT_CHANNEL_CONNECT_ERROR = "生成渠道暂时无法连接，请稍后重试或联系管理员。";
export const UNKNOWN_SUBMISSION_REVIEW_ERROR = "上游提交结果不确定，未取得可查询的任务 ID；为避免重复生成和扣费，系统已停止自动重试。";

export function toSafeGenerationErrorMessage(error: unknown, fallback: string) {
    const message = generationErrorMessage(error);
    if (hasInsufficientPointsError(error)) return "积分不足";
    if (isTimeoutError(error, message)) return "生成接口响应超时，请稍后重试或检查模型服务。";
    if (isFetchNetworkError(error, message)) return DEFAULT_CHANNEL_CONNECT_ERROR;
    const upstreamHttpError = publicUpstreamHttpError(message);
    if (upstreamHttpError) return upstreamHttpError;
    if (isHtmlGatewayError(message)) return DEFAULT_CHANNEL_CONNECT_ERROR;
    if (containsInfrastructureDetails(message)) return /参考|素材|公网/i.test(message) ? "参考素材暂时无法提交给当前生成渠道，请重新上传或稍后重试。" : DEFAULT_CHANNEL_CONNECT_ERROR;
    return message || fallback;
}

export function toSafeGenerationReviewReason(error: unknown, fallback: string) {
    if (error instanceof GenerationSubmissionUncertainError) {
        const upstreamHttpError = publicUpstreamHttpError(error.message);
        return upstreamHttpError ? `${upstreamHttpError}；创建结果无法确认，为避免重复生成和扣费，系统已停止自动重试。` : UNKNOWN_SUBMISSION_REVIEW_ERROR;
    }
    return toSafeGenerationErrorMessage(error, fallback);
}

function publicUpstreamHttpError(message: string) {
    const match = message.match(/^(.*?)，?上游返回了网页错误（HTTP\s+(\d{3})(?:，地址\s+(https?:\/\/[^，）\s]+))?(?:，类型\s+([^）]+))?）/u);
    if (!match) return "";
    let path = "";
    try {
        path = new URL(match[3]).pathname.slice(0, 160);
    } catch {
        path = "";
    }
    const contentType = match[4]?.trim().match(/^[\w.+-]+\/[\w.+-]+(?:;\s*charset=[\w-]+)?$/i)?.[0];
    const label = match[1].trim().replace(/[，,:：]+$/u, "") || "生成失败";
    return `${label}：上游接口${path ? ` ${path}` : ""} 返回 HTTP ${match[2]}${contentType ? `（${contentType}）` : ""}`;
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

function containsInfrastructureDetails(message: string) {
    return /https?:\/\/|\blocalhost\b|\b127\.0\.0\.1\b|next_public_site_url|base\s*url|api\s*key|\bdns\b|\beconn\w*\b|\benotfound\b|服务器网络|https\s*证书|代理配置/i.test(message);
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
