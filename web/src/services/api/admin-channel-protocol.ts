import type { ChannelProtocolDraft } from "@/lib/channel-protocol-draft";

export type AdminChannelProtocolDraftResult = {
    drafts: ChannelProtocolDraft[];
    warnings: string[];
    sourcePages: number;
};

export async function createAdminChannelProtocolDraft(input: { documentationUrl?: string; documentationText?: string; examples?: string; useTextModel?: boolean }) {
    const response = await fetch("/api/admin/channel-protocol-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
    });
    const payload = (await response.json().catch(() => ({}))) as { draft?: ChannelProtocolDraft; drafts?: ChannelProtocolDraft[]; warnings?: string[]; sourcePages?: number; error?: string };
    if (!response.ok || !payload.draft) throw new Error(payload.error || "协议分析失败");
    return {
        drafts: payload.drafts?.length ? payload.drafts : [payload.draft],
        warnings: payload.warnings || [],
        sourcePages: payload.sourcePages || 0,
    } satisfies AdminChannelProtocolDraftResult;
}
