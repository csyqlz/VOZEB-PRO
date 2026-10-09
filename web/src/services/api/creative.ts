import {
    isCreativeProjectHandoff,
    type CreativeAsset,
    type CreativeConversation,
    type CreativeConversationSource,
    type CreativeGenerationPreferences,
    type CreativeMessage,
    type CreativeProjectHandoff,
    type CreativeRunRequest,
    type CreativeReferenceReview,
    type CreativeReferenceRecovery,
} from "@/lib/creative-runtime-contract";
import { refreshUserPointsIfSystem } from "@/services/api/points";
import { ClientSessionExpiredError, stopIfClientSessionExpired, throwIfClientSessionExpired } from "@/services/api/session-expiration";

export type CreativeAgentRun = {
    id: string;
    conversationId: string;
    inputMessageId: string;
    assistantMessageId: string;
    status: "planning" | "running" | "paused" | "completed" | "failed" | "cancelled";
    surface?: CreativeRunRequest["surface"];
    projectId?: string;
    prompt?: string;
    referencedAssetIds?: string[];
    selectedSkillIds?: string[];
    requestedModelIds?: string[];
    generationPreferences?: CreativeGenerationPreferences;
    ecommerceQualityStatus?: "passed" | "needs_adjustment" | "needs_review";
    ecommerceQualityReview?: {
        kind: "hard_failure" | "check_unavailable" | "needs_adjustment";
        advisory?: boolean;
        failureKeys: Array<
            | "product_identity"
            | "product_silhouette"
            | "product_color_material"
            | "product_proportions_view"
            | "brand_logo"
            | "packaging_text"
            | "scene_intent"
            | "composition_lighting"
            | "canvas_geometry"
            | "stored_media"
            | "protected_structure"
            | "protected_material"
            | "unmodified_region"
        >;
        message?: string;
    };
    ecommerceSceneSelection?: { action: "confirm_scene_selection"; baselineAssetId: string; url: string; width: number; height: number };
    ecommerceReferenceReview?: CreativeReferenceReview | null;
    canCheckStatus?: boolean;
    createdAt?: number;
    updatedAt?: number;
    assetIds: string[];
    tasks: Array<{
        id: string;
        title: string;
        type?: "text" | "image" | "video" | "audio";
        model?: string;
        optimizedPrompt?: string;
        ratio?: string;
        quality?: string;
        seconds?: number;
        voice?: string;
        format?: string;
        generateAudio?: boolean;
        watermark?: boolean;
        speed?: number;
        count?: number;
        status: "ready" | "running" | "needs_review" | "completed" | "failed" | "cancelled";
        error?: string;
    }>;
    cancellation?: { pendingCount: number };
};

export type CreativeSceneSelection = { baselineAssetId: string; region: { x: number; y: number; width: number; height: number } };
export type CreativeAgentRunSnapshot = Pick<CreativeAgentRun, "id" | "status"> &
    Partial<Pick<CreativeAgentRun, "tasks" | "assetIds" | "ecommerceQualityStatus" | "ecommerceQualityReview" | "ecommerceSceneSelection" | "ecommerceReferenceReview" | "canCheckStatus" | "cancellation" | "updatedAt">>;

type ApiResponse<T> = { code: number; data: T; msg: string };

export function listCreativeConversationPage(input: { surface?: CreativeConversation["surface"]; source?: CreativeConversationSource; projectId?: string; offset?: number; limit?: number } = {}) {
    const query = new URLSearchParams({ surface: input.surface || "chat", source: input.source || "agent", status: "active", limit: String(input.limit || 50), offset: String(input.offset || 0) });
    if (input.projectId) query.set("projectId", input.projectId);
    return request<{ conversations: CreativeConversation[]; hasMore: boolean }>(`/api/creative/conversations?${query}`);
}

export function listCreativeConversations(source: CreativeConversationSource = "agent") {
    return listCreativeConversationPage({ source, limit: 100 }).then((data) => data.conversations);
}

export function getCreativeConversation(conversationId: string) {
    return request<{ conversation: CreativeConversation }>(`/api/creative/conversations/${encodeURIComponent(conversationId)}`).then((data) => data.conversation);
}

export function listCreativeMessages(conversationId: string, beforeSequence?: number, limit = 100) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (beforeSequence) query.set("beforeSequence", String(beforeSequence));
    return request<{ messages: CreativeMessage[] }>(`/api/creative/conversations/${encodeURIComponent(conversationId)}/messages?${query}`).then((data) => data.messages);
}

export function listCreativeAssets(conversationId: string) {
    return request<{ assets: CreativeAsset[] }>(`/api/creative/conversations/${encodeURIComponent(conversationId)}/assets`).then((data) => data.assets);
}

export function createCreativeConversation(input: { surface: "chat" | "canvas" | "drama"; source?: CreativeConversation["source"]; projectId?: string; title?: string }) {
    return request<{ conversation: CreativeConversation }>("/api/creative/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
    }).then((data) => data.conversation);
}

export function uploadCreativeAsset(conversationId: string, file: File) {
    const body = new FormData();
    body.set("conversationId", conversationId);
    body.set("file", file);
    return request<{ asset: CreativeAsset }>("/api/creative/assets", { method: "POST", body }).then((data) => data.asset);
}

export function createCreativeAgentRun(input: CreativeRunRequest) {
    return request<{ run: CreativeAgentRun; conversation?: CreativeConversation; created: boolean }>("/api/agent/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
}

export function controlCreativeAgentRun(runId: string, action: "cancel" | "pause" | "resume" | "retry", expectedConversationId?: string, sceneSelection?: CreativeSceneSelection, referenceRecovery?: CreativeReferenceRecovery) {
    return request<{ run: CreativeAgentRun }>(`/api/agent/runs/${encodeURIComponent(runId)}/${action}`, {
        method: "POST",
        ...(expectedConversationId
            ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId: expectedConversationId, ...(sceneSelection ? { sceneSelection } : {}), ...(referenceRecovery ? { referenceRecovery } : {}) }) }
            : {}),
    });
}

export function getCreativeAgentRun(runId: string) {
    return request<{ run: CreativeAgentRun }>(`/api/agent/runs/${encodeURIComponent(runId)}`).then((data) => data.run);
}

export function listCreativeAgentRuns(surface: CreativeRunRequest["surface"] = "chat", input: { activeOnly?: boolean; limit?: number; projectId?: string; conversationId?: string } = {}) {
    const query = new URLSearchParams({ surface });
    if (input.activeOnly) query.set("status", "active");
    if (input.limit) query.set("limit", String(input.limit));
    if (input.projectId) query.set("projectId", input.projectId);
    if (input.conversationId) query.set("conversationId", input.conversationId);
    return request<{ runs: CreativeAgentRun[] }>(`/api/agent/runs?${query}`).then((data) => data.runs);
}

export function retryCreativeAgentTask(runId: string, taskId: string, expectedConversationId?: string) {
    return retryCreativeAgentTasks(runId, [taskId], expectedConversationId);
}

export function retryCreativeAgentTasks(runId: string, taskIds: string[], expectedConversationId?: string) {
    const [taskId] = taskIds;
    if (!taskId) return Promise.reject(new Error("请选择需要重试的失败任务"));
    return request<{ run: CreativeAgentRun }>(`/api/agent/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(expectedConversationId ? { conversationId: expectedConversationId } : {}), taskIds }),
    }).then((data) => data.run);
}

export function updateCreativeConversation(conversationId: string, patch: { title?: string; status?: CreativeConversation["status"] }) {
    return request<{ conversation: CreativeConversation }>(`/api/creative/conversations/${encodeURIComponent(conversationId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
    }).then((data) => data.conversation);
}

export function deleteCreativeConversations(conversationIds: string[]) {
    return request<{ deleted: number }>("/api/creative/conversations", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: conversationIds }),
    });
}

type CreativeRunHandlers = {
    onProgress: (text: string) => void;
    onTerminal: (status: "completed" | "failed" | "cancelled", text?: string) => void;
    onConnectionError: (message: string) => void;
    onProjectHandoff?: (handoff: CreativeProjectHandoff) => void;
    onStatus?: (status: CreativeAgentRun["status"]) => void;
    onSnapshot?: (snapshot: CreativeAgentRunSnapshot) => void;
    onTaskCompleted?: (progress?: CreativeTaskProgress) => void;
};

export type CreativeTaskProgress = {
    taskId?: string;
    title: string;
    completedCount: number;
    failedCount: number;
    totalCount: number;
};

export function watchCreativeAgentRun(runId: string, handlers: CreativeRunHandlers) {
    const source = new EventSource(`/api/agent/runs/${encodeURIComponent(runId)}/events`);
    let settled = false;
    let connectionInterrupted = false;
    let reconciliation: Promise<void> | null = null;
    let latestReviewReason = "";
    const read = (event: Event) => {
        let parsed: { data?: Record<string, unknown>; status?: string } & Partial<Omit<CreativeAgentRunSnapshot, "status">>;
        try {
            parsed = JSON.parse((event as MessageEvent<string>).data) as typeof parsed;
        } catch {
            return null;
        }
        return parsed;
    };
    const finish = (status: "completed" | "failed" | "cancelled", text?: string) => {
        if (settled) return;
        settled = true;
        source.close();
        void refreshUserPointsIfSystem("system");
        handlers.onTerminal(status, text);
    };
    const stopObservation = (message: string) => {
        if (settled) return;
        settled = true;
        source.close();
        handlers.onConnectionError(message);
    };
    const reconcileRun = async () => {
        if (await stopIfClientSessionExpired()) {
            stopObservation("登录状态已失效，任务仍可能在后台运行；重新登录后可继续查看");
            return;
        }
        try {
            const run = await getCreativeAgentRun(runId);
            if (settled) return;
            handlers.onSnapshot?.(publicRunSnapshot(run));
            handlers.onStatus?.(run.status);
            if (run.status === "completed") return finish("completed");
            if (run.status === "failed") return finish("failed", run.tasks.find((task) => task.status === "failed")?.error || "Agent 执行失败");
            if (run.status === "cancelled") return finish("cancelled", "任务已取消");
            const reviewReason = run.tasks.find((task) => task.status === "needs_review" && task.error?.trim())?.error?.trim();
            if (reviewReason) latestReviewReason = reviewReason;
            handlers.onProgress(run.status === "paused" ? latestReviewReason || "任务仍在后台保存，当前处于暂停状态" : "任务仍在后台运行，正在恢复连接");
        } catch (error) {
            if (settled) return;
            if (error instanceof ClientSessionExpiredError) {
                stopObservation("登录状态已失效，任务仍可能在后台运行；重新登录后可继续查看");
                return;
            }
            handlers.onProgress("暂时无法确认实时状态，任务仍会在后台继续运行");
        }
    };
    const listen = (type: string, callback: (payload: { data?: Record<string, unknown>; status?: string } & Partial<Omit<CreativeAgentRunSnapshot, "status">>) => void) =>
        source.addEventListener(type, (event) => {
            const payload = read(event);
            if (payload) callback(payload);
        });

    listen("run.planning", () => handlers.onProgress("正在理解你的想法，并为你挑选合适的创作方式…"));
    listen("run.planning.context_ready", () => handlers.onProgress("需要的内容已经准备好，正在为你整理创作思路…"));
    listen("run.planning.model_connected", () => handlers.onProgress("创作思路已经理清，正在安排接下来的步骤…"));
    listen("run.planning.validating", () => handlers.onProgress("正在确认创作步骤，很快就可以开始…"));
    listen("ecommerce.progress", ({ data }) => {
        const stage = text(data?.stage);
        if (stage === "identifying_product") handlers.onProgress("正在识别商品");
        if (stage === "planning_scene") handlers.onProgress("正在规划场景");
        if (stage === "generating_image") handlers.onProgress("正在生成图片");
    });
    listen("skills.selected", () => handlers.onProgress("正在挑选更合适的创作方式…"));
    listen("run.planned", ({ data }) => {
        void refreshUserPointsIfSystem("system");
        handlers.onProgress(text(data?.reply) || "方案已确定，正在创建任务");
    });
    listen("task.running", ({ data }) => handlers.onProgress(`正在处理「${text(data?.title) || "创作任务"}」`));
    listen("task.waiting", ({ data }) => handlers.onProgress(text(data?.error) || `「${text(data?.title) || "创作任务"}」仍在上游处理中，系统会继续恢复`));
    listen("task.needs_review", ({ data }) => {
        latestReviewReason = text(data?.error);
        handlers.onStatus?.("paused");
        handlers.onProgress(latestReviewReason || "任务需要你确认后才能继续");
    });
    listen("task.child.completed", ({ data }) => {
        void refreshUserPointsIfSystem("system");
        const progress = taskProgress(data);
        handlers.onProgress(taskProgressText(progress));
        handlers.onTaskCompleted?.(progress);
    });
    listen("task.child.failed", ({ data }) => handlers.onProgress(taskProgressText(taskProgress(data))));
    listen("task.completed", ({ data }) => {
        void refreshUserPointsIfSystem("system");
        handlers.onProgress(text(data?.message) || `「${text(data?.title) || "创作任务"}」已完成`);
        handlers.onTaskCompleted?.();
    });
    listen("project.handoff", ({ data }) => {
        if (isCreativeProjectHandoff(data?.projectHandoff || data)) handlers.onProjectHandoff?.((data?.projectHandoff || data) as CreativeProjectHandoff);
    });
    listen("run.review.retry", () => handlers.onProgress("正在优化生成结果"));
    listen("run.review.passed", () => {
        void refreshUserPointsIfSystem("system");
        handlers.onProgress("检查完成，正在整理结果");
    });
    listen("run.review.unavailable", () => {
        void refreshUserPointsIfSystem("system");
        handlers.onProgress("正在整理已完成的创作结果");
    });
    listen("run.cancel.requested", () => handlers.onProgress("正在取消任务，等待子任务确认"));
    listen("run.cancel.pending", () => handlers.onProgress("部分子任务取消状态尚未确认，可稍后再次取消"));
    listen("run.completed", ({ data }) => finish("completed", text(data?.reply)));
    listen("run.failed", ({ data }) => finish("failed", text(data?.message) || "Agent 执行失败"));
    listen("run.cancelled", () => finish("cancelled", "任务已取消"));
    listen("run.snapshot", (payload) => {
        if (payload.id === runId && payload.status && ["planning", "running", "paused", "completed", "failed", "cancelled"].includes(payload.status)) {
            handlers.onSnapshot?.(publicRunSnapshot({ ...payload, id: payload.id, status: payload.status as CreativeAgentRun["status"] }));
        }
        if (payload.status && ["planning", "running", "paused", "completed", "failed", "cancelled"].includes(payload.status)) handlers.onStatus?.(payload.status as CreativeAgentRun["status"]);
        if (payload.status === "completed") finish("completed");
        if (payload.status === "failed") finish("failed", "Agent 执行失败");
        if (payload.status === "cancelled") finish("cancelled", "任务已取消");
        if (payload.status === "paused") handlers.onProgress(latestReviewReason || "任务已暂停，当前进度已经为你保存");
    });
    source.onopen = () => {
        if (connectionInterrupted && !settled) handlers.onProgress("连接已恢复，任务继续运行");
        connectionInterrupted = false;
    };
    source.onerror = () => {
        if (settled) return;
        connectionInterrupted = true;
        handlers.onProgress("连接暂时中断，正在确认后台任务状态");
        reconciliation ||= reconcileRun().finally(() => {
            reconciliation = null;
        });
    };
    return () => {
        settled = true;
        source.close();
    };
}

function publicRunSnapshot(run: CreativeAgentRunSnapshot): CreativeAgentRunSnapshot {
    return {
        id: run.id,
        status: run.status,
        tasks: run.tasks,
        assetIds: run.assetIds,
        ecommerceQualityStatus: run.ecommerceQualityStatus,
        ecommerceQualityReview: run.ecommerceQualityReview,
        ecommerceSceneSelection: run.ecommerceSceneSelection,
        ecommerceReferenceReview: run.ecommerceReferenceReview ?? null,
        canCheckStatus: run.canCheckStatus,
        cancellation: run.cancellation,
        updatedAt: run.updatedAt,
    };
}

async function request<T>(url: string, init?: RequestInit) {
    const response = await fetch(url, { ...init, cache: "no-store" });
    throwIfClientSessionExpired(response);
    const payload = (await response.json().catch(() => null)) as ApiResponse<T> | null;
    if (!response.ok || !payload || payload.code !== 0) throw new Error(payload?.msg || "请求失败");
    return payload.data;
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function taskProgress(data?: Record<string, unknown>): CreativeTaskProgress {
    return {
        taskId: text(data?.taskId) || undefined,
        title: text(data?.title) || "创作任务",
        completedCount: count(data?.completedCount),
        failedCount: count(data?.failedCount),
        totalCount: Math.max(1, count(data?.totalCount)),
    };
}

function taskProgressText(progress: CreativeTaskProgress) {
    const failed = progress.failedCount ? `，失败 ${progress.failedCount}` : "";
    return `「${progress.title}」已完成 ${progress.completedCount}/${progress.totalCount}${failed}`;
}

function count(value: unknown) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}
