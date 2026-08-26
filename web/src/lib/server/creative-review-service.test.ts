import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAuthSettings, refundUserPoints, fetchInternalApi, resolveLogicalModel } = vi.hoisted(() => ({ getAuthSettings: vi.fn(), refundUserPoints: vi.fn(), fetchInternalApi: vi.fn(), resolveLogicalModel: vi.fn() }));

vi.mock("@/lib/auth/store", () => ({ getAuthSettings, refundUserPoints }));
vi.mock("@/lib/server/internal-origin", () => ({ fetchInternalApi }));
vi.mock("@/lib/server/logical-model-router", () => ({ resolveLogicalModel }));
vi.mock("@/lib/server/structured-model-output", () => ({ strictJsonObjectText: (value: unknown) => (typeof value === "string" ? value : "") }));

import { reviewCreativeOutputs } from "./creative-review-service";

const foundation = { complexity: "simple" as const, brief: { objective: "生成商品主图" }, direction: { summary: "干净、可信、突出产品" } };

describe("creative review service", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getAuthSettings.mockResolvedValue({ site: { title: "星河创作" }, defaultModels: { textModel: "planner" } });
        resolveLogicalModel.mockReturnValue({ upstreamModel: "vendor-planner", channel: { id: "text-channel" } });
    });

    it("returns an explicit unavailable result when no visual or text input exists", async () => {
        const review = await reviewCreativeOutputs({ origin: "http://localhost:3000", cookie: "session=1", userId: "user", foundation, tasks: [{ id: "video", title: "视频", type: "video", prompt: "生成视频", resultSummary: "已完成" }] });

        expect(review).toMatchObject({ mode: "unavailable", status: "unavailable" });
        expect(getAuthSettings).not.toHaveBeenCalled();
    });

    it("sends real images to the trusted logical model route", async () => {
        fetchInternalApi.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    output: [
                        {
                            type: "function_call",
                            name: "review_creative_outputs",
                            arguments: JSON.stringify({ mode: "visual", status: "passed", score: 92, summary: "主体和视觉方向一致", issues: [], retryTaskIds: [] }),
                        },
                    ],
                }),
                { status: 200, headers: { "Content-Type": "application/json", "x-vozeb-pro-points-cost": "2" } },
            ),
        );

        const review = await reviewCreativeOutputs({
            origin: "http://localhost:3000",
            cookie: "session=1",
            userId: "user",
            billingId: "record-one",
            foundation,
            tasks: [{ id: "image-1", title: "主图", type: "image", prompt: "生成主图", resultSummary: "已生成", imageUrls: ["data:image/png;base64,AA=="] }],
        });

        expect(review).toMatchObject({ mode: "visual", status: "passed", score: 92 });
        expect(fetchInternalApi).toHaveBeenCalledWith("http://localhost:3000/api/ai/system/text-channel/responses", expect.objectContaining({ body: expect.stringContaining('"type":"input_image"') }));
        const requestBody = JSON.parse(fetchInternalApi.mock.calls[0][1].body);
        expect(requestBody.model).toBe("vendor-planner");
        expect(requestBody.input[0].content).toContain("你是 星河创作 创作质检 Agent");
        const headers = new Headers(fetchInternalApi.mock.calls[0][1].headers);
        expect(headers.get("x-vozeb-pro-logical-model")).toBe("planner");
        expect(headers.get("x-vozeb-pro-points-idempotency-key")).toMatch(/^creative-review:[a-f0-9]{32}$/);
    });

    it("refunds an invalid structured review and preserves the result as unavailable", async () => {
        fetchInternalApi.mockResolvedValueOnce(
            new Response(JSON.stringify({ output: [{ type: "function_call", name: "review_creative_outputs", arguments: JSON.stringify({ status: "passed" }) }] }), {
                status: 200,
                headers: { "Content-Type": "application/json", "x-vozeb-pro-points-cost": "3", "x-vozeb-pro-points-record-id": "points-review-3" },
            }),
        );

        const review = await reviewCreativeOutputs({
            origin: "http://localhost:3000",
            cookie: "session=1",
            userId: "user",
            foundation,
            tasks: [{ id: "image-1", title: "主图", type: "image", prompt: "生成主图", resultSummary: "已生成", imageUrls: ["data:image/png;base64,AA=="] }],
        });

        expect(review).toMatchObject({ status: "unavailable" });
        expect(refundUserPoints).toHaveBeenCalledWith("user", "planner", 3, "text", 1, undefined, "points-review-3");
    });

    it("refunds malformed review JSON", async () => {
        fetchInternalApi.mockResolvedValueOnce(
            new Response(JSON.stringify({ output: [{ type: "function_call", name: "review_creative_outputs", arguments: "{" }] }), {
                status: 200,
                headers: { "Content-Type": "application/json", "x-vozeb-pro-points-cost": "0", "x-vozeb-pro-points-record-id": "points-review-free" },
            }),
        );

        const review = await reviewCreativeOutputs({
            origin: "http://localhost:3000",
            cookie: "session=1",
            userId: "user",
            foundation,
            tasks: [{ id: "image-1", title: "主图", type: "image", prompt: "生成主图", resultSummary: "已生成", imageUrls: ["data:image/png;base64,AA=="] }],
        });

        expect(review.status).toBe("unavailable");
        expect(refundUserPoints).toHaveBeenCalledWith("user", "planner", 0, "text", 1, undefined, "points-review-free");
    });
});
