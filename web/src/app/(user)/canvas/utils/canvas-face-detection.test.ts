import { afterEach, describe, expect, it, vi } from "vitest";

describe("Canvas 人脸框", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.resetModules();
    });

    it("使用浏览器原生检测器返回多个人脸框", async () => {
        class FakeImage {
            width = 200;
            height = 100;
            onload: (() => void) | null = null;
            onerror: (() => void) | null = null;

            set src(_value: string) {
                this.onload?.();
            }
        }
        class FakeFaceDetector {
            async detect() {
                return [
                    { boundingBox: { x: 20, y: 10, width: 40, height: 30 }, confidence: 0.9 },
                    { boundingBox: { x: 120, y: 20, width: 50, height: 40 }, confidence: 0.8 },
                ];
            }
        }
        vi.stubGlobal("Image", FakeImage);
        vi.stubGlobal("window", { FaceDetector: FakeFaceDetector });
        const { detectCanvasFaces } = await import("./canvas-face-detection");

        await expect(detectCanvasFaces("data:image/png;base64,fixture")).resolves.toEqual([
            { x: 0.1, y: 0.1, width: 0.2, height: 0.3, score: 0.9 },
            { x: 0.6, y: 0.2, width: 0.25, height: 0.4, score: 0.8 },
        ]);
    });

    it("浏览器没有原生检测器时使用本地 Worker 并归一化多人框", async () => {
        const bitmap = { width: 400, height: 200, close: vi.fn() };
        const postMessage = vi.fn(function (this: FakeWorker, message: { id: number }) {
            queueMicrotask(() =>
                this.onmessage?.({
                    data: {
                        id: message.id,
                        faces: [
                            { x: 40, y: 20, width: 80, height: 60, score: 0.92 },
                            { x: 240, y: 40, width: 100, height: 80, score: 0.84 },
                        ],
                    },
                } as MessageEvent),
            );
        });
        class FakeWorker {
            onmessage: ((event: MessageEvent) => void) | null = null;
            onerror: ((event: ErrorEvent) => void) | null = null;
            onmessageerror: (() => void) | null = null;
            postMessage = postMessage;
            terminate = vi.fn();
        }
        vi.stubGlobal("window", {});
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: vi.fn().mockResolvedValue(new Blob(["fixture"])) }));
        vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
        vi.stubGlobal("Worker", FakeWorker);
        const { detectCanvasFaces } = await import("./canvas-face-detection");

        await expect(detectCanvasFaces("data:image/png;base64,fixture")).resolves.toEqual([
            { x: 0.1, y: 0.1, width: 0.2, height: 0.3, score: 0.92 },
            { x: 0.6, y: 0.2, width: 0.25, height: 0.4, score: 0.84 },
        ]);
        expect(postMessage).toHaveBeenCalledWith({ id: 1, image: bitmap }, [bitmap]);
    });

    it("原生检测器报错时回退本地 Worker", async () => {
        class BrokenFaceDetector {
            async detect() {
                throw new Error("native unavailable");
            }
        }
        class FakeImage {
            width = 200;
            height = 100;
            naturalWidth = 200;
            naturalHeight = 100;
            onload: (() => void) | null = null;
            onerror: (() => void) | null = null;

            set src(_value: string) {
                this.onload?.();
            }
        }
        class FakeWorker {
            onmessage: ((event: MessageEvent) => void) | null = null;
            onerror: ((event: ErrorEvent) => void) | null = null;
            onmessageerror: (() => void) | null = null;
            postMessage(message: { id: number }) {
                queueMicrotask(() => this.onmessage?.({ data: { id: message.id, faces: [{ x: 20, y: 10, width: 40, height: 30 }] } } as MessageEvent));
            }
            terminate() {}
        }
        vi.stubGlobal("Image", FakeImage);
        vi.stubGlobal("window", { FaceDetector: BrokenFaceDetector });
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: vi.fn().mockResolvedValue(new Blob(["fixture"])) }));
        vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 200, height: 100, close: vi.fn() }));
        vi.stubGlobal("Worker", FakeWorker);
        const { detectCanvasFaces } = await import("./canvas-face-detection");

        await expect(detectCanvasFaces("data:image/png;base64,fixture")).resolves.toEqual([{ x: 0.1, y: 0.1, width: 0.2, height: 0.3, score: undefined }]);
    });

    it("本地 Worker 错误会明确返回失败供界面切换手动框选", async () => {
        class FakeWorker {
            onmessage: ((event: MessageEvent) => void) | null = null;
            onerror: ((event: ErrorEvent) => void) | null = null;
            onmessageerror: (() => void) | null = null;
            postMessage(message: { id: number }) {
                queueMicrotask(() => this.onmessage?.({ data: { id: message.id, error: "本地模型加载失败" } } as MessageEvent));
            }
            terminate() {}
        }
        vi.stubGlobal("window", {});
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: vi.fn().mockResolvedValue(new Blob(["fixture"])) }));
        vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 200, height: 100, close: vi.fn() }));
        vi.stubGlobal("Worker", FakeWorker);
        const { detectCanvasFaces } = await import("./canvas-face-detection");

        await expect(detectCanvasFaces("data:image/png;base64,fixture")).rejects.toThrow("本地模型加载失败");
    });

    it("将原生检测像素框归一化并限制在图片范围", async () => {
        const { normalizeFaceBox } = await import("./canvas-face-detection");
        expect(normalizeFaceBox({ x: -20, y: 30, width: 600, height: 400 }, 1000, 1000)).toEqual({ x: 0, y: 0.03, width: 0.6, height: 0.4, score: undefined });
    });

    it("为表情编辑生成不暴露内部数据的目标描述", async () => {
        const { faceBoxPrompt } = await import("./canvas-face-detection");
        expect(faceBoxPrompt({ x: 0.2, y: 0.1, width: 0.2, height: 0.2 })).toContain("约 30% 横向、20% 纵向");
    });
});
