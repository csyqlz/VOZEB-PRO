import { CREATE_OVERVIEW_RECENT_ASSET_LIMIT, type CreateOverviewAsset, type CreateOverviewTask, type CreateWorkbenchOverviewPayload } from "@/lib/create-workbench-overview";
import { getLatestCanvasProjectOverview } from "@/lib/server/canvas-project-store";
import { createPostgresRepositories, ensurePostgresSchema, isPostgresDatabaseEnabled, type JsonValue } from "@/lib/server/database";
import { readGenerationLogDb, stableAssetUrl } from "@/lib/server/generation-log-repository";
import type { StoredGenerationLog } from "@/lib/server/generation-log-types";
import { listAgentRuns, type AgentRun } from "@/lib/server/agent-run-store";
import { getImageTask, type ImageTask } from "@/lib/server/image-task-store";
import type { EcommerceGenerationTrace } from "@/lib/server/ecommerce-generation-trace";

type OverviewImageTask = Pick<ImageTask, "userId" | "ecommerceExecution" | "ecommerceTrace">;

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

export function buildCreateGenerationOverview(logs: StoredGenerationLog[], imageTasks: ReadonlyMap<string, OverviewImageTask> = new Map()): Pick<CreateWorkbenchOverviewPayload, "runningTasks" | "recentAssets"> {
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
        if (!publishableCreateGenerationLog(log, log.taskId ? imageTasks.get(log.taskId) : undefined)) continue;
        for (const [index, asset] of log.assets.entries()) {
            const url = stableAssetUrl(asset).trim();
            if (!url || /^(data|blob):/i.test(url) || seen.has(url)) continue;
            seen.add(url);
            recentAssets.push({ id: `${log.id}-${index}`, kind: asset.type, title: log.title || (asset.type === "video" ? "生成视频" : "生成图片"), url, createdAt: log.createdAt });
            if (recentAssets.length >= CREATE_OVERVIEW_RECENT_ASSET_LIMIT) return { runningTasks, recentAssets };
        }
    }

    return { runningTasks, recentAssets };
}

function publishableCreateGenerationLog(log: StoredGenerationLog, task?: OverviewImageTask) {
    if (log.status !== "success" || (task && task.userId !== log.userId)) return false;
    const traces = [log.ecommerceTrace, task?.ecommerceTrace].filter((trace): trace is EcommerceGenerationTrace => Boolean(trace));
    if (!traces.length) return !task?.ecommerceExecution;
    const policies = traces.flatMap((trace) =>
        Array.isArray(trace.stages)
            ? trace.stages
                  .filter((stage) => stage.key === "quality_check")
                  .map((stage) => traceObject(stage.output).policy)
                  .filter((policy) => policy !== undefined)
            : [],
    );
    if (new Set(policies).size > 1) return false;
    return traces.every((trace) => {
        if (!Array.isArray(trace.stages)) return false;
        const shadow = trace.mode === "shadow" && !task?.ecommerceExecution && (trace.finalStatus === "completed" || trace.finalStatus === "passed");
        const quality = trace.stages.filter((stage) => stage.key === "quality_check");
        if (quality.some((stage) => traceObject(stage.output).policy !== undefined)) {
            const generation = trace.stages.filter((stage) => stage.key === "image_generation");
            return (
                trace.mode === "active" &&
                trace.finalStatus === "completed" &&
                quality.every((stage) => traceObject(stage.output).policy === "disabled" || traceObject(stage.output).policy === "advisory") &&
                generation.length > 0 &&
                generation.every((stage) => {
                    const technical = traceObject(traceObject(stage.output).technicalCheck);
                    return stage.status === "completed" && technical.status === "passed" && (technical.hardFailures === undefined || (Array.isArray(technical.hardFailures) && technical.hardFailures.length === 0));
                })
            );
        }
        return (
            (trace.finalStatus === "passed" || shadow) &&
            quality.length > 0 &&
            quality.every((qa) => {
                const output = traceObject(qa.output);
                return (
                    (qa.status === "passed" || (shadow && qa.status === "not_run")) &&
                    (output.status === undefined || output.status === "passed") &&
                    (output.publicStatus === undefined || output.publicStatus === "passed") &&
                    (output.hardFailures === undefined || (Array.isArray(output.hardFailures) && output.hardFailures.length === 0))
                );
            })
        );
    });
}

function traceObject(value: JsonValue | undefined): { [key: string]: JsonValue } {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function getCreateGenerationOverview(userId: string) {
    if (isPostgresDatabaseEnabled()) {
        await ensurePostgresSchema();
        return createPostgresRepositories().generationLogs.getCreateOverview(userId);
    }
    const logs = (await readGenerationLogDb()).logs.filter((log) => log.userId === userId);
    const recentLogs: StoredGenerationLog[] = [];
    const imageTasks = new Map<string, OverviewImageTask>();
    const seen = new Set<string>();
    for (const log of logs.toSorted((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))) {
        if (log.status !== "success") continue;
        if (log.kind === "image" && log.taskId && !imageTasks.has(log.taskId)) {
            const task = await getImageTask(log.taskId);
            if (task) imageTasks.set(log.taskId, task);
        }
        if (!publishableCreateGenerationLog(log, log.taskId ? imageTasks.get(log.taskId) : undefined)) continue;
        recentLogs.push(log);
        for (const asset of log.assets) {
            const url = stableAssetUrl(asset).trim();
            if (url && !/^(data|blob):/i.test(url)) seen.add(url);
        }
        if (seen.size >= CREATE_OVERVIEW_RECENT_ASSET_LIMIT) break;
    }
    return buildCreateGenerationOverview([...logs.filter((log) => log.status === "pending"), ...recentLogs], imageTasks);
}
