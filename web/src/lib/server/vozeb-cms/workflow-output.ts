import { registerGenerationTaskAssetsForUser } from "@/lib/server/creative-runtime-service";
import type { VozebCmsWorkflowNodeDefinition, VozebCmsWorkflowRun } from "@/lib/vozeb-cms/workflow-contract";

type WorkflowAsset = {
    type: "image" | "video" | "audio";
    url: string;
    mimeType?: string;
    width?: number;
    height?: number;
    durationMs?: number;
    bytes?: number;
    taskId?: string;
};

export async function persistVozebCmsWorkflowOutputAssets(input: { userId: string; run: VozebCmsWorkflowRun; node: VozebCmsWorkflowNodeDefinition; taskId?: string; output?: unknown }) {
    const conversationId = text(input.run.context.conversationId);
    const assets = extractWorkflowAssets(input.output);
    if (!assets.length) return [];
    const groups = new Map<string, WorkflowAsset[]>();
    for (const asset of assets) {
        const taskId = asset.taskId || input.taskId || `${input.run.id}:${input.node.id}`;
        groups.set(taskId, [...(groups.get(taskId) || []), asset]);
    }
    const registered = await Promise.all(
        [...groups].map(([taskId, groupedAssets]) =>
            registerGenerationTaskAssetsForUser(input.userId, {
                ...(conversationId ? { conversationId } : {}),
                runId: input.run.id,
                surface: surface(input.run.context.surface) || (input.run.projectRef?.type === "canvas" || input.run.projectRef?.type === "drama" ? input.run.projectRef.type : undefined),
                projectId: input.run.projectId,
                taskId,
                title: input.node.name,
                assets: groupedAssets.map(({ taskId: _taskId, ...asset }) => asset),
            }),
        ),
    );
    return registered.flat();
}

export function extractWorkflowAssets(value: unknown): WorkflowAsset[] {
    const candidates = Array.isArray(value) ? value : [value, record(value).result, record(value).output, record(value).results];
    const assets = candidates
        .flatMap((candidate) => (Array.isArray(candidate) ? candidate : [candidate]))
        .map(toWorkflowAsset)
        .filter((asset): asset is WorkflowAsset => Boolean(asset));
    return assets.filter((asset, index) => assets.findIndex((item) => item.type === asset.type && item.url === asset.url) === index);
}

function toWorkflowAsset(value: unknown): WorkflowAsset | null {
    const item = record(value);
    const url = text(item.url) || text(item.serverUrl) || text(item.remoteUrl);
    if (!url) return null;
    const mimeType = text(item.mimeType) || undefined;
    const type =
        item.type === "image" || item.type === "video" || item.type === "audio"
            ? item.type
            : mimeType?.startsWith("image/")
              ? "image"
              : mimeType?.startsWith("video/")
                ? "video"
                : mimeType?.startsWith("audio/")
                  ? "audio"
                  : /\.(png|jpe?g|webp|gif)(?:[?#]|$)/i.test(url)
                    ? "image"
                    : /\.(mp4|webm|mov)(?:[?#]|$)/i.test(url)
                      ? "video"
                      : /\.(mp3|wav|m4a|ogg)(?:[?#]|$)/i.test(url)
                        ? "audio"
                        : null;
    if (!type) return null;
    const taskId = text(item.taskId) || undefined;
    return { type, url, ...(mimeType ? { mimeType } : {}), ...(taskId ? { taskId } : {}), ...numberField(item.width, "width"), ...numberField(item.height, "height"), ...numberField(item.durationMs, "durationMs"), ...numberField(item.bytes, "bytes") };
}

function numberField(value: unknown, key: "width" | "height" | "durationMs" | "bytes") {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? { [key]: number } : {};
}

function surface(value: unknown): "chat" | "canvas" | "drama" | undefined {
    return value === "chat" || value === "canvas" || value === "drama" ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim().slice(0, 2000) : "";
}
