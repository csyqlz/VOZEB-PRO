import type { DramaEpisode, DramaProject } from "@/lib/drama-project-contract";
import { mentionAtCursor } from "@/lib/mention-at-cursor";

export type DramaAgentMentionKind = "character" | "scene" | "prop" | "clue" | "source" | "shot";
export type DramaAgentMentionItem = {
    id: string;
    kind: DramaAgentMentionKind;
    title: string;
    description: string;
    alias: string;
    preview?: { type: "image" | "video"; url: string };
};

const KIND_LABELS: Record<DramaAgentMentionKind, string> = {
    character: "角色",
    scene: "场景",
    prop: "道具",
    clue: "线索",
    source: "来源",
    shot: "镜头",
};

export function collectDramaAgentMentionItems(project: DramaProject, episode: DramaEpisode): DramaAgentMentionItem[] {
    const items: Array<Omit<DramaAgentMentionItem, "alias">> = [
        ...project.characters.map((item) => ({ id: item.id, kind: "character" as const, title: item.name, description: item.description })),
        ...project.scenes.map((item) => ({ id: item.id, kind: "scene" as const, title: item.name, description: item.description })),
        ...project.props.map((item) => ({ id: item.id, kind: "prop" as const, title: item.name, description: item.description })),
        ...project.clues.map((item) => ({ id: item.id, kind: "clue" as const, title: item.name, description: item.description || item.payoff })),
        ...(project.sourceAssets || []).map((item) => {
            const previewUrl = item.serverUrl || item.remoteUrl;
            const preview = previewUrl && (item.type === "image" || item.type === "video") ? { type: item.type, url: previewUrl } : undefined;
            return { id: item.id, kind: "source" as const, title: item.title, description: item.textContent || item.type, ...(preview ? { preview } : {}) };
        }),
        ...episode.shots.map((item) => ({ id: item.id, kind: "shot" as const, title: item.title || `镜头 ${String(item.order).padStart(2, "0")}`, description: item.description || item.sourceText })),
    ];
    const counts = new Map<DramaAgentMentionKind, number>();
    const usedAliases = new Set<string>();
    return items.map((item) => {
        const ordinal = (counts.get(item.kind) || 0) + 1;
        counts.set(item.kind, ordinal);
        const preferredAlias = item.kind === "character" ? item.title.trim().replace(/\s+/gu, "") : `${KIND_LABELS[item.kind]}${ordinal}`;
        const baseAlias = preferredAlias || `${KIND_LABELS[item.kind]}${ordinal}`;
        let alias = baseAlias;
        let duplicate = 2;
        while (usedAliases.has(alias)) alias = `${baseAlias}${duplicate++}`;
        usedAliases.add(alias);
        return { ...item, alias };
    });
}

export function dramaAgentMentionAtCursor(value: string, cursor: number) {
    return mentionAtCursor(value, cursor);
}

export function replaceDramaAgentMention(value: string, cursor: number, alias: string) {
    const range = dramaAgentMentionAtCursor(value, cursor) || { start: cursor, end: cursor };
    const before = value.slice(0, range.start);
    const after = value.slice(range.end);
    const token = `@${alias}`;
    const separator = !after || !/^[\s，。！？、；：,.!?;:）)\]}]/u.test(after) ? " " : "";
    return { value: `${before}${token}${separator}${after}`, cursor: before.length + token.length + separator.length };
}

export function dramaAgentMentionCandidates(items: DramaAgentMentionItem[], query: string) {
    const keyword = query.trim().toLocaleLowerCase();
    if (!keyword) return items;
    return items.filter((item) => [item.alias, item.title, item.description, KIND_LABELS[item.kind]].some((value) => value.toLocaleLowerCase().includes(keyword)));
}

export function referencedDramaAgentItems(value: string, items: DramaAgentMentionItem[]) {
    return items.filter((item) => new RegExp(`@${escapeRegExp(item.alias)}(?=$|[\\s，。！？、；：,.!?;:）)\\]}])`, "u").test(value));
}

export function dramaAgentMentionKindLabel(kind: DramaAgentMentionKind) {
    return KIND_LABELS[kind];
}

function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
