import type { AuthSettings } from "@/lib/auth/store";
import { typedReferenceAliases } from "@/lib/creative-asset-references";
import { isCreativeAutoValue } from "@/lib/creative-runtime-contract";
import { closestImageAspectRatio, extractImageOrientationFromPrompt, imageSizeMatchesOrientation, normalizeImageSizeValue, parseImageDimensions } from "@/lib/image-size";
import type { AgentRun, AgentRunReference, AgentRunTask } from "@/lib/server/agent-run-store";
import type { AgentPlan } from "@/lib/server/agent-run-validation";

import { selectedCanvasNodeIds } from "./agent-run-canvas-snapshot";
import { agentCanvasOutputNodeIds, agentCanvasTaskNodeId } from "./agent-run-canvas-node-ids";

export type CanvasTaskReferenceNode = {
    title: string;
    summary: string;
    url?: string;
    type?: AgentRunTask["type"];
    content?: string;
    width?: number;
    height?: number;
    size?: string;
};

export type CanvasSelectedReferenceNode = CanvasTaskReferenceNode & {
    nodeId: string;
    alias: string;
    type: AgentRunReference["type"];
    url: string;
};

export function canvasSnapshotNodes(snapshot: unknown) {
    const map = new Map<string, CanvasTaskReferenceNode>();
    const nodes = snapshot && typeof snapshot === "object" && Array.isArray((snapshot as { nodes?: unknown }).nodes) ? (snapshot as { nodes: Array<Record<string, unknown>> }).nodes : [];
    for (const node of nodes) {
        if (typeof node.id !== "string") continue;
        const metadata = node.metadata && typeof node.metadata === "object" ? (node.metadata as Record<string, unknown>) : {};
        const content = [metadata.content, metadata.prompt].find((item) => typeof item === "string" && item);
        const url = [metadata.remoteUrl, metadata.serverUrl, metadata.url, metadata.dataUrl].find((item) => typeof item === "string" && item) as string | undefined;
        const type = node.type === "panorama" ? "image" : node.type === "text" || node.type === "image" || node.type === "video" || node.type === "audio" ? node.type : undefined;
        const title = String(node.title || node.type || "节点");
        map.set(node.id, {
            title,
            summary: `${title}${content ? `；内容：${String(content)}` : ""}${url && !url.startsWith("data:") ? `；素材：${url}` : ""}`,
            url,
            type,
            content: typeof content === "string" ? content : undefined,
            width: positiveNumber(metadata.naturalWidth) || positiveNumber(node.width),
            height: positiveNumber(metadata.naturalHeight) || positiveNumber(node.height),
            size: typeof metadata.size === "string" ? metadata.size : undefined,
        });
    }
    return map;
}

export function selectedCanvasReferenceNodes(snapshot: unknown): CanvasSelectedReferenceNode[] {
    const nodes = canvasSnapshotNodes(snapshot);
    const selectedNodeIds = selectedCanvasNodeIds(snapshot);
    const candidates = selectedNodeIds.flatMap((nodeId) => {
        const node = nodes.get(nodeId);
        return node?.url && isMediaReferenceType(node.type) ? [{ id: nodeId, type: node.type }] : [];
    });
    const aliases = typedReferenceAliases(candidates, selectedNodeIds);
    return selectedNodeIds.flatMap((nodeId) => {
        const node = nodes.get(nodeId);
        const alias = aliases.get(nodeId);
        return node?.url && alias && isMediaReferenceType(node.type) ? [{ ...node, nodeId, alias, type: node.type, url: node.url }] : [];
    });
}

export function canvasReferenceContext(references: readonly CanvasSelectedReferenceNode[]) {
    return references.map((reference) => `引用别名：@${reference.alias}；画布节点 ID：${reference.nodeId}；类型：${reference.type}；标题：${reference.title}`).join("\n");
}

export function canvasReferenceSupportsTask(referenceType: AgentRunReference["type"], taskType: AgentRunTask["type"]) {
    if (taskType === "image") return referenceType === "image";
    if (taskType === "video") return referenceType === "image" || referenceType === "video" || referenceType === "audio";
    if (taskType === "audio") return referenceType === "audio";
    return false;
}

export function resolveCanvasTaskTargetNodeId(plannedTargetNodeId: string | undefined, taskType: AgentRunTask["type"], selectedNodeIds: Set<string>, nodes: Map<string, CanvasTaskReferenceNode>) {
    const planned = plannedTargetNodeId?.trim();
    if (selectedNodeIds.size) {
        if (planned && selectedNodeIds.has(planned) && nodeSupportsTaskReference(nodes.get(planned)?.type, taskType)) return planned;
        return Array.from(selectedNodeIds).find((id) => nodeSupportsTaskReference(nodes.get(id)?.type, taskType));
    }
    return planned && nodeSupportsTaskReference(nodes.get(planned)?.type, taskType) ? planned : undefined;
}

export function resolveAgentTaskRatio(input: {
    type: AgentRunTask["type"];
    requestPrompt?: string;
    requestedImageSize?: string;
    configuredImageSize?: string;
    configuredSizeExplicit?: boolean;
    plannedRatio?: string;
    defaultSize?: string;
    globalSize?: string;
    reference?: Pick<CanvasTaskReferenceNode, "type" | "width" | "height" | "size">;
}) {
    if (input.type !== "image" && input.type !== "video") return input.plannedRatio?.trim() || input.defaultSize?.trim() || input.globalSize?.trim() || undefined;
    const explicitValue = normalizeImageSizeValue(input.requestedImageSize);
    const configuredValue = normalizeImageSizeValue(input.configuredImageSize);
    const smart = isCreativeAutoValue(explicitValue) || isCreativeAutoValue(configuredValue);
    const explicit = isCreativeAutoValue(explicitValue) ? "" : explicitValue;
    const configured = isCreativeAutoValue(configuredValue) ? "" : configuredValue;
    const custom = parseImageDimensions(configured) ? configured : "";
    const configuredFixed = configured && !isCreativeAutoValue(configured) && !custom ? configured : "";
    const reference = input.reference?.type === "image" ? normalizeImageSizeValue(input.reference.size) || closestImageAspectRatio(input.reference.width, input.reference.height) : "";
    const planned = normalizeImageSizeValue(input.plannedRatio);
    const requestedOrientation = extractImageOrientationFromPrompt(input.requestPrompt || "");
    if (requestedOrientation) {
        const directed = [planned, configured, reference].find((value) => value && !isCreativeAutoValue(value) && imageSizeMatchesOrientation(value, requestedOrientation));
        return explicit || directed || "auto";
    }
    const fallback = smart ? "auto" : normalizeImageSizeValue(input.defaultSize) || normalizeImageSizeValue(input.globalSize) || "auto";
    return explicit || custom || (input.configuredSizeExplicit === true ? configuredFixed : "") || reference || (input.configuredSizeExplicit !== true ? configuredFixed : "") || (isCreativeAutoValue(planned) ? "" : planned) || fallback;
}

export function agentSurfaceImageSize(surface: AgentRun["surface"], snapshot: unknown) {
    if (!snapshot || typeof snapshot !== "object") return undefined;
    if (surface === "canvas") {
        const canvasSnapshot = snapshot as { imageSize?: unknown; nodes?: unknown; connections?: unknown };
        const nodes = Array.isArray(canvasSnapshot.nodes) ? canvasSnapshot.nodes.filter((node): node is Record<string, unknown> => Boolean(node) && typeof node === "object") : [];
        const configuredNodes = nodes.flatMap((node) => {
            if (node.type !== "config" || typeof node.id !== "string") return [];
            const metadata = node.metadata && typeof node.metadata === "object" ? (node.metadata as Record<string, unknown>) : {};
            const size = fixedImageSize(metadata.size);
            return size ? [{ id: node.id, size }] : [];
        });
        const imageSize = preciseImageSize(canvasSnapshot.imageSize);
        if (!configuredNodes.length) return imageSize;

        const selected = new Set(selectedCanvasNodeIds(snapshot));
        const selectedConfig = configuredNodes.find((node) => selected.has(node.id));
        if (selectedConfig) return selectedConfig.size;

        const connections = Array.isArray(canvasSnapshot.connections) ? canvasSnapshot.connections.filter((connection): connection is Record<string, unknown> => Boolean(connection) && typeof connection === "object") : [];
        const connectedConfig = configuredNodes.find((node) =>
            connections.some((connection) => (connection.fromNodeId === node.id && selected.has(String(connection.toNodeId || ""))) || (connection.toNodeId === node.id && selected.has(String(connection.fromNodeId || "")))),
        );
        if (connectedConfig) return connectedConfig.size;

        if (imageSize) return imageSize;

        const uniqueSizes = Array.from(new Set(configuredNodes.map((node) => node.size)));
        return uniqueSizes.length === 1 ? uniqueSizes[0] : undefined;
    }
    if (surface !== "drama") return undefined;
    const project = (snapshot as { project?: unknown }).project;
    if (!project || typeof project !== "object") return undefined;
    return normalizeImageSizeValue((project as { ratio?: unknown }).ratio) || undefined;
}

export function normalizeCanvasPlanForSelection(plan: AgentPlan, snapshot: unknown, requestPrompt: string): AgentPlan {
    const nodes = canvasSnapshotNodes(snapshot);
    const selectedEntries = selectedCanvasNodeIds(snapshot).map((id) => [id, nodes.get(id)] as const);
    const selectedTextEntry = selectedEntries.find((entry): entry is readonly [string, CanvasTaskReferenceNode] => entry[1]?.type === "text");
    if (selectedTextEntry && requestsSelectedTextEdit(requestPrompt)) {
        const [targetNodeId, target] = selectedTextEntry;
        const plannedText = plan.deliverables.find((item) => item.type === "text");
        const original = target.content?.trim() || "";
        const prompt = ["请按用户要求改写当前提示词，只返回修改后的完整提示词，不要解释、标题或 Markdown。", `用户要求：${requestPrompt}`, original ? `当前提示词：${original}` : ""].filter(Boolean).join("\n\n");
        return {
            ...plan,
            intent: "generation",
            objective: requestPrompt,
            reply: "我会直接修改当前提示词节点，不会自动生成图片。",
            decisions: [],
            projectHandoff: undefined,
            deliverables: [
                {
                    id: plannedText?.id?.trim() || "edit-selected-text",
                    targetNodeId,
                    title: `修改${target.title || "提示词"}`,
                    type: "text",
                    model: plannedText?.model,
                    prompt,
                    count: 1,
                    dependencies: [],
                    assetIds: [],
                },
            ],
        };
    }

    const selectedImageEntry = selectedEntries.find((entry): entry is readonly [string, CanvasTaskReferenceNode] => entry[1]?.type === "image");
    if (!selectedImageEntry || !requestsSelectedImageEdit(requestPrompt)) return plan;
    const [targetNodeId, target] = selectedImageEntry;
    const plannedImage = plan.deliverables.find((item) => item.type === "image");
    return {
        ...plan,
        intent: "generation",
        objective: requestPrompt,
        reply: "我会直接编辑当前图片，不会改成视频任务。",
        skillIds: [],
        decisions: [],
        projectHandoff: undefined,
        deliverables: [
            {
                id: plannedImage?.id?.trim() || "edit-selected-image",
                targetNodeId,
                title: `编辑${target.title || "图片"}`,
                type: "image",
                model: plannedImage?.model,
                prompt: requestPrompt,
                count: plannedImage?.count || 1,
                ratio: plannedImage?.ratio,
                quality: plannedImage?.quality,
                dependencies: [],
                assetIds: [],
            },
        ],
    };
}

export function prepareFailedAgentTaskRetry(run: AgentRun, task: AgentRunTask, settings: AuthSettings) {
    if (run.surface !== "canvas")
        return {
            ...task,
            ratio: resolveAgentTaskRatio({
                type: task.type,
                requestPrompt: run.prompt,
                requestedImageSize: run.requestedImageSize,
                configuredImageSize: agentSurfaceImageSize(run.surface, run.snapshot),
                configuredSizeExplicit: false,
                plannedRatio: task.ratio,
                globalSize: settings.generationDefaults.imageSize,
            }),
        };
    const nodes = canvasSnapshotNodes(run.snapshot);
    const selected = new Set(selectedCanvasNodeIds(run.snapshot).filter((id) => nodes.has(id)));
    const targetNodeId = resolveCanvasTaskTargetNodeId(task.targetNodeId, task.type, selected, nodes);
    const target = targetNodeId ? nodes.get(targetNodeId) : undefined;
    const selectedReferences = selectedCanvasReferenceNodes(run.snapshot).filter((reference) => canvasReferenceSupportsTask(reference.type, task.type));
    const references = selectedReferences.length
        ? (selectedReferences.map((reference) => ({ nodeId: reference.nodeId, url: reference.url, type: reference.type })) satisfies AgentRunReference[])
        : target?.url && isMediaReferenceType(target.type)
          ? ([{ nodeId: targetNodeId, url: target.url, type: target.type }] satisfies AgentRunReference[])
          : task.references;
    const primaryReference = references?.[0];
    const context = [target ? `基于画布已有节点进行局部修改：${target.summary}` : "", selectedReferences.length ? `使用本轮画布引用：\n${canvasReferenceContext(selectedReferences)}` : ""].filter(Boolean).join("\n\n");
    return {
        ...task,
        targetNodeId: target ? targetNodeId : task.targetNodeId,
        referenceUrl: primaryReference?.url || task.referenceUrl,
        referenceType: primaryReference?.type || task.referenceType,
        references,
        ratio: resolveAgentTaskRatio({
            type: task.type,
            requestPrompt: run.prompt,
            requestedImageSize: run.requestedImageSize,
            configuredImageSize: agentSurfaceImageSize(run.surface, run.snapshot),
            configuredSizeExplicit: true,
            plannedRatio: task.ratio,
            globalSize: settings.generationDefaults.imageSize,
            reference: target || selectedReferences.find((reference) => reference.type === "image"),
        }),
        prompt: context && !task.prompt.includes(context) ? `${task.prompt}\n\n${context}` : task.prompt,
    };
}

export function failedAgentTaskRetryOps(run: AgentRun, task: AgentRunTask) {
    if (run.surface !== "canvas") return [];
    const taskIndex = run.tasks.findIndex((item) => item.id === task.id);
    if (taskIndex < 0) return [];
    const taskNodeId = agentCanvasTaskNodeId(run.id, taskIndex);
    const outputNodeIds = task.type === "text" ? [] : agentCanvasOutputNodeIds(run.id, taskIndex, task);
    const sourceNodeIds = canvasTaskSourceNodeIds(task);
    return [
        { type: "update_node", id: taskNodeId, metadata: { targetNodeId: task.targetNodeId, agentTaskStatus: "ready", agentTaskError: "", agentTaskAttempts: task.attempts, agentTaskOutputNodeIds: outputNodeIds, agentGenerationTaskIds: [] } },
        ...outputNodeIds.map((id) => ({
            type: "update_node",
            id,
            metadata: {
                agentRunId: run.id,
                agentTaskId: task.id,
                agentTaskType: task.type,
                model: task.model,
                prompt: task.prompt,
                size: task.ratio,
                quality: task.quality,
                count: task.count,
                status: "loading",
                errorDetails: "",
                agentGenerationTaskIds: [],
            },
        })),
        ...sourceNodeIds.flatMap((sourceNodeId) => [{ type: "connect_nodes", fromNodeId: sourceNodeId, toNodeId: taskNodeId }, ...outputNodeIds.map((outputNodeId) => ({ type: "connect_nodes", fromNodeId: sourceNodeId, toNodeId: outputNodeId }))]),
    ];
}

export function canvasTaskSourceNodeIds(task: Pick<AgentRunTask, "targetNodeId" | "references">, existingNodeIds?: ReadonlySet<string>) {
    return Array.from(
        new Set([task.targetNodeId, ...(task.references || []).map((reference) => reference.nodeId)].filter((nodeId): nodeId is string => typeof nodeId === "string" && nodeId.length > 0 && (!existingNodeIds || existingNodeIds.has(nodeId)))),
    );
}

function nodeSupportsTaskReference(nodeType: CanvasTaskReferenceNode["type"], taskType: AgentRunTask["type"]) {
    if (taskType === "text") return nodeType === "text";
    if (taskType === "image") return nodeType === "image";
    if (taskType === "video") return nodeType === "image" || nodeType === "video";
    if (taskType === "audio") return nodeType === "audio";
    return false;
}

export function isMediaReferenceType(type: CanvasTaskReferenceNode["type"]): type is AgentRunReference["type"] {
    return type === "image" || type === "video" || type === "audio";
}

function requestsSelectedTextEdit(prompt: string) {
    const normalized = prompt.replace(/(?:不要|无需|不需要|别)\s*(?:生成|生图|出图|制作)(?:图片|图像|画面|视频|音频)?/gu, "");
    const requestsEdit = /修改|改写|优化|润色|调整|重写|精简|扩写|翻译/u.test(normalized);
    const requestsMedia = /(?:生成|生图|出图|绘制|制作).{0,10}(?:图片|图像|画面|视频|音频)|(?:图片|图像|画面|视频|音频).{0,10}(?:生成|生图|出图|绘制|制作)/u.test(normalized);
    return requestsEdit && !requestsMedia;
}

function requestsSelectedImageEdit(prompt: string) {
    const explicitlyRequestsAnotherMedium = /(?:视频|短视频|动画|动起来|运动起来|运镜|音频|配音|朗读|歌曲|音乐)/u.test(prompt);
    if (explicitlyRequestsAnotherMedium) return false;
    return /换成|替换|换掉|改成|改为|变成|变为|做成|修改|调整|重绘|重做|修图|扩图|去掉|移除|删除|添加|增加|上色|改色|换背景|风格化/u.test(prompt);
}

function positiveNumber(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : undefined;
}

function fixedImageSize(value: unknown) {
    const normalized = normalizeImageSizeValue(value);
    return normalized && !isCreativeAutoValue(normalized) ? normalized : undefined;
}

function preciseImageSize(value: unknown) {
    const normalized = normalizeImageSizeValue(value);
    return parseImageDimensions(normalized) ? normalized : undefined;
}
