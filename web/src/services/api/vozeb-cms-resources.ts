import type { VozebCmsAsset, VozebCmsResourcePage, VozebCmsTask, VozebCmsTaskStatus, VozebCmsTaskType } from "@/lib/vozeb-cms/unified-resource-contract";
import type { VozebCmsLayoutDefinition } from "@/lib/vozeb-cms/layout-contract";

type Response<T> = { code: number; data: T; msg: string };

export function listVozebCmsTaskPage(input: { projectId?: string; projectType?: string; type?: VozebCmsTaskType; status?: VozebCmsTaskStatus; cursor?: string; limit?: number } = {}) {
    const query = new URLSearchParams(
        Object.entries(input)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => [key, String(value)]),
    );
    return request<{ tasks: VozebCmsTask[]; total: number; limit: number; nextCursor?: string }>(`/api/vozeb-cms/tasks${query.size ? `?${query}` : ""}`).then((data): VozebCmsResourcePage<VozebCmsTask> => ({
        items: data.tasks,
        total: data.total,
        limit: data.limit,
        ...(data.nextCursor ? { nextCursor: data.nextCursor } : {}),
    }));
}

export function listVozebCmsTasks(input: Parameters<typeof listVozebCmsTaskPage>[0] = {}) {
    return listVozebCmsTaskPage(input).then((page) => page.items);
}

export function getVozebCmsTask(id: string) {
    return request<{ task: VozebCmsTask }>(`/api/vozeb-cms/tasks/${encodeURIComponent(id)}`).then((data) => data.task);
}

export function controlVozebCmsTask(id: string, action: "cancel" | "recover" | "retry") {
    return request<{ task: VozebCmsTask }>(`/api/vozeb-cms/tasks/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ action }) }).then((data) => data.task);
}

export function subscribeVozebCmsTask(id: string, onTask: (task: VozebCmsTask) => void) {
    const source = new EventSource(`/api/vozeb-cms/tasks/${encodeURIComponent(id)}/events`);
    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        source.close();
    };
    const handle = (event: MessageEvent<string>) => {
        if (closed) return;
        try {
            const payload = JSON.parse(event.data) as VozebCmsTask | { task?: VozebCmsTask; data?: VozebCmsTask };
            const task = "status" in payload ? payload : payload.task || payload.data;
            if (task && "status" in task) {
                onTask(task);
                if (task.status === "success" || task.status === "error" || task.status === "cancelled") close();
            }
        } catch {
            // The next authoritative snapshot remains usable after malformed input.
        }
    };
    source.addEventListener("task.snapshot", handle);
    source.addEventListener("task.deleted", close);
    source.onerror = () => undefined;
    return close;
}

export function listVozebCmsAssets(input: { projectId?: string; projectType?: string; limit?: number } = {}) {
    const query = new URLSearchParams(
        Object.entries(input)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => [key, String(value)]),
    );
    return request<{ assets: VozebCmsAsset[] }>(`/api/vozeb-cms/assets${query.size ? `?${query}` : ""}`).then((data) => data.assets);
}

export function listVozebCmsLayouts(input: { projectId?: string; projectType?: string; sitePath?: string; limit?: number } = {}) {
    const query = new URLSearchParams();
    if (input.projectId) query.set("projectId", input.projectId);
    if (input.projectType) query.set("projectType", input.projectType);
    if (input.sitePath) query.set("sitePath", input.sitePath);
    if (input.limit) query.set("limit", String(input.limit));
    return request<{ layouts: VozebCmsLayoutDefinition[] }>(`/api/vozeb-cms/layouts${query.toString() ? `?${query}` : ""}`).then((data) => data.layouts);
}

export function createVozebCmsLayout(input: Partial<VozebCmsLayoutDefinition> & { projectRef?: VozebCmsLayoutDefinition["projectRef"] }) {
    return request<{ layout: VozebCmsLayoutDefinition }>("/api/vozeb-cms/layouts", { method: "POST", body: JSON.stringify(input) }).then((data) => data.layout);
}

export function buildVozebCmsLayout(input: { requestId: string; brief: string; name?: string; moduleId?: string; projectRef?: VozebCmsLayoutDefinition["projectRef"] }) {
    return request<{ layout: VozebCmsLayoutDefinition }>("/api/vozeb-cms/layouts/ai-build", { method: "POST", body: JSON.stringify(input) }).then((data) => data.layout);
}

export function saveVozebCmsLayoutDraft(id: string, input: Partial<VozebCmsLayoutDefinition> & { baseRevision: number; mutationId: string; projectRef?: VozebCmsLayoutDefinition["projectRef"] }) {
    return request<{ layout: VozebCmsLayoutDefinition }>(`/api/vozeb-cms/layouts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) }).then((data) => data.layout);
}

export function publishVozebCmsLayout(id: string, baseRevision: number) {
    return request<{ layout: VozebCmsLayoutDefinition }>(`/api/vozeb-cms/layouts/${encodeURIComponent(id)}/publish`, { method: "POST", body: JSON.stringify({ baseRevision }) }).then((data) => data.layout);
}

export function rollbackVozebCmsLayout(id: string, targetRevision: number, baseRevision: number) {
    return request<{ layout: VozebCmsLayoutDefinition }>(`/api/vozeb-cms/layouts/${encodeURIComponent(id)}/rollback`, { method: "POST", body: JSON.stringify({ targetRevision, baseRevision }) }).then((data) => data.layout);
}

async function request<T>(url: string, init: RequestInit = {}) {
    const response = await fetch(url, { ...init, cache: "no-store", headers: { "Content-Type": "application/json", ...(init.headers || {}) } });
    const payload = (await response.json().catch(() => null)) as Response<T> | null;
    if (!response.ok || !payload || !payload.data) throw new Error(payload?.msg || "VOZEBCMS 资源请求失败");
    return payload.data;
}
