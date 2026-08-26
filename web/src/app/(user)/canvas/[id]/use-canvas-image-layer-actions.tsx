"use client";

import { useCallback, useRef } from "react";

import { requestCanvasImageDecomposition } from "@/services/api/canvas-image-decomposition";
import { canvasImageLayerSlotId } from "@/lib/canvas-image-decomposition";
import { nanoid } from "nanoid";

import { CanvasNodeType, type CanvasNodeData } from "../types";
import { splitSubjectAndBackgroundDataUrl } from "../utils/canvas-image-data";
import { withCanvasLayerAnalysisStatus } from "./canvas-image-layer-analysis-status";
import { canvasEcommerceBackgroundPrompt, canvasEcommerceElementPrompt, createCanvasLayerTaskNode, runCanvasImageLayerTask, runCanvasImageLayerTaskBatch, stableCanvasLayerSource } from "./canvas-image-layer-runtime";
import { buildGenerationConfig, imageMetadata, uploadCanvasImage } from "./canvas-page-utils";
import type { CanvasPageState } from "./use-canvas-page-state";
import type { CanvasTaskRuntime } from "./use-canvas-task-runtime";

export function useCanvasImageLayerActions({ state, tasks }: { state: CanvasPageState; tasks: CanvasTaskRuntime }) {
    const { message, effectiveConfig, isAiConfigReady, nodes, openConfigDialog, setNodes, setConnections, setSelectedNodeIds, setSelectedConnectionId, setToolbarNodeId, setDialogNodeId, setRunningNodeId } = state;
    const operationNodeIds = useRef(new Set<string>());

    const removeBackgroundImageNode = useCallback(
        async (node: CanvasNodeData) => {
            if (!node.metadata?.content) return;
            if (operationNodeIds.current.has(node.id)) return message.info("正在处理这张图片，请稍候");
            const messageKey = `canvas-subject-${node.id}`;
            operationNodeIds.current.add(node.id);
            message.loading({ key: messageKey, content: "正在识别并提取主体…", duration: 0 });
            try {
                const layers = await splitSubjectAndBackgroundDataUrl(node.metadata.content);
                const image = await uploadCanvasImage(layers.foregroundBlob);
                const childId = nanoid();
                setNodes((current) => [
                    ...current,
                    {
                        id: childId,
                        type: CanvasNodeType.Image,
                        title: "主体（透明背景）",
                        position: { x: node.position.x + node.width + 96, y: node.position.y },
                        width: node.width,
                        height: node.height,
                        metadata: { ...imageMetadata(image), prompt: node.metadata?.prompt, layerName: "主体（透明背景）", sourceLayerNodeId: node.id },
                    },
                ]);
                setConnections((current) => [...current, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
                setSelectedNodeIds(new Set([childId]));
                setSelectedConnectionId(null);
                setToolbarNodeId(childId);
                setDialogNodeId(childId);
                message.success({ key: messageKey, content: "已生成透明主体图层" });
            } catch (error) {
                message.destroy(messageKey);
                throw error;
            } finally {
                operationNodeIds.current.delete(node.id);
            }
        },
        [message, setConnections, setDialogNodeId, setNodes, setSelectedConnectionId, setSelectedNodeIds, setToolbarNodeId],
    );

    const splitImageLayers = useCallback(
        async (node: CanvasNodeData) => {
            if (!node.metadata?.content) return;
            if (operationNodeIds.current.has(node.id)) return message.info("正在处理这张图片，请稍候");
            const baseConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), count: "1" };
            if (!isAiConfigReady(baseConfig, baseConfig.model)) {
                openConfigDialog(true);
                return;
            }

            const messageKey = `canvas-layers-${node.id}`;
            const analysisMessageKey = `${messageKey}-analysis`;
            operationNodeIds.current.add(node.id);
            try {
                const { source, decomposition } = await withCanvasLayerAnalysisStatus(message, analysisMessageKey, async () => {
                    const stableSource = await stableCanvasLayerSource(node, setNodes);
                    const analysis = await requestCanvasImageDecomposition({ requestId: nanoid(), source: stableSource.serverUrl || stableSource.url || stableSource.dataUrl });
                    return { source: stableSource, decomposition: analysis };
                });
                if (!decomposition.layers.length) throw new Error("没有识别到可独立分层的元素");
                const config = { ...baseConfig, size: `${decomposition.width}x${decomposition.height}` };
                const layerNodes: CanvasNodeData[] = [];
                const layerPlans: Array<{ targetNode: CanvasNodeData; prompt: string; outputBackground?: "transparent"; layerBatch: { grant: string; slotId: string } }> = [];
                for (const candidate of decomposition.layers) {
                    const prompt = canvasEcommerceElementPrompt(candidate, decomposition);
                    const layerNode = createCanvasLayerTaskNode(
                        node,
                        nanoid(),
                        candidate.name,
                        [...nodes, ...layerNodes],
                        config,
                        prompt,
                        source,
                        {
                            kind: candidate.kind,
                            bbox: candidate.bbox,
                            zIndex: candidate.zIndex,
                            groupId: candidate.groupId,
                            sourceWidth: decomposition.width,
                            sourceHeight: decomposition.height,
                        },
                        "transparent",
                        { grant: decomposition.batchGrant, slotId: canvasImageLayerSlotId(candidate.id) },
                    );
                    layerNodes.push(layerNode);
                    layerPlans.push({ targetNode: layerNode, prompt, outputBackground: "transparent", layerBatch: { grant: decomposition.batchGrant, slotId: canvasImageLayerSlotId(candidate.id) } });
                }
                const backgroundPrompt = canvasEcommerceBackgroundPrompt(decomposition);
                const backgroundBatch = { grant: decomposition.batchGrant, slotId: "background" };
                const backgroundNode = createCanvasLayerTaskNode(node, nanoid(), "背景", [...nodes, ...layerNodes], config, backgroundPrompt, source, undefined, undefined, backgroundBatch);
                const taskPlans = [...layerPlans, { targetNode: backgroundNode, prompt: backgroundPrompt, layerBatch: backgroundBatch }];
                const taskNodes = [...layerNodes, backgroundNode];
                setNodes((current) => [...current, ...taskNodes]);
                setConnections((current) => [...current, ...taskNodes.map((layer) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: layer.id }))]);
                setSelectedNodeIds(new Set(layerNodes.map((layer) => layer.id)));
                setSelectedConnectionId(null);
                setToolbarNodeId(layerNodes[0]?.id || backgroundNode.id);
                setRunningNodeId(node.id);

                const settled = await runCanvasImageLayerTaskBatch(taskPlans, source, (plan, stableSource) =>
                    runCanvasImageLayerTask({
                        sourceNode: node,
                        targetNode: plan.targetNode,
                        source: stableSource,
                        config,
                        prompt: plan.prompt,
                        outputBackground: plan.outputBackground,
                        layerBatch: plan.layerBatch,
                        state,
                        tasks,
                    }),
                );
                const outcomes = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : ["failed" as const]));
                const completed = outcomes.filter((outcome) => outcome === "completed").length;
                const needsReview = outcomes.filter((outcome) => outcome === "needs_review").length;
                const failed = outcomes.filter((outcome) => outcome === "failed").length;
                const cancelled = outcomes.filter((outcome) => outcome === "cancelled").length;
                if (needsReview || failed) message.warning({ key: messageKey, content: `已完成 ${completed} 项，${needsReview ? `${needsReview} 项待检查` : ""}${needsReview && failed ? "，" : ""}${failed ? `${failed} 项失败` : ""}` });
                else if (cancelled) message.info({ key: messageKey, content: `已完成 ${completed} 项，其余任务已停止` });
                else message.success({ key: messageKey, content: `${layerNodes.length} 个独立元素和背景已完成` });
            } catch (error) {
                const errorDetails = error instanceof Error ? error.message : "分层失败";
                message.error({ key: messageKey, content: errorDetails });
            } finally {
                operationNodeIds.current.delete(node.id);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, isAiConfigReady, message, nodes, openConfigDialog, setConnections, setNodes, setRunningNodeId, setSelectedConnectionId, setSelectedNodeIds, setToolbarNodeId, state, tasks],
    );

    return { removeBackgroundImageNode, splitImageLayers };
}
