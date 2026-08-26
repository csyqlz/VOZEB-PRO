import { typedReferenceAliases } from "@/lib/creative-asset-references";
import { mentionAtCursor } from "@/lib/mention-at-cursor";

import { CanvasNodeType, isCanvasImageNodeType, type CanvasNodeData } from "../types";

export type CanvasAgentMentionAsset = {
    id: string;
    title: string;
    type: "image" | "video";
    url: string;
};

export type CanvasAgentMention = {
    start: number;
    end: number;
    query: string;
};

export type CanvasAgentMentionSegment = {
    text: string;
    referenced: boolean;
    nodeId?: string;
};

export type CanvasAgentMentionDeletion = {
    nodeId: string;
    cursor: number;
};

export function collectCanvasAgentMentionAssets(nodes: CanvasNodeData[]): CanvasAgentMentionAsset[] {
    return nodes.flatMap((node) => {
        const type = isCanvasImageNodeType(node.type) ? "image" : node.type === CanvasNodeType.Video ? "video" : undefined;
        const url = [node.metadata?.content, node.metadata?.serverUrl, node.metadata?.remoteUrl].find((value): value is string => typeof value === "string" && Boolean(value.trim()));
        if (!type || !url) return [];
        return [{ id: node.id, title: node.title || (type === "image" ? "画布图片" : "画布视频"), type, url }];
    });
}

export function canvasAgentReferenceAliases(assets: readonly CanvasAgentMentionAsset[], nodeIds: readonly string[]) {
    return typedReferenceAliases(assets, nodeIds);
}

export function canvasAgentMentionAtCursor(value: string, cursor: number): CanvasAgentMention | undefined {
    return mentionAtCursor(value, cursor);
}

export function replaceCanvasAgentMention(value: string, cursor: number, alias: string) {
    const range = canvasAgentMentionAtCursor(value, cursor) || { start: cursor, end: cursor, query: "" };
    const before = value.slice(0, range.start);
    const after = value.slice(range.end);
    const token = `@${alias}`;
    const separator = !after || !/^[\s，。！？、；：,.!?;:）)\]}]/u.test(after) ? " " : "";
    return {
        value: `${before}${token}${separator}${after}`,
        cursor: before.length + token.length + separator.length,
    };
}

export function remapCanvasAgentReferences(value: string, assets: readonly CanvasAgentMentionAsset[], currentNodeIds: readonly string[], nextNodeIds: readonly string[]) {
    const currentAliases = canvasAgentReferenceAliases(assets, currentNodeIds);
    const nextAliases = canvasAgentReferenceAliases(assets, nextNodeIds);
    const nodeIdsByAlias = new Map(Array.from(currentAliases, ([nodeId, alias]) => [alias, nodeId]));
    return value
        .replace(/@(图片|视频)\d+/gu, (token) => {
            const nodeId = nodeIdsByAlias.get(token.slice(1));
            if (!nodeId) return token;
            const nextAlias = nextAliases.get(nodeId);
            return nextAlias ? `@${nextAlias}` : "";
        })
        .replace(/[ \t]{2,}/gu, " ")
        .replace(/^[ \t]+|[ \t]+$/gu, "");
}

export function canvasAgentMentionCandidates(assets: readonly CanvasAgentMentionAsset[], query: string) {
    const keyword = query.trim().toLocaleLowerCase();
    if (!keyword) return [...assets];
    return assets.filter((asset) => [asset.title, asset.id, asset.type === "image" ? "图片" : "视频"].some((value) => value.toLocaleLowerCase().includes(keyword)));
}

export function canvasAgentMentionSegments(value: string, aliases: ReadonlyMap<string, string>): CanvasAgentMentionSegment[] {
    const nodeIdsByToken = new Map(Array.from(aliases, ([nodeId, alias]) => [`@${alias}`, nodeId]));
    if (!value || !nodeIdsByToken.size) return value ? [{ text: value, referenced: false }] : [];

    const segments: CanvasAgentMentionSegment[] = [];
    let offset = 0;
    for (const match of value.matchAll(/@(图片|视频)\d+/gu)) {
        const start = match.index;
        if (start > offset) segments.push({ text: value.slice(offset, start), referenced: false });
        const nodeId = nodeIdsByToken.get(match[0]);
        segments.push({ text: match[0], referenced: Boolean(nodeId), ...(nodeId ? { nodeId } : {}) });
        offset = start + match[0].length;
    }
    if (offset < value.length) segments.push({ text: value.slice(offset), referenced: false });
    return segments.length ? segments : [{ text: value, referenced: false }];
}

export function canvasAgentMentionDeletionAtKey(value: string, selectionStart: number, selectionEnd: number, key: "Backspace" | "Delete", aliases: ReadonlyMap<string, string>): CanvasAgentMentionDeletion | undefined {
    const nodeIdsByToken = new Map(Array.from(aliases, ([nodeId, alias]) => [`@${alias}`, nodeId]));
    for (const match of value.matchAll(/@(图片|视频)\d+/gu)) {
        const nodeId = nodeIdsByToken.get(match[0]);
        if (!nodeId) continue;
        const start = match.index;
        const end = start + match[0].length;
        const intersectsSelection = selectionStart !== selectionEnd && selectionStart < end && selectionEnd > start;
        const removesBackward = key === "Backspace" && ((selectionStart > start && selectionStart <= end) || (selectionStart === end + 1 && /\s/u.test(value[end] || "")));
        const removesForward = key === "Delete" && selectionStart >= start && selectionStart < end;
        if (intersectsSelection || removesBackward || removesForward) return { nodeId, cursor: start };
    }
    return undefined;
}
