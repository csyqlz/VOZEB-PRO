import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CreativeAsset } from "@/lib/creative-runtime-contract";
import type { AgentRun } from "./agent-run-store";

const mocks = vi.hoisted(() => ({
    context: vi.fn(),
    assets: vi.fn(),
    internalFetch: vi.fn(),
    outboundFetch: vi.fn(),
    sign: vi.fn(),
}));

vi.mock("@/lib/server/creative-runtime-store", () => ({ getCreativeConversationContext: mocks.context, getCreativeAssetsByIds: mocks.assets }));
vi.mock("@/lib/server/internal-origin", () => ({ fetchInternalApi: mocks.internalFetch }));
vi.mock("@/lib/server/safe-outbound-fetch", () => ({ fetchSafeOutbound: mocks.outboundFetch }));
vi.mock("@/lib/server/reference-asset-access", () => ({ signReferenceAssetInputUrl: mocks.sign, signGenerationAssetInputUrl: mocks.sign }));

import { textConversationMessages } from "./agent-text-conversation";

const run = {
    id: "run-one",
    userId: "user-one",
    conversationId: "conversation-one",
    prompt: "请读取 @图片1 的标题，并解释图表趋势",
    referencedAssetIds: ["image-one"],
} as AgentRun;

const image = {
    id: "image-one",
    userId: "user-one",
    conversationId: "conversation-one",
    type: "image",
    status: "ready",
    title: "销售趋势截图",
    serverUrl: "/api/reference-assets/permanent/example.png",
    metadata: {},
} as CreativeAsset;

beforeEach(() => {
    vi.clearAllMocks();
    mocks.context.mockResolvedValue({
        summary: "此前讨论销售额",
        recentMessages: [
            { role: "user", content: "上一季度怎样？" },
            { role: "assistant", content: "持续增长" },
        ],
    });
    mocks.assets.mockResolvedValue([image]);
    mocks.sign.mockImplementation((value: string, origin: string) => `${origin}${value}?signature=signed`);
});

describe("textConversationMessages", () => {
    it("sends the actual image bytes with the question and conversation context", async () => {
        const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#ff0000" } })
            .png()
            .toBuffer();
        mocks.internalFetch.mockResolvedValue(new Response(new Uint8Array(png), { headers: { "content-type": "image/png" } }));

        const messages = await textConversationMessages(run, "http://127.0.0.1:3100");

        expect(messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
        expect(messages[0].content).toContain("此前讨论销售额");
        expect(messages[3].content).toEqual([
            { type: "text", text: run.prompt },
            { type: "text", text: "图片 @图片1（销售趋势截图）：" },
            { type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } },
        ]);
        expect(mocks.sign).toHaveBeenCalledWith(image.serverUrl, "http://127.0.0.1:3100", "user-one");
        expect(mocks.internalFetch).toHaveBeenCalledWith(`http://127.0.0.1:3100${image.serverUrl}?signature=signed`, { cache: "no-store", redirect: "manual" });
    });

    it("rejects media from another conversation before reading it", async () => {
        mocks.assets.mockResolvedValue([{ ...image, conversationId: "another" }]);
        await expect(textConversationMessages(run, "http://127.0.0.1:3100")).rejects.toThrow("当前会话");
        expect(mocks.internalFetch).not.toHaveBeenCalled();
    });

    it("rejects oversized image responses", async () => {
        mocks.internalFetch.mockResolvedValue(new Response("large", { headers: { "content-length": String(20 * 1024 * 1024 + 1) } }));
        await expect(textConversationMessages(run, "http://127.0.0.1:3100")).rejects.toThrow("大小限制");
    });
});
