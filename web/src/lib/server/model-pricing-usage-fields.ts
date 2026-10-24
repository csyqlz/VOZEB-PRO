/** Capture only numeric usage facts; never retain prompt, media, or arbitrary response text. */
export function inspectUsageFields(value: unknown, knownPaths: readonly string[]) {
    const fields: Record<string, string> = {};
    const known = new Set(knownPaths);
    const visit = (entry: unknown, path: string) => {
        if (Array.isArray(entry)) {
            entry.forEach((item, index) => {
                const modality = item && typeof item === "object" && !Array.isArray(item) && "modality" in item ? item.modality : undefined;
                const label = typeof modality === "string" && /^[A-Z_]+$/.test(modality) ? modality : String(index);
                visit(item, `${path}[${label}]`);
            });
            return;
        }
        if (entry && typeof entry === "object") {
            for (const [key, nested] of Object.entries(entry)) if (/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) visit(nested, path ? `${path}.${key}` : key);
            return;
        }
        if (!path || !((typeof entry === "number" && Number.isFinite(entry) && entry >= 0) || (typeof entry === "string" && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(entry)))) return;
        fields[path] = String(entry);
    };
    visit(value, "");
    return { fields, unmapped: Object.keys(fields).filter((path) => !known.has(path)) };
}
