import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";

import type { SystemChannelAdvancedConfig, SystemModelChannel } from "@/lib/auth/store";
import { channelProtocolDefinitions, registeredChannelProtocolDefinitions } from "@/lib/channel-protocol-registry";
import { GLOBAL_AIOPC_PRESETS } from "@/lib/globalaiopc-catalog";
import { createProtocolFixtureServer } from "../../../scripts/protocol-fixture-server.mjs";
import { requestStructuredText, type TextPlanningCandidate } from "./text-planning-runtime";

const STRICT_TEXT_PROTOCOLS = registeredChannelProtocolDefinitions.filter((definition) => definition.strict && definition.operations.text);
const MANUAL_TEXT_PROTOCOLS = channelProtocolDefinitions.filter((definition) => !definition.strict && definition.capabilities.includes("text"));
const GLOBAL_AIOPC_TEXT_PRESETS = GLOBAL_AIOPC_PRESETS.filter((preset) => preset.capability === "text");

let fixture: ReturnType<typeof createProtocolFixtureServer>;
let origin = "";

beforeAll(async () => {
    fixture = createProtocolFixtureServer();
    await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
    const address = fixture.server.address();
    if (!address || typeof address === "string") throw new Error("Protocol fixture did not expose a TCP port");
    origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve, reject) => fixture.server.close((error: Error | undefined) => (error ? reject(error) : resolve())));
});

describe("text planning runtime live protocol fixture", () => {
    it.each(["chat", "responses", "gemini", "custom"] as const)("sends the actual validation fields to the existing repair budget through %s TCP", async (protocol) => {
        const requests: Array<{ path: string; body: Record<string, unknown>; idempotencyKey?: string; billingKey?: string }> = [];
        const expectedCalls = protocol === "custom" ? 2 : 3;
        const server = createServer(async (request, response) => {
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            requests.push({ path: request.url || "", body, idempotencyKey: request.headers["idempotency-key"] as string | undefined, billingKey: request.headers["x-vozeb-pro-points-idempotency-key"] as string | undefined });
            const value = requests.length === expectedCalls ? { result: "accepted" } : { result: "invalid", attempt: requests.length };
            const payload =
                protocol === "responses"
                    ? { output_text: JSON.stringify(value) }
                    : protocol === "gemini"
                      ? { candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }] }
                      : protocol === "custom"
                        ? { data: { plan: value } }
                        : { choices: [{ message: { content: JSON.stringify(value) } }] };
            response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
        try {
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("Repair fixture did not expose a TCP port");
            const configured =
                protocol === "custom"
                    ? candidate("custom", { createPath: "/planner/run", requestTemplate: '{"deployment":"{{model}}","conversation":"{{messages}}"}', resultField: "data.plan" })
                    : protocol === "gemini"
                      ? candidate("compatible", { apiFormat: "gemini", createPath: "/models/:model:generateContent" })
                      : protocol === "responses"
                        ? candidate("compatible", { createPath: "/responses" })
                        : candidate("newapi");
            const validationInputs: string[] = [];
            const original = input(configured);
            const result = await requestStructuredText({
                ...original,
                origin: `http://127.0.0.1:${address.port}`,
                preferNativeTools: true,
                headers: { "idempotency-key": "reference-repair", "x-vozeb-pro-logical-model": "vision", "x-vozeb-pro-upstream-model": "mock-text", "x-vozeb-pro-points-idempotency-key": "reference-billing" },
                validateArguments: (argumentsText) => {
                    validationInputs.push(argumentsText);
                    const value = JSON.parse(argumentsText);
                    return value.result === "accepted"
                        ? { valid: true, issues: [] }
                        : { valid: false, issues: [{ code: "visual_field_invalid", path: value.attempt === 1 ? "references[0].productFacts.identity" : "references[1].cues[0].confidence", message: "缺少有效字段" }] };
                },
            });
            expect(JSON.parse(result.arguments)).toEqual({ result: "accepted" });
            expect(requests).toHaveLength(expectedCalls);
            expect(validationInputs).toHaveLength(expectedCalls);
            expect(new Set(requests.map((request) => request.path)).size).toBe(1);
            const repair = requests.at(-1)!;
            const repairText = JSON.stringify(repair.body);
            expect(repairText).toContain(expectedCalls === 2 ? "references[0].productFacts.identity" : "references[1].cues[0].confidence");
            expect(repairText).toContain("visual_field_invalid");
            expect(repairText).toContain("缺少有效字段");
            expect(repairText).toContain("返回测试计划");
            expect(repair.idempotencyKey).toBe(`reference-repair:${protocol}-repair`);
            expect(repair.billingKey).toMatch(/^reference-billing(?::json)?:repair$/);
            expect(original.messages).toEqual([{ role: "user", content: "返回测试计划" }]);
            expect(errors).toHaveBeenCalledTimes(expectedCalls - 1);
            for (const [message, detail] of errors.mock.calls) {
                expect(message).toBe("[text-planning] structured response failed argument validation");
                expect(JSON.parse(String(detail))).toMatchObject({ protocol, tool: original.tool.name });
            }
        } finally {
            errors.mockRestore();
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        }
    });

    it.each(STRICT_TEXT_PROTOCOLS)("sends the $id preset through Chat and reads strict JSON", async (definition) => {
        const result = await requestStructuredText(input(candidate(definition.id)));

        expect(result).toMatchObject({ protocol: "chat", arguments: "{}" });
        expect(lastRequest()).toMatchObject({ path: `/api/ai/system/${definition.id}/chat/completions`, body: expect.any(Buffer) });
        expect(JSON.parse(lastRequest().body.toString("utf8"))).toMatchObject({ model: "mock-text", messages: expect.any(Array) });
    });

    it.each(MANUAL_TEXT_PROTOCOLS)("receives structured text from the configured $id protocol", async (definition) => {
        const options = manualTextOptions(definition.id);
        const result = await requestStructuredText(input(candidate(definition.id, options)));
        const expectedProtocol = definition.id === "custom" ? "custom" : definition.id === "compatible" ? "responses" : "chat";
        const expectedPath = definition.id === "custom" ? "/planner/run" : definition.id === "compatible" ? "/responses" : "/chat/completions";

        expect(result).toMatchObject({ protocol: expectedProtocol, arguments: "{}" });
        expect(lastRequest().path).toBe(`/api/ai/system/${definition.id}${expectedPath}`);
    });

    it("sends a native Gemini model to generateContent and reads candidate text", async () => {
        const result = await requestStructuredText(input(candidate("compatible", { apiFormat: "gemini", createPath: "/models/:model:generateContent" })));

        expect(result).toMatchObject({ protocol: "gemini", arguments: "{}" });
        expect(lastRequest().path).toBe("/api/ai/system/compatible/models/mock-text:generateContent");
    });

    it("sends multimodal planning input through every supported TCP protocol contract", async () => {
        await requestStructuredText(multimodalInput(candidate("newapi")));
        expect(JSON.parse(lastRequest().body.toString("utf8"))).toMatchObject({
            messages: expect.arrayContaining([
                {
                    role: "user",
                    content: [
                        { type: "text", text: "analyze" },
                        { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
                    ],
                },
            ]),
        });

        await requestStructuredText(multimodalInput(candidate("compatible", { createPath: "/responses" })));
        expect(JSON.parse(lastRequest().body.toString("utf8"))).toMatchObject({
            input: expect.arrayContaining([
                {
                    role: "user",
                    content: [
                        { type: "input_text", text: "analyze" },
                        { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" },
                    ],
                },
            ]),
        });

        await requestStructuredText(multimodalInput(candidate("compatible", { apiFormat: "gemini", createPath: "/models/:model:generateContent" })));
        expect(JSON.parse(lastRequest().body.toString("utf8"))).toMatchObject({
            contents: [{ role: "user", parts: [{ text: "analyze" }, { inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } }] }],
        });

        const requestCount = fixture.requests.length;
        await expect(requestStructuredText(multimodalInput(candidate("custom", { createPath: "/planner/run", requestTemplate: '{"prompt":"{{prompt}}"}', resultField: "data.plan" })))).rejects.toThrow("不支持图片理解");
        expect(fixture.requests).toHaveLength(requestCount);
    });

    it.each(GLOBAL_AIOPC_TEXT_PRESETS)("receives structured text through the legacy $id preset", async (preset) => {
        const result = await requestStructuredText(input(candidate("globalaiopc", { apiFormat: preset.apiFormat, globalAiOpcPreset: preset.id as never }, preset.modelExamples[0])));

        expect(result.arguments).toBe("{}");
        expect(lastRequest().path).toMatch(/^\/api\/ai\/system\/globalaiopc\/(?:chat\/completions|responses)$/);
    });

    it("reads Chat, Responses, Gemini and custom streaming contracts from the TCP fixture", async () => {
        const chat = await requestStructuredText({ ...input(candidate("newapi")), stream: true });
        expect(chat).toMatchObject({ protocol: "chat", transport: "stream", arguments: "{}" });
        expect(lastRequest().path).toBe("/api/ai/system/newapi/chat/completions");
        expect(JSON.parse(lastRequest().body.toString("utf8"))).toMatchObject({ stream: true });

        const responses = await requestStructuredText({ ...input(candidate("compatible", { createPath: "/responses" })), stream: true });
        expect(responses).toMatchObject({ protocol: "responses", transport: "stream", arguments: "{}" });
        expect(lastRequest().path).toBe("/api/ai/system/compatible/responses");

        const gemini = await requestStructuredText({
            ...input(candidate("compatible", { apiFormat: "gemini", createPath: "/models/:model:generateContent", streaming: { enabled: true, path: "/models/:model:streamGenerateContent", format: "ndjson" } })),
            stream: true,
        });
        expect(gemini).toMatchObject({ protocol: "gemini", transport: "stream", arguments: "{}" });
        expect(lastRequest().path).toBe("/api/ai/system/compatible/models/mock-text:streamGenerateContent");

        const custom = await requestStructuredText({
            ...input(candidate("custom", { createPath: "/planner/run", requestTemplate: '{"prompt":"{{prompt}}"}', resultField: "data.plan", streaming: { enabled: true, path: "/planner/stream", format: "sse" } })),
            stream: true,
        });
        expect(custom).toMatchObject({ protocol: "custom", transport: "stream", arguments: "{}" });
        expect(lastRequest().path).toBe("/api/ai/system/custom/planner/stream");
    });
});

function manualTextOptions(protocol: SystemChannelAdvancedConfig["protocol"]): Partial<SystemChannelAdvancedConfig> {
    if (protocol === "custom") return { createPath: "/planner/run", requestTemplate: '{"deployment":"{{model}}","conversation":"{{messages}}"}', resultField: "data.plan" };
    return protocol === "compatible" ? { createPath: "/responses" } : {};
}

function input(configured: TextPlanningCandidate) {
    return {
        origin,
        cookie: "",
        candidate: configured,
        messages: [{ role: "user", content: "返回测试计划" }],
        tool: { name: "make_plan", description: "创建测试计划", parameters: { type: "object", properties: {} } },
    };
}

function multimodalInput(configured: TextPlanningCandidate) {
    return {
        ...input(configured),
        messages: [
            {
                role: "user",
                content: [
                    { type: "text" as const, text: "analyze" },
                    { type: "image_url" as const, image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
                ],
            },
        ],
    };
}

function candidate(protocol: SystemChannelAdvancedConfig["protocol"], options: Partial<SystemChannelAdvancedConfig> & { apiFormat?: "openai" | "gemini" } = {}, model = "mock-text"): TextPlanningCandidate {
    const advancedConfig = {
        protocol,
        textModel: model,
        imageModel: "",
        videoModel: "",
        createPath: "",
        queryPath: "",
        requestTemplate: "",
        resultField: "",
        statusField: "",
        durationRange: "",
        referenceRule: "",
        supportsReferenceImage: false,
        supportsReferenceVideo: false,
        supportsReferenceAudio: false,
        ...options,
    } satisfies SystemChannelAdvancedConfig;
    const channel = { id: protocol, name: protocol, baseUrl: origin, apiKey: "fixture", apiFormat: options.apiFormat || "openai", models: [model], enabled: true, advancedConfig } satisfies SystemModelChannel;
    return { channelId: channel.id, upstreamModel: model, channel };
}

function lastRequest() {
    const request = fixture.requests.at(-1);
    if (!request) throw new Error("Protocol fixture did not receive a request");
    return request;
}
