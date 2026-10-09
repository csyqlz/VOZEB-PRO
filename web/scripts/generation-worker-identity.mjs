const WORKER_ID_MAX_LENGTH = 150;
const WORKER_ID_FALLBACK = "generation-worker";

export function buildGenerationWorkerId({ configuredId = "", host = "", pid = "", uuid = "" } = {}) {
    const preferred = String(configuredId || "").trim();
    const generated = `generation-worker:${host}:${pid}:${uuid}`;
    return sanitizeGenerationWorkerId(preferred || generated);
}

export function sanitizeGenerationWorkerId(value, maxLength = WORKER_ID_MAX_LENGTH) {
    const normalized = String(value || "")
        .normalize("NFKD")
        .replace(/[^\x20-\x7E]+/g, "-")
        .replace(/[^A-Za-z0-9._:-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/([:._])-+/g, "$1")
        .replace(/-+([:._])/g, "$1")
        .replace(/:{2,}/g, ":")
        .replace(/\.{2,}/g, ".")
        .replace(/_{2,}/g, "_")
        .replace(/^[-:.]+|[-:.]+$/g, "");
    const bounded = normalized.slice(0, Math.max(1, Math.floor(maxLength))).replace(/[-:.]+$/g, "");
    return bounded || WORKER_ID_FALLBACK;
}
