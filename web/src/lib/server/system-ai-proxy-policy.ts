import type { LogicalModel, LogicalModelCapability, PointUsageKind } from "@/lib/auth/store";
import { customGeminiImageModelParts } from "./custom-gemini-image-model";

type ProxyPathSet = {
    create?: Array<string | undefined>;
    query?: Array<string | undefined>;
    cancel?: Array<{ path?: string; method?: string }>;
};

type ProxyPolicyInput = {
    method: string;
    path: string[];
    search: string;
    channelId: string;
    upstreamModel: string;
    preferredLogicalModelId?: string;
    logicalModels: LogicalModel[];
    apiFormat: "openai" | "gemini";
    pointsUsageKind?: PointUsageKind;
    upstreamTaskIdHint?: string;
    paths?: ProxyPathSet;
};

export type SystemAiProxyAccess =
    | { allowed: true; capability: LogicalModelCapability; logicalModelId: string; operation: "create" }
    | { allowed: true; capability: LogicalModelCapability; logicalModelId: string; operation: "query" | "cancel"; upstreamTaskId: string }
    | { allowed: false; status: 400 | 403 | 404 | 405; error: string };

const TASK_PARAMETER = "__VOZEB_TASK_PARAMETER__";

export function authorizeSystemAiProxyRequest(input: ProxyPolicyInput): SystemAiProxyAccess {
    const method = input.method.toUpperCase();
    if (!new Set(["GET", "HEAD", "POST", "DELETE"]).has(method)) return denied(405, "系统模型代理不支持该请求方法");
    if (!safePathSegments(input.path)) return denied(400, "系统模型代理路径无效");

    const upstreamModel = normalizeModel(input.upstreamModel);
    if (!upstreamModel) return denied(400, "系统模型代理缺少上游模型标识");
    const logical = resolveBoundLogicalModel(input.logicalModels, input.channelId, upstreamModel, input.preferredLogicalModelId);
    if (!logical) return denied(403, "该上游模型未绑定可用逻辑模型");

    const candidates = requestPathCandidates(input.path, input.search);
    const cancelPaths = [...(input.paths?.cancel || []), ...defaultCancelPaths(logical.capability, input.paths?.create || [])].filter((item) => !item.method || item.method.toUpperCase() === method);
    const cancelMatch =
        method === "POST" || method === "DELETE"
            ? firstPathMatch(
                  candidates,
                  cancelPaths.map((item) => item.path),
                  upstreamModel,
              )
            : null;
    if (cancelMatch) {
        return allowedTaskOperation(logical, "cancel", taskIdForAccess(cancelMatch.taskId, input.upstreamTaskIdHint));
    }

    const queryPaths = [...(input.paths?.query || []), ...defaultQueryPaths(logical.capability, input.paths?.create || [], input.apiFormat)];
    const queryMatch = method === "GET" || method === "HEAD" ? firstPathMatch(candidates, queryPaths, upstreamModel) : null;
    if (queryMatch) {
        return allowedTaskOperation(logical, "query", taskIdForAccess(queryMatch.taskId, input.upstreamTaskIdHint));
    }

    const createPaths = [...(input.paths?.create || []), ...standardCreatePaths(logical.capability, input.apiFormat)];
    if (method === "POST" && createPaths.some((path) => pathMatchesAny(candidates, path, upstreamModel))) {
        if (!input.pointsUsageKind || input.pointsUsageKind === "api") return denied(400, "系统模型创建请求无法确定计费类型");
        if (input.pointsUsageKind !== logical.capability) return denied(403, "请求能力与逻辑模型不匹配");
        return allowed(logical, "create");
    }

    return denied(404, "系统模型代理路径未获授权");
}

function resolveBoundLogicalModel(logicalModels: LogicalModel[], channelId: string, upstreamModel: string, preferredLogicalModelId = "") {
    const matches = logicalModels.filter((logical) => logical.enabled && logical.bindings.some((binding) => binding.enabled && binding.channelId === channelId && normalizeModel(binding.upstreamModel) === upstreamModel));
    const preferred = preferredLogicalModelId.trim().toLowerCase();
    if (preferred) return matches.find((logical) => logical.id.toLowerCase() === preferred) || null;
    return matches.sort((left, right) => left.id.localeCompare(right.id))[0] || null;
}

function standardCreatePaths(capability: LogicalModelCapability, apiFormat: "openai" | "gemini") {
    if (capability === "image") return ["/images/generations", "/images/edits", "/responses", ...(apiFormat === "gemini" ? ["/models/:model:generateContent"] : [])];
    if (capability === "video") return ["/videos", "/video/generations", "/videos/generations", "/videos/videos", "/contents/generations/tasks", ...(apiFormat === "gemini" ? ["/models/:model:predictLongRunning"] : [])];
    if (capability === "audio") return ["/audio/speech"];
    return ["/chat/completions", "/responses", "/messages", ...(apiFormat === "gemini" ? ["/models/:model:generateContent", "/models/:model:streamGenerateContent"] : [])];
}

function defaultQueryPaths(capability: LogicalModelCapability, createPaths: Array<string | undefined>, apiFormat: "openai" | "gemini") {
    const fromCreate = createPaths.filter(Boolean).map((path) => `${String(path).replace(/\/+$/, "")}/:task_id`);
    if (capability === "video") {
        const geminiOperation = apiFormat === "gemini" || createPaths.some((path) => /\/models\/:model:predictLongRunning$/i.test(String(path || ""))) ? ["/models/:model/operations/:task_id"] : [];
        return [...geminiOperation, ...fromCreate, "/videos/:task_id", "/video/generations/:task_id", "/videos/generations/:task_id", "/result?id=:task_id", "/agnesapi?video_id=:task_id", "/v1/videos/:task_id/content", "/videos/:task_id/content"];
    }
    if (capability === "audio") return [...fromCreate, "/audio/speech/:task_id"];
    return fromCreate;
}

function defaultCancelPaths(capability: LogicalModelCapability, createPaths: Array<string | undefined>) {
    const paths = createPaths.filter(Boolean).flatMap((path) => {
        const base = String(path).replace(/\/+$/, "");
        return [
            { path: `${base}/:task_id/cancel`, method: "POST" },
            { path: `${base}/:task_id`, method: "DELETE" },
        ];
    });
    if (capability === "video") {
        paths.push({ path: "/videos/:task_id/cancel", method: "POST" }, { path: "/video/generations/:task_id/cancel", method: "POST" });
    }
    if (capability === "audio") paths.push({ path: "/audio/speech/:task_id/cancel", method: "POST" });
    return paths;
}

function requestPathCandidates(path: string[], search: string) {
    const normalized = `/${path.map((segment) => decodeURIComponent(segment)).join("/")}${search}`;
    const stripped =
        path[0]?.toLowerCase() === "v1" || path[0]?.toLowerCase() === "v1beta"
            ? `/${path
                  .slice(1)
                  .map((segment) => decodeURIComponent(segment))
                  .join("/")}${search}`
            : normalized;
    return [...new Set([normalized, stripped])];
}

function pathMatchesAny(candidates: string[], template: string | undefined, model: string) {
    if (!template?.trim()) return false;
    const pattern = pathTemplatePattern(template, model);
    return matchingPathCandidates(candidates, model).some((candidate) => pattern.test(candidate));
}

function firstPathMatch(candidates: string[], templates: Array<string | undefined>, model: string) {
    for (const template of templates) {
        if (!template?.trim()) continue;
        const pattern = pathTemplatePattern(template, model, true);
        for (const candidate of matchingPathCandidates(candidates, model)) {
            const match = candidate.match(pattern);
            if (match) return { taskId: decodeTaskId(match[1] || "") };
        }
    }
    return null;
}

function matchingPathCandidates(candidates: string[], model: string) {
    const normalized = candidates.map((candidate) => normalizeCustomGeminiImagePath(candidate, model));
    return [...new Set([...candidates, ...normalized])];
}

function normalizeCustomGeminiImagePath(candidate: string, model: string) {
    const baseModel = customGeminiImageModelParts(model)?.baseModel;
    if (!baseModel) return candidate;

    return candidate.replace(/(\/models\/)([^/:?#]+)(:generateContent(?:$|[/?#]))/i, (match, prefix: string, requestedModel: string, suffix: string) => {
        const requested = customGeminiImageModelParts(requestedModel);
        return requested?.baseModel?.toLowerCase() === baseModel.toLowerCase() ? `${prefix}${baseModel}${suffix}` : match;
    });
}

function pathTemplatePattern(template: string, model: string, captureTaskId = false) {
    const withModel = template
        .trim()
        .replace(/^https?:\/\/[^/]+/i, "")
        .replace(/\{\{\s*model\s*\}\}|\{model\}|:model\b/gi, model)
        .replace(/\{\{\s*(?:taskId|task_id|id)\s*\}\}|\{(?:taskId|task_id|id)\}|:(?:taskId|task_id|id)\b/gi, TASK_PARAMETER);
    const normalized = `${withModel.startsWith("/") ? "" : "/"}${withModel}`;
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll(TASK_PARAMETER, captureTaskId ? "([^/?#&=]+)" : "[^/?#&=]+");
    return new RegExp(`^${escaped}$`, "i");
}

function taskIdForAccess(pathTaskId: string, hintedTaskId: string | undefined) {
    const hint = decodeTaskId(hintedTaskId || "");
    if (pathTaskId && hint && pathTaskId !== hint) return "";
    return pathTaskId || hint;
}

function decodeTaskId(value: string) {
    try {
        return decodeURIComponent(value).trim().slice(0, 500);
    } catch {
        return "";
    }
}

function safePathSegments(path: string[]) {
    if (!path.length) return false;
    return path.every((segment) => {
        try {
            const decoded = decodeURIComponent(segment);
            return Boolean(decoded && decoded !== "." && decoded !== ".." && !/[\\/\0]/.test(decoded));
        } catch {
            return false;
        }
    });
}

function normalizeModel(value: string) {
    return value
        .trim()
        .replace(/^models\//i, "")
        .toLowerCase();
}

function allowed(logical: LogicalModel, operation: "create" | "query" | "cancel"): SystemAiProxyAccess {
    return operation === "create" ? { allowed: true, capability: logical.capability, logicalModelId: logical.id, operation } : denied(400, "系统模型任务操作缺少上游任务 ID");
}

function allowedTaskOperation(logical: LogicalModel, operation: "query" | "cancel", upstreamTaskId: string): SystemAiProxyAccess {
    return upstreamTaskId ? { allowed: true, capability: logical.capability, logicalModelId: logical.id, operation, upstreamTaskId } : denied(400, "系统模型任务操作缺少上游任务 ID");
}

function denied(status: 400 | 403 | 404 | 405, error: string): SystemAiProxyAccess {
    return { allowed: false, status, error };
}
