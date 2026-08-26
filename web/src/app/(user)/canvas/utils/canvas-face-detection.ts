"use client";

export type CanvasFaceBox = { x: number; y: number; width: number; height: number; score?: number };

type FaceDetectionWorkerFace = { x: number; y: number; width: number; height: number; score?: number };
type FaceDetectionWorkerResponse = { id: number; faces?: FaceDetectionWorkerFace[]; error?: string };
type PendingFaceDetection = {
    width: number;
    height: number;
    resolve: (faces: CanvasFaceBox[]) => void;
    reject: (error: Error) => void;
    cleanup: () => void;
};
type NativeFaceDetection = {
    boundingBox: DOMRectReadOnly | { x: number; y: number; width: number; height: number };
    confidence?: number;
};
type NativeFaceDetectorConstructor = new (options?: { maxDetectedFaces?: number; fastMode?: boolean }) => {
    detect: (image: HTMLImageElement) => Promise<NativeFaceDetection[]>;
};

let faceDetectionWorker: Worker | null = null;
let faceDetectionSequence = 0;
const pendingFaceDetections = new Map<number, PendingFaceDetection>();

export async function detectCanvasFaces(dataUrl: string, signal?: AbortSignal): Promise<CanvasFaceBox[]> {
    throwIfAborted(signal);
    const Detector = (window as Window & { FaceDetector?: NativeFaceDetectorConstructor }).FaceDetector;
    if (Detector) {
        try {
            return await detectWithNativeFaceDetector(dataUrl, Detector, signal);
        } catch (error) {
            if (isAbortError(error)) throw error;
        }
    }
    return detectWithLocalWorker(dataUrl, signal);
}

export function normalizeFaceBox(box: { x: number; y: number; width: number; height: number }, imageWidth: number, imageHeight: number, score?: number): CanvasFaceBox | null {
    const width = Math.max(0, Math.min(1, box.width / Math.max(1, imageWidth)));
    const height = Math.max(0, Math.min(1, box.height / Math.max(1, imageHeight)));
    const x = Math.max(0, Math.min(1 - width, box.x / Math.max(1, imageWidth)));
    const y = Math.max(0, Math.min(1 - height, box.y / Math.max(1, imageHeight)));
    return width > 0.01 && height > 0.01 ? { x, y, width, height, score } : null;
}

export function faceBoxPrompt(box: CanvasFaceBox) {
    const x = Math.round((box.x + box.width / 2) * 100);
    const y = Math.round((box.y + box.height / 2) * 100);
    return `画面中位于约 ${x}% 横向、${y}% 纵向的人物脸部`;
}

async function detectWithNativeFaceDetector(dataUrl: string, Detector: NativeFaceDetectorConstructor, signal?: AbortSignal) {
    const image = await loadImage(dataUrl, signal);
    const detections = await new Detector({ maxDetectedFaces: 20, fastMode: true }).detect(image);
    throwIfAborted(signal);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    return detections.map((detection) => normalizeFaceBox(detection.boundingBox, width, height, detection.confidence)).filter((face): face is CanvasFaceBox => Boolean(face));
}

async function detectWithLocalWorker(dataUrl: string, signal?: AbortSignal) {
    if (typeof createImageBitmap !== "function") throw new Error("当前浏览器无法初始化本地人脸识别，请手动框选");
    const response = await fetch(dataUrl, { signal });
    if (!response.ok) throw new Error("无法读取源图片，请重新上传后再试");
    const image = await createImageBitmap(await response.blob());
    throwIfAborted(signal, () => image.close());
    const worker = getFaceDetectionWorker();
    const id = ++faceDetectionSequence;
    return new Promise<CanvasFaceBox[]>((resolve, reject) => {
        const abort = () => {
            const request = pendingFaceDetections.get(id);
            if (!request) return;
            pendingFaceDetections.delete(id);
            request.cleanup();
            reject(abortError());
        };
        const cleanup = () => signal?.removeEventListener("abort", abort);
        pendingFaceDetections.set(id, { width: image.width, height: image.height, resolve, reject, cleanup });
        signal?.addEventListener("abort", abort, { once: true });
        try {
            worker.postMessage({ id, image }, [image]);
        } catch (error) {
            pendingFaceDetections.delete(id);
            cleanup();
            image.close();
            reject(error instanceof Error ? error : new Error("无法启动本地人脸识别"));
        }
    });
}

function getFaceDetectionWorker() {
    if (faceDetectionWorker) return faceDetectionWorker;
    const worker = new Worker("/canvas/face-detector-worker.js");
    worker.onmessage = (event: MessageEvent<unknown>) => {
        const response = readWorkerResponse(event.data);
        if (!response) {
            failFaceDetectionWorker(new Error("本地人脸识别返回了无效数据"));
            return;
        }
        const request = pendingFaceDetections.get(response.id);
        if (!request) return;
        pendingFaceDetections.delete(response.id);
        request.cleanup();
        if (response.error) {
            request.reject(new Error(response.error));
            return;
        }
        request.resolve((response.faces || []).map((face) => normalizeFaceBox(face, request.width, request.height, face.score)).filter((face): face is CanvasFaceBox => Boolean(face)));
    };
    worker.onerror = (event) => failFaceDetectionWorker(new Error(event.message || "本地人脸识别初始化失败"));
    worker.onmessageerror = () => failFaceDetectionWorker(new Error("本地人脸识别通信失败"));
    faceDetectionWorker = worker;
    return worker;
}

function failFaceDetectionWorker(error: Error) {
    pendingFaceDetections.forEach((request) => {
        request.cleanup();
        request.reject(error);
    });
    pendingFaceDetections.clear();
    faceDetectionWorker?.terminate();
    faceDetectionWorker = null;
}

function readWorkerResponse(value: unknown): FaceDetectionWorkerResponse | null {
    if (!value || typeof value !== "object") return null;
    const data = value as Record<string, unknown>;
    if (typeof data.id !== "number" || !Number.isInteger(data.id)) return null;
    if (data.error !== undefined && typeof data.error !== "string") return null;
    const rawFaces = data.faces;
    if (rawFaces !== undefined && !Array.isArray(rawFaces)) return null;
    const faces = (rawFaces || []).map(readWorkerFace);
    if (faces.some((face) => !face)) return null;
    return { id: data.id as number, error: data.error as string | undefined, faces: faces as FaceDetectionWorkerFace[] };
}

function readWorkerFace(value: unknown): FaceDetectionWorkerFace | null {
    if (!value || typeof value !== "object") return null;
    const face = value as Record<string, unknown>;
    if (![face.x, face.y, face.width, face.height].every((number) => typeof number === "number" && Number.isFinite(number))) return null;
    if (face.score !== undefined && (typeof face.score !== "number" || !Number.isFinite(face.score))) return null;
    return { x: face.x as number, y: face.y as number, width: face.width as number, height: face.height as number, score: face.score as number | undefined };
}

function loadImage(dataUrl: string, signal?: AbortSignal) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        const cleanup = () => signal?.removeEventListener("abort", abort);
        const abort = () => {
            image.onload = null;
            image.onerror = null;
            image.src = "";
            cleanup();
            reject(abortError());
        };
        image.onload = () => {
            cleanup();
            resolve(image);
        };
        image.onerror = () => {
            cleanup();
            reject(new Error("图片读取失败，无法识别人脸"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        image.src = dataUrl;
    });
}

function throwIfAborted(signal?: AbortSignal, cleanup?: () => void) {
    if (!signal?.aborted) return;
    cleanup?.();
    throw abortError();
}

function abortError() {
    return new DOMException("人脸识别已取消", "AbortError");
}

function isAbortError(error: unknown) {
    return error instanceof DOMException && error.name === "AbortError";
}
