import type { CanvasProject } from "@/lib/canvas-project-contract";

export const CREATE_OVERVIEW_RECENT_ASSET_LIMIT = 8;

export type CreateOverviewMedia = {
    kind: "image" | "video";
    url: string;
};

export type CreateOverviewProject = {
    id: string;
    title: string;
    updatedAt: string;
    nodeCount: number;
    connectionCount: number;
    previews: CreateOverviewMedia[];
};

export type CreateOverviewTask = {
    id: string;
    kind: "agent" | "image" | "video";
    source: string;
    title: string;
    createdAt: string;
    conversationId?: string;
    status?: "planning" | "running" | "paused";
};

export type CreateOverviewAsset = CreateOverviewMedia & {
    id: string;
    title: string;
    createdAt: string;
    expiresAt: string;
};

export type CreateWorkbenchOverviewPayload = {
    latestProject?: CreateOverviewProject;
    runningTasks: CreateOverviewTask[];
    recentAssets: CreateOverviewAsset[];
};

export function summarizeCanvasProject(project: CanvasProject): CreateOverviewProject {
    const candidates: Array<CreateOverviewMedia & { preferred: boolean }> = [];
    const seen = new Set<string>();

    for (const node of project.nodes) {
        const kind = node.type === "video" ? "video" : node.type === "image" || node.type === "panorama" ? "image" : undefined;
        if (!kind || node.metadata?.status === "error") continue;

        for (const value of [node.metadata?.serverUrl, node.metadata?.remoteUrl, node.metadata?.content]) {
            const url = stableMediaUrl(value);
            if (!url || seen.has(url)) continue;
            seen.add(url);
            candidates.push({ kind, url, preferred: node.metadata?.status === "success" });
        }
    }

    return {
        id: project.id,
        title: project.title,
        updatedAt: project.updatedAt,
        nodeCount: project.nodes.length,
        connectionCount: project.connections.length,
        previews: candidates
            .sort((left, right) => Number(right.preferred) - Number(left.preferred) || Number(right.kind === "image") - Number(left.kind === "image"))
            .slice(0, 6)
            .map(({ kind, url }) => ({ kind, url })),
    };
}

function stableMediaUrl(value: unknown) {
    const url = typeof value === "string" ? value.trim() : "";
    return url && !/^(data|blob):/i.test(url) ? url : "";
}
