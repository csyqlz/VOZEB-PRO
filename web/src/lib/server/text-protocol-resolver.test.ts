import { describe, expect, it } from "vitest";
import { emptyAdvancedConfig } from "@/lib/channel-protocol-registry";
import { resolveTextProtocol } from "./text-protocol-resolver";

describe("text protocol routing", () => {
    it("uses native Messages through the system proxy only for explicit Anthropic bindings", () => {
        const input = { model: "claude-fable-5", apiFormat: "openai" as const, throughSystemProxy: true };
        expect(resolveTextProtocol({ ...input, advancedConfig: { ...emptyAdvancedConfig(), protocol: "anthropic" } })).toMatchObject({ kind: "claude", path: "/v1/messages", providerKind: "claude" });
        expect(resolveTextProtocol({ ...input, advancedConfig: { ...emptyAdvancedConfig(), protocol: "openai" } })).toMatchObject({ kind: "chat", path: "/chat/completions" });
        expect(resolveTextProtocol({ ...input, model: "gpt-6-sol", advancedConfig: { ...emptyAdvancedConfig(), protocol: "openai" } })).toMatchObject({ kind: "chat", path: "/chat/completions" });
        expect(resolveTextProtocol({ ...input, advancedConfig: { ...emptyAdvancedConfig(), protocol: "globalaiopc", globalAiOpcPreset: "text-claude-native" } })).toMatchObject({
            kind: "chat",
            path: "/chat/completions",
            providerKind: "claude",
            providerPath: "/messages",
        });
    });
});
