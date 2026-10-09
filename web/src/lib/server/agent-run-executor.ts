import { getAuthSettings } from "@/lib/auth/store";
import { nanoid } from "nanoid";
import { resolveLogicalModelCandidates } from "@/lib/server/logical-model-router";
import { systemAiIdempotencyKey } from "@/lib/server/system-ai-billing";
import { getAgentRun, updateAgentRunById, type AgentRun } from "@/lib/server/agent-run-store";
import { agentPlannerSystemPrompt, agentPlanReply, buildAgentPlannerInput, conversationFallbackReply, plannerAgentSkills, prioritizeAgentPlannerModels, selectAgentSkills, taskPlanSummary } from "@/lib/server/agent-run-surface-policy";
import { getCreativeAssetsByIds, getCreativeConversationContext, listRecentCreativeMediaAssets } from "@/lib/server/creative-runtime-store";
import { toSafeGenerationErrorMessage } from "@/lib/server/generation-errors";
import { parseAgentPlanCall, type AgentFunctionCallResult } from "./agent-function-call";
import {
    agentModelOptions,
    agentPlanFallbackExample,
    agentPlanTool,
    canContinue,
    directAgentPlan,
    directGenerationPreferences,
    executeTasks,
    fallbackUnsupportedMediaPlanToText,
    normalizeTasks,
    planToOps,
    refundFunctionCall,
    requestFunctionCall,
} from "./agent-run-execution";
import { isExplicitProjectHandoffRequest, normalizeAgentProjectHandoff } from "./agent-run-project-handoff";
import { normalizeCanvasPlanForSelection } from "./agent-run-task-input";
import { GenerationSubmissionUncertainError } from "@/lib/server/generation-submission-error";
import { rankTextPlanningCandidates } from "@/lib/server/text-planning-runtime";
import { filterAgentPlannerModels } from "@/lib/server/agent-run-planning-profile";
import { buildAgentRunPlannerAudit } from "@/lib/server/agent-run-audit";
import { agentRequestDigest, buildAgentRequest, serializeAgentRequest } from "@/lib/server/agent-prompt-json";
import { orderCreativeAssetsByIds } from "@/lib/creative-asset-references";
import { withDirectAgentExecutionContext } from "./agent-run-direct-context";

const globalAgentExecutors = globalThis as typeof globalThis & { __vozebProAgentRunControllers?: Map<string, AbortController> };
const controllers = (globalAgentExecutors.__vozebProAgentRunControllers ??= new Map<string, AbortController>());

export function abortAgentRun(id: string) {
    controllers.get(id)?.abort();
}

export async function executeAgentRun(run: AgentRun, origin: string, cookie: string) {
    abortAgentRun(run.id);
    const controller = new AbortController();
    const executionId = nanoid();
    let acceptedPlan: { userId: string; model: string; channelId: string; upstreamModel: string; call: AgentFunctionCallResult } | undefined;
    let planningPersisted = false;
    let failureStage: NonNullable<AgentRun["failureStage"]> = run.tasks.length ? "task_execution" : "planning";
    const candidateFailures: NonNullable<AgentRun["candidateFailures"]> = [];
    const refundAcceptedPlan = async () => {
        if (!acceptedPlan || planningPersisted) return;
        await refundFunctionCall(acceptedPlan.userId, acceptedPlan.model, acceptedPlan.call);
        acceptedPlan = undefined;
    };
    controllers.set(run.id, controller);
    try {
        const claimed = await updateAgentRunById(
            run.id,
            { status: "running", executionId, timings: { ...(run.timings || { requestAcceptedAt: run.createdAt }), ...(run.tasks.length ? {} : { planningStartedAt: Date.now() }) } },
            { type: run.tasks.length ? "run.resumed" : "run.planning" },
            ["planning", "running"],
        );
        if (!claimed) return;
        if (claimed.tasks.length) {
            failureStage = "task_execution";
            const settings = await getAuthSettings();
            await executeTasks(run.id, origin, cookie, executionId, settings);
            return;
        }
        const directModelSelection = Boolean(claimed.requestedModelIds?.length);
        const usesMemoryCandidates = !directModelSelection && claimed.surface === "chat" && claimed.referencedAssetIds.length === 0;
        const [settings, loadedExplicitAssets, conversationContext, memoryAssets] = await Promise.all([
            getAuthSettings(),
            getCreativeAssetsByIds(claimed.referencedAssetIds, claimed.userId),
            getCreativeConversationContext(claimed.conversationId, claimed.userId, claimed.id),
            usesMemoryCandidates ? listRecentCreativeMediaAssets(claimed.conversationId, claimed.userId, 6) : Promise.resolve([]),
        ]);
        const explicitAssets = orderCreativeAssetsByIds(loadedExplicitAssets, claimed.referencedAssetIds);
        const allModels = agentModelOptions(settings);
        const availableModels = prioritizeAgentPlannerModels(filterAgentPlannerModels(allModels, claimed), claimed, settings);
        const skillOptions = plannerAgentSkills(settings, claimed);
        const skills = selectAgentSkills(settings, claimed.surface, claimed.selectedSkillIds);
        if (!(await canContinue(run.id, executionId))) return;
        if (claimed.requestedModelIds?.length) {
            const directModelOptions = claimed.generationPreferences?.mode ? availableModels : allModels;
            const selectedModels = claimed.requestedModelIds.map((id) => directModelOptions.find((item) => item.id === id && item.capability !== "text")).filter((item): item is ReturnType<typeof agentModelOptions>[number] => Boolean(item));
            if (selectedModels.length !== claimed.requestedModelIds.length) throw new Error("部分所选模型当前不可用，请重新选择");
            const plan = directAgentPlan(selectedModels, claimed.prompt, claimed.referencedAssetIds, claimed.generationPreferences);
            const tasks = withDirectAgentExecutionContext(
                normalizeTasks(plan, skills, settings, claimed.snapshot, claimed.prompt, claimed.surface, explicitAssets, claimed.requestedImageSize, directGenerationPreferences(claimed.generationPreferences)),
                claimed.surface,
                claimed.snapshot,
                conversationContext,
            );
            await updateAgentRunById(run.id, {}, { type: "skills.selected", data: { skills: skills.map((skill) => ({ id: skill.id, name: skill.name })) } }, ["running"], executionId);
            const event = claimed.surface === "canvas" ? { type: "canvas.ops", data: { ops: planToOps(plan, tasks, run.id, claimed.snapshot), reply: plan.reply } } : { type: "run.planned", data: { reply: plan.reply, tasks: tasks.map(taskPlanSummary) } };
            await updateAgentRunById(
                run.id,
                { tasks, foundation: plan.foundation, reviewed: false, plannerAudit: buildAgentRunPlannerAudit({ mode: "direct", skills }), timings: { ...(claimed.timings || { requestAcceptedAt: claimed.createdAt }), planningCompletedAt: Date.now() } },
                event,
                ["running"],
                executionId,
            );
            await executeTasks(run.id, origin, cookie, executionId, settings);
            return;
        }
        const referencedAssets = usesMemoryCandidates ? memoryAssets : explicitAssets;
        const referenceSource = claimed.referencedAssetIds.length ? "current-turn-explicit" : usesMemoryCandidates && referencedAssets.length ? "conversation-memory-candidates" : "none";
        const model = settings.defaultModels.textModel;
        const candidates = resolveLogicalModelCandidates(settings, "text", model);
        if (!model || !candidates.length) throw new Error("后台尚未配置可用的默认文本模型");
        const fallbackExample = agentPlanFallbackExample(availableModels);
        const plannerContext = buildAgentPlannerInput(claimed, conversationContext, referencedAssets, referenceSource, skillOptions, availableModels, settings);
        if (!(await updateAgentRunById(run.id, { plannerContext: plannerContext.summary }, { type: "skills.selected", data: { skills: skills.map((skill) => ({ id: skill.id, name: skill.name })) } }, ["running"], executionId))) return;
        const plannerRequest = buildAgentRequest(claimed, plannerContext.input);
        const planningInput = [
            {
                role: "system",
                content: agentPlannerSystemPrompt(claimed.surface, fallbackExample, settings.site.title),
            },
            {
                role: "user",
                content: serializeAgentRequest(plannerRequest),
            },
        ];
        if (
            !(await updateAgentRunById(
                run.id,
                {
                    promptSchemaVersion: plannerRequest.schema,
                    promptTransport: "json",
                    contextDigest: agentRequestDigest(plannerRequest),
                    plannerStreamMode: undefined,
                    plannerStreamFallbackReason: undefined,
                },
                { type: "run.planning.context_ready" },
                ["running"],
                executionId,
            ))
        )
            return;
        let plan: Awaited<ReturnType<typeof parseAgentPlanCall>> | undefined;
        let latestPlanningError: unknown;
        for (const candidate of rankTextPlanningCandidates(candidates.map((candidate) => ({ ...candidate, channelId: candidate.channel.id })))) {
            try {
                const planCall = await requestFunctionCall(
                    origin,
                    cookie,
                    candidate,
                    planningInput,
                    agentPlanTool,
                    "create_agent_plan",
                    controller.signal,
                    run.userId,
                    model,
                    false,
                    systemAiIdempotencyKey("agent-plan", run.userId, run.id, candidate.channel.id, candidate.upstreamModel),
                    true,
                    () =>
                        updateAgentRunById(run.id, { timings: { ...(claimed.timings || { requestAcceptedAt: claimed.createdAt }), plannerFirstByteAt: Date.now() } }, { type: "run.planning.model_connected" }, ["running"], executionId).then(
                            () => undefined,
                        ),
                );
                await updateAgentRunById(
                    run.id,
                    {
                        plannerStreamMode: planCall.transport || "complete",
                        ...(planCall.fallbackReason ? { plannerStreamFallbackReason: planCall.fallbackReason } : {}),
                    },
                    { type: "run.planning.validating" },
                    ["running"],
                    executionId,
                );
                plan = await parseAgentPlanCall(planCall, () => refundFunctionCall(claimed.userId, model, planCall), undefined, {
                    allowProjectHandoff: claimed.surface === "chat" && isExplicitProjectHandoffRequest(claimed.prompt),
                    requiredGenerationMode: claimed.generationPreferences?.mode,
                });
                if (plan) acceptedPlan = { userId: claimed.userId, model, channelId: candidate.channel.id, upstreamModel: candidate.upstreamModel, call: planCall };
                break;
            } catch (error) {
                if (controller.signal.aborted) throw error;
                if (error instanceof GenerationSubmissionUncertainError) throw error;
                latestPlanningError = error;
                candidateFailures.push({ channelId: candidate.channel.id, upstreamModel: candidate.upstreamModel, error: toSafeGenerationErrorMessage(error, "规划渠道调用失败") });
            }
        }
        if (!plan) throw latestPlanningError instanceof Error ? latestPlanningError : new Error("没有可用的文本模型渠道");
        if (claimed.surface === "canvas") plan = normalizeCanvasPlanForSelection(plan, claimed.snapshot, claimed.prompt);
        const plannerAudit = buildAgentRunPlannerAudit({
            mode: "model",
            logicalModelId: model,
            channelId: acceptedPlan?.channelId,
            upstreamModel: acceptedPlan?.upstreamModel,
            protocol: acceptedPlan?.call.protocol,
            elapsedMs: acceptedPlan?.call.elapsedMs,
            pointsCost: acceptedPlan?.call.pointsCost,
            pointsRecordId: acceptedPlan?.call.pointsRecordId,
            skills,
        });
        if (!(await canContinue(run.id, executionId))) {
            await refundAcceptedPlan();
            return;
        }
        if (plan.intent === "conversation") {
            const completed = await updateAgentRunById(
                run.id,
                {
                    status: "completed",
                    tasks: [],
                    reviewed: true,
                    plannerAudit,
                    executionId: undefined,
                    timings: { ...(claimed.timings || { requestAcceptedAt: claimed.createdAt }), planningCompletedAt: Date.now(), allResultsReadyAt: Date.now(), runCompletedAt: Date.now() },
                },
                { type: "run.completed", data: { completed: 0, reply: plan.reply?.trim() || conversationFallbackReply(claimed.surface) } },
                ["running"],
                executionId,
            );
            if (!completed) {
                await refundAcceptedPlan();
                return;
            }
            planningPersisted = true;
            return;
        }
        const executablePlan = fallbackUnsupportedMediaPlanToText(plan, settings);
        const tasks = normalizeTasks(executablePlan, skills, settings, claimed.snapshot, claimed.prompt, claimed.surface, referencedAssets, claimed.requestedImageSize, claimed.generationPreferences);
        const projectHandoff = normalizeAgentProjectHandoff(executablePlan, claimed.surface, referencedAssets, claimed.prompt);
        const reply = agentPlanReply({ ...executablePlan, projectHandoff }, tasks, claimed.surface);
        const event = claimed.surface === "canvas" ? { type: "canvas.ops", data: { ops: planToOps(executablePlan, tasks, run.id, claimed.snapshot), reply } } : { type: "run.planned", data: { reply, tasks: tasks.map(taskPlanSummary), projectHandoff } };
        const planned = await updateAgentRunById(
            run.id,
            { tasks, foundation: executablePlan.foundation, projectHandoff, reviewed: tasks.length ? claimed.reviewed : true, plannerAudit, timings: { ...(claimed.timings || { requestAcceptedAt: claimed.createdAt }), planningCompletedAt: Date.now() } },
            event,
            ["running"],
            executionId,
        );
        if (!planned) {
            await refundAcceptedPlan();
            return;
        }
        planningPersisted = true;
        failureStage = "task_execution";
        await executeTasks(run.id, origin, cookie, executionId, settings);
    } catch (error) {
        let failure = error;
        try {
            await refundAcceptedPlan();
        } catch (refundError) {
            console.error("Agent planning refund failed", refundError instanceof Error ? refundError.message : refundError);
            failure = refundError;
            failureStage = "refund";
        }
        const latest = await getAgentRun(run.id);
        if (latest && !["paused", "cancelled"].includes(latest.status))
            await updateAgentRunById(
                run.id,
                {
                    status: "failed",
                    executionId: undefined,
                    failure: toSafeGenerationErrorMessage(failure, "Agent 执行失败"),
                    failureStage,
                    candidateFailures: candidateFailures.length ? candidateFailures : undefined,
                    timings: { ...(latest.timings || { requestAcceptedAt: latest.createdAt }), runCompletedAt: Date.now() },
                },
                { type: "run.failed", data: { message: toSafeGenerationErrorMessage(failure, "Agent 执行失败") } },
                ["planning", "running"],
                executionId,
            );
    } finally {
        if (controllers.get(run.id) === controller) controllers.delete(run.id);
    }
}
