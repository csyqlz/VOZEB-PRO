export type DramaSourceEpisodeDraft = {
    title: string;
    script: string;
    sourceRange: string;
};

const HEADING_PATTERN =
    /^(?:第\s*[0-9０-９〇零一二三四五六七八九十百千万两]+\s*[章节集回幕卷](?:\s+.*|[-:：._、].*)?|序章(?:\s+.*|[-:：._、].*)?|楔子(?:\s+.*|[-:：._、].*)?|前言(?:\s+.*|[-:：._、].*)?|尾声(?:\s+.*|[-:：._、].*)?|番外(?:\s+.*|[-:：._、].*)?|(?:chapter|episode)\s*[0-9０-９]+(?:\s+.*|[-:：._、].*)?)$/iu;

export function splitDramaSource(value: string, targetCharacters = 4000): DramaSourceEpisodeDraft[] {
    const source = value.replace(/\r\n?/g, "\n").trim();
    if (!source) return [];
    const requestedTarget = Math.floor(targetCharacters);
    const target = Number.isSafeInteger(requestedTarget) && requestedTarget > 0 ? requestedTarget : 4000;
    const sections = headingSections(source);
    const hasChapterSections = sections.some((section) => section.title);
    const drafts = sections.flatMap((section) =>
        (hasChapterSections ? [section.text] : chunkText(section.text, target)).map((script, partIndex) => ({
            sourceTitle: section.title,
            sourceRange: section.title ? (partIndex ? `${section.title}（续 ${partIndex + 1}）` : section.title) : `全文分段 ${partIndex + 1}`,
            script,
        })),
    );
    return drafts.map((draft, index) => ({
        title: `第 ${index + 1} 集${draft.sourceTitle ? ` · ${shortTitle(draft.sourceTitle)}` : ""}`,
        script: draft.script,
        sourceRange: draft.sourceRange,
    }));
}

function headingSections(source: string) {
    const sections: Array<{ title: string; text: string }> = [];
    let title = "";
    let lines: string[] = [];
    for (const line of source.split("\n")) {
        const trimmed = line.trim();
        if (HEADING_PATTERN.test(trimmed) && lines.some((item) => item.trim())) {
            sections.push({ title, text: lines.join("\n").trim() });
            title = trimmed;
            lines = [trimmed];
            continue;
        }
        if (HEADING_PATTERN.test(trimmed) && !lines.length) title = trimmed;
        lines.push(line);
    }
    if (lines.some((item) => item.trim())) sections.push({ title, text: lines.join("\n").trim() });
    return sections.length ? sections : [{ title: "", text: source }];
}

function chunkText(value: string, target: number) {
    if (value.length <= target) return [value];
    const chunks: string[] = [];
    let current = "";
    for (const paragraph of value
        .split(/\n{2,}/)
        .map((item) => item.trim())
        .filter(Boolean)) {
        if (paragraph.length > target) {
            if (current) chunks.push(current);
            current = "";
            for (let start = 0; start < paragraph.length; start += target) chunks.push(paragraph.slice(start, start + target));
            continue;
        }
        if (current && current.length + paragraph.length + 2 > target) {
            chunks.push(current);
            current = paragraph;
        } else {
            current = current ? `${current}\n\n${paragraph}` : paragraph;
        }
    }
    if (current) chunks.push(current);
    return chunks.filter(Boolean);
}

function shortTitle(value: string) {
    return value.replace(/\s+/g, " ").trim().slice(0, 40);
}
