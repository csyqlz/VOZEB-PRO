import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

import { createProtocolFixtureServer } from "../../../scripts/protocol-fixture-server.mjs";

const mocks = vi.hoisted(() => ({
    fetchInternalApi: vi.fn(),
    getAuthSettings: vi.fn(),
    refundUserPoints: vi.fn(),
    resolveLogicalModelCandidates: vi.fn(),
}));

vi.mock("@/lib/auth/store", () => ({
    getAuthSettings: mocks.getAuthSettings,
    refundUserPoints: mocks.refundUserPoints,
}));
vi.mock("@/lib/server/internal-origin", () => ({ fetchInternalApi: mocks.fetchInternalApi }));
vi.mock("@/lib/server/logical-model-router", () => ({ resolveLogicalModelCandidates: mocks.resolveLogicalModelCandidates }));

import { decomposeCanvasImage } from "./canvas-image-decomposition-service";

const candidate = {
    channelId: "fixture-text",
    upstreamModel: "mock-text",
    channel: {
        id: "fixture-text",
        name: "本地视觉文本模型",
        baseUrl: "http://127.0.0.1",
        apiKey: "fixture",
        apiFormat: "openai",
        models: ["mock-text"],
        enabled: true,
    },
};

let fixture: ReturnType<typeof createProtocolFixtureServer>;
let origin = "";
let source = "";

beforeAll(async () => {
    fixture = createProtocolFixtureServer();
    await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
    const address = fixture.server.address();
    if (!address || typeof address === "string") throw new Error("Protocol fixture did not bind a TCP port");
    origin = `http://127.0.0.1:${address.port}`;
    const image = await sharp({ create: { width: 1000, height: 800, channels: 4, background: "#4775d1" } })
        .png()
        .toBuffer();
    source = `data:image/png;base64,${image.toString("base64")}`;
});

afterAll(async () => {
    await new Promise<void>((resolve, reject) => fixture.server.close((error?: Error) => (error ? reject(error) : resolve())));
});

beforeEach(() => {
    fixture.requests.splice(0);
    mocks.getAuthSettings.mockReset().mockResolvedValue({ defaultModels: { textModel: "planner" } });
    mocks.resolveLogicalModelCandidates.mockReset().mockReturnValue([candidate]);
    mocks.refundUserPoints.mockReset();
    mocks.fetchInternalApi.mockReset().mockImplementation((input: string | URL, init?: RequestInit) => fetch(input, init));
});

describe("canvas image decomposition service protocol integration", () => {
    it("sends the source image to the configured vision model and preserves ecommerce layers", async () => {
        const result = await decomposeCanvasImage({ origin, cookie: "session=fixture", userId: "user-one", requestId: "request-one", source });

        expect(result).toMatchObject({
            strategy: "ecommerce",
            width: 1000,
            height: 800,
            backgroundDescription: "协议夹具蓝色渐变背景",
            backgroundPreservedVisuals: ["蓝色渐变", "柔和环境光"],
            layers: [{ kind: "decoration" }, { kind: "product" }, { kind: "headline" }, { kind: "badge" }, { kind: "logo" }],
        });
        expect(fixture.requests).toHaveLength(1);
        expect(fixture.requests[0]).toMatchObject({ method: "POST", path: "/api/ai/system/fixture-text/chat/completions" });
        const payload = JSON.parse(fixture.requests[0].body.toString("utf8"));
        expect(payload.messages[1].content).toEqual(
            expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.stringContaining("1000x800") }), expect.objectContaining({ type: "image_url", image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) } })]),
        );
        expect(payload.tool_choice).toMatchObject({ function: { name: "decompose_ecommerce_image" } });
    });

    it("refunds a charged response whose body is not valid JSON", async () => {
        mocks.fetchInternalApi.mockResolvedValueOnce(
            new Response("not-json", {
                status: 200,
                headers: {
                    "content-type": "application/json",
                    "x-vozeb-pro-points-cost": "0",
                    "x-vozeb-pro-points-record-id": "points-decomposition",
                },
            }),
        );

        await expect(decomposeCanvasImage({ origin, cookie: "", userId: "user-one", requestId: "request-invalid", source })).rejects.toThrow("图片理解模型返回了无效 JSON");
        expect(mocks.refundUserPoints).toHaveBeenCalledWith("user-one", "planner", 0, "text", 1, undefined, "points-decomposition");
    });
});
