export const VOZEB_CMS_MODULE_IDS = ["create", "canvas", "drama", "image", "video"] as const;

export type VozebCmsModuleId = (typeof VOZEB_CMS_MODULE_IDS)[number];

export type VozebCmsModuleManifest = {
    id: VozebCmsModuleId;
    name: string;
    description: string;
    version: string;
    routes: string[];
    permissions: string[];
    capabilities: string[];
    enabled: boolean;
    dependencies: VozebCmsModuleId[];
};

export type VozebCmsCapabilityDefinition = {
    id: string;
    name: string;
    description: string;
    moduleId: VozebCmsModuleId | "platform";
    actionId: string;
    taskType?: "agent" | "text" | "image" | "video" | "audio" | "drama" | "workflow";
    billable: boolean;
    feature?: string;
};

export type VozebCmsModuleState = {
    moduleId: VozebCmsModuleId;
    enabled: boolean;
    revision: number;
    lastMutationId?: string;
    updatedAt?: string;
    updatedBy?: string;
};

export type VozebCmsModuleView = VozebCmsModuleManifest & Omit<VozebCmsModuleState, "moduleId" | "enabled">;

export type VozebCmsModuleStateMutation = {
    moduleId: VozebCmsModuleId;
    enabled: boolean;
    baseRevision: number;
    mutationId: string;
    updatedBy: string;
};

const moduleIds = new Set<string>(VOZEB_CMS_MODULE_IDS);

export function isVozebCmsModuleId(value: unknown): value is VozebCmsModuleId {
    return typeof value === "string" && moduleIds.has(value);
}

export function normalizeVozebCmsModuleState(value: unknown): VozebCmsModuleState | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const input = value as Partial<VozebCmsModuleState>;
    if (!isVozebCmsModuleId(input.moduleId) || typeof input.enabled !== "boolean") return undefined;
    const revision = Number(input.revision);
    return {
        moduleId: input.moduleId,
        enabled: input.enabled,
        revision: Number.isInteger(revision) && revision >= 0 ? revision : 0,
        lastMutationId: normalizedText(input.lastMutationId, 120),
        updatedAt: normalizedIso(input.updatedAt),
        updatedBy: normalizedText(input.updatedBy, 120),
    };
}

function normalizedText(value: unknown, maxLength: number) {
    const text = typeof value === "string" ? value.trim().slice(0, maxLength) : "";
    return text || undefined;
}

function normalizedIso(value: unknown) {
    if (typeof value !== "string") return undefined;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
