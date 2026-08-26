"use client";

export type CanvasSubjectMask = {
    width: number;
    height: number;
    data: Float32Array;
};

export type CanvasSubjectLayerResult = { kind: "blobs"; foregroundBlob: Blob; editMaskBlob: Blob; width: number; height: number; foregroundPixels: number; backgroundPixels: number } | { kind: "mask"; mask: CanvasSubjectMask };
export type CanvasSubjectRegion = { x: number; y: number; width: number; height: number };

type SubjectSegmentationWorkerResponse = {
    id: number;
    operation?: "mask" | "layers";
    width?: number;
    height?: number;
    mask?: ArrayBuffer;
    foregroundBlob?: Blob;
    editMaskBlob?: Blob;
    foregroundPixels?: number;
    backgroundPixels?: number;
    error?: string;
};

type PendingSubjectSegmentation = {
    operation: "mask" | "layers";
    resolve: (result: { operation: "mask"; mask: CanvasSubjectMask } | { operation: "layers"; layers: CanvasSubjectLayerResult }) => void;
    reject: (error: Error) => void;
    cleanup: () => void;
};

let subjectSegmentationWorker: Worker | null = null;
let subjectSegmentationSequence = 0;
const pendingSubjectSegmentations = new Map<number, PendingSubjectSegmentation>();

type CanvasSubjectSource = string | Blob;

export async function segmentCanvasSubject(source: CanvasSubjectSource, signal?: AbortSignal, targetPoint?: { x: number; y: number }, targetRegion?: CanvasSubjectRegion): Promise<CanvasSubjectMask> {
    const result = await requestCanvasSubjectWorker(source, "mask", signal, targetPoint, targetRegion);
    if (result.operation !== "mask") throw new Error("本地主体分割返回了错误结果");
    return result.mask;
}

export async function renderCanvasSubjectLayers(source: CanvasSubjectSource, signal?: AbortSignal, targetPoint?: { x: number; y: number }, targetRegion?: CanvasSubjectRegion, collectParts = false): Promise<CanvasSubjectLayerResult> {
    const result = await requestCanvasSubjectWorker(source, "layers", signal, targetPoint, targetRegion, collectParts);
    if (result.operation !== "layers") throw new Error("本地主体分割返回了错误结果");
    return result.layers;
}

export async function renderCanvasPromptedSubjectLayers(source: CanvasSubjectSource, targetPoints: Array<{ x: number; y: number }>, targetRegion: CanvasSubjectRegion, signal?: AbortSignal): Promise<CanvasSubjectLayerResult> {
    const result = await requestCanvasSubjectWorker(source, "layers", signal, targetPoints[0], targetRegion, true, targetPoints);
    if (result.operation !== "layers") throw new Error("本地主体分割返回了错误结果");
    return result.layers;
}

async function requestCanvasSubjectWorker(
    source: CanvasSubjectSource,
    operation: "mask" | "layers",
    signal?: AbortSignal,
    targetPoint?: { x: number; y: number },
    targetRegion?: CanvasSubjectRegion,
    collectParts = false,
    targetPoints?: Array<{ x: number; y: number }>,
) {
    throwIfAborted(signal);
    if (typeof createImageBitmap !== "function") throw new Error("当前浏览器无法初始化本地主体分割");
    const blob = typeof source === "string" ? await fetchImageBlob(source, signal) : source;
    if (!blob.size || (blob.type && !blob.type.startsWith("image/"))) throw new Error("源图片文件无效，请重新上传后再试");
    let image: ImageBitmap;
    try {
        image = await createImageBitmap(blob);
    } catch {
        throw new Error("源图片无法解码，请重新上传后再试");
    }
    throwIfAborted(signal, () => image.close());
    const worker = getSubjectSegmentationWorker();
    const id = ++subjectSegmentationSequence;
    return new Promise<{ operation: "mask"; mask: CanvasSubjectMask } | { operation: "layers"; layers: CanvasSubjectLayerResult }>((resolve, reject) => {
        const abort = () => {
            const request = pendingSubjectSegmentations.get(id);
            if (!request) return;
            pendingSubjectSegmentations.delete(id);
            request.cleanup();
            reject(abortError());
        };
        const cleanup = () => signal?.removeEventListener("abort", abort);
        pendingSubjectSegmentations.set(id, { operation, resolve, reject, cleanup });
        signal?.addEventListener("abort", abort, { once: true });
        try {
            worker.postMessage({ id, operation, image, targetPoint, targetRegion, collectParts, ...(targetPoints?.length ? { targetPoints } : {}) }, [image]);
        } catch (error) {
            pendingSubjectSegmentations.delete(id);
            cleanup();
            image.close();
            reject(error instanceof Error ? error : new Error("无法启动本地主体分割"));
        }
    });
}

async function fetchImageBlob(source: string, signal?: AbortSignal) {
    const response = await fetch(source, { signal });
    if (!response.ok) throw new Error("无法读取源图片，请重新上传后再试");
    return response.blob();
}

export function readSubjectSegmentationWorkerResponse(value: unknown): SubjectSegmentationWorkerResponse | null {
    if (!value || typeof value !== "object") return null;
    const data = value as Record<string, unknown>;
    if (typeof data.id !== "number" || !Number.isInteger(data.id)) return null;
    if (data.error !== undefined) return typeof data.error === "string" ? { id: data.id, error: data.error } : null;
    if (data.operation !== "mask" && data.operation !== "layers") return null;
    if (typeof data.width !== "number" || !Number.isInteger(data.width) || data.width < 1) return null;
    if (typeof data.height !== "number" || !Number.isInteger(data.height) || data.height < 1) return null;
    if (data.mask instanceof ArrayBuffer) {
        if (data.mask.byteLength !== data.width * data.height * Float32Array.BYTES_PER_ELEMENT) return null;
        return { id: data.id, operation: data.operation, width: data.width, height: data.height, mask: data.mask };
    }
    if (
        data.operation !== "layers" ||
        !(data.foregroundBlob instanceof Blob) ||
        data.foregroundBlob.type !== "image/png" ||
        !data.foregroundBlob.size ||
        !(data.editMaskBlob instanceof Blob) ||
        data.editMaskBlob.type !== "image/png" ||
        !data.editMaskBlob.size
    )
        return null;
    if (typeof data.foregroundPixels !== "number" || !Number.isInteger(data.foregroundPixels) || data.foregroundPixels < 1) return null;
    if (typeof data.backgroundPixels !== "number" || !Number.isInteger(data.backgroundPixels) || data.backgroundPixels < 1 || data.foregroundPixels + data.backgroundPixels !== data.width * data.height) return null;
    return { id: data.id, operation: data.operation, width: data.width, height: data.height, foregroundBlob: data.foregroundBlob, editMaskBlob: data.editMaskBlob, foregroundPixels: data.foregroundPixels, backgroundPixels: data.backgroundPixels };
}

export function validateCanvasSubjectMask(input: { width: number; height: number; data: Float32Array }): CanvasSubjectMask {
    if (!Number.isInteger(input.width) || input.width < 1 || !Number.isInteger(input.height) || input.height < 1 || input.data.length !== input.width * input.height) throw new Error("本地主体分割返回的蒙版尺寸无效");
    let foregroundPixels = 0;
    let backgroundPixels = 0;
    for (const confidence of input.data) {
        if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("本地主体分割返回的蒙版数值无效");
        if (confidence >= 0.5) foregroundPixels += 1;
        else backgroundPixels += 1;
    }
    if (!foregroundPixels) throw new Error("没有识别到明确主体，请尝试局部编辑");
    if (!backgroundPixels) throw new Error("没有识别到可移除背景，请尝试局部编辑");
    return input;
}

function getSubjectSegmentationWorker() {
    if (subjectSegmentationWorker) return subjectSegmentationWorker;
    const worker = new Worker("/canvas/subject-segmenter-worker.js?v=9");
    worker.onmessage = (event: MessageEvent<unknown>) => {
        const response = readSubjectSegmentationWorkerResponse(event.data);
        if (!response) {
            failSubjectSegmentationWorker(new Error("本地主体分割返回了无效数据"));
            return;
        }
        const request = pendingSubjectSegmentations.get(response.id);
        if (!request) return;
        pendingSubjectSegmentations.delete(response.id);
        request.cleanup();
        if (response.error) {
            request.reject(new Error(response.error));
            return;
        }
        try {
            if (request.operation !== response.operation) throw new Error("本地主体分割返回了错误操作结果");
            if (response.mask) {
                const mask = validateCanvasSubjectMask({ width: response.width!, height: response.height!, data: new Float32Array(response.mask) });
                request.resolve(request.operation === "mask" ? { operation: "mask", mask } : { operation: "layers", layers: { kind: "mask", mask } });
                return;
            }
            request.resolve({
                operation: "layers",
                layers: {
                    kind: "blobs",
                    foregroundBlob: response.foregroundBlob!,
                    editMaskBlob: response.editMaskBlob!,
                    width: response.width!,
                    height: response.height!,
                    foregroundPixels: response.foregroundPixels!,
                    backgroundPixels: response.backgroundPixels!,
                },
            });
        } catch (error) {
            request.reject(error instanceof Error ? error : new Error("本地主体分割返回了无效蒙版"));
        }
    };
    worker.onerror = (event) => failSubjectSegmentationWorker(new Error(event.message || "本地主体分割初始化失败"));
    worker.onmessageerror = () => failSubjectSegmentationWorker(new Error("本地主体分割通信失败"));
    subjectSegmentationWorker = worker;
    return worker;
}

function failSubjectSegmentationWorker(error: Error) {
    pendingSubjectSegmentations.forEach((request) => {
        request.cleanup();
        request.reject(error);
    });
    pendingSubjectSegmentations.clear();
    subjectSegmentationWorker?.terminate();
    subjectSegmentationWorker = null;
}

function throwIfAborted(signal?: AbortSignal, cleanup?: () => void) {
    if (!signal?.aborted) return;
    cleanup?.();
    throw abortError();
}

function abortError() {
    return new DOMException("主体分割已取消", "AbortError");
}
