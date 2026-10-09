export type GcpAgentPlatformResource = {
    projectId: string;
    location: string;
};

export function isValidGcpProjectId(value: string) {
    return /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value.trim());
}

export function isValidGcpLocation(value: string) {
    return /^(?:global|us|eu|[a-z][a-z0-9]*(?:-[a-z0-9]+)+)$/.test(value.trim());
}

export function gcpAgentPlatformBaseUrl(location: string) {
    const normalized = location.trim().toLowerCase();
    if (!isValidGcpLocation(normalized)) throw new Error("GCP Location 无效");
    return normalized === "global" ? "https://aiplatform.googleapis.com" : `https://${normalized}-aiplatform.googleapis.com`;
}

export function gcpAgentPlatformTargetUrl(resource: GcpAgentPlatformResource, path: string[], search: string) {
    const projectId = resource.projectId.trim();
    const location = resource.location.trim().toLowerCase();
    if (!isValidGcpProjectId(projectId)) throw new Error("GCP Project ID 无效");
    if (!isValidGcpLocation(location)) throw new Error("GCP Location 无效");

    const logicalPath = path[0]?.toLowerCase() === "v1" || path[0]?.toLowerCase() === "v1beta" ? path.slice(1) : path;
    if (logicalPath.length !== 2 || logicalPath[0]?.toLowerCase() !== "models") throw new Error("GCP Agent Platform 模型路径无效");
    const modelAction = safeDecodeURIComponent(logicalPath[1] || "").match(/^(.+):(generateContent|streamGenerateContent)$/);
    if (!modelAction?.[1]) throw new Error("GCP Agent Platform 模型路径无效");
    const model = modelAction[1].replace(/^models\//i, "").trim();
    if (!model || /[/?#]/.test(model)) throw new Error("GCP Agent Platform 模型路径无效");

    return `${gcpAgentPlatformBaseUrl(location)}/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:${modelAction[2]}${search}`;
}

function safeDecodeURIComponent(value: string) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}
