import { afterEach, describe, expect, it, vi } from "vitest";

import { reviewOfficialPrices } from "./model-pricing";

const input = { manufacturer: "ByteDance / Volcengine", sourceUrl: "https://docs.byteplus.com/pricing", requestId: "test-request" };

describe("official price review stream", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("updates stages across chunk boundaries and returns the final result", async () => {
        const encoder = new TextEncoder();
        const chunks = [
            'event: progress\ndata: {"stage":"source","status":"active","detail":"读取官网"}\n',
            '\nevent: progress\ndata: {"stage":"source","status":"done","detail":"已读取"}\n\n',
            ': heartbeat\n\nevent: partial\ndata: {"findings":[{"officialModelId":"seedream-4-5-251128"}],"warnings":[]}\n\nevent: result\ndata: {"findings":[{"officialModelId":"seedream-4-5-251128"}],"warnings":[]}\n\n',
        ];
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
                controller.close();
            },
        });
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { headers: { "content-type": "text/event-stream" } })));
        const onProgress = vi.fn();
        const onPartial = vi.fn();

        await expect(reviewOfficialPrices(input, onProgress, onPartial)).resolves.toMatchObject({ findings: [{ officialModelId: "seedream-4-5-251128" }] });
        expect(onProgress).toHaveBeenCalledTimes(2);
        expect(onProgress).toHaveBeenLastCalledWith({ stage: "source", status: "done", detail: "已读取" });
        expect(onPartial).toHaveBeenCalledWith(expect.objectContaining({ findings: [{ officialModelId: "seedream-4-5-251128" }] }));
    });

    it("shows a useful error when a gateway returns HTML instead of JSON", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>Gateway Time-out</html>", { status: 504, headers: { "content-type": "text/html" } })));

        await expect(reviewOfficialPrices(input)).rejects.toThrow("官网核价连接在网关等待超时");
    });

    it("surfaces a streamed model failure", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('event: error\ndata: {"message":"默认文本模型渠道连接或响应超时"}\n\n', { headers: { "content-type": "text/event-stream" } })));

        await expect(reviewOfficialPrices(input)).rejects.toThrow("默认文本模型渠道连接或响应超时");
    });
});
