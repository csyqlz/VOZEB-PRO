import type { CreateDramaProjectInput, DramaCostSummary, DramaEpisode, DramaProject, DramaProjectSummary, DramaProjectVersion, DramaProjectVersionScope, DramaVisualReview } from "@/lib/drama-project-contract";

export type DramaProjectSummaryResponse = { projects: DramaProjectSummary[]; total: number; page: number; pageSize: number };

export function listDramaProjectSummaries(input: { page?: number; pageSize?: number } = {}) {
    const query = new URLSearchParams({ page: String(input.page || 1), pageSize: String(input.pageSize || 12) });
    return request<DramaProjectSummaryResponse>(`/api/drama/projects?${query}`);
}

export async function getDramaProject(id: string) {
    return request<{ project: DramaProject }>(`/api/drama/projects/${encodeURIComponent(id)}`).then((data) => data.project);
}

export function createDramaProject(input: CreateDramaProjectInput) {
    return request<{ project: DramaProject }>("/api/drama/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }).then((data) => data.project);
}

export function saveDramaProject(project: DramaProject) {
    return request<{ project: DramaProject }>(`/api/drama/projects/${encodeURIComponent(project.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(project) }).then((data) => data.project);
}

export function deleteDramaProject(id: string) {
    return request<{ deleted: boolean }>(`/api/drama/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function deleteDramaAgentConversation(projectId: string, conversationId: string) {
    return request<{ deleted: boolean; activeConversationId: string; project: DramaProject }>(`/api/drama/projects/${encodeURIComponent(projectId)}/agent-conversations/${encodeURIComponent(conversationId)}`, { method: "DELETE" });
}

export function createDramaProjectVersion(project: DramaProject, reason: string, scope: DramaProjectVersionScope = {}) {
    const episodeIds = Array.from(new Set((scope.episodeIds || []).filter((id) => project.episodes.some((episode) => episode.id === id))));
    const snapshot = episodeIds.length ? { ...project, episodes: project.episodes.filter((episode) => episodeIds.includes(episode.id)) } : project;
    return request<{ version: DramaProjectVersion }>(`/api/drama/projects/${encodeURIComponent(project.id)}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, snapshot, scope: episodeIds.length ? { episodeIds } : undefined }),
    }).then((data) => data.version);
}

export function listDramaProjectVersions(projectId: string) {
    return request<{ versions: DramaProjectVersion[] }>(`/api/drama/projects/${encodeURIComponent(projectId)}/versions`).then((data) => data.versions);
}

export function restoreDramaProjectVersion(projectId: string, versionId: string) {
    return request<{ project: DramaProject }>(`/api/drama/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}`, { method: "POST" }).then((data) => data.project);
}

export function deleteDramaProjectVersion(projectId: string, versionId: string) {
    return request<{ deleted: true }>(`/api/drama/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}`, { method: "DELETE" });
}

export function getDramaProjectCosts(projectId: string) {
    return request<{ summary: DramaCostSummary }>(`/api/drama/projects/${encodeURIComponent(projectId)}/costs`).then((data) => data.summary);
}

export function reviewDramaEpisode(project: DramaProject, episode: DramaEpisode) {
    return request<{ review: DramaVisualReview }>("/api/drama/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: { title: project.title, summary: project.summary, style: project.style, ratio: project.ratio }, episode }),
    }).then((data) => data.review);
}

export async function exportDramaJianyingDraft(projectId: string, input: { episodeId: string; draftPath: string; version: "5" | "6" }) {
    const response = await fetch(`/api/drama/projects/${encodeURIComponent(projectId)}/export-jianying`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { msg?: string };
        throw new Error(payload.msg || "剪映草稿导出失败");
    }
    const disposition = response.headers.get("content-disposition") || "";
    const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    return { blob: await response.blob(), fileName: encodedName ? decodeURIComponent(encodedName) : "短剧剪映草稿.zip" };
}

async function request<T>(url: string, init?: RequestInit) {
    const response = await fetch(url, { cache: "no-store", ...init });
    const payload = (await response.json().catch(() => ({}))) as { data?: T; msg?: string };
    if (!response.ok || !payload.data) throw new Error(payload.msg || "短剧项目请求失败");
    return payload.data;
}
