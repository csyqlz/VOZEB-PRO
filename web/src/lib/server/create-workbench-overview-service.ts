import { CREATE_OVERVIEW_RECENT_ASSET_LIMIT, type CreateOverviewAsset, type CreateOverviewTask, type CreateWorkbenchOverviewPayload } from "@/lib/create-workbench-overview";
import { getLatestCanvasProjectOverview } from "@/lib/server/canvas-project-store";
import { createPostgresRepositories, ensurePostgresSchema, isPostgresDatabaseEnabled } from "@/lib/server/database";
import { readGenerationLogDb, stableAssetUrl } from "@/lib/server/generation-log-repository";
import type { StoredGenerationLog } from "@/lib/server/generation-log-types";
import { listAgentRuns, type AgentRun } from "@/lib/server/agent-run-store";

const CREATE_OVERVIEW_MEDIA_TTL_MS = 24 * 60 * 60 * 1000;

export async function getCreateWorkbenchOverview(userId: string): Promise<CreateWorkbenchOverviewPayload> {
    const [latestProject, generation, agentRuns] = await Promise.all([getLatestCanvasProjectOverview(userId), getCreateGenerationOverview(userId), listAgentRuns({ userId, surface: "chat", statuses: ["planning", "running", "paused"], limit: 4 })]);
    const runningTasks = [...buildCreateAgentRunOverview(agentRuns), ...generation.runningTasks]
        .filter((task, index, tasks) => tasks.findIndex((candidate) => candidate.id === task.id) === index)
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
        .slice(0, 4);
    return { latestProject, runningTasks, recentAssets: generation.recentAssets };
}

export function buildCreateAgentRunOverview(runs: AgentRun[]): CreateOverviewTask[] {
    return runs.flatMap((run): CreateOverviewTask[] => {
        if (run.surface !== "chat" || (run.status !== "planning" && run.status !== "running" && run.status !== "paused")) return [];
        return [
            {
                id: run.id,
                kind: run.tasks.some((task) => task.type === "video") ? "video" : run.tasks.some((task) => task.type === "image") ? "image" : "agent",
                source: "agent",
                title: (run.publicPrompt || run.prompt).trim().slice(0, 80) || "Agent 创作任务",
                createdAt: new Date(run.createdAt).toISOString(),
                conversationId: run.conversationId,
                status: run.status,
            },
        ];
    });
}

export function buildCreateGenerationOverview(logs: StoredGenerationLog[], now = Date.now()): Pick<CreateWorkbenchOverviewPayload, "runningTasks" | "recentAssets"> {
    const sorted = [...logs].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    const runningTasks = sorted
        .filter((log) => log.status === "pending")
        .slice(0, 4)
        .map((log): CreateOverviewTask => ({
            id: log.id,
            kind: log.kind,
            source: log.source,
            title: log.title || (log.kind === "video" ? "视频生成" : "图片生成"),
            createdAt: log.createdAt,
        }));
    const recentAssets: CreateOverviewAsset[] = [];
    const seen = new Set<string>();

    for (const log of sorted) {
        if (log.status !== "success" || isExpiredOverviewMedia(log.createdAt, now)) continue;
        for (const [index, asset] of log.assets.entries()) {
            const url = stableAssetUrl(asset).trim();
            if (!url || /^(data|blob):/i.test(url) || seen.has(url)) continue;
            seen.add(url);
            recentAssets.push({
                id: `${log.id}-${index}`,
                kind: asset.type,
                title: log.title || (asset.type === "video" ? "生成视频" : "生成图片"),
                url,
                createdAt: log.createdAt,
                expiresAt: new Date(Date.parse(log.createdAt) + CREATE_OVERVIEW_MEDIA_TTL_MS).toISOString(),
            });
            if (recentAssets.length >= CREATE_OVERVIEW_RECENT_ASSET_LIMIT) return { runningTasks, recentAssets };
        }
    }

    return { runningTasks, recentAssets };
}

function isExpiredOverviewMedia(createdAt: string, now: number) {
    const createdAtMs = Date.parse(createdAt);
    return !Number.isFinite(createdAtMs) || createdAtMs + CREATE_OVERVIEW_MEDIA_TTL_MS <= now;
}

async function getCreateGenerationOverview(userId: string) {
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        return createPostgresRepositories().generationLogs.getCreateOverview(userId);
    }
    const logs = (await readGenerationLogDb()).logs.filter((log) => log.userId === userId);
    return buildCreateGenerationOverview(logs);
}
