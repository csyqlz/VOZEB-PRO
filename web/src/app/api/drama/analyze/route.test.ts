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

describe("POST /api/drama/analyze", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: "user-one" });
        mocks.checkRateLimit.mockResolvedValue({ allowed: true });
        mocks.getAuthSettings.mockResolvedValue({
            defaultModels: { textModel: "planner", videoModel: "video-planner" },
            generationDefaults: { videoSeconds: 5 },
            generationPointMultipliers: { videoSeconds: { "5": 1, "8": 1, "10": 1, "15": 1 } },
        });
        mocks.resolveLogicalModelCandidates.mockImplementation((_settings: unknown, capability: string) =>
            capability === "video"
                ? [
                      {
                          logicalModelId: "video-planner",
                          channelId: "video-channel",
                          channel: {
                              id: "video-channel",
                              name: "视频渠道",
                              baseUrl: "https://video.example.com/v1",
                              apiKey: "secret",
                              apiFormat: "openai",
                              models: ["vendor-video"],
                              enabled: true,
                              advancedConfig: { durationRange: "4-15 秒" },
                          },
                          upstreamModel: "vendor-video",
                          capabilityProfile: { minDurationSeconds: 4, maxDurationSeconds: 15 },
                      },
                  ]
                : [
                      {
                          logicalModelId: "planner",
                          channelId: "text-channel",
                          channel: { id: "text-channel", name: "文本渠道", baseUrl: "https://example.com/v1", apiKey: "secret", apiFormat: "openai", models: ["vendor-planner"], enabled: true },
                          upstreamModel: "vendor-planner",
                      },
                  ],
        );
        mocks.requestStructuredText.mockResolvedValue({
            arguments: JSON.stringify({
                episode: { outline: "大纲", hook: "", nextPreview: "", sourceRange: "第一场" },
                characters: [],
                scenes: [],
                props: [],
                clues: [],
                shots: [
                    {
                        title: "荒原",
                        description: "灰黑色风暴扫过废墟",
                        sourceText: "灰黑色风暴扫过废墟。",
                        shotBoundary: "环境建立",
                        dialogue: "",
                        narration: "",
                        utterances: [],
                        duration: 6,
                        characterNames: [],
                        sceneName: "废墟",
                        propNames: [],
                        clueNames: [],
                    },
                ],
            }),
            headers: new Headers(),
            protocol: "chat",
            elapsedMs: 10,
        });
    });

    it("uses one strict JSON request for drama analysis", async () => {
        const response = await POST(
            new Request("http://localhost/api/drama/analyze", {
                method: "POST",
                headers: { "content-type": "application/json", cookie: "session=test" },
                body: JSON.stringify({ requestId: "drama-content-request-one", phase: "content", script: "灰黑色风暴扫过废墟。" }),
            }),
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ code: 0, data: { shots: [expect.objectContaining({ title: "荒原", duration: 5 })] } });
        expect(mocks.requestStructuredText).toHaveBeenCalledOnce();
        const input = mocks.requestStructuredText.mock.calls[0]?.[0] as {
            preferNativeTools?: boolean;
            headers?: HeadersInit;
            fallbackHeaders?: HeadersInit;
            tool?: { name?: string };
            validateArguments?: (argumentsText: string) => boolean;
            messages?: Array<{ role: string; content: string }>;
            stream?: boolean;
            streamFallback?: boolean;
            signal?: AbortSignal;
        };
        const toolBillingKey = new Headers(input.headers).get("x-vozeb-pro-points-idempotency-key");
        const fallbackBillingKey = new Headers(input.fallbackHeaders).get("x-vozeb-pro-points-idempotency-key");
        expect(input).toMatchObject({ preferNativeTools: false, stream: true, streamFallback: true, tool: { name: "analyze_drama_content" } });
        expect(input.signal).toBeInstanceOf(AbortSignal);
        expect(input.validateArguments?.('{"script":"输入回显"}')).toBe(false);
        expect(input.validateArguments?.('{"episode":{"outline":"大纲"},"shots":[{"title":"镜头"}]}')).toBe(true);
        expect(
            input.validateArguments?.(
                JSON.stringify({
                    episode: { outline: "大纲" },
                    characters: [],
                    shots: [{ characterNames: [], utterances: [{ type: "dialogue", speaker: "", text: "灰黑色风暴扫过废墟。" }] }],
                }),
            ),
        ).toBe(true);
        expect(toolBillingKey).toMatch(/:tool$/);
        expect(fallbackBillingKey).toMatch(/:json$/);
        expect(fallbackBillingKey).not.toBe(toolBillingKey);
        expect(input.messages?.[0]?.content).toContain("5、8、10、15 秒");
        expect(input.messages?.[0]?.content).toContain("不能删句");
        expect(input.messages?.[0]?.content).not.toContain("JSON Schema");
    });

    it("unwraps a Responses-compatible data wrapper before validating drama fields", async () => {
        mocks.requestStructuredText.mockResolvedValueOnce({
            arguments: JSON.stringify({
                data: {
                    episode: { outline: "大纲", hook: "", nextPreview: "", sourceRange: "第一场" },
                    characters: [],
                    scenes: [],
                    props: [],
                    clues: [],
                    shots: [
                        {
                            title: "荒原",
                            description: "灰黑色风暴扫过废墟",
                            sourceText: "灰黑色风暴扫过废墟。",
                            shotBoundary: "环境建立",
                            dialogue: "",
                            narration: "",
                            utterances: [],
                            duration: 5,
                            characterNames: [],
                            sceneName: "废墟",
                            propNames: [],
                            clueNames: [],
                        },
                    ],
                },
            }),
            headers: new Headers(),
            protocol: "responses",
            elapsedMs: 10,
        });
        const response = await POST(
            new Request("http://localhost/api/drama/analyze", {
                method: "POST",
                headers: { "content-type": "application/json", cookie: "session=test" },
                body: JSON.stringify({ requestId: "drama-content-request-wrapper", phase: "content", script: "灰黑色风暴扫过废墟。" }),
            }),
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ code: 0, data: { shots: [expect.objectContaining({ title: "荒原" })] } });
    });

    it("normalizes missing model utterances from the original novel instead of rejecting the request", async () => {
        const script = "顾言推开城门说：“先离开这里。”\n风雪压过城门。";
        mocks.requestStructuredText.mockResolvedValueOnce({
            arguments: JSON.stringify({
                episode: { outline: "城门告急", hook: "", nextPreview: "", sourceRange: "第一章" },
                characters: [],
                scenes: [],
                props: [],
                clues: [],
                shots: [{ title: "城门", description: "顾言推开城门", sourceText: script, shotBoundary: "对白后切镜", dialogue: "", narration: "", utterances: [], duration: 5, characterNames: [], sceneName: "城门", propNames: [], clueNames: [] }],
            }),
            headers: new Headers(),
            protocol: "chat",
            elapsedMs: 10,
        });

        const response = await POST(
            new Request("http://localhost/api/drama/analyze", {
                method: "POST",
                headers: { "content-type": "application/json", cookie: "session=test" },
                body: JSON.stringify({ requestId: "drama-content-recover-dialogue", phase: "content", script }),
            }),
        );
        const payload = (await response.json()) as { data: { shots: Array<{ utterances: Array<{ speaker: string; text: string }> }> }; meta?: { mode?: string } };

        expect(response.status).toBe(200);
        expect(payload.meta?.mode).not.toBe("fallback");
        expect(payload.data.shots.flatMap((shot) => shot.utterances)).toEqual([expect.objectContaining({ speaker: "顾言", text: "先离开这里。" })]);
    });

    it("rejects dialogue that still has no specific speaker after source normalization", async () => {
        const script = "他说：“快走！”";
        mocks.requestStructuredText.mockResolvedValueOnce({
            arguments: JSON.stringify({
                episode: { outline: "紧急撤离", hook: "", nextPreview: "", sourceRange: "第一章" },
                characters: [],
                scenes: [],
                props: [],
                clues: [],
                shots: [
                    {
                        title: "撤离",
                        description: "有人催促离开",
                        sourceText: script,
                        shotBoundary: "对白结束",
                        dialogue: "快走！",
                        narration: "",
                        utterances: [{ type: "dialogue", speaker: "他", text: "快走！" }],
                        duration: 5,
                        characterNames: [],
                        sceneName: "",
                        propNames: [],
                        clueNames: [],
                    },
                ],
            }),
            headers: new Headers(),
            protocol: "chat",
            elapsedMs: 10,
        });

        const response = await POST(
            new Request("http://localhost/api/drama/analyze", {
                method: "POST",
                headers: { "content-type": "application/json", cookie: "session=test" },
                body: JSON.stringify({ requestId: "drama-content-unresolved-speaker", phase: "content", script }),
            }),
        );

        expect(response.status).toBe(502);
        await expect(response.json()).resolves.toMatchObject({ code: 502, data: null, msg: "模型返回的剧本对白或原文不完整" });
        expect(mocks.requestStructuredText).toHaveBeenCalledOnce();
    });

    it("splits a malformed single eight-second response before returning it to the editor", async () => {
        const lines = Array.from({ length: 78 }, (_, index) => `角色${index + 1}说：“第${index + 1}句对白必须保留。”`);
        mocks.refundUserPoints.mockResolvedValue({ pointsBalance: 98 });
        const responseForSegment = (segment: string) => ({
            arguments: JSON.stringify({
                episode: { outline: "长篇对白", hook: "", nextPreview: "", sourceRange: "第一章" },
                characters: [],
                scenes: [],
                props: [],
                clues: [],
                shots: [
                    {
                        title: "分段对白",
                        description: segment,
                        sourceText: segment,
                        shotBoundary: "说话人转换",
                        dialogue: [...segment.matchAll(/：“([^”]+)”/gu)].map((match) => match[1]).join("\n"),
                        narration: "",
                        utterances: [...segment.matchAll(/(角色\d+)说：“([^”]+)”/gu)].map((match) => ({ type: "dialogue", speaker: match[1], text: match[2] })),
                        duration: 8,
                        characterNames: [...segment.matchAll(/(角色\d+)说/gu)].map((match) => match[1]),
                        sceneName: "",
                        propNames: [],
                        clueNames: [],
                    },
                ],
            }),
            headers: new Headers(),
            protocol: "chat",
            elapsedMs: 10,
        });
        mocks.requestStructuredText
            .mockResolvedValueOnce({
                arguments: JSON.stringify({
                    episode: { outline: "长篇对白", hook: "", nextPreview: "", sourceRange: "第一章" },
                    characters: [],
                    scenes: [],
                    props: [],
                    clues: [],
                    shots: [
                        { title: "错误合并镜头", description: "只概括了开头", sourceText: lines[0], shotBoundary: "没有正确切镜", dialogue: "", narration: "", utterances: [], duration: 8, characterNames: [], sceneName: "", propNames: [], clueNames: [] },
                    ],
                }),
                headers: new Headers({ "x-vozeb-pro-points-cost": "2", "x-vozeb-pro-points-record-id": "points-full" }),
                protocol: "chat",
                elapsedMs: 10,
            })
            .mockImplementation(async (input) => {
                const messages = (input as { messages: Array<{ role: string; content: string }> }).messages;
                const payload = JSON.parse(messages.at(-1)!.content) as { script: string };
                return responseForSegment(payload.script);
            });

        const response = await POST(
            new Request("http://localhost/api/drama/analyze", {
                method: "POST",
                headers: { "content-type": "application/json", cookie: "session=test" },
                body: JSON.stringify({ requestId: "drama-content-many-lines", phase: "content", script: lines.join("\n"), videoModel: "video-planner" }),
            }),
        );
        const payload = (await response.json()) as { data: { shots: Array<{ duration: number; utterances: Array<{ text: string }> }> } };

        expect(response.status).toBe(200);
        expect(payload.data.shots.length).toBeGreaterThan(1);
        expect(payload.data.shots.every((shot) => [5, 8, 10, 15].includes(shot.duration))).toBe(true);
        expect(payload.data.shots.flatMap((shot) => shot.utterances.map((utterance) => utterance.text))).toEqual(lines.map((_, index) => `第${index + 1}句对白必须保留。`));
        const requestedScripts = mocks.requestStructuredText.mock.calls.map(([input]) => {
            const messages = (input as { messages: Array<{ role: string; content: string }> }).messages;
            return (JSON.parse(messages.at(-1)!.content) as { script: string }).script;
        });
        expect(requestedScripts).toHaveLength(3);
        expect(requestedScripts[0]).toBe(lines.join("\n"));
        expect(requestedScripts.slice(1).every((segment) => segment !== requestedScripts[0])).toBe(true);
        expect(mocks.refundUserPoints).toHaveBeenCalledWith("user-one", "planner", 2, "text", 1, undefined, "points-full");
    });

    it("refunds successful segments when a later segment cannot be analyzed", async () => {
        const lines = ["角色甲说：“第一句。”", "角色乙说：“第二句。”"];
        const script = lines.join("\n");
        const segmentResponse = (segment: string, billed = false) => ({
            arguments: JSON.stringify({
                episode: { outline: "对白", hook: "", nextPreview: "", sourceRange: "第一章" },
                characters: [],
                scenes: [],
                props: [],
                clues: [],
                shots: [
                    {
                        title: "对白",
                        description: segment,
                        sourceText: segment,
                        shotBoundary: "说话人转换",
                        dialogue: [...segment.matchAll(/：“([^”]+)”/gu)].map((match) => match[1]).join("\n"),
                        narration: "",
                        utterances: [...segment.matchAll(/(角色[^“]+)说：“([^”]+)”/gu)].map((match) => ({ type: "dialogue", speaker: match[1], text: match[2] })),
                        duration: 5,
                        characterNames: [...segment.matchAll(/(角色[^“]+)说/gu)].map((match) => match[1]),
                        sceneName: "",
                        propNames: [],
                        clueNames: [],
                    },
                ],
            }),
            headers: billed ? new Headers({ "x-vozeb-pro-points-cost": "3", "x-vozeb-pro-points-record-id": "points-segment" }) : new Headers(),
            protocol: "chat",
            elapsedMs: 10,
        });
        const invalidResponse = (segment: string, billed = true, complete = true) => ({
            ...segmentResponse(segment),
            headers: billed ? new Headers({ "x-vozeb-pro-points-cost": "4", "x-vozeb-pro-points-record-id": "points-failed-segment" }) : new Headers(),
            arguments: JSON.stringify({ episode: { outline: "对白" }, shots: [{ sourceText: complete ? segment : segment.slice(0, 1), description: segment, utterances: [] }] }),
        });
        mocks.refundUserPoints.mockResolvedValue({ pointsBalance: 90 });
        mocks.requestStructuredText.mockImplementation(async (input) => {
            const messages = (input as { messages: Array<{ role: string; content: string }> }).messages;
            const requestedScript = (JSON.parse(messages.at(-1)!.content) as { script: string }).script;
            if (requestedScript === script) return invalidResponse(requestedScript, false, false);
            if (requestedScript === lines[0]) return segmentResponse(requestedScript, true);
            return invalidResponse(requestedScript, true, false);
        });

        const response = await POST(
            new Request("http://localhost/api/drama/analyze", {
                method: "POST",
                headers: { "content-type": "application/json", cookie: "session=test" },
                body: JSON.stringify({ requestId: "drama-content-refund-segments", phase: "content", script }),
            }),
        );

        expect(response.status).toBe(502);
        expect(mocks.refundUserPoints).toHaveBeenCalledTimes(2);
        expect(mocks.refundUserPoints.mock.calls.map((call) => call[6])).toEqual(expect.arrayContaining(["points-failed-segment", "points-segment"]));
    });

    it("keeps one request idempotent while separate user actions use different billing keys", async () => {
        for (const requestId of ["drama-content-request-one", "drama-content-request-one", "drama-content-request-two"]) {
            const response = await POST(
                new Request("http://localhost/api/drama/analyze", {
                    method: "POST",
                    headers: { "content-type": "application/json", cookie: "session=test" },
                    body: JSON.stringify({ requestId, phase: "content", script: "灰黑色风暴扫过废墟。", videoModel: "video-planner" }),
                }),
            );
            expect(response.status).toBe(200);
        }

        const billingKeys = mocks.requestStructuredText.mock.calls.map(([input]) => new Headers((input as { headers?: HeadersInit }).headers).get("x-vozeb-pro-points-idempotency-key"));
        expect(billingKeys[0]).toBe(billingKeys[1]);
        expect(billingKeys[2]).not.toBe(billingKeys[0]);
    });

    it("adaptively splits a structurally invalid visual request and preserves shot order", async () => {
        const shots = Array.from({ length: 4 }, (_, index) => ({ id: `shot-${index + 1}`, title: `镜头 ${index + 1}`, description: `描述 ${index + 1}`, sourceText: `原文 ${index + 1}`, duration: 5 }));
        mocks.requestStructuredText.mockRejectedValueOnce(new Error("模型没有返回所需的结构化结果")).mockImplementation(async (input) => {
            const messages = (input as { messages: Array<{ role: string; content: string }> }).messages;
            const payload = JSON.parse(messages.at(-1)!.content) as { shots: Array<{ id: string }> };
            return {
                arguments: JSON.stringify({
                    shots: payload.shots.map((shot) => ({
                        shotId: shot.id,
                        imagePrompt: `${shot.id} 图片提示词`,
                        videoPrompt: `${shot.id} 视频提示词`,
                    })),
                }),
                headers: new Headers(),
                protocol: "chat",
                elapsedMs: 10,
            };
        });

        const response = await POST(
            new Request("http://localhost/api/drama/analyze", {
                method: "POST",
                headers: { "content-type": "application/json", cookie: "session=test" },
                body: JSON.stringify({ requestId: "drama-visual-adaptive", phase: "visual", shots }),
            }),
        );
        const payload = (await response.json()) as { data: { shots: Array<{ shotId: string }> } };
        const requestedShotIds = mocks.requestStructuredText.mock.calls.map(([input]) => {
            const messages = (input as { messages: Array<{ role: string; content: string }> }).messages;
            return (JSON.parse(messages.at(-1)!.content) as { shots: Array<{ id: string }> }).shots.map((shot) => shot.id);
        });
        const billingKeys = mocks.requestStructuredText.mock.calls.map(([input]) => new Headers((input as { headers?: HeadersInit }).headers).get("x-vozeb-pro-points-idempotency-key"));
        expect((mocks.requestStructuredText.mock.calls[0]?.[0] as { allowRepair?: boolean }).allowRepair).toBe(false);
        expect(mocks.requestStructuredText.mock.calls.every(([input]) => (input as { stream?: boolean }).stream === true)).toBe(true);

        expect(response.status).toBe(200);
        expect(requestedShotIds).toEqual([
            ["shot-1", "shot-2", "shot-3", "shot-4"],
            ["shot-1", "shot-2"],
            ["shot-3", "shot-4"],
        ]);
        expect(payload.data.shots.map((shot) => shot.shotId)).toEqual(["shot-1", "shot-2", "shot-3", "shot-4"]);
        expect(new Set(billingKeys).size).toBe(3);
    });

    it("requests only missing shots from a valid partial visual response", async () => {
        const shots = [
            { id: "shot-one", sourceText: "原文一" },
            { id: "shot-two", sourceText: "原文二" },
        ];
        mocks.requestStructuredText.mockImplementation(async (input) => {
            const messages = (input as { messages: Array<{ role: string; content: string }> }).messages;
            const requested = (JSON.parse(messages.at(-1)!.content) as { shots: Array<{ id: string }> }).shots;
            const returned = requested.length > 1 ? requested.slice(0, 1) : requested;
            return {
                arguments: JSON.stringify({ shots: returned.map((shot) => ({ shotId: shot.id, imagePrompt: `${shot.id} 图片提示词`, videoPrompt: `${shot.id} 视频提示词` })) }),
                headers: new Headers(),
                protocol: "chat",
                elapsedMs: 10,
            };
        });

        const response = await POST(
            new Request("http://localhost/api/drama/analyze", {
                method: "POST",
                headers: { "content-type": "application/json", cookie: "session=test" },
                body: JSON.stringify({ requestId: "drama-visual-partial", phase: "visual", shots }),
            }),
        );
        const payload = (await response.json()) as { data: { shots: Array<{ shotId: string }> } };
        const requestedShotIds = mocks.requestStructuredText.mock.calls.map(([input]) => {
            const messages = (input as { messages: Array<{ role: string; content: string }> }).messages;
            return (JSON.parse(messages.at(-1)!.content) as { shots: Array<{ id: string }> }).shots.map((shot) => shot.id);
        });

        expect(response.status).toBe(200);
        expect(requestedShotIds).toEqual([["shot-one", "shot-two"], ["shot-two"]]);
        expect(payload.data.shots.map((shot) => shot.shotId)).toEqual(["shot-one", "shot-two"]);
    });

    it("rejects analysis without a request identity before calling the model", async () => {
        const response = await POST(
            new Request("http://localhost/api/drama/analyze", {
                method: "POST",
                headers: { "content-type": "application/json", cookie: "session=test" },
                body: JSON.stringify({ phase: "content", script: "灰黑色风暴扫过废墟。" }),
            }),
        );

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({ msg: "剧本分析请求标识无效" });
        expect(mocks.requestStructuredText).not.toHaveBeenCalled();
    });

    it("rejects a structured response that echoes the input fields", async () => {
        mocks.requestStructuredText.mockResolvedValue({
            arguments: JSON.stringify({ script: "灰黑色风暴扫过废墟。", summary: "输入摘要", episode: { outline: "大纲" }, shots: [{ sourceText: "灰黑色风暴扫过废墟。" }] }),
            headers: new Headers(),
            protocol: "chat",
            elapsedMs: 10,
        });

        const response = await POST(
            new Request("http://localhost/api/drama/analyze", {
                method: "POST",
                headers: { "content-type": "application/json", cookie: "session=test" },
                body: JSON.stringify({ requestId: "drama-content-echo", phase: "content", script: "灰黑色风暴扫过废墟。" }),
            }),
        );

        expect(response.status).toBe(502);
        expect(mocks.requestStructuredText).toHaveBeenCalledOnce();
    });
});
