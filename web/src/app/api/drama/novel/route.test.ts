import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    getAuthSettings: vi.fn(),
    refundUserPoints: vi.fn(),
    resolveLogicalModelCandidates: vi.fn(),
    checkRateLimit: vi.fn(),
    requestStructuredText: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/auth/store", () => ({ getAuthSettings: mocks.getAuthSettings, isAuthInputError: vi.fn(() => false), refundUserPoints: mocks.refundUserPoints }));
vi.mock("@/lib/server/internal-origin", () => ({ resolveInternalOrigin: vi.fn((origin: string) => origin) }));
vi.mock("@/lib/server/logical-model-router", () => ({ resolveLogicalModelCandidates: mocks.resolveLogicalModelCandidates }));
vi.mock("@/lib/server/security", () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock("@/lib/server/text-planning-runtime", () => ({ isStructuredTextFailure: vi.fn(() => false), rankTextPlanningCandidates: vi.fn((items: unknown[]) => items), requestStructuredText: mocks.requestStructuredText }));

import { POST } from "./route";

const chapterText = "第一章的内容".padEnd(120, "情节推进");

function request(body: Record<string, unknown>) {
    return new Request("http://127.0.0.1:3000/api/drama/novel", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

function candidate() {
    return [
        {
            logicalModelId: "glm-5.3-flash",
            channelId: "dm-channel",
            channel: { id: "dm-channel", name: "国产渠道", baseUrl: "https://dm.example.com/v1", apiKey: "secret", apiFormat: "openai", models: ["glm-5.3-flash"], enabled: true },
            upstreamModel: "glm-5.3-flash",
        },
    ];
}

function successfulCall(script = "第一场：深夜办公室\n画面：林小雨加班。\n林小雨：你被选中了。") {
    return {
        arguments: JSON.stringify({ script, summary: "林小雨深夜收到神秘短信，被卷入未知事件。" }),
        headers: new Headers({ "x-vozeb-pro-points-remaining": "42" }),
    };
}

describe("POST /api/drama/novel", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: "user-one" });
        mocks.checkRateLimit.mockResolvedValue({ allowed: true });
        mocks.getAuthSettings.mockResolvedValue({ defaultModels: { textModel: "default-text" } });
        mocks.resolveLogicalModelCandidates.mockImplementation((_settings: unknown, capability: string, model: string) => (capability === "text" && model === "glm-5.3-flash" ? candidate() : []));
    });

    it("用自选模型改编章节并返回剧本与摘要", async () => {
        mocks.requestStructuredText.mockResolvedValue(successfulCall());

        const response = await POST(request({ requestId: "novel-1", textModel: "glm-5.3-flash", chapterTitle: "第一章 深夜短信", chapterText, previousSummary: "上一章：...", style: "都市悬疑" }));
        const payload = await response.json();

        expect(response.status).toBe(200);
        expect(payload.code).toBe(0);
        expect(payload.data.script).toContain("第一场");
        expect(payload.data.summary).toContain("林小雨");
        expect(response.headers.get("x-vozeb-pro-points-remaining")).toBe("42");
        const call = mocks.requestStructuredText.mock.calls[0][0] as { tool: { name: string }; candidate: { upstreamModel: string } };
        expect(call.tool.name).toBe("adapt_novel_chapter");
        expect(call.candidate.upstreamModel).toBe("glm-5.3-flash");
    });

    it("未选择模型或模型不可用时返回 400", async () => {
        const noModel = await POST(request({ requestId: "novel-2", chapterText }));
        expect(noModel.status).toBe(400);
        expect(((await noModel.json()) as { msg: string }).msg).toContain("请选择");

        const badModel = await POST(request({ requestId: "novel-3", textModel: "missing-model", chapterText }));
        expect(badModel.status).toBe(400);
    });

    it("章节正文过短或过长时返回 400", async () => {
        const tooShort = await POST(request({ requestId: "novel-4", textModel: "glm-5.3-flash", chapterText: "太短" }));
        expect(tooShort.status).toBe(400);
        const tooLong = await POST(request({ requestId: "novel-5", textModel: "glm-5.3-flash", chapterText: "长".repeat(20_001) }));
        expect(tooLong.status).toBe(400);
    });

    it("改编输出缺少剧本或摘要时判定失败", async () => {
        mocks.requestStructuredText.mockResolvedValue({ arguments: JSON.stringify({ script: "", summary: "" }), headers: new Headers() });

        const response = await POST(request({ requestId: "novel-6", textModel: "glm-5.3-flash", chapterText }));
        expect(response.status).toBe(502);
    });
});
