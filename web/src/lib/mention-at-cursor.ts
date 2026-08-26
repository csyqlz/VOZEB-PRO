export type MentionAtCursor = {
    start: number;
    end: number;
    query: string;
};

export function mentionAtCursor(value: string, cursor: number): MentionAtCursor | undefined {
    const end = Math.max(0, Math.min(value.length, cursor));
    const match = value.slice(0, end).match(/@([^\s@]*)$/u);
    if (!match) return undefined;
    return { start: end - match[0].length, end, query: match[1] || "" };
}
