import type { LogicalModelCapability } from "@/lib/auth/store";

export type ModelPriorityRow = {
    modelId: string;
    modelName: string;
    manufacturer: string;
    series: string;
    capability: LogicalModelCapability;
    modelEnabled: boolean;
    bindingId: string;
    channelId: string;
    channelName: string;
    upstreamModel: string;
    enabled: boolean;
    channelEnabled: boolean;
    weight: number;
    oldPriority: number;
    newPriority: number;
    before: string[];
    after: string[];
    version: string;
    excluded: boolean;
};

async function request<T>(method: "POST" | "PATCH", body: unknown): Promise<T> {
    const response = await fetch("/api/admin/model-priorities", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const payload = (await response.json()) as { code: number; data: T; msg: string };
    if (!response.ok || payload.code !== 0) throw new Error(payload.msg || "请求失败");
    return payload.data;
}

export function previewModelPriorityBatch(scope: { channelIds: string[]; manufacturer?: string; series?: string; capability?: LogicalModelCapability; priority: number; excluded?: string[] }) {
    return request<{ rows: ModelPriorityRow[] }>("POST", scope);
}

export function commitModelPriorityBatch(input: { priority: number; selected: Array<Pick<ModelPriorityRow, "modelId" | "bindingId" | "version">>; excluded: string[] }) {
    return request<{ changes: Array<{ modelId: string; bindingId: string; channelId: string; oldPriority: number; newPriority: number }>; scope: { channelIds: string[]; modelIds: string[]; priority: number }; excluded: string[] }>("PATCH", input);
}
