import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

describe("Canvas 分层 Worker 候选选择", () => {
    it("中心主体可靠时只推理一次并立即返回", async () => {
        const primary = mask([5, 6, 9, 10]);
        const worker = await loadWorker(() => primary);

        await worker.send();

        expect(worker.segment).toHaveBeenCalledTimes(1);
        expect(worker.result()).toEqual(primary);
    });

    it("最终蒙版清除目标区域外的误识别背景", async () => {
        const worker = await loadWorker(() => mask([5, 6, 9, 10, 14]));

        await worker.send();

        expect(worker.segment).toHaveBeenCalledTimes(1);
        expect(worker.result()).toEqual(mask([5, 6, 9, 10]));
    });

    it("智能分层只合并同一目标区域内的可靠部件", async () => {
        const parts = [mask([5]), mask([6]), mask([9]), mask([10, 14])];
        let call = 0;
        const worker = await loadWorker(() => parts[call++]);

        await worker.send(true, [point(5), point(6), point(9), point(10)]);

        expect(worker.segment).toHaveBeenCalledTimes(4);
        expect(worker.result()).toEqual(mask([5, 6, 9, 10]));
        expect(worker.result()[14]).toBe(0);
    });

    it("智能分层只保留包含主体提示点的连通区域", async () => {
        const worker = await loadWorker(() => mask([5, 15]));

        await worker.send(true, [point(5)]);

        expect(worker.result()).toEqual(mask([5]));
        expect(worker.result()[15]).toBe(0);
    });

    it("中心不可靠时选择最佳单一蒙版而不合并背景候选", async () => {
        const wholeImage = mask(Array.from({ length: 16 }, (_, index) => index));
        const subject = mask([5, 6, 9, 10]);
        const backgroundFragments = [mask([6]), mask([9, 13]), mask([10]), mask([10, 14])];
        let call = 0;
        const worker = await loadWorker(() => [wholeImage, subject, ...backgroundFragments][call++]);

        await worker.send();

        expect(worker.segment).toHaveBeenCalledTimes(5);
        expect(worker.result()).toEqual(subject);
        expect(worker.result()[13]).toBe(0);
        expect(worker.result()[14]).toBe(0);
    });
});

function mask(foreground: number[]) {
    const data = new Float32Array(16);
    foreground.forEach((index) => (data[index] = 1));
    return [...data];
}

async function loadWorker(nextMask: () => number[]) {
    const posts: Array<{ mask?: ArrayBuffer; error?: string }> = [];
    const segment = vi.fn((_image: unknown, _options: unknown) => {
        const data = new Float32Array(nextMask());
        return {
            confidenceMasks: [{ width: 4, height: 4, getAsFloat32Array: () => data }],
            close: vi.fn(),
        };
    });
    const image = { width: 4, height: 4, close: vi.fn() };
    const context = {
        console,
        Float32Array,
        Map,
        Number,
        Math,
        importScripts: vi.fn(),
        Vision: { InteractiveSegmenterLegacy: { createFromOptions: vi.fn().mockResolvedValue({ segment, close: vi.fn() }) } },
        self: { postMessage: vi.fn((value: { mask?: ArrayBuffer; error?: string }) => posts.push(value)) },
    };
    runInNewContext(await readFile(new URL("../../../../../public/canvas/subject-segmenter-worker.js", import.meta.url), "utf8"), context);
    const send = (collectParts = false, targetPoints?: Array<{ x: number; y: number }>) =>
        (context.self as typeof context.self & { onmessage: (event: { data: unknown }) => Promise<void> }).onmessage({
            data: { id: 1, image, operation: "mask", targetPoint: { x: 0.5, y: 0.5 }, targetPoints, targetRegion: { x: 0.2, y: 0.2, width: 0.6, height: 0.6 }, collectParts },
        });
    return {
        segment,
        send,
        result: () => {
            expect(posts[0]?.error).toBeUndefined();
            const buffer = posts[0]?.mask;
            expect(buffer).toBeDefined();
            return [...new Float32Array(buffer!)];
        },
    };
}

function point(index: number) {
    return { x: (index % 4) / 3, y: Math.floor(index / 4) / 3 };
}
