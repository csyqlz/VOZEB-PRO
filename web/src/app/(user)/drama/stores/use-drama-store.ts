import { nanoid } from "nanoid";
import { create } from "zustand";

import { createClientSessionEpoch, type ClientSessionStamp } from "@/lib/client-session-epoch";
import type { CreateDramaProjectInput, DramaCharacter, DramaClue, DramaContentAnalysis, DramaEpisode, DramaProject, DramaProjectSummary, DramaProp, DramaScene, DramaShot, DramaVisualAnalysis } from "@/lib/drama-project-contract";
import { summarizeDramaProject } from "@/lib/drama-project-summary";
import type { DramaSourceEpisodeDraft } from "@/lib/drama-source-splitter";
import { createDramaProject, createDramaProjectVersion, deleteDramaProject, getDramaProject, listDramaProjectSummaries, listDramaProjectVersions, restoreDramaProjectVersion, saveDramaProject } from "@/services/api/drama-projects";
import { useUserStore } from "@/stores/use-user-store";

type DramaStore = {
    hydrated: boolean;
    hydratedUserId: string;
    syncError?: string;
    saveStateByProject: Record<string, { status: "saving" | "saved" | "error"; savedAt?: string }>;
    summaries: DramaProjectSummary[];
    summaryTotal: number;
    summaryPage: number;
    summaryPageSize: number;
    summaryLoadingMore: boolean;
    projects: DramaProject[];
    hydrate: (force?: boolean) => Promise<void>;
    loadMore: () => Promise<void>;
    loadProject: (id: string, force?: boolean) => Promise<DramaProject>;
    createProject: (input: CreateDramaProjectInput) => Promise<string>;
    deleteProject: (id: string) => Promise<void>;
    updateProject: (id: string, patch: Partial<Pick<DramaProject, "title" | "summary" | "style" | "ratio" | "status" | "creativeConversationId" | "defaultVideoMode">>) => void;
    addCharacter: (projectId: string, input: Omit<DramaCharacter, "id">) => void;
    addScene: (projectId: string, input: Omit<DramaScene, "id">) => void;
    addProp: (projectId: string, input: Omit<DramaProp, "id">) => void;
    addClue: (projectId: string, input: Omit<DramaClue, "id">) => void;
    updateAsset: (projectId: string, kind: DramaAssetKind, id: string, patch: Partial<DramaCharacter & DramaClue>) => void;
    removeAsset: (projectId: string, kind: DramaAssetKind, id: string) => void;
    addEpisode: (projectId: string) => void;
    importEpisodes: (projectId: string, drafts: DramaSourceEpisodeDraft[]) => Promise<void>;
    deleteEpisode: (projectId: string, episodeId: string) => void;
    selectEpisode: (projectId: string, episodeId: string) => void;
    updateEpisodeNumber: (projectId: string, episodeId: string, episodeNumber: number) => void;
    updateEpisode: (
        projectId: string,
        episodeId: string,
        patch: Partial<
            Pick<
                DramaEpisode,
                | "episodeNumber"
                | "title"
                | "script"
                | "scriptRichContent"
                | "outline"
                | "hook"
                | "nextPreview"
                | "sourceRange"
                | "reviewStatus"
                | "contentTaskId"
                | "contentError"
                | "visualTaskId"
                | "visualCompletedTaskId"
                | "visualError"
                | "renderTask"
                | "visualReview"
            >
        >,
    ) => void;
    saveProjectNow: (projectId: string) => Promise<void>;
    buildStoryboard: (projectId: string, episodeId: string) => void;
    updateShot: (projectId: string, episodeId: string, shotId: string, patch: Partial<DramaShot>) => void;
    queueShots: (projectId: string, episodeId: string, shotIds: string[]) => void;
    applyContentAnalysis: (projectId: string, episodeId: string, analysis: DramaContentAnalysis) => void;
    applyVisualAnalysis: (projectId: string, episodeId: string, analysis: DramaVisualAnalysis) => void;
    replaceProject: (project: DramaProject) => void;
    createVersion: (project: DramaProject, reason: string) => Promise<void>;
    listVersions: (projectId: string) => Promise<import("@/lib/drama-project-contract").DramaProjectVersion[]>;
    restoreVersion: (projectId: string, versionId: string) => Promise<void>;
    queueAudio: (projectId: string, episodeId: string, shotIds: string[]) => void;
    reset: () => void;
};

type DramaAssetKind = "characters" | "scenes" | "props" | "clues";

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const saveQueues = new Map<string, Promise<void>>();
const suspendedSaves = new Set<string>();
const latestProjectTimes = new Map<string, number>();
const projectRequests = new Map<string, Promise<DramaProject>>();
const sessionEpoch = createClientSessionEpoch(() => useUserStore.getState().user?.id || "");
let hydrateRequestId = 0;
let hydrateRequest: (ClientSessionStamp & { requestId: number; promise: Promise<void> }) | null = null;
const SUMMARY_PAGE_SIZE = 12;

export const useDramaStore = create<DramaStore>((set, get) => ({
    hydrated: false,
    hydratedUserId: "",
    saveStateByProject: {},
    summaries: [],
    summaryTotal: 0,
    summaryPage: 0,
    summaryPageSize: SUMMARY_PAGE_SIZE,
    summaryLoadingMore: false,
    projects: [],
    hydrate: async (force = false) => {
        const userId = useUserStore.getState().user?.id || "";
        if (!userId) {
            invalidateSession();
            set({ hydrated: true, hydratedUserId: "", summaries: [], summaryTotal: 0, summaryPage: 0, summaryLoadingMore: false, projects: [], syncError: undefined });
            return;
        }
        if (!force && get().hydrated && get().hydratedUserId === userId) return;
        const session = sessionEpoch.capture();
        if (!force && hydrateRequest?.userId === session.userId && hydrateRequest.epoch === session.epoch) return hydrateRequest.promise;
        const requestId = ++hydrateRequestId;
        set((state) => ({
            hydrated: false,
            hydratedUserId: userId,
            summaries: state.hydratedUserId === userId ? state.summaries : [],
            summaryTotal: state.hydratedUserId === userId ? state.summaryTotal : 0,
            summaryPage: state.hydratedUserId === userId ? state.summaryPage : 0,
            summaryLoadingMore: false,
            projects: state.hydratedUserId === userId ? state.projects : [],
            saveStateByProject: state.hydratedUserId === userId ? state.saveStateByProject : {},
            syncError: undefined,
        }));
        const promise = listDramaProjectSummaries({ page: 1, pageSize: SUMMARY_PAGE_SIZE })
            .then((result) => {
                if (!isActiveHydrate(session, requestId)) return;
                set({ summaries: result.projects, summaryTotal: result.total, summaryPage: result.page, summaryPageSize: result.pageSize, hydrated: true, hydratedUserId: userId });
            })
            .catch((error) => {
                if (isActiveHydrate(session, requestId)) set({ summaries: [], summaryTotal: 0, summaryPage: 0, hydrated: false, hydratedUserId: userId, syncError: error instanceof Error ? error.message : "短剧项目加载失败" });
            })
            .finally(() => {
                if (hydrateRequest?.requestId === requestId) hydrateRequest = null;
            });
        hydrateRequest = { ...session, requestId, promise };
        return promise;
    },
    loadMore: async () => {
        const session = requireSession();
        const state = get();
        if (!state.hydrated || state.summaryLoadingMore || state.summaries.length >= state.summaryTotal) return;
        const page = state.summaryPage + 1;
        set({ summaryLoadingMore: true, syncError: undefined });
        try {
            const result = await listDramaProjectSummaries({ page, pageSize: state.summaryPageSize });
            assertCurrent(session);
            set((current) => {
                const existing = new Set(current.summaries.map((item) => item.id));
                return {
                    summaries: [...current.summaries, ...result.projects.filter((item) => !existing.has(item.id))],
                    summaryTotal: result.total,
                    summaryPage: result.page,
                    summaryPageSize: result.pageSize,
                    summaryLoadingMore: false,
                };
            });
        } catch (error) {
            if (sessionEpoch.isCurrent(session)) set({ summaryLoadingMore: false, syncError: error instanceof Error ? error.message : "更多项目加载失败" });
        }
    },
    loadProject: async (id, force = false) => {
        const session = requireSession();
        const current = get().projects.find((project) => project.id === id);
        if (!force && current) return current;
        const key = sessionEpoch.key(session, id);
        const pending = projectRequests.get(key);
        if (!force && pending) return pending;
        const request = getDramaProject(id)
            .then((project) => {
                assertCurrent(session);
                latestProjectTimes.set(key, Date.parse(project.updatedAt) || Date.now());
                set((state) => ({
                    projects: [project, ...state.projects.filter((item) => item.id !== project.id)],
                    summaries: upsertSummary(state.summaries, project),
                    syncError: undefined,
                    saveStateByProject: { ...state.saveStateByProject, [project.id]: { status: "saved", savedAt: project.updatedAt } },
                }));
                return project;
            })
            .finally(() => {
                if (projectRequests.get(key) === request) projectRequests.delete(key);
            });
        projectRequests.set(key, request);
        return request;
    },
    createProject: async (input) => {
        const session = requireSession();
        const project = await createDramaProject(input);
        assertCurrent(session);
        set((state) => {
            const known = state.summaries.some((item) => item.id === project.id);
            return {
                projects: [project, ...state.projects.filter((item) => item.id !== project.id)],
                summaries: upsertSummary(state.summaries, project),
                summaryTotal: known ? state.summaryTotal : state.summaryTotal + 1,
                saveStateByProject: { ...state.saveStateByProject, [project.id]: { status: "saved", savedAt: project.updatedAt } },
            };
        });
        return project.id;
    },
    deleteProject: async (id) => {
        const session = requireSession();
        const key = sessionEpoch.key(session, id);
        clearProjectSave(session, id);
        await saveQueues.get(key)?.catch(() => undefined);
        assertCurrent(session);
        await deleteDramaProject(id);
        if (!sessionEpoch.isCurrent(session)) return;
        latestProjectTimes.delete(key);
        set((state) => ({ projects: state.projects.filter((project) => project.id !== id), summaries: state.summaries.filter((project) => project.id !== id), summaryTotal: Math.max(0, state.summaryTotal - 1) }));
    },
    updateProject: (id, patch) => mutateProject(id, (project) => ({ ...project, ...patch })),
    addCharacter: (projectId, input) => mutateProject(projectId, (project) => ({ ...project, characters: [...project.characters, { ...input, id: `character-${nanoid()}` }] })),
    addScene: (projectId, input) => mutateProject(projectId, (project) => ({ ...project, scenes: [...project.scenes, { ...input, id: `scene-${nanoid()}` }] })),
    addProp: (projectId, input) => mutateProject(projectId, (project) => ({ ...project, props: [...project.props, { ...input, id: `prop-${nanoid()}` }] })),
    addClue: (projectId, input) => mutateProject(projectId, (project) => ({ ...project, clues: [...project.clues, { ...input, id: `clue-${nanoid()}` }] })),
    updateAsset: (projectId, kind, id, patch) => mutateProject(projectId, (project) => ({ ...project, [kind]: project[kind].map((item) => (item.id === id ? { ...item, ...patch, id } : item)) })),
    removeAsset: (projectId, kind, id) =>
        mutateProject(projectId, (project) => ({
            ...project,
            [kind]: project[kind].filter((item) => item.id !== id),
            episodes: project.episodes.map((episode) => ({
                ...episode,
                shots: episode.shots.map((shot) =>
                    kind === "characters"
                        ? { ...shot, characterIds: shot.characterIds.filter((value) => value !== id) }
                        : kind === "scenes"
                          ? { ...shot, sceneId: shot.sceneId === id ? undefined : shot.sceneId }
                          : kind === "props"
                            ? { ...shot, propIds: shot.propIds.filter((value) => value !== id) }
                            : { ...shot, clueIds: shot.clueIds.filter((value) => value !== id) },
                ),
            })),
        })),
    addEpisode: (projectId) =>
        mutateProject(projectId, (project) => {
            const episode: DramaEpisode = {
                id: `episode-${nanoid()}`,
                episodeNumber: project.episodes.length + 1,
                title: `第 ${project.episodes.length + 1} 集`,
                script: "",
                outline: "",
                hook: "",
                nextPreview: "",
                sourceRange: "",
                reviewStatus: "draft",
                shots: [],
            };
            return { ...project, activeEpisodeId: episode.id, episodes: [...project.episodes, episode] };
        }),
    importEpisodes: async (projectId, drafts) => {
        const session = requireSession();
        const key = sessionEpoch.key(session, projectId);
        clearProjectSave(session, projectId);
        await saveQueues.get(key)?.catch(() => undefined);
        assertCurrent(session);
        const current = get().projects.find((project) => project.id === projectId);
        if (!current || !drafts.length) return;
        const project = { ...projectWithImportedEpisodes(current, drafts), updatedAt: nextUpdatedAt(session, current) };
        set((state) => ({ saveStateByProject: { ...state.saveStateByProject, [projectId]: { status: "saving", savedAt: state.saveStateByProject[projectId]?.savedAt } } }));
        try {
            const saved = await saveDramaProject(project);
            assertCurrent(session);
            set((state) => ({
                projects: state.projects.map((item) => (item.id === saved.id ? saved : item)),
                summaries: upsertSummary(state.summaries, saved),
                syncError: undefined,
                saveStateByProject: { ...state.saveStateByProject, [projectId]: { status: "saved", savedAt: saved.updatedAt } },
            }));
        } catch (error) {
            if (sessionEpoch.isCurrent(session))
                set((state) => ({
                    syncError: error instanceof Error ? error.message : "短剧项目保存失败",
                    saveStateByProject: { ...state.saveStateByProject, [projectId]: { status: "error", savedAt: state.saveStateByProject[projectId]?.savedAt } },
                }));
            throw error;
        }
    },
    deleteEpisode: (projectId, episodeId) =>
        mutateProject(projectId, (project) => {
            if (project.episodes.length <= 1) return project;
            const episodes = project.episodes.filter((episode) => episode.id !== episodeId);
            return { ...project, episodes, activeEpisodeId: project.activeEpisodeId === episodeId ? episodes[0].id : project.activeEpisodeId };
        }),
    selectEpisode: (projectId, episodeId) => mutateProject(projectId, (project) => (project.episodes.some((episode) => episode.id === episodeId) ? { ...project, activeEpisodeId: episodeId } : project)),
    updateEpisodeNumber: (projectId, episodeId, episodeNumber) =>
        mutateProject(projectId, (project) => {
            const nextNumber = Number.isSafeInteger(episodeNumber) && episodeNumber > 0 ? episodeNumber : 1;
            const index = project.episodes.findIndex((episode) => episode.id === episodeId);
            if (index < 0) return project;
            const current = project.episodes[index];
            const currentNumber = current.episodeNumber || index + 1;
            const title = /^第\s*\d+\s*集$/u.test(current.title.trim()) && current.title.trim() === `第 ${currentNumber} 集` ? `第 ${nextNumber} 集` : current.title;
            return { ...project, episodes: project.episodes.map((episode) => (episode.id === episodeId ? { ...episode, episodeNumber: nextNumber, title } : episode)) };
        }),
    updateEpisode: (projectId, episodeId, patch) => mutateProject(projectId, (project) => ({ ...project, episodes: project.episodes.map((episode) => (episode.id === episodeId ? { ...episode, ...patch } : episode)) })),
    saveProjectNow: (projectId) => saveProjectNow(projectId),
    buildStoryboard: (projectId, episodeId) =>
        mutateProject(projectId, (project) => ({ ...project, episodes: project.episodes.map((episode) => (episode.id === episodeId ? { ...episode, shots: scriptToShots(episode.script, project), renderTask: undefined } : episode)) })),
    updateShot: (projectId, episodeId, shotId, patch) =>
        mutateProject(projectId, (project) => ({
            ...project,
            episodes: project.episodes.map((episode) => (episode.id === episodeId ? { ...episode, shots: episode.shots.map((shot) => (shot.id === shotId ? { ...shot, ...patch } : shot)) } : episode)),
        })),
    queueShots: (projectId, episodeId, shotIds) =>
        mutateProject(projectId, (project) => {
            if (project.episodes.find((episode) => episode.id === episodeId)?.reviewStatus !== "visual_ready") return project;
            return updateShots(project, episodeId, shotIds, (shot) =>
                (shot.videoMode || project.defaultVideoMode) !== "storyboard"
                    ? {
                          ...shot,
                          generationStatus: "queued",
                          generationAttempt: (shot.generationAttempt || 0) + 1,
                          generationTaskId: undefined,
                          generationError: undefined,
                          videoUrl: undefined,
                          audioStatus: "idle",
                          audioTaskId: undefined,
                          audioUrl: undefined,
                      }
                    : shot.storyboardStatus === "success" && shot.storyboardImageUrl && (shot.storyboardFrameMode !== "first_last" || (shot.storyboardEndStatus === "success" && shot.storyboardEndImageUrl))
                      ? {
                            ...shot,
                            generationStatus: "queued",
                            generationAttempt: (shot.generationAttempt || 0) + 1,
                            generationTaskId: undefined,
                            generationError: undefined,
                            videoUrl: undefined,
                            audioStatus: "idle",
                            audioTaskId: undefined,
                            audioUrl: undefined,
                        }
                      : shot.storyboardStatus === "success" && shot.storyboardImageUrl && shot.storyboardFrameMode === "first_last"
                        ? {
                              ...shot,
                              storyboardEndStatus: "queued",
                              storyboardEndAttempt: (shot.storyboardEndAttempt || 0) + 1,
                              storyboardEndTaskId: undefined,
                              storyboardEndError: undefined,
                              generationStatus: "idle",
                              generationTaskId: undefined,
                              generationError: undefined,
                              videoUrl: undefined,
                          }
                        : {
                              ...shot,
                              storyboardStatus: "queued",
                              storyboardAttempt: (shot.storyboardAttempt || 0) + 1,
                              storyboardTaskId: undefined,
                              storyboardError: undefined,
                              storyboardImageUrl: undefined,
                              storyboardEndStatus: shot.storyboardEndStatus === "success" && shot.storyboardEndImageUrl ? "success" : "idle",
                              storyboardEndTaskId: shot.storyboardEndStatus === "success" && shot.storyboardEndImageUrl ? shot.storyboardEndTaskId : undefined,
                              storyboardEndError: shot.storyboardEndStatus === "success" && shot.storyboardEndImageUrl ? undefined : shot.storyboardEndError,
                              generationStatus: "idle",
                              generationTaskId: undefined,
                              generationError: undefined,
                              videoUrl: undefined,
                              audioStatus: "idle",
                              audioTaskId: undefined,
                              audioUrl: undefined,
                          },
            );
        }),
    applyContentAnalysis: (projectId, episodeId, analysis) =>
        mutateProject(projectId, (project) => {
            const { items: characters, ids: characterIds } = mergeNamedItems(project.characters, analysis.characters, "character");
            const { items: scenes, ids: sceneIds } = mergeNamedItems(project.scenes, analysis.scenes, "scene");
            const { items: props, ids: propIds } = mergeNamedItems(project.props, analysis.props, "prop");
            const { items: clues, ids: clueIds } = mergeNamedItems(project.clues, analysis.clues, "clue");
            const episodes = project.episodes.map((episode) =>
                episode.id === episodeId
                    ? {
                          ...episode,
                          ...analysis.episode,
                          reviewStatus: "content_review" as const,
                          contentTaskId: undefined,
                          contentError: undefined,
                          visualTaskId: undefined,
                          visualError: undefined,
                          renderTask: undefined,
                          shots: analysis.shots.map((shot, index) => ({
                              id: `shot-${nanoid()}`,
                              order: index + 1,
                              title: shot.title,
                              description: shot.description,
                              sourceText: shot.sourceText,
                              shotBoundary: shot.shotBoundary,
                              dialogue: shot.dialogue,
                              narration: shot.narration,
                              utterances: shot.utterances,
                              subtitle: [shot.dialogue, shot.narration].filter(Boolean).join("\n"),
                              imagePrompt: "",
                              videoPrompt: "",
                              cameraMotion: "",
                              startFramePrompt: "",
                              endFramePrompt: "",
                              negativePrompt: "",
                              continuity: emptyContinuity(),
                              duration: shot.duration,
                              characterIds: shot.characterNames.map((name) => characterIds.get(normalizeName(name))).filter((id): id is string => Boolean(id)),
                              sceneId: sceneIds.get(normalizeName(shot.sceneName)),
                              propIds: shot.propNames.map((name) => propIds.get(normalizeName(name))).filter((id): id is string => Boolean(id)),
                              clueIds: shot.clueNames.map((name) => clueIds.get(normalizeName(name))).filter((id): id is string => Boolean(id)),
                              videoMode: project.defaultVideoMode,
                              storyboardFrameMode: "single" as const,
                              storyboardStatus: "idle" as const,
                              generationStatus: "idle" as const,
                              audioMode: "source" as const,
                              audioStatus: "idle" as const,
                          })),
                      }
                    : episode,
            );
            return { ...project, characters, scenes, props, clues, episodes };
        }),
    applyVisualAnalysis: (projectId, episodeId, analysis) =>
        mutateProject(projectId, (project) => {
            const visualByShot = new Map(analysis.shots.map((shot) => [shot.shotId, shot]));
            return {
                ...project,
                episodes: project.episodes.map((episode) =>
                    episode.id === episodeId
                        ? {
                              ...episode,
                              reviewStatus: "visual_ready" as const,
                              visualTaskId: undefined,
                              visualError: undefined,
                              renderTask: undefined,
                              shots: episode.shots.map((shot) => {
                                  const visual = visualByShot.get(shot.id);
                                  return visual
                                      ? {
                                            ...shot,
                                            imagePrompt: visual.imagePrompt,
                                            videoPrompt: visual.videoPrompt,
                                            cameraMotion: visual.cameraMotion,
                                            startFramePrompt: visual.startFramePrompt,
                                            endFramePrompt: visual.endFramePrompt,
                                            negativePrompt: visual.negativePrompt,
                                            continuity: visual.continuity,
                                            storyboardStatus: "idle" as const,
                                            storyboardTaskId: undefined,
                                            storyboardImageUrl: undefined,
                                            storyboardEndStatus: "idle" as const,
                                            storyboardEndTaskId: undefined,
                                            storyboardEndImageUrl: undefined,
                                            generationStatus: "idle" as const,
                                            generationTaskId: undefined,
                                            videoUrl: undefined,
                                        }
                                      : shot;
                              }),
                          }
                        : episode,
                ),
            };
        }),
    replaceProject: (project) => set((state) => ({ projects: state.projects.map((item) => (item.id === project.id ? project : item)), summaries: upsertSummary(state.summaries, project) })),
    createVersion: async (project, reason) => {
        await createDramaProjectVersion(project, reason);
    },
    listVersions: (projectId) => listDramaProjectVersions(projectId),
    restoreVersion: async (projectId, versionId) => {
        const session = requireSession();
        const key = sessionEpoch.key(session, projectId);
        clearProjectSave(session, projectId);
        suspendedSaves.add(key);
        try {
            await saveQueues.get(key)?.catch(() => undefined);
            assertCurrent(session);
            const project = await restoreDramaProjectVersion(projectId, versionId);
            assertCurrent(session);
            latestProjectTimes.set(key, Date.parse(project.updatedAt) || Date.now());
            set((state) => ({ projects: state.projects.map((item) => (item.id === project.id ? project : item)), summaries: upsertSummary(state.summaries, project) }));
        } finally {
            suspendedSaves.delete(key);
        }
    },
    queueAudio: (projectId, episodeId, shotIds) =>
        mutateProject(projectId, (project) =>
            updateShots(project, episodeId, shotIds, (shot) =>
                shot.videoUrl && (shot.subtitle || shot.dialogue).trim() ? { ...shot, audioMode: "voiceover", audioStatus: "queued", audioAttempt: (shot.audioAttempt || 0) + 1, audioTaskId: undefined, audioError: undefined, audioUrl: undefined } : shot,
            ),
        ),
    reset: () => {
        invalidateSession();
        set({ hydrated: false, hydratedUserId: "", summaries: [], summaryTotal: 0, summaryPage: 0, summaryPageSize: SUMMARY_PAGE_SIZE, summaryLoadingMore: false, projects: [], syncError: undefined, saveStateByProject: {} });
    },
}));

function mutateProject(projectId: string, updater: (project: DramaProject) => DramaProject) {
    const session = sessionEpoch.capture();
    if (!session.userId) return;
    let nextProject: DramaProject | undefined;
    useDramaStore.setState((state) => {
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

async function saveProjectNow(projectId: string) {
    const session = requireSession();
    const key = sessionEpoch.key(session, projectId);
    clearProjectSave(session, projectId);
    const previous = saveQueues.get(key) || Promise.resolve();
    const operation = previous.then(async () => {
        assertCurrent(session);
        clearProjectSave(session, projectId);
        const project = useDramaStore.getState().projects.find((item) => item.id === projectId);
        if (!project) throw new Error("短剧项目不存在");
        try {
            const saved = await saveDramaProject(project);
            assertCurrent(session);
            useDramaStore.setState((state) => ({
                projects: state.projects.map((item) => (item.id === saved.id && item.updatedAt === project.updatedAt ? saved : item)),
                summaries: upsertSummary(state.summaries, saved),
                syncError: undefined,
                saveStateByProject: state.projects.find((item) => item.id === projectId)?.updatedAt === project.updatedAt ? { ...state.saveStateByProject, [projectId]: { status: "saved", savedAt: saved.updatedAt } } : state.saveStateByProject,
            }));
        } catch (error) {
            if (sessionEpoch.isCurrent(session))
                useDramaStore.setState((state) => ({
                    syncError: error instanceof Error ? error.message : "短剧项目保存失败",
                    saveStateByProject: { ...state.saveStateByProject, [projectId]: { status: "error", savedAt: state.saveStateByProject[projectId]?.savedAt } },
                }));
            throw error;
        }
    });
    saveQueues.set(key, operation);
    try {
        await operation;
    } finally {
        if (saveQueues.get(key) === operation) saveQueues.delete(key);
    }
}

function updateShots(project: DramaProject, episodeId: string, shotIds: string[], update: (shot: DramaShot) => DramaShot) {
    const selected = new Set(shotIds);
    return {
        ...project,
        episodes: project.episodes.map((episode) => {
            if (episode.id !== episodeId) return episode;
            if (episode.renderTask && (episode.renderTask.status === "pending" || episode.renderTask.status === "running")) return episode;
            return { ...episode, renderTask: undefined, shots: episode.shots.map((shot) => (selected.has(shot.id) && !hasActiveShotTask(shot) ? update(shot) : shot)) };
        }),
    };
}

function mergeNamedItems<T extends { id: string; name: string }>(existing: T[], incoming: Array<Omit<T, "id">>, prefix: string) {
    const items = existing.map((item) => ({ ...item }));
    const ids = new Map(existing.map((item) => [normalizeName(item.name), item.id]));
    for (const item of incoming) {
        const name = normalizeName(item.name);
        if (!name) continue;
        const existingIndex = items.findIndex((current) => normalizeName(current.name) === name);
        if (existingIndex >= 0) {
            const id = items[existingIndex].id;
            items[existingIndex] = { ...items[existingIndex], ...item, id };
            ids.set(name, id);
            continue;
        }
        const id = `${prefix}-${nanoid()}`;
        items.push({ ...item, id } as T);
        ids.set(name, id);
    }
    return { items, ids };
}

function normalizeName(value: string) {
    return value.trim().toLocaleLowerCase();
}

function hasActiveShotTask(shot: DramaShot) {
    return [shot.storyboardStatus, shot.storyboardEndStatus, shot.generationStatus, shot.audioStatus].some((status) => status === "queued" || status === "running");
}

export function projectWithImportedEpisodes(project: DramaProject, drafts: DramaSourceEpisodeDraft[], episodeId = () => `episode-${nanoid()}`): DramaProject {
    const episodes = drafts.map<DramaEpisode>((draft, index) => ({
        id: episodeId(),
        episodeNumber: index + 1,
        title: draft.title || `第 ${index + 1} 集`,
        script: draft.script,
        outline: "",
        hook: "",
        nextPreview: "",
        sourceRange: draft.sourceRange,
        reviewStatus: "draft",
        shots: [],
    }));
    return episodes.length ? { ...project, activeEpisodeId: episodes[0].id, episodes } : project;
}

function queueSave(session: ClientSessionStamp, project: DramaProject) {
    const key = sessionEpoch.key(session, project.id);
    if (suspendedSaves.has(key)) return;
    useDramaStore.setState((state) => ({ saveStateByProject: { ...state.saveStateByProject, [project.id]: { status: "saving", savedAt: state.saveStateByProject[project.id]?.savedAt } } }));
    clearProjectSave(session, project.id);
    saveTimers.set(
        key,
        setTimeout(() => {
            saveTimers.delete(key);
            if (!sessionEpoch.isCurrent(session)) return;
            const previous = saveQueues.get(key) || Promise.resolve();
            const operation = previous.then(async () => {
                if (!sessionEpoch.isCurrent(session)) return;
                try {
                    const saved = await saveDramaProject(project);
                    if (!sessionEpoch.isCurrent(session)) return;
                    useDramaStore.setState((state) => ({
                        projects: state.projects.map((item) => (item.id === saved.id && item.updatedAt === project.updatedAt ? saved : item)),
                        summaries: upsertSummary(state.summaries, saved),
                        syncError: undefined,
                        saveStateByProject: state.projects.find((item) => item.id === project.id)?.updatedAt === project.updatedAt ? { ...state.saveStateByProject, [project.id]: { status: "saved", savedAt: saved.updatedAt } } : state.saveStateByProject,
                    }));
                } catch (error) {
                    if (!sessionEpoch.isCurrent(session)) return;
                    const latest = useDramaStore.getState().projects.find((item) => item.id === project.id);
                    if (latest?.updatedAt === project.updatedAt)
                        useDramaStore.setState((state) => ({
                            syncError: error instanceof Error ? error.message : "短剧项目保存失败",
                            saveStateByProject: { ...state.saveStateByProject, [project.id]: { status: "error", savedAt: state.saveStateByProject[project.id]?.savedAt } },
                        }));
                }
            });
            saveQueues.set(key, operation);
            void operation.finally(() => {
                if (saveQueues.get(key) === operation) saveQueues.delete(key);
            });
        }, 250),
    );
}

function nextUpdatedAt(session: ClientSessionStamp, project: DramaProject) {
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
    suspendedSaves.clear();
    latestProjectTimes.clear();
    projectRequests.clear();
}

function upsertSummary(summaries: DramaProjectSummary[], project: DramaProject) {
    const summary = summarizeDramaProject(project);
    return [summary, ...summaries.filter((item) => item.id !== project.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function scriptToShots(script: string, project: DramaProject): DramaShot[] {
    return script
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((text, index) => {
            const context = [project.style, project.summary, text].filter(Boolean).join("，");
            return {
                id: `shot-${nanoid()}`,
                order: index + 1,
                title: `镜头 ${String(index + 1).padStart(2, "0")}`,
                description: text,
                sourceText: text,
                shotBoundary: "段落边界",
                dialogue: "",
                narration: "",
                utterances: [],
                imagePrompt: `${context}，角色与画风保持一致，电影分镜画面`,
                videoPrompt: `${context}，镜头运动自然，人物动作连续，保持角色一致性`,
                cameraMotion: "自然镜头运动",
                startFramePrompt: text,
                endFramePrompt: text,
                negativePrompt: "文字、水印、角色身份漂移、服装变化、错误肢体",
                continuity: emptyContinuity(),
                duration: 5,
                characterIds: [],
                propIds: [],
                clueIds: [],
                sceneId: project.scenes[0]?.id,
                videoMode: project.defaultVideoMode,
                storyboardFrameMode: "single",
                storyboardStatus: "idle",
                generationStatus: "idle",
                audioMode: "source",
                audioStatus: "idle",
            };
        });
}

function emptyContinuity() {
    return {
        shotSize: "",
        cameraAngle: "",
        composition: "",
        characterBlocking: "",
        gazeDirection: "",
        actionStart: "",
        actionEnd: "",
        screenDirection: "",
        axisRule: "",
        continuityNotes: "",
    };
}
