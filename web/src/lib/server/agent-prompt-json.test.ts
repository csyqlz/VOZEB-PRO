import { describe, expect, it } from "vitest";
import { AGENT_REQUEST_SCHEMA, AGENT_PROMPT_SCHEMA, agentRequestDigest, buildAgentRequest, buildAgentPromptJson, promptJsonDigest, serializeAgentRequest, serializeAgentPromptJson } from "./agent-prompt-json";

describe("agent prompt JSON", () => {
    it("uses AgentRequestV1 as the canonical contract while retaining source aliases", () => {
        const request = buildAgentRequest({ id: "run", conversationId: "conversation", surface: "chat", prompt: "你好" }, { requirement: "你好" });

        expect(AGENT_PROMPT_SCHEMA).toBe(AGENT_REQUEST_SCHEMA);
        expect(request.schema).toBe("vozeb.agent.request.v1");
        expect(serializeAgentRequest(request)).toBe(serializeAgentPromptJson(buildAgentPromptJson({ id: "run", conversationId: "conversation", surface: "chat", prompt: "你好" }, { requirement: "你好" })));
        expect(agentRequestDigest(request)).toBe(promptJsonDigest(request));
    });

    it("keeps stable request and reference identities while preserving planner context", () => {
        const prompt = buildAgentPromptJson(
            {
                id: "run-one",
                conversationId: "conversation-one",
                surface: "drama",
                projectId: "project-one",
                prompt: "继续当前一集",
                referencedAssetIds: ["asset-one", "asset-one"],
                selectedSkillIds: ["skill-one"],
                requestedModelIds: ["planner-one"],
            },
            {
                requirement: "继续当前一集",
                referencedAssets: [{ id: "asset-two" }],
                currentTurnSelection: { selectedNodeIds: ["node-one", "node-one"] },
                projectSnapshot: { episodeId: "episode-one" },
            },
        );

        expect(prompt).toMatchObject({
            schema: AGENT_PROMPT_SCHEMA,
            request: { runId: "run-one", conversationId: "conversation-one", projectId: "project-one", surface: "drama" },
            references: { assetIds: ["asset-one"], selectedNodeIds: ["node-one"], selectedSkillIds: ["skill-one"] },
            projectSnapshot: { episodeId: "episode-one" },
        });
        expect(JSON.parse(serializeAgentPromptJson(prompt))).toEqual(prompt);
    });

    it("changes digest when planner context changes", () => {
        const base = buildAgentPromptJson({ id: "run", conversationId: "conversation", surface: "chat", prompt: "你好" }, { requirement: "你好" });
        const changed = buildAgentPromptJson({ id: "run", conversationId: "conversation", surface: "chat", prompt: "你好" }, { requirement: "你好", availableModels: [{ id: "model-two" }] });
        expect(promptJsonDigest(base)).not.toBe(promptJsonDigest(changed));
        expect(promptJsonDigest(base)).toMatch(/^[0-9a-f]{64}$/);
    });

    it("protects contract metadata from planner context keys", () => {
        const prompt = buildAgentPromptJson(
            { id: "run", conversationId: "conversation", surface: "chat", prompt: "原始请求" },
            {
                schema: "spoofed",
                request: { userText: "spoofed" },
                references: { assetIds: ["spoofed"] },
                preferences: { mode: "image" },
            },
        );

        expect(prompt.schema).toBe(AGENT_PROMPT_SCHEMA);
        expect(prompt.request).toMatchObject({ runId: "run", conversationId: "conversation", userText: "原始请求" });
        expect(prompt.references.assetIds).toEqual([]);
        expect(prompt.preferences).toBeUndefined();
    });
});
