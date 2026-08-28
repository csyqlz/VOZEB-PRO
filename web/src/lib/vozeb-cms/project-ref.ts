export const VOZEB_CMS_PROJECT_TYPES = ["canvas", "drama", "conversation"] as const;
export type VozebCmsProjectType = (typeof VOZEB_CMS_PROJECT_TYPES)[number];

export type VozebCmsProjectRef = {
    id: string;
    type: VozebCmsProjectType;
    ownerId: string;
};

export function normalizeVozebCmsProjectRef(value: unknown, ownerId: string): VozebCmsProjectRef | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const input = value as Record<string, unknown>;
    const id = typeof input.id === "string" ? input.id.trim().slice(0, 160) : "";
    const type = VOZEB_CMS_PROJECT_TYPES.find((item) => item === input.type);
    if (!id || !type || !ownerId.trim()) return undefined;
    return { id, type, ownerId: ownerId.trim() };
}
