const TECHNICAL_ERROR_PATTERN = /\{\s*"error"|request id|new_api_error|convert_request_failed|not available|backend-(?:anon|api)\/conversation failed|<!doctype\s+html|<html\b|\bnginx\b/i;
const ACTIONABLE_ERROR_PATTERN = /积分不足|余额不足|请先登录|登录(?:状态)?(?:已)?失效|没有权限|无权访问|请求过于频繁|内容(?:不符合|未通过).*审核|当前渠道无法读取站内参考素材|参考素材暂时无法提交|参考图片暂时无法被上游模型读取/;
const UPSTREAM_MODEL_QUOTA_OR_RATE_LIMIT_ERROR = "上游模型额度不足或请求过于频繁，请检查模型服务账号余额、Key 权限或稍后重试。";
const MODEL_NOT_CONFIGURED_ERROR = "当前没有可用模型，请管理员检查默认模型和渠道配置。";
const IMAGE_DIMENSION_ERROR = "当前图片尺寸超过模型限制，请把宽高调整到 1024×1024 或更小后重试。";
const UPSTREAM_MEDIA_ACCESS_ERROR = "参考图片暂时无法被上游模型读取，请重新上传图片，或使用公网可访问的图片地址后重试。";

export function friendlyAgentError(value: unknown, fallback = "Agent 暂时无法完成这次任务，请切换模型或稍后重试。") {
    const message = value instanceof Error ? value.message : typeof value === "string" ? value : "";
    const actionable = actionableErrorMessage(message);
    if (actionable) return actionable;
    const classified = classifiedTechnicalError(message);
    if (classified) return classified;
    if (!message) return fallback;
    if (/任务依赖无法继续执行/.test(message)) return "部分创作任务未能完成，请调整需求后重试。";
    return message;
}

export function formatAgentMessageText(text: string) {
    if (isErrorPayload(text)) {
        const actionable = actionableErrorMessage(text);
        if (actionable) return actionable;
        const classified = classifiedTechnicalError(text);
        if (classified) return classified;
    }
    const legacyTextResult = text.match(/^已完成 1 个创作任务。\s*「[^」]+」已完成：\s*\*\*(.+?)\*\*/s);
    if (legacyTextResult?.[1]) return legacyTextResult[1].trim();
    if (/^正在执行任务 task-[^（]+（第 \d+ 次）…?$/.test(text.trim())) return "正在执行创作任务…";
    if (text.trim() === "任务依赖无法继续执行") return "部分创作任务未能完成，请调整需求后重试。";
    if (text.trim() === "创作计划与后台生成任务已全部完成。") return "创作任务已完成。";
    const planningBoundary = ["\n\n我的选择：", "\n\n已安排 "].map((value) => text.indexOf(value)).filter((index) => index >= 0);
    const visibleText = planningBoundary.length ? text.slice(0, Math.min(...planningBoundary)) : text;
    return formatAgentArtifactText(visibleText)
        .split("\n")
        .filter((line) => !/^「[^」]+」已生成(?:并返回画布)?。$/.test(line.trim()))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

export function formatAgentArtifactText(value: string) {
    if (!/:::writing\{[^}\r\n]*\}/.test(value)) return value.trim();
    return value
        .replace(/:::writing\{[^}\r\n]*\}([\s\S]*?):::/g, "$1")
        .replace(/:::writing\{[^}\r\n]*\}[ \t]*(?:\r?\n)?/g, "")
        .replace(/(?:\r?\n)?[ \t]*:::[ \t]*$/g, "")
        .trim();
}

function isErrorPayload(value: string) {
    const text = value.trim();
    return text.startsWith("{") || /^(?:<!doctype\s+html|<html\b)/i.test(text);
}

function actionableErrorMessage(value: string) {
    const text = value.trim();
    if (!text.startsWith("{")) return normalizeActionableError(text);
    try {
        const payload = JSON.parse(text) as Record<string, unknown>;
        const error = payload.error;
        const response = payload.response && typeof payload.response === "object" ? (payload.response as Record<string, unknown>) : undefined;
        const responseError = response?.error;
        const candidates = [payload.msg, payload.message, error, objectMessage(error), response?.msg, responseError, objectMessage(responseError)];
        return candidates.map((candidate) => (typeof candidate === "string" ? normalizeActionableError(candidate.trim()) : "")).find(Boolean) || normalizeActionableError(text);
    } catch {
        return "";
    }
}

function classifiedTechnicalError(value: string) {
    const message = extractErrorMessage(value);
    if (!message) return "";
    if (isUpstreamQuotaOrRateLimit(message)) return UPSTREAM_MODEL_QUOTA_OR_RATE_LIMIT_ERROR;
    if (isModelNotConfigured(message)) return MODEL_NOT_CONFIGURED_ERROR;
    if (isImageDimensionError(message)) return IMAGE_DIMENSION_ERROR;
    if (isUpstreamMediaAccessError(message)) return UPSTREAM_MEDIA_ACCESS_ERROR;
    if (/content\s*(?:policy|moderation|safety)|sensitive|nsfw|安全审核|内容审核|内容违规|违规内容/i.test(message)) return "内容未通过模型安全审核，请调整提示词或参考素材后重试。";
    if (/request entity too large|payload too large|body exceeded|文件过大|素材过大|图片过大/i.test(message)) return "上传素材过大，请压缩图片或减少参考素材后重试。";
    if (/unsupported image format|invalid image|图片格式(?:不支持|错误)|无效图片|无法解析图片/i.test(message)) return "参考图片格式暂不支持，请换成 PNG 或 JPG 后重试。";
    if (/积分不足|余额不足/.test(message)) return "积分不足";
    if (/status\s*[=:]\s*(401|403)|unauthorized|forbidden|鉴权失败|api\s*key|密钥/i.test(message)) return "当前渠道鉴权失败，请管理员检查 API Key 和模型权限。";
    if (/status\s*[=:]\s*429|rate.?limit|限流|请求过于频繁/i.test(message)) return "请求过于频繁，请稍后重试。";
    if (/timeout|timed\s*out|超时|响应超时/i.test(message)) return "模型响应超时，请稍后重试。";
    if (/network|fetch failed|econn|enotfound|dns|证书|连接失败|无法连接|服务器网络/i.test(message)) return "模型服务连接失败，请稍后重试。";
    if (/status\s*[=:]\s*4\d{2}|invalid|unsupported|参数(?:错误|无效|不支持)|请求参数/i.test(message)) return "当前请求参数不被模型支持，请检查模型与生成参数。";
    if (/status\s*[=:]\s*5\d{2}|not available|convert_request_failed|backend-(?:anon|api)\/conversation failed|<!doctype\s+html|<html\b|\bnginx\b|request id|new_api_error/i.test(message)) {
        return "当前模型暂不可用，请切换模型或稍后重试。";
    }
    return TECHNICAL_ERROR_PATTERN.test(value) ? "当前模型暂不可用，请切换模型或稍后重试。" : "";
}

function extractErrorMessage(value: string) {
    const text = value.trim();
    if (!text) return "";
    if (!text.startsWith("{")) return text;
    try {
        const payload = JSON.parse(text) as Record<string, unknown>;
        const error = payload.error;
        const response = payload.response && typeof payload.response === "object" ? (payload.response as Record<string, unknown>) : undefined;
        const responseError = response?.error;
        return [payload.msg, payload.message, error, objectMessage(error), response?.msg, responseError, objectMessage(responseError)].map((candidate) => (typeof candidate === "string" ? candidate.trim() : "")).find(Boolean) || text;
    } catch {
        return text;
    }
}

function objectMessage(value: unknown) {
    return value && typeof value === "object" && typeof (value as { message?: unknown }).message === "string" ? String((value as { message: string }).message) : "";
}

function normalizeActionableError(message: string) {
    if (isUpstreamQuotaOrRateLimit(message)) return UPSTREAM_MODEL_QUOTA_OR_RATE_LIMIT_ERROR;
    if (isModelNotConfigured(message)) return MODEL_NOT_CONFIGURED_ERROR;
    if (isImageDimensionError(message)) return IMAGE_DIMENSION_ERROR;
    if (isUpstreamMediaAccessError(message)) return UPSTREAM_MEDIA_ACCESS_ERROR;
    if (/积分不足|余额不足/.test(message)) return "积分不足";
    if (/must use application\/json|requires? application\/json|content[- ]type[^\n]*application\/json/i.test(message)) return "当前视频渠道要求 application/json，请在后台选择匹配的内置协议，或使用自定义协议配置请求模板。";
    if (/\b(?:unauthorized|forbidden|permission denied)\b|未授权|权限不足|无权调用/i.test(message)) return "当前渠道拒绝了请求，请管理员检查 API Key 和模型权限。";
    if (/\b(?:invalid|unsupported) (?:request|parameter|field|argument)\b|参数(?:错误|无效|不支持)|不支持的参数/i.test(message)) return "当前渠道拒绝了请求参数，请管理员核对所选协议与模型能力。";
    return ACTIONABLE_ERROR_PATTERN.test(message) ? message : "";
}

function isUpstreamQuotaOrRateLimit(message: string) {
    return /上游模型|文本模型渠道|额度不足|余额不足|insufficient\s+(?:balance|quota|credits?)/i.test(message) && !/积分不足/.test(message);
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
