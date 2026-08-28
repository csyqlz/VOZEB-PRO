export type VozebCmsResourceCursor = {
    time: number;
    source: "generation" | "workflow";
    id: string;
};

export function encodeVozebCmsResourceCursor(cursor: VozebCmsResourceCursor) {
    return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeVozebCmsResourceCursor(value: unknown): VozebCmsResourceCursor | undefined {
    if (typeof value !== "string" || !value.trim()) return undefined;
    try {
        const parsed = JSON.parse(Buffer.from(value.trim(), "base64url").toString("utf8")) as Partial<VozebCmsResourceCursor>;
        const time = Number(parsed.time);
        const source = parsed.source === "workflow" ? "workflow" : parsed.source === "generation" ? "generation" : undefined;
        const id = typeof parsed.id === "string" ? parsed.id.trim().slice(0, 500) : "";
        return Number.isFinite(time) && time > 0 && source && id ? { time: Math.floor(time), source, id } : undefined;
    } catch {
        return undefined;
    }
}

export function comesBeforeVozebCmsResourceCursor(item: VozebCmsResourceCursor, cursor?: VozebCmsResourceCursor) {
    return !cursor || item.time < cursor.time || (item.time === cursor.time && (item.source < cursor.source || (item.source === cursor.source && item.id < cursor.id)));
}

export function compareVozebCmsResourceCursor(left: VozebCmsResourceCursor, right: VozebCmsResourceCursor) {
    return right.time - left.time || right.source.localeCompare(left.source) || right.id.localeCompare(left.id);
}
