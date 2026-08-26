export function splitDramaScriptAtBoundary(script: string): [string, string] | null {
    const normalized = script.trim();
    if (!normalized) return null;

    const boundaries = collectBoundaries(normalized);
    const midpoint = normalized.length / 2;
    for (const boundary of boundaries.sort((left, right) => Math.abs(left - midpoint) - Math.abs(right - midpoint))) {
        const left = normalized.slice(0, boundary).trim();
        const right = normalized.slice(boundary).trim();
        if (left && right) return [left, right];
    }
    return null;
}

function collectBoundaries(value: string) {
    const boundaries: number[] = [];
    const quoteClosers = new Map<string, string>([
        ["“", "”"],
        ["「", "」"],
        ["『", "』"],
        ['"', '"'],
    ]);
    let closer = "";
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        if (closer) {
            if (character === closer) closer = "";
            continue;
        }
        const nextCloser = quoteClosers.get(character);
        if (nextCloser) {
            closer = nextCloser;
            continue;
        }
        if (character === "\n" || /[。！？!?；;]/u.test(character)) boundaries.push(index + 1);
    }
    return boundaries.filter((boundary) => boundary > 0 && boundary < value.length);
}
