const TECHNICAL_ERROR_PATTERN = /\{\s*"error"|request id|new_api_error|convert_request_failed|not available|backend-(?:anon|api)\/conversation failed|<!doctype\s+html|<html\b|\bnginx\b/i;
const ACTIONABLE_ERROR_PATTERN = /积分不足|余额不足|请先登录|登录(?:状态)?(?:已)?失效|没有权限|无权访问|请求过于频繁|内容(?:不符合|未通过).*审核|当前渠道无法读取站内参考素材|参考素材暂时无法提交/;

export function friendlyAgentError(value: unknown, fallback = "智能创作助手暂时无法完成这次任务，请稍后重试。") {
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
    if (/积分不足|余额不足/.test(message)) return "人民币余额不足，请先充值后再生成。";
    if (/任务已取消|用户取消|已取消生成|cancel(?:led|ed)|task cancelled/i.test(message)) return "已取消生成。";
    if (/请上传.*参考|缺少.*参考|参考(?:图|视频|音频|素材).*(?:失败|缺少|无法读取)|reference (?:image|asset|file).*(?:required|missing|failed)|upload.*reference/i.test(message)) return "请先上传可用的参考素材后再生成。";
    if (/内容政策|内容审核|安全审核|未通过.*审核|content policy|policy violation|moderation|safety filter/i.test(message)) return "内容未通过模型安全审核，请修改描述后重试。";
    if (/status\s*[=:]\s*(401|403)|invalid token|api key required|authentication failed|unauthorized|forbidden|鉴权失败|api\s*key|密钥/i.test(message)) return "当前模型渠道暂时无法使用，请联系管理员。";
    if (/\b(?:not found|model .*does not exist|unknown model|no such model)\b|模型不存在|模型.*(?:下架|不存在)/i.test(message)) return "该模型暂时不可用，请切换其他模型。";
    if (/invalid image size|edges must be multiples|cannot unmarshal|application\/json/i.test(message)) return "当前参数不符合模型要求，请调整后重试。";
    if (/status\s*[=:]\s*429|rate.?limit|限流|请求过于频繁/i.test(message)) return "请求过于频繁，请稍后重试。";
    if (/timeout|timed\s*out|超时|响应超时/i.test(message)) return "模型响应超时，请稍后重试。";
    if (/network|fetch failed|econn|enotfound|dns|证书|连接失败|无法连接|服务器网络/i.test(message)) return "模型服务连接失败，请稍后重试。";
    if (/status\s*[=:]\s*4\d{2}|invalid|unsupported|参数(?:错误|无效|不支持)|请求参数/i.test(message)) return "当前参数不符合模型要求，请调整后重试。";
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
    if (/积分不足|余额不足/.test(message)) return "人民币余额不足，请先充值后再生成。";
    if (/must use application\/json|requires? application\/json|content[- ]type[^\n]*application\/json/i.test(message)) return "当前参数不符合模型要求，请调整后重试。";
    if (/\b(?:unauthorized|forbidden|permission denied|invalid token)\b|未授权|权限不足|无权调用/i.test(message)) return "当前模型渠道暂时无法使用，请联系管理员。";
    if (/\b(?:invalid|unsupported) (?:request|parameter|field|argument)\b|参数(?:错误|无效|不支持)|不支持的参数/i.test(message)) return "当前参数不符合模型要求，请调整后重试。";
    if (/当前渠道无法读取站内参考素材|当前服务无法读取参考素材|站点部署地址|公网图片 URL|参考素材暂时无法提交/i.test(message)) return "参考素材暂时无法提交，请重新上传或稍后重试。";
    return ACTIONABLE_ERROR_PATTERN.test(message) ? message : "";
}
