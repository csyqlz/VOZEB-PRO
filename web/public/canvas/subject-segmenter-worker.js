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

let segmenterPromise = null;

const fallbackPoints = [
    { x: 0.25, y: 0.25 },
    { x: 0.5, y: 0.25 },
    { x: 0.75, y: 0.25 },
    { x: 0.25, y: 0.5 },
    { x: 0.75, y: 0.5 },
    { x: 0.25, y: 0.75 },
    { x: 0.5, y: 0.75 },
    { x: 0.75, y: 0.75 },
];

function getSegmenter() {
    if (!segmenterPromise) {
        segmenterPromise = Vision.InteractiveSegmenterLegacy.createFromOptions(
            {
                wasmLoaderPath: "/mediapipe/wasm/vision_wasm_internal.js",
                wasmBinaryPath: "/mediapipe/wasm/vision_wasm_internal.wasm",
            },
            {
                baseOptions: { modelAssetPath: "/canvas/models/magic_touch.tflite" },
                runningMode: "IMAGE",
                outputConfidenceMasks: true,
                outputCategoryMask: false,
            },
        );
    }
    return segmenterPromise;
}

async function resetSegmenter() {
    const current = segmenterPromise;
    segmenterPromise = null;
    if (!current) return;
    try {
        (await current).close();
    } catch {
        // The model may have failed before a segmenter instance existed.
    }
}

self.onmessage = async (event) => {
    const { id, image, operation = "mask", targetPoint, targetPoints, targetRegion, collectParts = false } = event.data || {};
    try {
        if (!Number.isInteger(id) || !image || (operation !== "mask" && operation !== "layers")) throw new Error("主体分割请求无效");
        const segmenter = await getSegmenter();
        const firstPoint = normalizedPoint(targetPoint) || { x: 0.5, y: 0.5 };
        const promptPoints = normalizedPoints(targetPoints);
        if (!promptPoints.length) promptPoints.push(firstPoint);
        const region = normalizedRegion(targetRegion);
        const candidates = promptPoints.map((point) => segmentCandidate(segmenter, image, point, region, collectParts));
        if (!collectParts && !isStrongCandidate(candidates[0], region)) {
            for (const point of fallbackCandidatePoints(firstPoint, region, image)) candidates.push(segmentCandidate(segmenter, image, point, region, false));
        }
        const best = candidates.reduce((selected, candidate) => betterCandidate(selected, candidate), null);
        const selected = collectParts && region ? mergePromptedParts(candidates, best, region, promptPoints) : best;
        if (!selected || !isReliableCandidate(selected)) throw new Error("没有识别到可靠主体，请尝试局部编辑");
        clipCandidateToRegion(selected, region);
        if (operation === "layers" && supportsWorkerImageEncoding()) {
            const layers = await composeSubjectLayers(image, selected, region);
            self.postMessage({ id, operation, ...layers });
        } else {
            self.postMessage({ id, operation, width: selected.width, height: selected.height, mask: selected.data.buffer }, [selected.data.buffer]);
        }
    } catch (error) {
        await resetSegmenter();
        self.postMessage({ id, error: error instanceof Error ? error.message : "本地主体分割失败" });
    } finally {
        image?.close();
    }
};

function segmentCandidate(segmenter, image, point, targetRegion, keepPromptComponent) {
    const result = segmenter.segment(image, { keypoint: point });
    try {
        const masks = result.confidenceMasks || [];
        if (!masks.length) throw new Error("本地模型没有返回主体蒙版");
        const arrays = masks.map((mask) => mask.getAsFloat32Array());
        const selectedIndex = masks.reduce((best, mask, index) => (pointConfidence(mask, arrays[index], point) > pointConfidence(masks[best], arrays[best], point) ? index : best), 0);
        const selected = masks[selectedIndex];
        const data = new Float32Array(arrays[selectedIndex]);
        const pointScore = pointConfidence(selected, data, point);
        if (keepPromptComponent) retainPromptComponent(data, selected.width, selected.height, point);
        const stats = maskStats(data, selected.width, selected.height, targetRegion);
        return { width: selected.width, height: selected.height, data, point, pointScore, ...stats, score: stats.score * (0.5 + pointScore * 0.5) };
    } finally {
        result.close();
    }
}

function betterCandidate(best, candidate) {
    if (!best) return candidate;
    const candidateReliable = isReliableCandidate(candidate);
    const bestReliable = isReliableCandidate(best);
    if (candidateReliable !== bestReliable) return candidateReliable ? candidate : best;
    return candidate.score > best.score ? candidate : best;
}

function mergePromptedParts(candidates, fallback, region, promptPoints) {
    const parts = candidates.filter((candidate) => isReliableCandidate(candidate) && candidate.outsideRatio <= 0.55 && candidate.borderRatio <= 0.2);
    if (!parts.length) return fallback;
    const data = new Float32Array(parts[0].data.length);
    for (const part of parts) {
        for (let index = 0; index < data.length; index += 1) data[index] = Math.max(data[index], part.data[index]);
    }
    retainPromptedComponents(data, parts[0].width, parts[0].height, promptPoints);
    const stats = maskStats(data, parts[0].width, parts[0].height, region);
    const pointScore = Math.max(...parts.map((part) => part.pointScore));
    return { width: parts[0].width, height: parts[0].height, data, pointScore, ...stats, score: stats.score * (0.5 + pointScore * 0.5) };
}

function retainPromptComponent(data, width, height, point) {
    retainPromptedComponents(data, width, height, [point]);
}

function retainPromptedComponents(data, width, height, points) {
    const foreground = new Uint8Array(data.length);
    for (let index = 0; index < data.length; index += 1) foreground[index] = data[index] >= 0.68 ? 1 : 0;
    const keep = new Uint8Array(data.length);
    for (const point of points) {
        const anchor = nearestForegroundIndex(foreground, width, height, point);
        if (anchor < 0 || keep[anchor]) continue;
        const queue = [anchor];
        keep[anchor] = 1;
        for (let cursor = 0; cursor < queue.length; cursor += 1) {
            const index = queue[cursor];
            const x = index % width;
            const y = Math.floor(index / width);
            for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
                for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
                    if ((!offsetX && !offsetY) || x + offsetX < 0 || x + offsetX >= width || y + offsetY < 0 || y + offsetY >= height) continue;
                    const next = (y + offsetY) * width + x + offsetX;
                    if (!foreground[next] || keep[next]) continue;
                    keep[next] = 1;
                    queue.push(next);
                }
            }
        }
    }
    const softened = new Uint8Array(keep);
    for (let index = 0; index < keep.length; index += 1) {
        if (!keep[index]) continue;
        const x = index % width;
        const y = Math.floor(index / width);
        for (let offsetY = -2; offsetY <= 2; offsetY += 1) {
            for (let offsetX = -2; offsetX <= 2; offsetX += 1) {
                if (x + offsetX < 0 || x + offsetX >= width || y + offsetY < 0 || y + offsetY >= height) continue;
                const next = (y + offsetY) * width + x + offsetX;
                if (data[next] >= 0.08) softened[next] = 1;
            }
        }
    }
    for (let index = 0; index < data.length; index += 1) if (!softened[index]) data[index] = 0;
}

function nearestForegroundIndex(foreground, width, height, point) {
    const centerX = Math.min(width - 1, Math.max(0, Math.round(point.x * (width - 1))));
    const centerY = Math.min(height - 1, Math.max(0, Math.round(point.y * (height - 1))));
    for (let radius = 0; radius <= 4; radius += 1) {
        for (let y = Math.max(0, centerY - radius); y <= Math.min(height - 1, centerY + radius); y += 1) {
            for (let x = Math.max(0, centerX - radius); x <= Math.min(width - 1, centerX + radius); x += 1) {
                if ((Math.abs(x - centerX) !== radius && Math.abs(y - centerY) !== radius) || !foreground[y * width + x]) continue;
                return y * width + x;
            }
        }
    }
    return -1;
}

function pointConfidence(mask, data, point) {
    const x = Math.min(mask.width - 1, Math.max(0, Math.round(point.x * (mask.width - 1))));
    const y = Math.min(mask.height - 1, Math.max(0, Math.round(point.y * (mask.height - 1))));
    return data[y * mask.width + x];
}

function maskStats(data, width, height, targetRegion) {
    let foregroundPixels = 0;
    let borderPixels = 0;
    let foregroundBorderPixels = 0;
    let targetPixels = 0;
    let targetForegroundPixels = 0;
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const foreground = data[y * width + x] >= 0.5;
            if (foreground) foregroundPixels += 1;
            const inTarget =
                !targetRegion ||
                (x / Math.max(1, width - 1) >= targetRegion.x && x / Math.max(1, width - 1) <= targetRegion.x + targetRegion.width && y / Math.max(1, height - 1) >= targetRegion.y && y / Math.max(1, height - 1) <= targetRegion.y + targetRegion.height);
            if (inTarget) {
                targetPixels += 1;
                if (foreground) targetForegroundPixels += 1;
            }
            if (x !== 0 && y !== 0 && x !== width - 1 && y !== height - 1) continue;
            borderPixels += 1;
            if (foreground) foregroundBorderPixels += 1;
        }
    }
    const areaRatio = foregroundPixels / Math.max(1, width * height);
    const borderRatio = foregroundBorderPixels / Math.max(1, borderPixels);
    const targetCoverage = targetPixels ? targetForegroundPixels / targetPixels : 0;
    const outsideRatio = foregroundPixels ? Math.max(0, (foregroundPixels - targetForegroundPixels) / foregroundPixels) : 1;
    const insideRatio = foregroundPixels ? targetForegroundPixels / foregroundPixels : 0;
    const regionScore = targetRegion ? (0.4 + insideRatio * 0.6) * (1 - outsideRatio) : 1;
    return { areaRatio, borderRatio, targetCoverage, outsideRatio, score: areaRatio * (1 - areaRatio) * (1 - borderRatio) * regionScore };
}

function normalizedPoint(value) {
    if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) return null;
    return { x: Math.min(1, Math.max(0, value.x)), y: Math.min(1, Math.max(0, value.y)) };
}

function normalizedPoints(value) {
    if (!Array.isArray(value)) return [];
    const unique = new Map();
    for (const point of value.map(normalizedPoint).filter(Boolean)) unique.set(`${point.x.toFixed(4)}:${point.y.toFixed(4)}`, point);
    return [...unique.values()];
}

function normalizedRegion(value) {
    if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y) || !Number.isFinite(value.width) || !Number.isFinite(value.height) || value.width <= 0 || value.height <= 0) return null;
    const x = Math.min(1, Math.max(0, value.x));
    const y = Math.min(1, Math.max(0, value.y));
    const right = Math.min(1, Math.max(x, value.x + value.width));
    const bottom = Math.min(1, Math.max(y, value.y + value.height));
    return { x, y, width: Math.max(0.001, right - x), height: Math.max(0.001, bottom - y) };
}

function fallbackCandidatePoints(center, region, image) {
    if (!region) return fallbackPoints.filter((point) => point.x !== center.x || point.y !== center.y);
    const aspect = (region.width * image.width) / Math.max(1, region.height * image.height);
    if (aspect >= 1.6) return regionalGridPoints(center, region, [0.1, 0.23, 0.37, 0.5, 0.63, 0.77, 0.9], [0.35, 0.65]);
    if (aspect <= 0.625) return regionalGridPoints(center, region, [0.35, 0.65], [0.1, 0.23, 0.37, 0.5, 0.63, 0.77, 0.9]);
    const points = [
        { x: region.x + region.width * 0.35, y: region.y + region.height * 0.35 },
        { x: region.x + region.width * 0.65, y: region.y + region.height * 0.35 },
        { x: region.x + region.width * 0.35, y: region.y + region.height * 0.65 },
        { x: region.x + region.width * 0.65, y: region.y + region.height * 0.65 },
    ];
    const unique = new Map();
    for (const point of points.map(normalizedPoint).filter(Boolean)) unique.set(`${point.x.toFixed(4)}:${point.y.toFixed(4)}`, point);
    unique.delete(`${center.x.toFixed(4)}:${center.y.toFixed(4)}`);
    return [...unique.values()];
}

function regionalGridPoints(center, region, columns, rows) {
    const points = columns.flatMap((column) => rows.map((row) => ({ x: region.x + region.width * column, y: region.y + region.height * row })));
    const unique = new Map();
    for (const point of points.map(normalizedPoint).filter(Boolean)) unique.set(`${point.x.toFixed(4)}:${point.y.toFixed(4)}`, point);
    unique.delete(`${center.x.toFixed(4)}:${center.y.toFixed(4)}`);
    return [...unique.values()];
}

function clipCandidateToRegion(candidate, region) {
    if (!region) return;
    for (let y = 0; y < candidate.height; y += 1) {
        for (let x = 0; x < candidate.width; x += 1) {
            if (!pointInRegion(x / Math.max(1, candidate.width - 1), y / Math.max(1, candidate.height - 1), region)) candidate.data[y * candidate.width + x] = 0;
        }
    }
}

function pointInRegion(x, y, region) {
    return !region || (x >= region.x && x <= region.x + region.width && y >= region.y && y <= region.y + region.height);
}

function isReliableCandidate(candidate) {
    return candidate.pointScore >= 0.5 && candidate.areaRatio >= 0.01 && candidate.areaRatio <= 0.95 && candidate.borderRatio <= 0.5;
}

function isStrongCandidate(candidate, region) {
    return isReliableCandidate(candidate) && (!region || candidate.outsideRatio <= 0.2);
}

function supportsWorkerImageEncoding() {
    return typeof OffscreenCanvas === "function" && typeof OffscreenCanvas.prototype.convertToBlob === "function";
}

async function composeSubjectLayers(image, subjectMask, targetRegion) {
    const width = image.width;
    const height = image.height;
    const foregroundCanvas = new OffscreenCanvas(width, height);
    const foregroundContext = foregroundCanvas.getContext("2d", { willReadFrequently: true });
    const editMaskCanvas = new OffscreenCanvas(width, height);
    const editMaskContext = editMaskCanvas.getContext("2d");
    if (!foregroundContext || !editMaskContext) throw new Error("浏览器无法创建主体图层");
    foregroundContext.drawImage(image, 0, 0);
    const foreground = foregroundContext.getImageData(0, 0, width, height);
    const editMask = editMaskContext.createImageData(width, height);
    let foregroundPixels = 0;
    let backgroundPixels = 0;
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const normalizedX = width === 1 ? 0 : x / (width - 1);
            const normalizedY = height === 1 ? 0 : y / (height - 1);
            const confidence = pointInRegion(normalizedX, normalizedY, targetRegion) ? sampleSubjectConfidence(subjectMask, x, y, width, height) : 0;
            const offset = (y * width + x) * 4;
            foreground.data[offset + 3] = Math.round(foreground.data[offset + 3] * confidence);
            editMask.data[offset] = 255;
            editMask.data[offset + 1] = 255;
            editMask.data[offset + 2] = 255;
            editMask.data[offset + 3] = Math.round(255 * (1 - confidence));
            if (confidence >= 0.5) foregroundPixels += 1;
            else backgroundPixels += 1;
        }
    }
    foregroundContext.putImageData(foreground, 0, 0);
    editMaskContext.putImageData(editMask, 0, 0);
    const [foregroundBlob, editMaskBlob] = await Promise.all([foregroundCanvas.convertToBlob({ type: "image/png" }), editMaskCanvas.convertToBlob({ type: "image/png" })]);
    return { width, height, foregroundPixels, backgroundPixels, foregroundBlob, editMaskBlob };
}

function sampleSubjectConfidence(mask, x, y, width, height) {
    const sourceX = width === 1 ? 0 : (x / (width - 1)) * (mask.width - 1);
    const sourceY = height === 1 ? 0 : (y / (height - 1)) * (mask.height - 1);
    const left = Math.floor(sourceX);
    const top = Math.floor(sourceY);
    const right = Math.min(mask.width - 1, left + 1);
    const bottom = Math.min(mask.height - 1, top + 1);
    const horizontal = sourceX - left;
    const vertical = sourceY - top;
    const topValue = mask.data[top * mask.width + left] * (1 - horizontal) + mask.data[top * mask.width + right] * horizontal;
    const bottomValue = mask.data[bottom * mask.width + left] * (1 - horizontal) + mask.data[bottom * mask.width + right] * horizontal;
    return Math.max(0, Math.min(1, topValue * (1 - vertical) + bottomValue * vertical));
}
