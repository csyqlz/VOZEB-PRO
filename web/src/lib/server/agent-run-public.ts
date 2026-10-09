import type { CreativeRunEvent } from "@/lib/creative-runtime-contract";
import { toSafeGenerationErrorMessage } from "./generation-errors";
import type { AgentRun, AgentRunTask } from "./agent-run-store";
import { ECOMMERCE_QUALITY_CHECK_KEYS, type EcommerceQualityCheck } from "./ecommerce-quality-check";

const PUBLIC_QUALITY_KEYS = new Set<string>([...ECOMMERCE_QUALITY_CHECK_KEYS, "canvas_geometry", "stored_media"]);

export function publicAgentRun(run: AgentRun) {
    const qualityCheck = run.ecommerceSnapshot?.qualityCheck;
    const technicalCheck = run.ecommerceSnapshot?.technicalCheck;
    const optionalQuality = Boolean(run.ecommerceSnapshot?.qualityPolicy);
    const ecommerceQualityStatus = optionalQuality
        ? technicalCheck && technicalCheck.status !== "passed"
            ? "needs_review"
            : qualityCheck
              ? qualityCheck.status === "passed"
                  ? "passed"
                  : "needs_adjustment"
              : undefined
        : qualityCheck?.status === "blocked" || qualityCheck?.status === "unavailable" || qualityCheck?.hardFailures?.length
          ? "needs_review"
          : qualityCheck?.publicStatus;
    const reviewCheck = optionalQuality && technicalCheck?.status !== "passed" ? technicalCheck : qualityCheck;
    const ecommerceQualityReview =
        ecommerceQualityStatus === "needs_review" || ecommerceQualityStatus === "needs_adjustment"
            ? {
                  kind: reviewCheck?.status === "unavailable" && !reviewCheck?.hardFailures?.length ? ("check_unavailable" as const) : ecommerceQualityStatus === "needs_adjustment" ? ("needs_adjustment" as const) : ("hard_failure" as const),
                  ...(optionalQuality && technicalCheck?.status === "passed" ? { advisory: true } : {}),
                  failureKeys: Array.from(
                      new Set(
                          (ecommerceQualityStatus === "needs_adjustment" ? reviewCheck?.checks || [] : reviewCheck?.hardFailures || [])
                              .filter((item) => (ecommerceQualityStatus !== "needs_adjustment" || item.status === "failed") && PUBLIC_QUALITY_KEYS.has(item.key))
                              .map((item) => item.key),
                      ),
                  ),
                  ...(optionalQuality && technicalCheck?.status === "passed"
                      ? { message: qualityCheck?.status === "unavailable" ? "图片已生成，视觉质检暂时不可用。" : "图片已生成，以下视觉建议供参考。" }
                      : publicCanvasFailureMessage(reviewCheck)
                        ? { message: publicCanvasFailureMessage(reviewCheck) }
                        : {}),
              }
            : undefined;
    const blockedEcommerceResult = optionalQuality ? technicalCheck?.status !== "passed" : ecommerceQualityStatus === "needs_review";
    return {
        id: run.id,
        conversationId: run.conversationId,
        inputMessageId: run.inputMessageId,
        assistantMessageId: run.assistantMessageId,
        surface: run.surface,
        projectId: run.projectId,
        status: run.status,
        prompt: run.publicPrompt || run.prompt,
        referencedAssetIds: run.referencedAssetIds || [],
        selectedSkillIds: run.selectedSkillIds,
        requestedModelIds: run.requestedModelIds,
        generationPreferences: run.generationPreferences,
        assetIds: blockedEcommerceResult ? [] : run.assetIds || [],
        ...(ecommerceQualityStatus ? { ecommerceQualityStatus } : {}),
        ...(ecommerceQualityReview ? { ecommerceQualityReview } : {}),
        tasks: (run.tasks || []).map(publicAgentRunTask),
        cancellation: run.cancellation ? { pendingCount: run.cancellation.pendingChildTaskIds.length } : undefined,
        timings: run.timings,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
    };
}

export function publicAgentRunSnapshot(run: AgentRun) {
    const value = publicAgentRun(run);
    return {
        id: value.id,
        status: value.status,
        tasks: value.tasks,
        assetIds: value.assetIds,
        ecommerceQualityStatus: value.ecommerceQualityStatus,
        ecommerceQualityReview: value.ecommerceQualityReview,
        cancellation: value.cancellation,
        timings: value.timings,
        updatedAt: value.updatedAt,
    };
}

function publicCanvasFailureMessage(check: Pick<EcommerceQualityCheck, "hardFailures" | "canvasEvidence"> | undefined) {
    if (!check?.hardFailures?.some((item) => item.key === "canvas_geometry")) return "";
    const evidence = check.canvasEvidence?.find((item) => item.nativeMatches === false || item.storedMatches === false);
    const sizeText = (size: { width: number; height: number } | undefined) => (size && Number.isSafeInteger(size.width) && size.width > 0 && Number.isSafeInteger(size.height) && size.height > 0 ? `${size.width}×${size.height}` : "");
    const requested = sizeText(evidence?.constraint.size);
    const native = sizeText(evidence?.nativeSize);
    const stored = sizeText(evidence?.storedSize);
    const sizes = [requested ? `${evidence?.constraint.mode === "ratio" ? "要求比例" : "要求"} ${requested}` : "", native ? `上游原图 ${native}` : "", stored ? `落盘图片 ${stored}` : ""].filter(Boolean);
    return `画幅与要求不一致${sizes.length ? `：${sizes.join("，")}` : ""}。`;
}

export function publicAgentRunEvent(event: CreativeRunEvent): CreativeRunEvent {
    if (event.type.startsWith("run.planning.")) return { ...event, data: undefined };
    if (event.type.startsWith("run.review.")) return { ...event, data: undefined };
    if (event.type === "run.cancel.pending") return { ...event, data: { pendingCount: arrayValue(recordValue(event.data).pendingTaskIds).length } };
    if (event.type === "canvas.ops") {
        const data = recordValue(event.data);
        return { ...event, data: { ...(textValue(data.reply) ? { reply: textValue(data.reply) } : {}), ops: publicCanvasOps(arrayValue(data.ops)) } };
    }
    if (event.type === "ecommerce.quality") {
        const data = recordValue(event.data);
        const status = textValue(data.status);
        const text = textValue(data.text);
        return { ...event, data: { ...(status ? { status } : {}), ...(text ? { text } : {}) } };
    }
    return event;
}

function publicAgentRunTask(task: AgentRunTask) {
    const optimizedPrompt = task.optimizedPrompt?.trim() || publicPromptFromExecutionPrompt(task.prompt);
    return {
        id: task.id,
        title: task.title,
        type: task.type,
        model: task.model,
        optimizedPrompt: optimizedPrompt || undefined,
        ratio: task.ratio,
        quality: task.quality,
        seconds: task.seconds,
        voice: task.voice,
        format: task.format,
        generateAudio: task.generateAudio,
        watermark: task.watermark,
        speed: task.speed,
        count: task.count,
        status: task.status,
        error: task.error ? toSafeGenerationErrorMessage(task.error, "生成任务失败") : undefined,
    };
}

function publicPromptFromExecutionPrompt(prompt: string | undefined) {
    if (!prompt) return "";
    const markers = [
        "\n\n统一创作约束：",
        "\n\n执行以下已选 Skill 约束：",
        "\n\n严格输出要求：",
        "\n\n基于画布已有节点进行局部修改：",
        "\n\n使用已引用创作资产：",
        "\n\n请保持与以下已完成产物一致，并将依赖媒体作为真实生成参考：",
        "\n\n以下为内部执行上下文，只用于理解连续创作关系和指代；",
    ];
    const boundary = markers.reduce((earliest, marker) => {
        const index = prompt.indexOf(marker);
        return index >= 0 && (earliest < 0 || index < earliest) ? index : earliest;
    }, -1);
    return boundary >= 0 ? prompt.slice(0, boundary).trim() : "";
}

function publicCanvasOps(value: unknown[]) {
    const ops = value.map(recordValue);
    const internalNodeIds = new Set(ops.flatMap((op) => (op.type === "add_node" && (op.nodeType === "brief" || op.nodeType === "brand-kit") && typeof op.id === "string" ? [op.id] : [])));
    return ops
        .filter((op) => {
            if (typeof op.id === "string" && internalNodeIds.has(op.id)) return false;
            if (op.type === "connect_nodes" && ((typeof op.fromNodeId === "string" && internalNodeIds.has(op.fromNodeId)) || (typeof op.toNodeId === "string" && internalNodeIds.has(op.toNodeId)))) return false;
            return true;
        })
        .map((op) => {
            const metadata = recordValue(op.metadata);
            if (!Object.keys(metadata).length) return op;
            const { prompt: _prompt, agentBrief: _agentBrief, brandKit: _brandKit, foundation: _foundation, review: _review, resolvedPrompt: _resolvedPrompt, ...publicMetadata } = metadata;
            return { ...op, metadata: publicMetadata };
        });
}

function recordValue(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function arrayValue(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function textValue(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}
