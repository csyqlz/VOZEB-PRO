export const CREATE_AGENT_PROMPT_MAX_LENGTH = 4000;

export const CREATE_AGENT_MODES = ["agent", "text", "image", "video", "audio"] as const;

export type CreateAgentMode = (typeof CREATE_AGENT_MODES)[number];
export type CreateAgentPromptSource = "gallery" | "home";

type CreateAgentPromptOptions = {
    source?: CreateAgentPromptSource;
    mode?: CreateAgentMode;
};

export type CreateAgentDraft = {
    source: CreateAgentPromptSource;
    prompt: string;
    mode?: CreateAgentMode;
};

export function createAgentPromptHref(value: string, options: CreateAgentPromptOptions = {}) {
    const prompt = value.trim().slice(0, CREATE_AGENT_PROMPT_MAX_LENGTH);
    if (!prompt && (!options.mode || options.mode === "agent")) return "/create";
    const params = new URLSearchParams({ source: options.source || "gallery" });
    if (prompt) params.set("prompt", prompt);
    if (options.mode) params.set("mode", options.mode);
    return `/create#${params}`;
}

export function createAgentPromptFromHash(value: string) {
    return createAgentDraftFromHash(value)?.prompt || "";
}

export function createAgentDraftFromHash(value: string): CreateAgentDraft | null {
    const params = new URLSearchParams(value.replace(/^#/, ""));
    const source = params.get("source");
    if (source !== "gallery" && source !== "home") return null;
    const mode = params.get("mode");
    return {
        source,
        prompt: (params.get("prompt") || "").trim().slice(0, CREATE_AGENT_PROMPT_MAX_LENGTH),
        ...(isCreateAgentMode(mode) ? { mode } : {}),
    };
}

function isCreateAgentMode(value: string | null): value is CreateAgentMode {
    return CREATE_AGENT_MODES.includes(value as CreateAgentMode);
}
