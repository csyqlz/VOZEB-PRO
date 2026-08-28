import { createHash } from "node:crypto";

import { getAuthSettings, refundUserPoints } from "@/lib/auth/store";
import { CREATE_AGENT_PROMPT_MAX_LENGTH } from "@/lib/create-agent-prompt";
import { getVozebCmsModuleManifest } from "@/lib/vozeb-cms/module-registry";
import { normalizeVozebCmsLayoutBuilderDraft, VOZEB_CMS_LAYOUT_BUILDER_TOOL } from "@/lib/vozeb-cms/layout-builder-contract";
import { createVozebCmsLayoutDefinition, validateVozebCmsLayoutDefinition } from "@/lib/vozeb-cms/layout-contract";
import { assertVozebCmsCapabilityEnabled, assertVozebCmsModuleEnabled } from "./module-service";
import { resolveVozebCmsProjectRef } from "./project-ref-service";
import { createVozebCmsLayout, getVozebCmsLayout } from "./layout-store";
import { resolveLogicalModelCandidates } from "@/lib/server/logical-model-router";
import { toSafeGenerationErrorMessage } from "@/lib/server/generation-errors";
import { rankTextPlanningCandidates, requestStructuredText } from "@/lib/server/text-planning-runtime";
import { hasSystemAiCharge, readSystemAiBilling, systemAiBillingHeaders, systemAiIdempotencyKey } from "@/lib/server/system-ai-billing";

type Runtime = { origin: string; cookie: string; signal?: AbortSignal };

export class VozebCmsLayoutBuilderError extends Error {
    constructor(
        message: string,
        readonly status = 502,
    ) {
        super(message);
        this.name = "VozebCmsLayoutBuilderError";
    }
}

export async function buildVozebCmsLayoutForUser(userId: string, value: unknown, runtime: Runtime) {
    await assertVozebCmsCapabilityEnabled("layout.compose");
    const input = record(value);
    const requestId = text(input.requestId, 160);
    const name = text(input.name, 160) || "AI 页面草稿";
    const brief = text(input.brief, CREATE_AGENT_PROMPT_MAX_LENGTH);
    const moduleId = text(input.moduleId, 40) || undefined;
    if (!requestId || !brief) throw new VozebCmsLayoutBuilderError("AI 搭建请求缺少 requestId 或页面需求", 400);
    const manifest = moduleId ? getVozebCmsModuleManifest(moduleId as never) : undefined;
    if (moduleId && !manifest) throw new VozebCmsLayoutBuilderError("页面模块未注册", 400);
    if (moduleId) await assertVozebCmsModuleEnabled(moduleId as never);
    const projectRef = await resolveVozebCmsProjectRef(userId, input.projectRef, Boolean(input.projectRef));
    const layoutId = stableLayoutId(userId, requestId);
    const existing = await getVozebCmsLayout(userId, layoutId);
    if (existing) return existing;

    const settings = await getAuthSettings();
    const model = settings.defaultModels.textModel;
    const candidates = resolveLogicalModelCandidates(settings, "text", model);
    if (!model || !candidates.length) throw new VozebCmsLayoutBuilderError("后台尚未配置可用的默认文本模型", 503);
    let latestError: unknown;
    for (const candidate of rankTextPlanningCandidates(candidates)) {
        const idempotencyKey = systemAiIdempotencyKey("layout-builder", userId, requestId, candidate.channelId, candidate.upstreamModel);
        try {
            const call = await requestStructuredText({
                origin: runtime.origin,
                cookie: runtime.cookie,
                signal: runtime.signal,
                candidate,
                messages: [
                    {
                        role: "system",
                        content: `你是 VOZEB PRO 站点设计 Agent。根据公开需求生成可审阅的首页区块草稿。只能使用已注册区块：${VOZEB_CMS_LAYOUT_BUILDER_TOOL.parameters.properties.nodes.items.properties.componentId.enum.join("、")}。按页头、价值说明、真实产品入口、内容证明、转化入口和页脚组织清晰层级。不得输出 HTML、CSS、脚本、事件属性、函数、渠道、模型、内部提示词或思维链。${manifest ? `重点展示${manifest.name}，但可以组合平台区块。` : "这是平台级首页。"}`,
                    },
                    { role: "user", content: JSON.stringify({ name, brief, moduleId, projectRef }) },
                ],
                tool: VOZEB_CMS_LAYOUT_BUILDER_TOOL,
                headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey, "X-Client-Request-Id": idempotencyKey, ...systemAiBillingHeaders(model, idempotencyKey, candidate.upstreamModel) },
                validateArguments: (argumentsText) => canNormalize(argumentsText),
                onInvalidResponse: (headers) => refundInvalidResponse(userId, model, headers),
            });
            const draft = normalizeVozebCmsLayoutBuilderDraft(JSON.parse(call.arguments));
            const definition = createVozebCmsLayoutDefinition(
                userId,
                {
                    id: layoutId,
                    name,
                    moduleId,
                    projectRef,
                    site: { kind: "page", path: "/", title: name, description: brief.slice(0, 320) },
                    permissions: manifest?.permissions || [],
                    capabilities: ["layout.compose", ...(manifest?.capabilities || [])],
                    nodes: draft.nodes,
                },
                projectRef,
            );
            validateVozebCmsLayoutDefinition(definition);
            return await createVozebCmsLayout(definition);
        } catch (error) {
            if (runtime.signal?.aborted) throw error;
            latestError = error;
        }
    }
    throw new VozebCmsLayoutBuilderError(toSafeGenerationErrorMessage(latestError, "AI 页面搭建失败，请稍后重试"));
}

function canNormalize(argumentsText: string) {
    try {
        normalizeVozebCmsLayoutBuilderDraft(JSON.parse(argumentsText));
        return true;
    } catch {
        return false;
    }
}

async function refundInvalidResponse(userId: string, model: string, headers: Headers) {
    const billing = readSystemAiBilling(headers);
    if (hasSystemAiCharge(billing)) await refundUserPoints(userId, model, billing.pointsCost, "text", 1, undefined, billing.pointsRecordId);
}

function stableLayoutId(userId: string, requestId: string) {
    return `layout-builder-${createHash("sha256").update(`${userId}\0${requestId}`).digest("hex").slice(0, 24)}`;
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown, maxLength: number) {
    return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}
