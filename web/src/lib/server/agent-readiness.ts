import type { AuthSettings, LogicalModelCapability } from "@/lib/auth/store";
import { toSafeGenerationErrorMessage } from "@/lib/server/generation-errors";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { readSystemAiBilling, systemAiBillingHeaders, systemAiIdempotencyKey } from "@/lib/server/system-ai-billing";
import { requestStructuredText } from "@/lib/server/text-planning-runtime";
import { resolveLogicalModel } from "./logical-model-router";

export type AgentReadinessCheck = {
    key: string;
    label: string;
    status: "pass" | "warn" | "fail";
    message: string;
};

export type AgentReadinessProbe = {
    capability: "text";
    status: "pass" | "fail" | "skip";
    message: string;
    protocol?: string;
    channelName?: string;
    logicalModel?: string;
    upstreamModel?: string;
    elapsedMs?: number;
    pointsCost?: number;
};

type AgentReadiness = {
    ready: boolean;
    capabilities: Array<{
        type: "text" | "image" | "video" | "audio";
        model: string;
        configured: boolean;
        channelId?: string;
        channelName?: string;
        upstreamModel?: string;
        protocol?: string;
        apiFormat?: string;
        ready: boolean;
        message: string;
        checks: AgentReadinessCheck[];
    }>;
    skills: Record<"image" | "video" | "canvas" | "drama", number>;
    defaults: AuthSettings["generationDefaults"];
    concurrency: AuthSettings["generationConcurrency"];
    diagnostics: {
        checkedAt: string;
        summary: string;
        blockingIssues: string[];
        warnings: string[];
        probes?: AgentReadinessProbe[];
    };
};

export function buildAgentReadiness(settings: AuthSettings): AgentReadiness {
    const models = { text: settings.defaultModels.textModel, image: settings.defaultModels.imageModel, video: settings.defaultModels.videoModel, audio: settings.defaultModels.audioModel };
    const capabilities = (Object.entries(models) as Array<[keyof typeof models, string]>).map(([type, model]) => {
        const resolved = resolveLogicalModel(settings, type, model);
        const configured = isCapabilityConfigured(settings, type, model);
        const checks = modelCapabilityChecks(settings, type, model, resolved, configured);
        const ready = checks.every((check) => check.status !== "fail");
        return {
            type,
            model,
            configured,
            channelId: resolved?.channelId,
            channelName: resolved?.channel.name,
            upstreamModel: resolved?.upstreamModel,
            protocol: resolved?.channel.advancedConfig?.protocol || resolved?.channel.apiFormat,
            apiFormat: resolved?.channel.apiFormat,
            ready,
            message: !configured ? "当前 MVP 未启用" : !model ? "未设置默认模型" : !resolved ? "默认模型没有可用渠道绑定" : `使用渠道：${resolved.channel.name}`,
            checks,
        };
    });
    const skills = { image: 0, video: 0, canvas: 0, drama: 0 };
    for (const skill of settings.agentSkills) if (skill.enabled) for (const workspace of skill.workspaces || ["image"]) skills[workspace] += 1;
    const blockingIssues = capabilities.flatMap((capability) => {
        if (!isRequiredCapability(capability.type) && !capability.configured) return [];
        return capability.checks.filter((check) => check.status === "fail").map((check) => `${capabilityLabel(capability.type)}：${check.message}`);
    });
    const warnings = capabilities.flatMap((capability) => capability.checks.filter((check) => check.status === "warn").map((check) => `${capabilityLabel(capability.type)}：${check.message}`));
    return {
        ready: capabilities.every((item) => (!isRequiredCapability(item.type) && !item.configured) || item.ready),
        capabilities,
        skills,
        defaults: settings.generationDefaults,
        concurrency: settings.generationConcurrency,
        diagnostics: {
            checkedAt: new Date().toISOString(),
            summary: blockingIssues.length ? `发现 ${blockingIssues.length} 个阻断项` : warnings.length ? `配置可用，有 ${warnings.length} 个建议项` : "模型配置已就绪",
            blockingIssues,
            warnings,
        },
    };
}

export async function probeDefaultTextModel(input: { settings: AuthSettings; request: Request; userId: string }): Promise<AgentReadinessProbe> {
    const model = input.settings.defaultModels.textModel;
    const resolved = resolveLogicalModel(input.settings, "text", model);
    if (!model) return { capability: "text", status: "skip", message: "未设置默认文本模型，跳过实测" };
    if (!resolved) return { capability: "text", status: "fail", message: "默认文本模型没有可用渠道绑定" };
    try {
        const businessRequestId = systemAiIdempotencyKey("admin-model-diagnostic", input.userId, resolved.logicalModelId, resolved.channelId, resolved.upstreamModel, String(Date.now()));
        const result = await requestStructuredText({
            origin: resolveInternalOrigin(new URL(input.request.url).origin),
            cookie: input.request.headers.get("cookie") || "",
            candidate: resolved,
            messages: [
                { role: "system", content: "你是后台模型连通性诊断器。只返回工具调用或 JSON，不输出解释。" },
                { role: "user", content: '请返回 {"ok":"OK"}，用于确认文本模型可用。' },
            ],
            tool: {
                name: "admin_model_diagnostic",
                description: "Return a short model diagnostic result.",
                parameters: {
                    type: "object",
                    properties: { ok: { type: "string" } },
                    required: ["ok"],
                    additionalProperties: false,
                },
            },
            headers: systemAiBillingHeaders(resolved.logicalModelId, businessRequestId, resolved.upstreamModel),
            allowRepair: false,
            allowNaturalLanguage: true,
            validateArguments: (argumentsText) => /ok/i.test(argumentsText),
        });
        const billing = readSystemAiBilling(result.headers);
        return {
            capability: "text",
            status: "pass",
            message: "默认文本模型实测通过",
            protocol: result.protocol,
            channelName: resolved.channel.name,
            logicalModel: resolved.logicalModelId,
            upstreamModel: resolved.upstreamModel,
            elapsedMs: result.elapsedMs,
            pointsCost: billing.pointsCost,
        };
    } catch (error) {
        return {
            capability: "text",
            status: "fail",
            message: toSafeGenerationErrorMessage(error, "默认文本模型实测失败"),
            channelName: resolved.channel.name,
            logicalModel: resolved.logicalModelId,
            upstreamModel: resolved.upstreamModel,
        };
    }
}

function modelCapabilityChecks(settings: AuthSettings, type: LogicalModelCapability, model: string, resolved: ReturnType<typeof resolveLogicalModel>, configured: boolean): AgentReadinessCheck[] {
    const logical = model ? settings.logicalModels.find((item) => item.enabled && item.capability === type && item.id.toLowerCase() === model.toLowerCase()) : undefined;
    const enabledBindings = logical?.bindings.filter((binding) => binding.enabled) || [];
    if (!isRequiredCapability(type) && !configured) {
        return [
            {
                key: "optional-capability",
                label: "能力状态",
                status: "warn",
                message: "当前 MVP 未启用，可后续接入",
            },
            {
                key: "generation-defaults",
                label: "生成参数",
                status: "pass",
                message: "默认参数可用于诊断",
            },
        ];
    }
    return [
        {
            key: "default-model",
            label: "默认模型",
            status: model ? "pass" : "fail",
            message: model ? `默认模型：${model}` : "未设置默认模型",
        },
        {
            key: "logical-binding",
            label: "逻辑绑定",
            status: !model ? "fail" : resolved ? "pass" : enabledBindings.length ? "fail" : settings.logicalModels.length ? "fail" : "warn",
            message: resolved ? `已绑定上游模型：${resolved.upstreamModel}` : enabledBindings.length ? "绑定渠道不可用或上游模型未启用" : settings.logicalModels.length ? "没有启用的逻辑模型绑定" : "未启用逻辑模型表，使用渠道模型直接匹配",
        },
        {
            key: "channel",
            label: "渠道状态",
            status: !model ? "fail" : resolved?.channel.enabled ? "pass" : "fail",
            message: resolved?.channel ? `渠道可用：${resolved.channel.name}` : "没有可用渠道",
        },
        {
            key: "api-key",
            label: "API Key",
            status: !model ? "fail" : resolved?.channel.apiKey?.trim() ? "pass" : "fail",
            message: resolved?.channel.apiKey?.trim() ? "API Key 已配置" : "API Key 未配置",
        },
        {
            key: "base-url",
            label: "Base URL",
            status: !model ? "fail" : resolved?.channel.baseUrl?.trim() ? "pass" : "fail",
            message: resolved?.channel.baseUrl?.trim() ? "Base URL 已配置" : "Base URL 未配置",
        },
        {
            key: "generation-defaults",
            label: "生成参数",
            status: type === "image" && imageDefaultMayNeedAdjustment(settings.generationDefaults.imageSize) ? "warn" : "pass",
            message: type === "image" ? imageDefaultMessage(settings.generationDefaults.imageSize) : "默认参数可用于诊断",
        },
    ];
}

function isRequiredCapability(type: LogicalModelCapability) {
    return type === "text" || type === "image";
}

function isCapabilityConfigured(settings: AuthSettings, type: LogicalModelCapability, model: string) {
    if (model.trim()) return true;
    return settings.logicalModels.some((item) => item.enabled && item.capability === type && item.bindings.some((binding) => binding.enabled));
}

function imageDefaultMayNeedAdjustment(size: string | undefined) {
    return Boolean(size && /^\d+x\d+$/i.test(size) && size.split("x").some((value) => Number(value) >= 2048));
}

function imageDefaultMessage(size: string | undefined) {
    if (imageDefaultMayNeedAdjustment(size)) return "当前默认图片尺寸可能超过上游限制，建议使用 1024x1024、1:1 或 auto";
    return `默认图片尺寸：${size || "auto"}`;
}

function capabilityLabel(type: LogicalModelCapability) {
    return { text: "文本", image: "图片", video: "视频", audio: "音频" }[type];
}
