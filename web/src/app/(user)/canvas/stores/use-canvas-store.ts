import { create } from "zustand";
import { nanoid } from "nanoid";

import { createClientSessionEpoch, type ClientSessionStamp } from "@/lib/client-session-epoch";
import type { CanvasProject, CanvasProjectSummary } from "@/lib/canvas-project-contract";
import { applyCanvasProjectMutation, createCanvasProjectMutation, hasCanvasProjectMutationChanges } from "@/lib/canvas-project-mutation";
import { summarizeCanvasProjectRecord } from "@/lib/canvas-project-summary";
import { CanvasProjectRequestError, createCanvasProject, deleteCanvasProjects as deleteCanvasProjectsRequest, getCanvasProject, listCanvasProjectSummaries, saveCanvasProjectMutation } from "@/services/api/canvas-projects";
import { useUserStore } from "@/stores/use-user-store";

export type { CanvasProject, CanvasProjectSummary } from "@/lib/canvas-project-contract";

type CanvasProjectPatch = Partial<Pick<CanvasProject, "creativeConversationId" | "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">>;
export type CanvasProjectSaveState = { status: "saving" | "saved" | "error" | "conflict"; message?: string };

type CanvasStore = {
    hydrated: boolean;
    hydratedUserId: string;
    syncError?: string;
    summaries: CanvasProjectSummary[];
    summaryTotal: number;
    summaryPage: number;
    summaryPageSize: number;
    projects: CanvasProject[];
    saveStateByProject: Record<string, CanvasProjectSaveState>;
    hydrate: (force?: boolean, page?: number) => Promise<void>;
    loadProject: (id: string, force?: boolean) => Promise<CanvasProject>;
    createProject: (title?: string) => Promise<string>;
    importProject: (project: Partial<CanvasProject>, sourceHandoffId?: string) => Promise<string>;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => Promise<void>;
    updateProject: (id: string, patch: CanvasProjectPatch) => void;
    flushProjectSave: (id: string, keepalive?: boolean) => Promise<void>;
    retryProjectSave: (id: string) => void;
    reset: () => void;
};

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const saveRetryCancellations = new Map<string, () => void>();
const saveQueues = new Map<string, Promise<void>>();
const latestProjectTimes = new Map<string, number>();
const persistedProjectSnapshots = new Map<string, CanvasProject>();
const mutationIdsByVersion = new Map<string, string>();
const projectRequests = new Map<string, Promise<CanvasProject>>();
const sessionEpoch = createClientSessionEpoch(() => useUserStore.getState().user?.id || "");
let hydrateRequestId = 0;
let hydrateRequest: (ClientSessionStamp & { requestId: number; promise: Promise<void> }) | null = null;

export const useCanvasStore = create<CanvasStore>((set, get) => ({
    hydrated: false,
    hydratedUserId: "",
    summaries: [],
    summaryTotal: 0,
    summaryPage: 1,
    summaryPageSize: 12,
    projects: [],
    saveStateByProject: {},
    hydrate: async (force = false, requestedPage) => {
        const userId = useUserStore.getState().user?.id || "";
        if (!userId) {
            invalidateSession();
            set({ hydrated: true, hydratedUserId: "", summaries: [], summaryTotal: 0, summaryPage: 1, projects: [], saveStateByProject: {}, syncError: undefined });
            return;
        }
        const page = requestedPage || (get().hydratedUserId === userId ? get().summaryPage : 1);
        const pageSize = get().summaryPageSize;
        if (!force && get().hydrated && get().hydratedUserId === userId && get().summaryPage === page) return;
        const session = sessionEpoch.capture();
        if (!force && hydrateRequest?.userId === session.userId && hydrateRequest.epoch === session.epoch) return hydrateRequest.promise;
        const requestId = ++hydrateRequestId;
        set((state) => ({
            hydrated: false,
            hydratedUserId: userId,
            summaries: state.hydratedUserId === userId ? state.summaries : [],
            projects: state.hydratedUserId === userId ? state.projects : [],
            saveStateByProject: state.hydratedUserId === userId ? state.saveStateByProject : {},
            syncError: undefined,
        }));
        const promise = loadSummaryPage(page, pageSize)
            .then((result) => {
                if (!isActiveHydrate(session, requestId)) return;
                set({ summaries: result.projects, summaryTotal: result.total, summaryPage: result.page, summaryPageSize: result.pageSize, hydrated: true, hydratedUserId: userId });
            })
            .catch((error) => {
                if (isActiveHydrate(session, requestId)) set({ summaries: [], hydrated: false, hydratedUserId: userId, syncError: error instanceof Error ? error.message : "画布项目加载失败" });
            })
            .finally(() => {
                if (hydrateRequest?.requestId === requestId) hydrateRequest = null;
            });
        hydrateRequest = { ...session, requestId, promise };
        return promise;
    },
    loadProject: async (id, force = false) => {
        const session = requireSession();
        const current = get().projects.find((project) => project.id === id);
        if (!force && current) return current;
        const key = sessionEpoch.key(session, id);
        const pending = projectRequests.get(key);
        if (!force && pending) return pending;
        const request = getCanvasProject(id)
            .then((project) => {
                assertCurrent(session);
                if (projectRequests.get(key) !== request) return project;
                latestProjectTimes.set(key, Date.parse(project.updatedAt) || Date.now());
                persistedProjectSnapshots.set(key, project);
                set((state) => ({
                    projects: [project, ...state.projects.filter((item) => item.id !== project.id)],
                    summaries: upsertSummary(state.summaries, project),
                    saveStateByProject: { ...state.saveStateByProject, [project.id]: { status: "saved" } },
                    syncError: undefined,
                }));
                return project;
            })
            .finally(() => {
                if (projectRequests.get(key) === request) projectRequests.delete(key);
            });
        projectRequests.set(key, request);
        return request;
    },
    createProject: async (title = "未命名画布") => {
        const session = requireSession();
        const project = await createCanvasProject({ title });
        assertCurrent(session);
        set((state) => ({
            projects: [project, ...state.projects.filter((item) => item.id !== project.id)],
            summaries: state.summaryPage === 1 ? upsertSummary(state.summaries, project).slice(0, state.summaryPageSize) : state.summaries,
            summaryTotal: state.summaryTotal + (state.summaries.some((item) => item.id === project.id) ? 0 : 1),
            saveStateByProject: { ...state.saveStateByProject, [project.id]: { status: "saved" } },
            syncError: undefined,
        }));
        persistedProjectSnapshots.set(sessionEpoch.key(session, project.id), project);
        return project.id;
    },
    importProject: async (project, sourceHandoffId) => {
        const session = requireSession();
        const created = await createCanvasProject({ title: project.title || "导入画布", sourceHandoffId, project });
        assertCurrent(session);
        set((state) => ({
            projects: [created, ...state.projects.filter((item) => item.id !== created.id)],
            summaries: state.summaryPage === 1 ? upsertSummary(state.summaries, created).slice(0, state.summaryPageSize) : state.summaries,
            summaryTotal: state.summaryTotal + (state.summaries.some((item) => item.id === created.id) ? 0 : 1),
            saveStateByProject: { ...state.saveStateByProject, [created.id]: { status: "saved" } },
            syncError: undefined,
        }));
        persistedProjectSnapshots.set(sessionEpoch.key(session, created.id), created);
        return created.id;
    },
    renameProject: (id, title) => {
        const nextTitle = title.trim();
        if (!nextTitle) return;
        if (get().projects.some((project) => project.id === id)) {
            mutateProject(id, (project) => (project.title === nextTitle ? project : { ...project, title: nextTitle }));
            return;
        }
        void get()
            .loadProject(id)
            .then(() => mutateProject(id, (project) => (project.title === nextTitle ? project : { ...project, title: nextTitle })))
            .catch((error) => set({ syncError: error instanceof Error ? error.message : "画布项目重命名失败" }));
    },
    deleteProjects: async (ids) => {
        const session = requireSession();
        const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
        if (!uniqueIds.length) return;
        uniqueIds.forEach((id) => {
            clearProjectSave(session, id);
            cancelProjectSaveRetry(session, id);
        });
        await Promise.all(uniqueIds.map((id) => saveQueues.get(sessionEpoch.key(session, id))?.catch(() => undefined)));
        assertCurrent(session);
        const result = await deleteCanvasProjectsRequest(uniqueIds);
        if (!sessionEpoch.isCurrent(session)) return;
        uniqueIds.forEach((id) => latestProjectTimes.delete(sessionEpoch.key(session, id)));
        uniqueIds.forEach((id) => persistedProjectSnapshots.delete(sessionEpoch.key(session, id)));
        mutationIdsByVersion.forEach((_, versionKey) => {
            if (uniqueIds.some((id) => versionKey.startsWith(`${id}:`))) mutationIdsByVersion.delete(versionKey);
        });
        set((state) => ({
            projects: state.projects.filter((project) => !uniqueIds.includes(project.id)),
            summaries: state.summaries.filter((project) => !uniqueIds.includes(project.id)),
            summaryTotal: Math.max(0, state.summaryTotal - result.deleted),
            saveStateByProject: Object.fromEntries(Object.entries(state.saveStateByProject).filter(([id]) => !uniqueIds.includes(id))),
            syncError: undefined,
        }));
        const state = get();
        const lastPage = Math.max(1, Math.ceil(state.summaryTotal / state.summaryPageSize));
        await get().hydrate(true, Math.min(state.summaryPage, lastPage));
    },
    updateProject: (id, patch) =>
        mutateProject(id, (project) => {
            const changed = Object.entries(patch).some(([key, value]) => !Object.is(project[key as keyof CanvasProject], value));
            return changed ? { ...project, ...patch } : project;
        }),
    flushProjectSave: async (id, keepalive = false) => {
        const session = sessionEpoch.capture();
        const project = get().projects.find((item) => item.id === id);
        if (!session.userId || !project) return;
        clearProjectSave(session, id);
        setProjectSaveState(id, { status: "saving" });
        await startProjectSave(session, project, keepalive);
    },
    retryProjectSave: (id) => {
        const session = sessionEpoch.capture();
        const project = get().projects.find((item) => item.id === id);
        if (session.userId && project) queueSave(session, project);
    },
    reset: () => {
        invalidateSession();
        set({ hydrated: false, hydratedUserId: "", summaries: [], summaryTotal: 0, summaryPage: 1, projects: [], saveStateByProject: {}, syncError: undefined });
    },
}));

function mutateProject(projectId: string, updater: (project: CanvasProject) => CanvasProject) {
    const session = sessionEpoch.capture();
    if (!session.userId) return;
    let nextProject: CanvasProject | undefined;
    useCanvasStore.setState((state) => {
        const projects = state.projects.map((project) => {
            if (project.id !== projectId) return project;
            const updated = updater(project);
            if (updated === project) return project;
            nextProject = { ...updated, updatedAt: nextUpdatedAt(session, project) };
            return nextProject;
        });
        return { projects, summaries: nextProject ? upsertSummary(state.summaries, nextProject) : state.summaries };
    });
    if (nextProject) queueSave(session, nextProject);
}

function queueSave(session: ClientSessionStamp, project: CanvasProject) {
    const key = sessionEpoch.key(session, project.id);
    clearProjectSave(session, project.id);
    setProjectSaveState(project.id, { status: "saving" });
    saveTimers.set(
        key,
        setTimeout(() => {
            saveTimers.delete(key);
            if (!sessionEpoch.isCurrent(session)) return;
            void startProjectSave(session, project);
        }, 250),
    );
}

function startProjectSave(session: ClientSessionStamp, project: CanvasProject, keepalive = false) {
    const key = sessionEpoch.key(session, project.id);
    const previous = saveQueues.get(key) || Promise.resolve();
    const operation = previous.then(async () => {
        if (!sessionEpoch.isCurrent(session)) return;
        try {
            const base = persistedProjectSnapshots.get(key);
            if (!base) throw new Error("画布项目版本尚未加载，请刷新后重试");
            const mutationKey = `${project.id}:${project.updatedAt}`;
            const mutationId = mutationIdsByVersion.get(mutationKey) || nanoid();
            mutationIdsByVersion.set(mutationKey, mutationId);
            const mutation = createCanvasProjectMutation(base, project, mutationId);
            if (!hasCanvasProjectMutationChanges(mutation)) {
                if (mutationIdsByVersion.get(mutationKey) === mutationId) mutationIdsByVersion.delete(mutationKey);
                acknowledgeProjectSnapshot(project, base);
                return;
            }
            const saved = await saveProjectMutationWithRetry(session, project.id, mutation, keepalive);
            if (!saved) return;
            if (!sessionEpoch.isCurrent(session)) return;
            const acknowledged = applyCanvasProjectMutation(base, mutation, saved.updatedAt);
            if (mutationIdsByVersion.get(mutationKey) === mutationId) mutationIdsByVersion.delete(mutationKey);
            persistedProjectSnapshots.set(key, acknowledged);
            acknowledgeProjectSnapshot(project, acknowledged);
        } catch (error) {
            if (!sessionEpoch.isCurrent(session)) return;
            const latest = useCanvasStore.getState().projects.find((item) => item.id === project.id);
            if (latest?.updatedAt === project.updatedAt) {
                const message = error instanceof Error ? error.message : "画布项目保存失败";
                const status = error instanceof CanvasProjectRequestError && error.status === 409 ? "conflict" : "error";
                useCanvasStore.setState((state) => ({ syncError: message, saveStateByProject: { ...state.saveStateByProject, [project.id]: { status, message } } }));
            }
        }
    });
    saveQueues.set(key, operation);
    void operation.finally(() => {
        if (saveQueues.get(key) === operation) saveQueues.delete(key);
    });
    return operation;
}

function acknowledgeProjectSnapshot(requested: CanvasProject, acknowledged: CanvasProject) {
    useCanvasStore.setState((state) => {
        const current = state.projects.find((item) => item.id === acknowledged.id);
        const isLatest = current?.updatedAt === requested.updatedAt;
        const visibleProject = isLatest ? acknowledged : current || acknowledged;
        return {
            projects: state.projects.map((item) => (item.id === acknowledged.id && isLatest ? acknowledged : item)),
            summaries: upsertSummary(state.summaries, visibleProject),
            saveStateByProject: isLatest ? { ...state.saveStateByProject, [requested.id]: { status: "saved" } } : state.saveStateByProject,
            syncError: undefined,
        };
    });
}

function setProjectSaveState(projectId: string, saveState: CanvasProjectSaveState) {
    useCanvasStore.setState((state) => ({ saveStateByProject: { ...state.saveStateByProject, [projectId]: saveState }, syncError: saveState.status === "saving" ? undefined : state.syncError }));
}

function nextUpdatedAt(session: ClientSessionStamp, project: CanvasProject) {
    const key = sessionEpoch.key(session, project.id);
    const previous = Math.max(Date.parse(project.updatedAt) || 0, latestProjectTimes.get(key) || 0);
    const next = Math.max(Date.now(), previous + 1);
    latestProjectTimes.set(key, next);
    return new Date(next).toISOString();
}

function clearProjectSave(session: ClientSessionStamp, projectId: string) {
    const key = sessionEpoch.key(session, projectId);
    const timer = saveTimers.get(key);
    if (timer) clearTimeout(timer);
    saveTimers.delete(key);
}

async function saveProjectMutationWithRetry(session: ClientSessionStamp, projectId: string, mutation: ReturnType<typeof createCanvasProjectMutation>, keepalive: boolean) {
    for (let attempt = 0; ; attempt += 1) {
        try {
            return keepalive ? await saveCanvasProjectMutation(projectId, mutation, { keepalive: true }) : await saveCanvasProjectMutation(projectId, mutation);
        } catch (error) {
            if (keepalive || !isRetryableSaveError(error) || attempt >= SAVE_RETRY_DELAYS.length) throw error;
            setProjectSaveState(projectId, { status: "saving", message: "网络波动，正在重新保存" });
            if (!(await waitForProjectSaveRetry(session, projectId, SAVE_RETRY_DELAYS[attempt]))) return null;
            if (!sessionEpoch.isCurrent(session)) return null;
        }
    }
}

function waitForProjectSaveRetry(session: ClientSessionStamp, projectId: string, delay: number) {
    const key = sessionEpoch.key(session, projectId);
    return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (retry: boolean) => {
            if (settled) return;
            settled = true;
            if (saveRetryCancellations.get(key) === cancel) saveRetryCancellations.delete(key);
            resolve(retry);
        };
        const timer = setTimeout(() => finish(true), delay);
        const cancel = () => {
            clearTimeout(timer);
            finish(false);
        };
        saveRetryCancellations.set(key, cancel);
    });
}

function cancelProjectSaveRetry(session: ClientSessionStamp, projectId: string) {
    const key = sessionEpoch.key(session, projectId);
    saveRetryCancellations.get(key)?.();
}

function isRetryableSaveError(error: unknown) {
    return !(error instanceof CanvasProjectRequestError) || error.status === 408 || error.status === 429 || error.status >= 500;
}

function isActiveHydrate(session: ClientSessionStamp, requestId: number) {
    return sessionEpoch.isCurrent(session) && hydrateRequest?.requestId === requestId;
}

function requireSession() {
    const session = sessionEpoch.capture();
    if (!session.userId) throw new Error("请先登录");
    return session;
}

function assertCurrent(session: ClientSessionStamp) {
    if (!sessionEpoch.isCurrent(session)) throw new Error("登录会话已变更，请重试");
}

function invalidateSession() {
    sessionEpoch.invalidate();
    hydrateRequest = null;
    saveTimers.forEach((timer) => clearTimeout(timer));
    saveTimers.clear();
    saveRetryCancellations.forEach((cancel) => cancel());
    saveRetryCancellations.clear();
    latestProjectTimes.clear();
    persistedProjectSnapshots.clear();
    mutationIdsByVersion.clear();
    projectRequests.clear();
}

const SAVE_RETRY_DELAYS = [1_000, 2_500, 5_000] as const;

function upsertSummary(summaries: CanvasProjectSummary[], project: CanvasProject) {
    const summary = summarizeCanvasProjectRecord(project);
    return [summary, ...summaries.filter((item) => item.id !== project.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

async function loadSummaryPage(page: number, pageSize: number) {
    const result = await listCanvasProjectSummaries({ page, pageSize });
    const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));
    return result.page > lastPage ? listCanvasProjectSummaries({ page: lastPage, pageSize: result.pageSize }) : result;
}
