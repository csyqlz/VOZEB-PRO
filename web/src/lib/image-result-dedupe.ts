type ImageResultIdentity = {
    dataUrl?: string;
    remoteUrl?: string;
    serverUrl?: string;
    storageKey?: string;
};

export function dedupeImageResults<T extends ImageResultIdentity>(items: T[]) {
    const seen = new Set<string>();
    return items.filter((item) => {
        const identities = imageResultIdentities(item);
        if (!identities.length || identities.some((identity) => seen.has(identity))) return false;
        identities.forEach((identity) => seen.add(identity));
        return true;
    });
}

function imageResultIdentities(item: ImageResultIdentity) {
    const sourceIdentities = [item.storageKey, item.serverUrl, item.remoteUrl].flatMap(mediaAliases).filter(Boolean);
    return Array.from(new Set(sourceIdentities.length ? sourceIdentities : mediaAliases(item.dataUrl).filter(Boolean)));
}

function mediaAliases(value?: string) {
    const normalized = value?.trim();
    if (!normalized) return [];
    if (!normalized.startsWith("/") && !/^https?:\/\//i.test(normalized)) return [normalized];
    try {
        const parsed = new URL(normalized, "http://vozeb.local");
        const source = parsed.searchParams.get("url")?.trim();
        return source && /^https?:\/\//i.test(source) ? [normalized, source] : [normalized];
    } catch {
        return [normalized];
    }
}
