import { createHash } from "node:crypto";
import type { CreativeGenerationPreferences, CreativeSurface } from "@/lib/creative-runtime-contract";

/** Canonical planner input contract. The old prompt name is kept as a source alias only. */
export const AGENT_REQUEST_SCHEMA = "vozeb.agent.request.v1" as const;
/** @deprecated Use AGENT_REQUEST_SCHEMA. */
export const AGENT_PROMPT_SCHEMA = AGENT_REQUEST_SCHEMA;

export type AgentRequestV1 = {
    schema: typeof AGENT_REQUEST_SCHEMA;
    request: {
        runId: string;
        conversationId: string;
        surface: CreativeSurface;
        projectId?: string;
        userText: string;
    };
    references: {
        assetIds: string[];
        selectedNodeIds: string[];
        selectedSkillIds: string[];
        requestedModelIds: string[];
    };
    preferences?: CreativeGenerationPreferences;
    [key: string]: unknown;
};

/** @deprecated Use AgentRequestV1. */
export type AgentPromptJson = AgentRequestV1;

type AgentPromptSource = {
    id: string;
    conversationId: string;
    surface: CreativeSurface;
    projectId?: string;
    prompt: string;
    referencedAssetIds?: string[];
    selectedSkillIds?: string[];
    requestedModelIds?: string[];
    generationPreferences?: CreativeGenerationPreferences;
};

export function buildAgentRequest(run: AgentPromptSource, plannerInput: Record<string, unknown>): AgentRequestV1 {
    const selectedNodeIds = readStringArray(record(plannerInput.currentTurnSelection).selectedNodeIds);
    const assetIds = readIds(plannerInput.referencedAssets);
    return {
        ...plannerInput,
        schema: AGENT_REQUEST_SCHEMA,
        request: {
            runId: run.id,
            conversationId: run.conversationId,
            surface: run.surface,
            ...(run.projectId ? { projectId: run.projectId } : {}),
            userText: run.prompt,
        },
        references: {
            assetIds: uniqueStrings(run.referencedAssetIds?.length ? run.referencedAssetIds : assetIds),
            selectedNodeIds,
            selectedSkillIds: uniqueStrings(run.selectedSkillIds || []),
            requestedModelIds: uniqueStrings(run.requestedModelIds || []),
        },
        preferences: run.generationPreferences,
    };
}

export function serializeAgentRequest(value: AgentRequestV1) {
    return JSON.stringify(value);
}

export function agentRequestDigest(value: AgentRequestV1) {
    return createHash("sha256").update(serializeAgentRequest(value), "utf8").digest("hex");
}

/** @deprecated Use buildAgentRequest. */
export const buildAgentPromptJson = buildAgentRequest;
/** @deprecated Use serializeAgentRequest. */
export const serializeAgentPromptJson = serializeAgentRequest;
/** @deprecated Use agentRequestDigest. */
export const promptJsonDigest = agentRequestDigest;

function uniqueStrings(values: unknown[]) {
    return Array.from(new Set(values.flatMap((value) => (typeof value === "string" && value.trim() ? [value.trim()] : []))));
}

function readStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return uniqueStrings(value.map((item) => (item && typeof item === "object" ? (item as { id?: unknown }).id : item)));
}

function readIds(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return uniqueStrings(value.map((item) => (item && typeof item === "object" ? (item as { id?: unknown }).id : undefined)));
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
