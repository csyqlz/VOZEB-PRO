import { isGenerationTaskNeedsReviewError } from "@/services/api/generation-task-state";
import type { UploadedImage } from "@/services/image-storage";
import type { ReferenceImage } from "@/types/image";
import type { CanvasImageDecomposition, CanvasImageLayerCandidate } from "@/lib/canvas-image-decomposition";
import { CanvasNodeType, type CanvasNodeData } from "../types";
import { findFreeNodePosition } from "../utils/canvas-agent-ops";
import { NODE_STATUS_ERROR, NODE_STATUS_LOADING } from "./canvas-page-elements";
import { pauseCanvasGenerationReview } from "./canvas-generation-review";
import { buildGenerationConfig, buildImageGenerationMetadata, canvasNodeReferenceImage, imageMetadata, isGenerationCanceled, uploadCanvasImage } from "./canvas-page-utils";
import type { CanvasPageState } from "./use-canvas-page-state";
import type { CanvasTaskRuntime } from "./use-canvas-task-runtime";

export async function stableCanvasLayerSource(node: CanvasNodeData, setNodes: CanvasPageState["setNodes"]): Promise<ReferenceImage> {
    let source = canvasNodeReferenceImage(node);
    if (/^(data:|blob:)/i.test(source.dataUrl)) {
        const stored = await uploadCanvasImage(source.dataUrl);
        source = canvasLayerReference(stored, node.id, "source.png");
        setNodes((current) => current.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, ...imageMetadata(stored) } } : item)));
    }
    return source;
}

export function createCanvasLayerTaskNode(
    sourceNode: CanvasNodeData,
    id: string,
    name: string,
    occupiedNodes: CanvasNodeData[],
    config: ReturnType<typeof buildGenerationConfig>,
    prompt: string,
    source: ReferenceImage,
    imageLayer?: NonNullable<CanvasNodeData["metadata"]>["imageLayer"],
    outputBackground?: "transparent",
    layerBatch?: { grant: string; slotId: string },
): CanvasNodeData {
    const position = findFreeNodePosition(occupiedNodes, { x: sourceNode.position.x + sourceNode.width + 36, y: sourceNode.position.y }, sourceNode.width, sourceNode.height);
    return {
        id,
        type: CanvasNodeType.Image,
        title: `${sourceNode.title || "图片"} · ${name}`,
        position,
        width: sourceNode.width,
        height: sourceNode.height,
        metadata: {
            prompt,
            status: NODE_STATUS_LOADING,
            ...buildImageGenerationMetadata("edit", config, 1, [source]),
            layerName: name,
            sourceLayerNodeId: sourceNode.id,
            imageLayer,
            imageOutputBackground: outputBackground,
            ...(outputBackground ? { imageOutputMode: "layers" as const } : {}),
            imageLayerBatch: layerBatch,
        },
    };
}

export function canvasEcommerceElementPrompt(candidate: CanvasImageLayerCandidate, decomposition: CanvasImageDecomposition) {
    const { bbox } = candidate;
    const focus = (candidate.focusPoints || []).map((point) => `(${point.x},${point.y})`).join("、");
    return [
        `从这张完整主图中精准提取“${candidate.name}”作为唯一独立元素。`,
        `原图尺寸 ${decomposition.width}x${decomposition.height}，元素范围 x=${bbox.x}, y=${bbox.y}, width=${bbox.width}, height=${bbox.height}。`,
        focus ? `元素内部定位点：${focus}。` : "",
        "输出必须保持原图完整宽高和原坐标，只保留该元素的原始像素、文字、颜色、结构与清晰边缘，其余区域全部透明。不得移动、缩放、重绘、改写或混入其他元素。",
    ]
        .filter(Boolean)
        .join("");
}

export function canvasEcommerceBackgroundPrompt(decomposition: CanvasImageDecomposition) {
    const elements = decomposition.layers.map(({ name, bbox }) => `${name}[x=${bbox.x},y=${bbox.y},width=${bbox.width},height=${bbox.height}]`).join("；");
    const preserved = decomposition.backgroundPreservedVisuals.length ? `必须保留这些背景视觉：${decomposition.backgroundPreservedVisuals.join("、")}。` : "";
    const background = decomposition.backgroundDescription ? `背景应延续：${decomposition.backgroundDescription}。` : "";
    return `基于这张完整主图生成干净背景，移除这些独立前景元素：${elements}。自然补全所有被遮挡区域，保持原图背景、构图、光线、色彩和完整尺寸，不得把已移除元素重新画回。${preserved}${background}`;
}

export async function runCanvasImageLayerTaskBatch<TPlan, TResult>(plans: readonly TPlan[], source: ReferenceImage, execute: (plan: TPlan, source: ReferenceImage) => Promise<TResult>) {
    return Promise.allSettled(plans.map((plan) => execute(plan, source)));
}

export async function runCanvasImageLayerTask({
    sourceNode,
    targetNode,
    source,
    config,
    prompt,
    outputBackground,
    layerBatch,
    state,
    tasks,
}: {
    sourceNode: CanvasNodeData;
    targetNode: CanvasNodeData;
    source: ReferenceImage;
    config: ReturnType<typeof buildGenerationConfig>;
    prompt: string;
    outputBackground?: "transparent";
    layerBatch?: { grant: string; slotId: string };
    state: CanvasPageState;
    tasks: CanvasTaskRuntime;
}) {
    const { setConnections, setNodes } = state;
    const { finishGenerationRequest, startAndCompleteImageTask, startGenerationRequest } = tasks;
    const controller = startGenerationRequest(targetNode.id, sourceNode.id, sourceNode.id);
    try {
        await startAndCompleteImageTask(targetNode.id, config, prompt, [source], undefined, controller, { outputBackground, layerBatch });
        return "completed" as const;
    } catch (error) {
        if (isGenerationCanceled(error)) {
            setNodes((current) => current.filter((item) => item.id !== targetNode.id));
            setConnections((current) => current.filter((connection) => connection.toNodeId !== targetNode.id));
            return "cancelled" as const;
        }
        const errorDetails = error instanceof Error ? error.message : `${targetNode.metadata?.layerName || targetNode.title}生成失败`;
        if (isGenerationTaskNeedsReviewError(error)) {
            setNodes((current) => pauseCanvasGenerationReview(current, [targetNode.id], errorDetails));
            return "needs_review" as const;
        }
        setNodes((current) => current.map((item) => (item.id === targetNode.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, imageTask: undefined, errorDetails } } : item)));
        return "failed" as const;
    } finally {
        finishGenerationRequest(targetNode.id, controller);
    }
}

export function canvasLayerReference(image: UploadedImage, id: string, name: string): ReferenceImage {
    const dataUrl = image.serverUrl || image.url;
    return { id, name, type: image.mimeType || "image/png", dataUrl, url: dataUrl, serverUrl: dataUrl, storageKey: image.storageKey, width: image.width, height: image.height };
}
