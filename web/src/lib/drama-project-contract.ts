export const DRAMA_PROJECT_MAX_BYTES = 8 * 1024 * 1024;

export type DramaTaskStatus = "idle" | "queued" | "running" | "success" | "error" | "cancelled";
export type DramaReviewStatus = "draft" | "content_review" | "approved" | "visual_ready";
export type DramaVideoMode = "storyboard" | "direct" | "reference";
export type DramaStoryboardFrameMode = "single" | "first_last";
export type DramaShotAudioMode = "source" | "voiceover" | "mute";

export type DramaAssetReference = {
    id: string;
    url: string;
    storageKey?: string;
    source: "upload" | "generated" | "library";
    label: string;
    width?: number;
    height?: number;
    createdAt: string;
};

export type DramaAssetProfile = {
    visualIdentity: string;
    styling: string;
    colorPalette: string;
    consistencyRules: string;
};

export type DramaVoiceProfile = {
    voice: string;
    speed: number;
    instructions: string;
};

export type DramaNamedAsset = {
    id: string;
    name: string;
    description: string;
    profile?: DramaAssetProfile;
    references?: DramaAssetReference[];
    primaryReferenceId?: string;
    referenceImageUrl?: string;
    referenceStorageKey?: string;
};

export type DramaCharacter = DramaNamedAsset & { voiceProfile?: DramaVoiceProfile };
export type DramaScene = DramaNamedAsset;
export type DramaProp = DramaNamedAsset;
export type DramaClue = DramaNamedAsset & { payoff: string };

export type DramaShotContinuity = {
    shotSize: string;
    cameraAngle: string;
    composition: string;
    characterBlocking: string;
    gazeDirection: string;
    actionStart: string;
    actionEnd: string;
    screenDirection: string;
    axisRule: string;
    continuityNotes: string;
};

export type DramaUtterance = {
    id: string;
    order: number;
    type: "dialogue" | "voiceover";
    speaker: string;
    text: string;
};

export type DramaShot = {
    id: string;
    order: number;
    title: string;
    description: string;
    sourceText: string;
    shotBoundary: string;
    dialogue: string;
    narration: string;
    utterances: DramaUtterance[];
    imagePrompt: string;
    videoPrompt: string;
    cameraMotion: string;
    startFramePrompt?: string;
    endFramePrompt?: string;
    negativePrompt?: string;
    continuity?: DramaShotContinuity;
    duration: number;
    characterIds: string[];
    propIds: string[];
    clueIds: string[];
    sceneId?: string;
    videoMode?: DramaVideoMode;
    storyboardStatus?: DramaTaskStatus;
    storyboardFrameMode?: DramaStoryboardFrameMode;
    storyboardAttempt?: number;
    storyboardTaskId?: string;
    storyboardError?: string;
    storyboardImageUrl?: string;
    storyboardImageWidth?: number;
    storyboardImageHeight?: number;
    storyboardEndStatus?: DramaTaskStatus;
    storyboardEndAttempt?: number;
    storyboardEndTaskId?: string;
    storyboardEndError?: string;
    storyboardEndImageUrl?: string;
    storyboardEndImageWidth?: number;
    storyboardEndImageHeight?: number;
    generationStatus?: DramaTaskStatus;
    generationAttempt?: number;
    generationTaskId?: string;
    generationError?: string;
    videoUrl?: string;
    subtitle?: string;
    audioMode?: DramaShotAudioMode;
    audioStatus?: DramaTaskStatus;
    audioAttempt?: number;
    audioTaskId?: string;
    audioError?: string;
    audioUrl?: string;
};

export type DramaRenderTask = {
    id: string;
    status: "pending" | "running" | "success" | "error" | "cancelled";
    result?: { url?: string };
    error?: string;
};

export type DramaVisualReview = {
    mode: "visual" | "text" | "unavailable";
    status: "passed" | "needs_revision" | "unavailable";
    score?: number;
    summary: string;
    issues: Array<{ taskId?: string; category: string; severity: "low" | "medium" | "high"; message: string; correction?: string }>;
    retryTaskIds: string[];
};

export type DramaEpisode = {
    id: string;
    episodeNumber?: number;
    title: string;
    script: string;
    scriptRichContent?: import("@/lib/drama-script-rich-content").DramaScriptRichContent;
    outline: string;
    hook: string;
    nextPreview: string;
    sourceRange: string;
    reviewStatus: DramaReviewStatus;
    contentTaskId?: string;
    contentError?: string;
    visualTaskId?: string;
    visualCompletedTaskId?: string;
    visualError?: string;
    shots: DramaShot[];
    renderTask?: DramaRenderTask;
    visualReview?: DramaVisualReview;
};

export type DramaSourceAsset = {
    id: string;
    type: "text" | "image" | "video" | "audio";
    title: string;
    textContent?: string;
    storageKey?: string;
    remoteUrl?: string;
    serverUrl?: string;
    mimeType?: string;
    width?: number;
    height?: number;
};

export type DramaProject = {
    id: string;
    sourceHandoffId?: string;
    title: string;
    summary: string;
    style: string;
    ratio: string;
    status: "active" | "archived";
    creativeConversationId?: string;
    activeEpisodeId?: string;
    characters: DramaCharacter[];
    scenes: DramaScene[];
    props: DramaProp[];
    clues: DramaClue[];
    defaultVideoMode: DramaVideoMode;
    episodes: DramaEpisode[];
    sourceAssets?: DramaSourceAsset[];
    createdAt: string;
    updatedAt: string;
};

export type DramaProjectSummary = Pick<DramaProject, "id" | "title" | "summary" | "style" | "ratio" | "status" | "createdAt" | "updatedAt"> & {
    episodeCount: number;
    characterCount: number;
    sceneCount: number;
    shotCount: number;
    pendingTaskCount: number;
    failedTaskCount: number;
};

export type DramaProjectSummaryPage = {
    items: DramaProjectSummary[];
    total: number;
    page: number;
    pageSize: number;
};

export type CreateDramaProjectInput = Pick<DramaProject, "title" | "summary" | "style" | "ratio"> & {
    sourceHandoffId?: string;
    initialScript?: string;
    sourceAssets?: DramaSourceAsset[];
    defaultVideoMode?: DramaVideoMode;
};

export type DramaContentAnalysis = {
    episode: Pick<DramaEpisode, "outline" | "hook" | "nextPreview" | "sourceRange">;
    characters: Array<Omit<DramaCharacter, "id">>;
    scenes: Array<Omit<DramaScene, "id">>;
    props: Array<Omit<DramaProp, "id">>;
    clues: Array<Omit<DramaClue, "id">>;
    shots: Array<
        Pick<DramaShot, "title" | "description" | "sourceText" | "shotBoundary" | "dialogue" | "narration" | "utterances" | "duration"> & {
            characterNames: string[];
            propNames: string[];
            clueNames: string[];
            sceneName: string;
        }
    >;
};

export type DramaVisualAnalysis = {
    shots: Array<
        Pick<DramaShot, "imagePrompt" | "videoPrompt" | "cameraMotion"> &
            Required<Pick<DramaShot, "startFramePrompt" | "endFramePrompt" | "negativePrompt" | "continuity">> & {
                shotId: string;
            }
    >;
};

export type DramaProjectVersion = {
    id: string;
    projectId: string;
    version: number;
    reason: string;
    createdAt: string;
};

export type DramaCostSummary = {
    estimatedPoints: number;
    actualPoints: number;
    taskCount: number;
    successCount: number;
    failedCount: number;
    byType: Partial<Record<"image" | "video" | "audio", { tasks: number; estimatedPoints: number; actualPoints: number }>>;
};
