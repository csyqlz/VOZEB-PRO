import { nanoid } from "nanoid";

import {
    DRAMA_PROJECT_MAX_BYTES,
    type CreateDramaProjectInput,
    type DramaAssetProfile,
    type DramaAssetReference,
    type DramaEpisode,
    type DramaNamedAsset,
    type DramaProject,
    type DramaShot,
    type DramaShotContinuity,
    type DramaUtterance,
    type DramaVideoMode,
} from "@/lib/drama-project-contract";
import { dramaRichContentToPlainText, normalizeDramaScriptRichContent } from "@/lib/drama-script-rich-content";
import { normalizeDramaImageSize } from "@/lib/drama-image-size";
import { normalizeDramaVisualAnalysis } from "@/lib/server/drama-analysis";
import { resolveDramaShotDuration } from "@/lib/server/drama-shot-config";
import { listAgentRuns } from "@/lib/server/agent-run-store";
import { CreativeEntityDeletionConflict, deleteDramaConversationAggregate } from "@/lib/server/creative-entity-deletion-store";
import { createCreativeConversation, getCreativeConversation, listCreativeConversations, updateCreativeConversation } from "@/lib/server/creative-runtime-store";
import {
    applyDramaVisualResult,
    assignDramaContentTask,
    assignDramaVisualTask,
    createDramaProject,
    deleteDramaProject,
    DramaProjectStoreError,
    findDramaProjectBySourceHandoffId,
    getDramaProject,
    listDramaProjectSummaries,
    updateDramaProject,
} from "@/lib/server/drama-project-store";
import { createDramaProjectVersion, getDramaProjectVersion, listDramaProjectVersions } from "@/lib/server/drama-project-version-store";
import { collectLocalMediaStorageKeys } from "@/lib/server/local-media-references";
import { deleteUserMediaAssetsCascade } from "@/lib/server/user-media-deletion-service";

export class DramaProjectServiceError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}

export function listDramaProjectSummariesForUser(userId: string, input: { page?: number; pageSize?: number } = {}) {
    return listDramaProjectSummaries(userId, input);
}

export async function getDramaProjectForUser(userId: string, id: string) {
    const project = await getDramaProject(cleanText(id), userId);
    if (!project) throw new DramaProjectServiceError("短剧项目不存在", 404);
    return project;
}

export async function createDramaProjectForUser(userId: string, value: unknown) {
    const input = normalizeCreateInput(value);
    const now = new Date().toISOString();
    if (input.sourceHandoffId) {
        const existing = await findDramaProjectBySourceHandoffId(userId, input.sourceHandoffId);
        if (existing) return existing;
    }
    const projectId = input.sourceHandoffId ? `drama-${input.sourceHandoffId}` : `drama-${nanoid()}`;
    const episode: DramaEpisode = {
        id: `episode-${nanoid()}`,
        episodeNumber: 1,
        title: "第 1 集",
        script: input.initialScript,
        outline: "",
        hook: "",
        nextPreview: "",
        sourceRange: "",
        reviewStatus: "draft",
        shots: [],
    };
    const conversation = await createCreativeConversation(userId, { surface: "drama", projectId, title: input.title });
    const project: DramaProject = {
        id: projectId,
        sourceHandoffId: input.sourceHandoffId,
        title: input.title,
        summary: input.summary,
        style: input.style,
        ratio: input.ratio,
        status: "active",
        creativeConversationId: conversation.id,
        activeEpisodeId: episode.id,
        characters: [],
        scenes: [],
        props: [],
        clues: [],
        defaultVideoMode: input.defaultVideoMode,
        episodes: [episode],
        sourceAssets: input.sourceAssets,
        createdAt: now,
        updatedAt: now,
    };
    if (Buffer.byteLength(JSON.stringify(project)) > DRAMA_PROJECT_MAX_BYTES) throw new DramaProjectServiceError("短剧项目数据过大", 413);
    try {
        return await createDramaProject(userId, project);
    } catch (error) {
        await updateCreativeConversation(conversation.id, userId, { status: "archived" }).catch(() => null);
        throw error;
    }
}

export async function updateDramaProjectForUser(userId: string, id: string, value: unknown) {
    const current = await getDramaProjectForUser(userId, id);
    const size = Buffer.byteLength(JSON.stringify(value || {}));
    if (size > DRAMA_PROJECT_MAX_BYTES) throw new DramaProjectServiceError("短剧项目数据过大", 413);
    const incomingUpdatedAt = parseTimestamp(object(value).updatedAt);
    if (incomingUpdatedAt && incomingUpdatedAt < parseTimestamp(current.updatedAt)) return current;
    const project = normalizeProject(value, current);
    if (incomingUpdatedAt) project.updatedAt = new Date(incomingUpdatedAt).toISOString();
    try {
        return await updateDramaProject(userId, project, current.updatedAt);
    } catch (error) {
        if (error instanceof DramaProjectStoreError) throw new DramaProjectServiceError(error.message, error.status);
        throw error;
    }
}

export async function assignDramaContentTaskForUser(userId: string, projectId: string, episodeId: string, taskId: string) {
    try {
        return await assignDramaContentTask(userId, cleanText(projectId), cleanText(episodeId), cleanText(taskId));
    } catch (error) {
        if (error instanceof DramaProjectStoreError) throw new DramaProjectServiceError(error.message, error.status);
        throw error;
    }
}

export async function assignDramaVisualTaskForUser(userId: string, projectId: string, episodeId: string, taskId: string) {
    try {
        return await assignDramaVisualTask(userId, cleanText(projectId), cleanText(episodeId), cleanText(taskId));
    } catch (error) {
        if (error instanceof DramaProjectStoreError) throw new DramaProjectServiceError(error.message, error.status);
        throw error;
    }
}

export async function applyDramaVisualResultForUser(userId: string, projectIdValue: string, episodeIdValue: string, value: unknown) {
    const projectId = cleanText(projectIdValue);
    const episodeId = cleanText(episodeIdValue);
    const input = object(value);
    const taskId = cleanText(input.taskId);
    if (!taskId) throw new DramaProjectServiceError("视觉任务标识无效", 400);
    const current = await getDramaProjectForUser(userId, projectId);
    const episode = current.episodes.find((item) => item.id === episodeId);
    if (!episode) throw new DramaProjectServiceError("短剧剧集不存在", 404);
    const analysis = normalizeDramaVisualAnalysis(
        input.analysis,
        episode.shots.map((shot) => shot.id),
    );
    if (analysis.shots.length !== episode.shots.length) throw new DramaProjectServiceError("视觉方案镜头不完整，未保存任何结果", 422);
    try {
        return await applyDramaVisualResult(userId, projectId, episodeId, taskId, analysis);
    } catch (error) {
        if (error instanceof DramaProjectStoreError) throw new DramaProjectServiceError(error.message, error.status);
        throw error;
    }
}

export async function listDramaProjectVersionsForUser(userId: string, id: string) {
    await getDramaProjectForUser(userId, cleanText(id));
    return listDramaProjectVersions(userId, cleanText(id));
}

export async function createDramaProjectVersionForUser(userId: string, id: string, value: unknown) {
    const current = await getDramaProjectForUser(userId, cleanText(id));
    const input = object(value);
    const snapshot = normalizeProject(input.snapshot, current);
    if (Buffer.byteLength(JSON.stringify(snapshot)) > DRAMA_PROJECT_MAX_BYTES) throw new DramaProjectServiceError("短剧版本数据过大", 413);
    const reason = cleanText(input.reason) || "手动保存版本";
    return createDramaProjectVersion(userId, current.id, reason, snapshot);
}

export async function restoreDramaProjectVersionForUser(userId: string, id: string, versionId: string) {
    const projectId = cleanText(id);
    const current = await getDramaProjectForUser(userId, projectId);
    const version = await getDramaProjectVersion(userId, projectId, cleanText(versionId));
    if (!version) throw new DramaProjectServiceError("短剧版本不存在", 404);
    await createDramaProjectVersion(userId, projectId, "恢复前自动快照", current);
    try {
        return await updateDramaProject(userId, normalizeProject(version.snapshot, current), current.updatedAt);
    } catch (error) {
        if (error instanceof DramaProjectStoreError) throw new DramaProjectServiceError(error.message, error.status);
        throw error;
    }
}

export async function deleteDramaProjectForUser(userId: string, id: string) {
    const projectId = cleanText(id);
    const current = await getDramaProject(projectId, userId);
    const deleted = await deleteDramaProject(userId, projectId);
    if (!deleted) throw new DramaProjectServiceError("短剧项目不存在", 404);
    if (current?.creativeConversationId) await updateCreativeConversation(current.creativeConversationId, userId, { status: "archived" });
    if (current) await deleteUserMediaAssetsCascade(userId, collectLocalMediaStorageKeys(current));
}

export async function deleteDramaAgentConversationForUser(userId: string, projectIdValue: string, conversationIdValue: unknown) {
    const project = await getDramaProjectForUser(userId, projectIdValue);
    const conversationId = cleanText(conversationIdValue);
    if (!conversationId) throw new DramaProjectServiceError("请选择要删除的对话", 400);
    const conversation = await getCreativeConversation(conversationId, userId);
    if (!conversation || conversation.surface !== "drama" || conversation.projectId !== project.id) throw new DramaProjectServiceError("Agent 对话与当前短剧项目不匹配", 409);

    const activeRuns = await listAgentRuns({ userId, conversationId, surface: "drama", statuses: ["planning", "running", "paused"], limit: 1 });
    if (activeRuns.length) throw new DramaProjectServiceError("运行中的对话需先停止任务再删除", 409);

    let replacementConversationId: string | undefined;
    let createdReplacement = false;
    if (project.creativeConversationId === conversationId) {
        const candidates = await listCreativeConversations(userId, { surface: "drama", source: "drama", projectId: project.id, status: "active", limit: 2 });
        let replacement = candidates.find((item) => item.id !== conversationId);
        if (!replacement) {
            replacement = await createCreativeConversation(userId, { surface: "drama", source: "drama", projectId: project.id, title: "新对话" });
            createdReplacement = true;
        }
        replacementConversationId = replacement.id;
    }

    let result: Awaited<ReturnType<typeof deleteDramaConversationAggregate>>;
    try {
        result = await deleteDramaConversationAggregate(userId, project.id, conversationId, replacementConversationId);
    } catch (error) {
        if (createdReplacement && replacementConversationId) await updateCreativeConversation(replacementConversationId, userId, { status: "archived" }).catch(() => null);
        if (error instanceof CreativeEntityDeletionConflict) throw new DramaProjectServiceError(error.message, 409);
        throw error;
    }
    await deleteUserMediaAssetsCascade(userId, result.mediaStorageKeys);
    const updatedProject = result.dramaProject || project;
    return { deleted: result.deletedConversations > 0, activeConversationId: updatedProject.creativeConversationId || "", project: updatedProject };
}

function normalizeCreateInput(value: unknown): Required<Omit<CreateDramaProjectInput, "sourceAssets" | "sourceHandoffId">> & Pick<CreateDramaProjectInput, "sourceAssets" | "sourceHandoffId"> {
    const input = object(value);
    const title = cleanText(input.title);
    if (!title) throw new DramaProjectServiceError("项目名称不能为空", 400);
    const ratio = input.ratio === undefined ? "9:16" : normalizeDramaImageSize(input.ratio);
    if (!ratio) throw new DramaProjectServiceError("短剧尺寸无效", 400);
    return {
        title,
        sourceHandoffId: optionalText(input.sourceHandoffId),
        summary: cleanText(input.summary),
        style: cleanText(input.style) || "电影感国漫",
        ratio,
        initialScript: cleanText(input.initialScript),
        sourceAssets: normalizeSourceAssets(input.sourceAssets),
        defaultVideoMode: videoMode(input.defaultVideoMode),
    };
}

export function normalizeProject(value: unknown, current: DramaProject): DramaProject {
    const input = object(value);
    const episodes = array(input.episodes)
        .map((value, index) => normalizeEpisode(value, index))
        .filter((episode): episode is DramaEpisode => Boolean(episode));
    if (!episodes.length) throw new DramaProjectServiceError("短剧项目至少需要一集", 400);
    const activeEpisodeId = cleanText(input.activeEpisodeId);
    const ratio = input.ratio === undefined ? normalizeDramaImageSize(current.ratio) : normalizeDramaImageSize(input.ratio);
    if (!ratio) throw new DramaProjectServiceError("短剧尺寸无效", 400);
    return {
        id: current.id,
        sourceHandoffId: current.sourceHandoffId,
        title: cleanText(input.title) || current.title,
        summary: cleanText(input.summary),
        style: cleanText(input.style),
        ratio,
        status: input.status === "archived" ? "archived" : "active",
        creativeConversationId: current.creativeConversationId,
        activeEpisodeId: episodes.some((episode) => episode.id === activeEpisodeId) ? activeEpisodeId : episodes[0].id,
        characters: normalizeNamedAssets(input.characters, "character", true),
        scenes: normalizeNamedAssets(input.scenes, "scene"),
        props: normalizeNamedAssets(input.props, "prop"),
        clues: normalizeClues(input.clues),
        defaultVideoMode: videoMode(input.defaultVideoMode),
        episodes,
        sourceAssets: normalizeSourceAssets(input.sourceAssets),
        createdAt: current.createdAt,
        updatedAt: nextTimestamp(current.updatedAt),
    };
}

function normalizeEpisode(value: unknown, index: number): DramaEpisode | null {
    const input = object(value);
    const id = cleanText(input.id);
    if (!id) return null;
    const render = object(input.renderTask);
    const renderStatus = render.status;
    const renderTask =
        cleanText(render.id) && ["pending", "running", "success", "error", "cancelled"].includes(String(renderStatus))
            ? {
                  id: cleanText(render.id),
                  status: renderStatus as "pending" | "running" | "success" | "error" | "cancelled",
                  result: stableUrl(object(render.result).url) ? { url: stableUrl(object(render.result).url) } : undefined,
                  error: optionalText(render.error),
              }
            : undefined;
    const script = cleanText(input.script);
    const scriptRichContent = normalizeDramaScriptRichContent(input.scriptRichContent);
    return {
        id,
        episodeNumber: optionalPositiveInteger(input.episodeNumber) || index + 1,
        title: cleanText(input.title) || "未命名剧集",
        script: scriptRichContent ? dramaRichContentToPlainText(scriptRichContent).trim() : script,
        scriptRichContent,
        outline: cleanText(input.outline),
        hook: cleanText(input.hook),
        nextPreview: cleanText(input.nextPreview),
        sourceRange: cleanText(input.sourceRange),
        reviewStatus: reviewStatus(input.reviewStatus),
        contentTaskId: optionalText(input.contentTaskId),
        contentError: optionalText(input.contentError),
        visualTaskId: optionalText(input.visualTaskId),
        visualCompletedTaskId: optionalText(input.visualCompletedTaskId),
        visualError: optionalText(input.visualError),
        shots: array(input.shots).map(normalizeShot),
        renderTask,
        visualReview: normalizeVisualReview(input.visualReview),
    };
}

function normalizeVisualReview(value: unknown): DramaEpisode["visualReview"] {
    const input = object(value);
    const mode = input.mode === "visual" || input.mode === "text" || input.mode === "unavailable" ? input.mode : null;
    const status = input.status === "passed" || input.status === "needs_revision" || input.status === "unavailable" ? input.status : null;
    const summary = cleanText(input.summary);
    if (!mode || !status || !summary) return undefined;
    const scoreValue = Number(input.score);
    const issues = array(input.issues).flatMap((item) => {
        const issue = object(item);
        const category = cleanText(issue.category);
        const message = cleanText(issue.message);
        if (!category || !message) return [];
        const severity: "low" | "medium" | "high" = issue.severity === "high" || issue.severity === "medium" ? issue.severity : "low";
        return [
            {
                taskId: optionalText(issue.taskId),
                category,
                severity,
                message,
                correction: optionalText(issue.correction),
            },
        ];
    });
    return {
        mode,
        status,
        score: Number.isFinite(scoreValue) ? Math.max(0, Math.min(100, Math.round(scoreValue))) : undefined,
        summary,
        issues,
        retryTaskIds: ids(input.retryTaskIds),
    };
}

function normalizeShot(value: unknown, index: number): DramaShot {
    const input = object(value);
    return {
        id: cleanText(input.id) || `shot-${nanoid()}`,
        order: Math.max(1, Math.floor(Number(input.order) || index + 1)),
        title: cleanText(input.title) || `镜头 ${index + 1}`,
        description: cleanText(input.description),
        sourceText: cleanText(input.sourceText),
        shotBoundary: cleanText(input.shotBoundary),
        dialogue: cleanText(input.dialogue),
        narration: cleanText(input.narration),
        utterances: normalizeUtterances(input.utterances),
        imagePrompt: cleanText(input.imagePrompt),
        videoPrompt: cleanText(input.videoPrompt),
        cameraMotion: cleanText(input.cameraMotion),
        startFramePrompt: optionalText(input.startFramePrompt),
        endFramePrompt: optionalText(input.endFramePrompt),
        negativePrompt: optionalText(input.negativePrompt),
        continuity: normalizeContinuity(input.continuity),
        duration: resolveDramaShotDuration(input.duration, 5),
        characterIds: array(input.characterIds)
            .map((id) => cleanText(id))
            .filter(Boolean),
        propIds: ids(input.propIds),
        clueIds: ids(input.clueIds),
        sceneId: optionalText(input.sceneId),
        videoMode: videoMode(input.videoMode),
        storyboardFrameMode: input.storyboardFrameMode === "first_last" ? "first_last" : "single",
        storyboardStatus: taskStatus(input.storyboardStatus),
        storyboardAttempt: optionalPositiveInteger(input.storyboardAttempt),
        storyboardTaskId: optionalText(input.storyboardTaskId),
        storyboardError: optionalText(input.storyboardError),
        storyboardImageUrl: stableUrl(input.storyboardImageUrl),
        storyboardImageWidth: optionalPositiveInteger(input.storyboardImageWidth),
        storyboardImageHeight: optionalPositiveInteger(input.storyboardImageHeight),
        storyboardEndStatus: taskStatus(input.storyboardEndStatus),
        storyboardEndAttempt: optionalPositiveInteger(input.storyboardEndAttempt),
        storyboardEndTaskId: optionalText(input.storyboardEndTaskId),
        storyboardEndError: optionalText(input.storyboardEndError),
        storyboardEndImageUrl: stableUrl(input.storyboardEndImageUrl),
        storyboardEndImageWidth: optionalPositiveInteger(input.storyboardEndImageWidth),
        storyboardEndImageHeight: optionalPositiveInteger(input.storyboardEndImageHeight),
        generationStatus: taskStatus(input.generationStatus),
        generationAttempt: optionalPositiveInteger(input.generationAttempt),
        generationTaskId: optionalText(input.generationTaskId),
        generationError: optionalText(input.generationError),
        videoUrl: stableUrl(input.videoUrl),
        subtitle: optionalText(input.subtitle),
        audioMode: input.audioMode === "voiceover" || input.audioMode === "mute" ? input.audioMode : "source",
        audioStatus: taskStatus(input.audioStatus),
        audioAttempt: optionalPositiveInteger(input.audioAttempt),
        audioTaskId: optionalText(input.audioTaskId),
        audioError: optionalText(input.audioError),
        audioUrl: stableUrl(input.audioUrl),
    };
}

function normalizeNamedAssets(value: unknown, prefix: string, character = false): DramaNamedAsset[] {
    return array(value)
        .map((item) => {
            const input = object(item);
            const id = cleanText(input.id) || `${prefix}-${nanoid()}`;
            const references = normalizeAssetReferences(input.references, id, input.referenceImageUrl, input.referenceStorageKey);
            const primaryReferenceId = references.some((reference) => reference.id === input.primaryReferenceId) ? String(input.primaryReferenceId) : references[0]?.id;
            const primaryReference = references.find((reference) => reference.id === primaryReferenceId);
            return {
                id,
                name: cleanText(input.name),
                description: cleanText(input.description),
                profile: normalizeAssetProfile(input.profile),
                references,
                primaryReferenceId,
                referenceImageUrl: primaryReference?.url,
                referenceStorageKey: primaryReference?.storageKey,
                ...(character ? { voiceProfile: normalizeVoiceProfile(input.voiceProfile) } : {}),
            };
        })
        .filter((item) => item.name);
}

function normalizeClues(value: unknown) {
    return array(value).flatMap((item) => {
        const input = object(item);
        const name = cleanText(input.name);
        if (!name) return [];
        const id = cleanText(input.id) || `clue-${nanoid()}`;
        const references = normalizeAssetReferences(input.references, id, input.referenceImageUrl, input.referenceStorageKey);
        const primaryReferenceId = references.some((reference) => reference.id === input.primaryReferenceId) ? String(input.primaryReferenceId) : references[0]?.id;
        const primaryReference = references.find((reference) => reference.id === primaryReferenceId);
        return [
            {
                id,
                name,
                description: cleanText(input.description),
                profile: normalizeAssetProfile(input.profile),
                references,
                primaryReferenceId,
                payoff: cleanText(input.payoff),
                referenceImageUrl: primaryReference?.url,
                referenceStorageKey: primaryReference?.storageKey,
            },
        ];
    });
}

function normalizeAssetProfile(value: unknown): DramaAssetProfile {
    const input = object(value);
    return {
        visualIdentity: cleanText(input.visualIdentity),
        styling: cleanText(input.styling),
        colorPalette: cleanText(input.colorPalette),
        consistencyRules: cleanText(input.consistencyRules),
    };
}

function normalizeAssetReferences(value: unknown, assetId: string, legacyUrl: unknown, legacyStorageKey: unknown): DramaAssetReference[] {
    const references = array(value).flatMap((item, index) => {
        const input = object(item);
        const url = stableUrl(input.url);
        if (!url) return [];
        const source: DramaAssetReference["source"] = input.source === "generated" || input.source === "library" ? input.source : "upload";
        return [
            {
                id: cleanText(input.id) || `${assetId}-reference-${index + 1}`,
                url,
                storageKey: optionalText(input.storageKey),
                source,
                label: cleanText(input.label) || `参考图 ${index + 1}`,
                width: optionalPositiveInteger(input.width),
                height: optionalPositiveInteger(input.height),
                createdAt: timestamp(input.createdAt) || new Date(0).toISOString(),
            },
        ];
    });
    const url = stableUrl(legacyUrl);
    if (!references.length && url) references.push({ id: `${assetId}-reference-legacy`, url, storageKey: optionalText(legacyStorageKey), source: "library", label: "原参考图", width: undefined, height: undefined, createdAt: new Date(0).toISOString() });
    return references;
}

function normalizeVoiceProfile(value: unknown) {
    const input = object(value);
    return {
        voice: cleanText(input.voice),
        speed: Math.max(0.25, Math.min(4, Number(input.speed) || 1)),
        instructions: cleanText(input.instructions),
    };
}

function normalizeContinuity(value: unknown): DramaShotContinuity {
    const input = object(value);
    return {
        shotSize: cleanText(input.shotSize),
        cameraAngle: cleanText(input.cameraAngle),
        composition: cleanText(input.composition),
        characterBlocking: cleanText(input.characterBlocking),
        gazeDirection: cleanText(input.gazeDirection),
        actionStart: cleanText(input.actionStart),
        actionEnd: cleanText(input.actionEnd),
        screenDirection: cleanText(input.screenDirection),
        axisRule: cleanText(input.axisRule),
        continuityNotes: cleanText(input.continuityNotes),
    };
}

function normalizeUtterances(value: unknown): DramaUtterance[] {
    return array(value)
        .map((item, index) => {
            const input = object(item);
            return {
                id: cleanText(input.id) || `utterance-${nanoid()}`,
                order: Math.max(1, Math.floor(Number(input.order) || index + 1)),
                type: input.type === "voiceover" ? "voiceover" : "dialogue",
                speaker: cleanText(input.speaker),
                text: cleanText(input.text),
            } as DramaUtterance;
        })
        .filter((item) => item.text);
}

function ids(value: unknown) {
    return array(value)
        .map((id) => cleanText(id))
        .filter(Boolean);
}

function reviewStatus(value: unknown): DramaEpisode["reviewStatus"] {
    return value === "content_review" || value === "approved" || value === "visual_ready" ? value : "draft";
}

function videoMode(value: unknown): DramaVideoMode {
    return value === "direct" || value === "reference" ? value : "storyboard";
}

function normalizeSourceAssets(value: unknown) {
    return array(value).map((item) => {
        const asset = object(item);
        const type = ["text", "image", "video", "audio"].includes(String(asset.type)) ? (asset.type as "text" | "image" | "video" | "audio") : "text";
        return {
            id: cleanText(asset.id) || `source-${nanoid()}`,
            type,
            title: cleanText(asset.title) || "创作素材",
            textContent: type === "text" ? optionalText(asset.textContent) : undefined,
            storageKey: optionalText(asset.storageKey),
            remoteUrl: stableUrl(asset.remoteUrl),
            serverUrl: stableUrl(asset.serverUrl),
            mimeType: optionalText(asset.mimeType),
            width: optionalPositiveInteger(asset.width),
            height: optionalPositiveInteger(asset.height),
        };
    });
}

function taskStatus(value: unknown) {
    return ["idle", "queued", "running", "success", "error", "cancelled"].includes(String(value)) ? (value as DramaShot["generationStatus"]) : undefined;
}

function optionalPositiveInteger(value: unknown) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number > 0 ? number : undefined;
}

function stableUrl(value: unknown) {
    const text = cleanText(value);
    return text && !text.startsWith("data:") && !text.startsWith("blob:") ? text : undefined;
}

function optionalText(value: unknown) {
    return cleanText(value) || undefined;
}

function cleanText(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function parseTimestamp(value: unknown) {
    const time = Date.parse(String(value || ""));
    return Number.isFinite(time) ? time : 0;
}

function nextTimestamp(previous: string) {
    return new Date(Math.max(Date.now(), parseTimestamp(previous) + 1)).toISOString();
}

function timestamp(value: unknown) {
    const time = parseTimestamp(value);
    return time ? new Date(time).toISOString() : "";
}

function object(value: unknown) {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function array(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}
