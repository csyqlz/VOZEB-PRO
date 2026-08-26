"use strict";

const reportWorkerError = console.error.bind(console);
console.error = (...args) => {
    if (String(args[0] || "").startsWith("INFO:")) {
        console.info(...args);
        return;
    }
    reportWorkerError(...args);
};

importScripts("/mediapipe/vision_bundle.js");

let detectorPromise = null;

function getDetector() {
    if (!detectorPromise) {
        detectorPromise = Vision.FaceDetector.createFromOptions(
            {
                wasmLoaderPath: "/mediapipe/wasm/vision_wasm_internal.js",
                wasmBinaryPath: "/mediapipe/wasm/vision_wasm_internal.wasm",
            },
            {
                baseOptions: { modelAssetPath: "/canvas/models/face_detection_full_range_sparse.tflite" },
                runningMode: "IMAGE",
            },
        );
    }
    return detectorPromise;
}

self.onmessage = async (event) => {
    const { id, image } = event.data || {};
    try {
        const detector = await getDetector();
        const faces = detector.detect(image).detections.flatMap((detection) => {
            const box = detection.boundingBox;
            if (!box) return [];
            return [
                {
                    x: box.originX,
                    y: box.originY,
                    width: box.width,
                    height: box.height,
                    score: detection.categories[0]?.score,
                },
            ];
        });
        self.postMessage({ id, faces });
    } catch (error) {
        detectorPromise = null;
        self.postMessage({ id, error: error instanceof Error ? error.message : "本地人脸识别失败" });
    } finally {
        image?.close();
    }
};
