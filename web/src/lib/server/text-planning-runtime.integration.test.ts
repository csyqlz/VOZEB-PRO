import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
