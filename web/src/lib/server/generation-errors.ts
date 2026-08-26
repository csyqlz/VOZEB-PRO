import { hasInsufficientPointsError } from "@/lib/creative-generation-status";
import { readProviderError } from "@/lib/server/provider-task-config";

export const DEFAULT_CHANNEL_CONNECT_ERROR = "模型服务暂时无法连接，请稍后重试。";

export type GenerationErrorCategory =
    | "auth"
    | "model_not_found"
    | "parameter"
    | "reference"
    | "quota"
    | "cancelled"
    | "moderation"
    | "timeout"
    | "network"
    | "upstream"
    | "unknown";

const GENERATION_ERROR_CATEGORY_LABELS: Record<GenerationErrorCategory, string> = {
    auth: "渠道鉴权失败",
    model_not_found: "模型不存在或已下架",
    parameter: "参数不符合上游要求",
    reference: "缺少参考素材",
    quota: "余额或上游额度不足",
    cancelled: "用户取消",
    moderation: "内容审核未通过",
    timeout: "模型响应超时",
    network: "模型服务连接失败",
    upstream: "上游服务异常",
    unknown: "未知错误",
};

export function generationErrorCategoryLabel(category: GenerationErrorCategory) {
    return GENERATION_ERROR_CATEGORY_LABELS[category];
}

export function classifyGenerationError(error: unknown): GenerationErrorCategory {
    const message = generationErrorMessage(error);
    if (!message) return "unknown";
    if (hasInsufficientPointsError(error) || /余额不足|额度不足|insufficient (?:balance|quota|funds)|quota exceeded|预扣费额度失败|点数不足/i.test(message)) return "quota";
    if (/任务已取消|用户取消|已取消生成|cancel(?:led|ed)|task cancelled/i.test(message)) return "cancelled";
    if (/请上传.*参考|缺少.*参考|参考(?:图|视频|音频|素材).*(?:失败|缺少|无法读取)|reference (?:image|asset|file).*(?:required|missing|failed)|upload.*reference/i.test(message)) return "reference";
    if (/内容政策|内容审核|安全审核|未通过.*审核|content policy|policy violation|moderation|safety filter/i.test(message)) return "moderation";
    if (isUpstreamAuthFailure(message) || /status\s*[=:]\s*(401|403)\b/i.test(message) || /(?:模型|渠道)?鉴权失败|API\s*Key.*(?:权限|无效|错误)|模型权限/i.test(message)) return "auth";
    if (/\b(?:not found|model .*does not exist|unknown model|no such model)\b|模型不存在|模型.*(?:下架|不存在)/i.test(message)) return "model_not_found";
    if (/invalid image size|edges must be multiples|cannot unmarshal|application\/json|invalid|unsupported|status\s*[=:]\s*4\d{2}|参数(?:错误|无效|不支持)|请求参数/i.test(message)) return "parameter";
    if (isTimeoutError(error, message)) return "timeout";
    if (isHtmlGatewayError(message)) return "network";
    if (isFetchNetworkError(error, message) || /network|连接失败|无法连接|服务器网络|dns|证书|econn|fetch failed/i.test(message)) return "network";
    if (isUpstreamUnavailable(message) || isUpstreamForbidden(message) || /status\s*[=:]\s*5\d{2}|upstream|gateway|服务异常|暂不可用/i.test(message)) return "upstream";
    return "unknown";
}

export function toSafeGenerationErrorMessage(error: unknown, fallback: string) {
    const message = generationErrorMessage(error);
    const category = classifyGenerationError(error);
    if (category === "quota") return "人民币余额不足，请先充值后再生成。";
    if (category === "cancelled") return "已取消生成。";
    if (category === "reference") return containsInfrastructureDetails(message) ? "参考素材暂时无法提交，请重新上传或稍后重试。" : "请先上传可用的参考素材后再生成。";
    if (category === "moderation") return "内容未通过模型安全审核，请修改描述后重试。";
    if (category === "auth") return "当前模型渠道暂时无法使用，请联系管理员。";
    if (category === "model_not_found") return "该模型暂时不可用，请切换其他模型。";
    if (category === "parameter") return "当前参数不符合模型要求，请调整后重试。";
    if (category === "timeout") return "模型响应超时，请稍后重试。";
    if (category === "network") return DEFAULT_CHANNEL_CONNECT_ERROR;
    if (category === "upstream") return "当前模型暂不可用，请切换模型或稍后重试。";
    if (isHtmlGatewayError(message)) return DEFAULT_CHANNEL_CONNECT_ERROR;
    if (containsInfrastructureDetails(message)) return /参考|素材|公网/i.test(message) ? "参考素材暂时无法提交，请重新上传或稍后重试。" : "当前模型暂不可用，请切换模型或联系客服。";
    return message || fallback;
}

function isUpstreamUnavailable(message: string) {
    return /service temporarily unavailable|upstream temporarily unavailable/i.test(message);
}

function isUpstreamForbidden(message: string) {
    return /upstream access forbidden|access forbidden/i.test(message);
}

function isUpstreamAuthFailure(message: string) {
    return /invalid token|api key required|authentication failed|unauthorized|鉴权失败|认证失败/i.test(message);
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
