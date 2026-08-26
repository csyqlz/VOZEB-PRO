import type { CreativeAsset } from "@/lib/creative-runtime-contract";
import { creativeAssetReferenceAliases } from "@/lib/creative-asset-references";
import { mentionAtCursor } from "@/lib/mention-at-cursor";

export type CreativeAssetMention = {
    start: number;
    end: number;
    query: string;
};

export type CreativeAssetMentionSegment = {
    text: string;
    referenced: boolean;
    assetId?: string;
};

export type CreativeAssetMentionDeletion = {
    assetId: string;
    cursor: number;
};

export function creativeAssetMentionAtCursor(value: string, cursor: number): CreativeAssetMention | undefined {
    return mentionAtCursor(value, cursor);
}

export function replaceCreativeAssetMention(value: string, cursor: number, alias: string) {
    const range = creativeAssetMentionAtCursor(value, cursor) || { start: cursor, end: cursor, query: "" };
    const before = value.slice(0, range.start);
    const after = value.slice(range.end);
    const token = `@${alias}`;
    const separator = !after || !/^[\s，。！？、；：,.!?;:）)\]}]/u.test(after) ? " " : "";
    return {
        value: `${before}${token}${separator}${after}`,
        cursor: before.length + token.length + separator.length,
    };
}

export function remapCreativeAssetReferences(value: string, assets: readonly CreativeAsset[], currentAssetIds: readonly string[], nextAssetIds: readonly string[]) {
    const currentAliases = creativeAssetReferenceAliases(assets, currentAssetIds);
    const nextAliases = creativeAssetReferenceAliases(assets, nextAssetIds);
    const assetIdsByAlias = new Map(Array.from(currentAliases, ([assetId, alias]) => [alias, assetId]));
    return value
        .replace(/@(图片|视频|音频|文本)\d+/gu, (token) => {
            const assetId = assetIdsByAlias.get(token.slice(1));
            if (!assetId) return token;
            const nextAlias = nextAliases.get(assetId);
            return nextAlias ? `@${nextAlias}` : "";
        })
        .replace(/[ \t]{2,}/gu, " ")
        .replace(/^[ \t]+|[ \t]+$/gu, "");
}

export function publicCreativeAssetPrompt(value: string) {
    return value.replace(/@(图片|视频|音频|文本)(\d+)/gu, "$1$2");
}

export function creativeAssetMentionCandidates(assets: CreativeAsset[], query: string) {
    const keyword = query.trim().toLocaleLowerCase();
    return assets.filter((asset) => {
        if (asset.status !== "ready") return false;
        if (!keyword) return true;
        return [asset.title, asset.textContent].some((value) => value?.toLocaleLowerCase().includes(keyword));
    });
}

export function creativeAssetMentionSegments(value: string, aliases: ReadonlyMap<string, string>): CreativeAssetMentionSegment[] {
    const assetIdsByToken = new Map(Array.from(aliases, ([assetId, alias]) => [`@${alias}`, assetId]));
    if (!value || !assetIdsByToken.size) return value ? [{ text: value, referenced: false }] : [];

    const segments: CreativeAssetMentionSegment[] = [];
    let offset = 0;
    for (const match of value.matchAll(/@(图片|视频|音频|文本)\d+/gu)) {
        const start = match.index;
        if (start > offset) segments.push({ text: value.slice(offset, start), referenced: false });
        const assetId = assetIdsByToken.get(match[0]);
        segments.push({ text: match[0], referenced: Boolean(assetId), ...(assetId ? { assetId } : {}) });
        offset = start + match[0].length;
    }
    if (offset < value.length) segments.push({ text: value.slice(offset), referenced: false });
    return segments.length ? segments : [{ text: value, referenced: false }];
}

export function creativeAssetMentionDeletionAtKey(value: string, selectionStart: number, selectionEnd: number, key: "Backspace" | "Delete", aliases: ReadonlyMap<string, string>): CreativeAssetMentionDeletion | undefined {
    const assetIdsByToken = new Map(Array.from(aliases, ([assetId, alias]) => [`@${alias}`, assetId]));
    for (const match of value.matchAll(/@(图片|视频|音频|文本)\d+/gu)) {
        const assetId = assetIdsByToken.get(match[0]);
        if (!assetId) continue;
        const start = match.index;
        const end = start + match[0].length;
        const intersectsSelection = selectionStart !== selectionEnd && selectionStart < end && selectionEnd > start;
        const removesBackward = key === "Backspace" && ((selectionStart > start && selectionStart <= end) || (selectionStart === end + 1 && /\s/u.test(value[end] || "")));
        const removesForward = key === "Delete" && selectionStart >= start && selectionStart < end;
        if (intersectsSelection || removesBackward || removesForward) return { assetId, cursor: start };
    }
    return undefined;
}
