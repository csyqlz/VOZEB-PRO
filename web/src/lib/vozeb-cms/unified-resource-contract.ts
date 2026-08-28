import type { VozebCmsProjectRef } from "./project-ref";

export const VOZEB_CMS_TASK_TYPES = ["text", "image", "video", "audio", "agent", "render", "workflow"] as const;
export type VozebCmsTaskType = (typeof VOZEB_CMS_TASK_TYPES)[number];

export const VOZEB_CMS_TASK_STATUSES = ["pending", "running", "waiting", "success", "error", "paused", "cancelled"] as const;
export type VozebCmsTaskStatus = (typeof VOZEB_CMS_TASK_STATUSES)[number];

export type VozebCmsResourcePage<T> = {
    items: T[];
    total: number;
    limit: number;
    nextCursor?: string;
};

export type VozebCmsTask = {
    id: string;
    type: VozebCmsTaskType;
    status: VozebCmsTaskStatus;
    source: "generation" | "workflow";
    input: unknown;
    output?: unknown;
    owner: string;
    project_id?: string;
    project_ref?: Pick<VozebCmsProjectRef, "id" | "type">;
    cost: number;
    metadata: Record<string, unknown>;
    created_at: string;
    updated_at?: string;
    execution_phase?: string;
    can_cancel?: boolean;
    can_retry?: boolean;
    can_recover?: boolean;
};

export type VozebCmsAsset = {
    id: string;
    owner: string;
    type: string;
    url?: string;
    source: string;
    project_id?: string;
    project_ref?: Pick<VozebCmsProjectRef, "id" | "type">;
    task_id?: string;
    run_id?: string;
    version: number;
    metadata: Record<string, unknown>;
    created_at: string;
};

export function isVozebCmsTaskType(value: unknown): value is VozebCmsTaskType {
    return typeof value === "string" && VOZEB_CMS_TASK_TYPES.includes(value as VozebCmsTaskType);
}

export function isVozebCmsTaskStatus(value: unknown): value is VozebCmsTaskStatus {
    return typeof value === "string" && VOZEB_CMS_TASK_STATUSES.includes(value as VozebCmsTaskStatus);
}
