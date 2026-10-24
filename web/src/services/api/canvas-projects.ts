import type { CanvasProject, CanvasProjectMutation, CanvasProjectSaveAck, CanvasProjectSummaryPage, CreateCanvasProjectInput } from "@/lib/canvas-project-contract";

export type CanvasProjectBillingSummary = {
    actualPoints: number;
    pendingHeldPoints: number;
    charges: Array<{ type: "text" | "image" | "video" | "audio"; purpose: "generation" | "planning" | "review" | "analysis"; logicalModelId?: string; chargedPoints: number; refundedPoints: number; actualPoints: number }>;
    pending: Array<{ type: "text" | "image" | "video" | "audio"; logicalModelId: string; heldPoints: number; count: number }>;
};

export function getCanvasProjectBilling(projectId: string) {
    return request<{ summary: CanvasProjectBillingSummary }>(`/api/canvas/projects/${encodeURIComponent(projectId)}/billing`, { cache: "no-store" }).then((data) => data.summary);
}

export function listCanvasProjectSummaries(input: { page: number; pageSize: number }) {
    const query = new URLSearchParams({ page: String(input.page), pageSize: String(input.pageSize) });
    return request<CanvasProjectSummaryPage>(`/api/canvas/projects?${query}`, { cache: "no-store" });
}

export function getCanvasProject(id: string) {
    return request<{ project: CanvasProject }>(`/api/canvas/projects/${encodeURIComponent(id)}`, { cache: "no-store" }).then((data) => data.project);
}

export function createCanvasProject(input: CreateCanvasProjectInput) {
    return request<{ project: CanvasProject }>("/api/canvas/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }).then((data) => data.project);
}

export function saveCanvasProject(project: CanvasProject, expectedUpdatedAt: string) {
    return request<{ project: CanvasProject }>(`/api/canvas/projects/${encodeURIComponent(project.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project, expectedUpdatedAt }),
    }).then((data) => data.project);
}

export function saveCanvasProjectMutation(projectId: string, mutation: CanvasProjectMutation, options?: { keepalive?: boolean }) {
    return request<{ ack: CanvasProjectSaveAck }>(`/api/canvas/projects/${encodeURIComponent(projectId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mutation }),
        keepalive: options?.keepalive,
    }).then((data) => data.ack);
}

export function deleteCanvasProjects(ids: string[]) {
    return request<{ deleted: number }>("/api/canvas/projects", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
}

export function deleteCanvasAssistantConversations(projectId: string, conversationIds: string[]) {
    return request<{ deleted: number; chatSessions: CanvasProject["chatSessions"]; activeChatId: string | null }>(`/api/canvas/projects/${encodeURIComponent(projectId)}/assistant-conversations`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationIds }),
    });
}

async function request<T>(url: string, init?: RequestInit) {
    const response = await fetch(url, init);
    const payload = (await response.json().catch(() => ({}))) as { data?: T; msg?: string; error?: string };
    if (!response.ok || !payload.data) throw new CanvasProjectRequestError(payload.msg || payload.error || "画布项目请求失败", response.status);
    return payload.data;
}

export class CanvasProjectRequestError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}
