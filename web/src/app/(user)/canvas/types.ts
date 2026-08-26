import type { CanvasImageLayerBox, CanvasImageLayerKind } from "@/lib/canvas-image-decomposition";
import type { CreativeVideoReferenceMode, VideoReferenceRole } from "@/lib/video-reference-contract";

export type Position = {
    x: number;
    y: number;
};

export type ViewportTransform = {
    x: number;
    y: number;
    k: number;
};

export enum CanvasNodeType {
    Image = "image",
    Panorama = "panorama",
    Text = "text",
    Config = "config",
    Video = "video",
    Audio = "audio",
    Brief = "brief",
    Task = "task",
    BrandKit = "brand-kit",
}

export function isCanvasImageNodeType(type: CanvasNodeType | null | undefined) {
    return type === CanvasNodeType.Image || type === CanvasNodeType.Panorama;
}

type CanvasNodeStatus = "idle" | "success" | "loading" | "error" | "needs_review" | "cancelled";
export type CanvasGenerationMode = "text" | "image" | "video" | "audio";
export type CanvasImageGenerationType = "generation" | "edit";

export type CameraControlOptions = {
    enabled: boolean;
    camera: string;
    lens: string;
    focalLength: number;
    aperture: number;
};

export type CanvasVideoFrameSelection = {
    nodeId?: string;
    title: string;
    source: string;
    previewUrl?: string;
    storageKey?: string;
    remoteUrl?: string;
    serverUrl?: string;
    mimeType?: string;
    width?: number;
    height?: number;
};

export type CanvasVideoReferenceSnapshot = {
    type: "image" | "video" | "audio";
    role: VideoReferenceRole;
    id: string;
    name: string;
    mimeType: string;
    source: string;
    previewUrl?: string;
    storageKey?: string;
    remoteUrl?: string;
    serverUrl?: string;
    bytes?: number;
    width?: number;
    height?: number;
    durationMs?: number;
};

export type CanvasNodeMetadata = {
    agentRunId?: string;
    agentTaskId?: string;
    agentGenerationTaskIds?: string[];
    agentTaskStatus?: "ready" | "pending" | "running" | "paused" | "waiting_user" | "completed" | "failed" | "cancelled";
    agentTaskType?: CanvasGenerationMode;
    agentTaskDependencies?: string[];
    agentTaskOutputNodeIds?: string[];
    agentTaskAttempts?: number;
    agentTaskError?: string;
    agentBrief?: {
        objective: string;
        audience?: string;
        usage?: string;
        coreMessage?: string;
        referenceStrategy?: string;
        tone?: string[];
        deliverables?: Array<{ type: string; title: string; count?: number; ratio?: string; requirements?: string[] }>;
        constraints?: string[];
    };
    brandKit?: {
        summary?: string;
        style?: string;
        composition?: string;
        colors?: string[];
        lighting?: string;
        keywords?: string[];
        visualKeywords?: string[];
        avoid?: string[];
        typography?: string[];
        approvedNodeIds?: string[];
        rejectedNodeIds?: string[];
    };
    content?: string;
    composerContent?: string;
    prompt?: string;
    sourcePrompt?: string;
    status?: CanvasNodeStatus;
    errorDetails?: string;
    fontSize?: number;
    configDetailsOpen?: boolean;
    generationMode?: CanvasGenerationMode;
    generationType?: CanvasImageGenerationType;
    model?: string;
    size?: string;
    sizeLocked?: boolean;
    quality?: string;
    count?: number;
    seconds?: string;
    vquality?: string;
    generateAudio?: string;
    watermark?: string;
    videoReferenceMode?: CreativeVideoReferenceMode;
    videoFirstFrame?: CanvasVideoFrameSelection;
    videoLastFrame?: CanvasVideoFrameSelection;
    videoReferences?: CanvasVideoReferenceSnapshot[];
    audioVoice?: string;
    audioFormat?: string;
    audioSpeed?: string;
    audioInstructions?: string;
    layerName?: string;
    layerVisible?: boolean;
    sourceLayerNodeId?: string;
    imageLayerTaskId?: string;
    imageLayerResultIndex?: number;
    imageLayer?: {
        kind: CanvasImageLayerKind;
        bbox: CanvasImageLayerBox;
        zIndex: number;
        groupId?: string;
        sourceWidth: number;
        sourceHeight: number;
    };
    imageEditMask?: {
        storageKey: string;
        serverUrl?: string;
        mimeType?: string;
        width?: number;
        height?: number;
    };
    imageEditValidationMask?: {
        storageKey: string;
        serverUrl?: string;
        mimeType?: string;
        width?: number;
        height?: number;
    };
    preserveUnmaskedPixels?: boolean;
    imageOutputBackground?: "opaque" | "transparent";
    imageOutputMode?: "layers";
    imageLayerBatch?: { grant: string; slotId: string };
    internalOnly?: boolean;
    cameraControl?: CameraControlOptions;
    panoramaProjection?: "equirectangular";
    panoramaSourcePrompt?: string;
    references?: string[];
    naturalWidth?: number;
    naturalHeight?: number;
    freeResize?: boolean;
    isBatchRoot?: boolean;
    batchRootId?: string;
    batchChildIds?: string[];
    batchUsesReferenceImages?: boolean;
    primaryImageId?: string;
    imageBatchExpanded?: boolean;
    storageKey?: string;
    remoteUrl?: string;
    serverUrl?: string;
    mimeType?: string;
    bytes?: number;
    durationMs?: number;
    videoTask?: {
        id: string;
        provider: "openai" | "seedance" | "generation";
        model: string;
        pollPath?: string;
    };
    imageTask?: {
        id: string;
        kind: CanvasImageGenerationType;
        model: string;
    };
    textTask?: {
        id: string;
        model: string;
    };
    audioTask?: {
        id: string;
        model: string;
    };
};

export type CanvasNodeData = {
    id: string;
    type: CanvasNodeType;
    title: string;
    position: Position;
    width: number;
    height: number;
    metadata?: CanvasNodeMetadata;
};

export type CanvasConnection = {
    id: string;
    fromNodeId: string;
    toNodeId: string;
};

export type CanvasAssistantReference = {
    id: string;
    type: CanvasNodeType;
    title: string;
    dataUrl?: string;
    storageKey?: string;
    text?: string;
};

export type CanvasAssistantImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    remoteUrl?: string;
    serverUrl?: string;
    prompt: string;
};

export type CanvasAssistantMessage = {
    id: string;
    runId?: string;
    role: "user" | "assistant" | "system" | "tool" | "error";
    title?: string;
    text: string;
    meta?: string;
    detail?: unknown;
    references?: CanvasAssistantReference[];
};

export type CanvasAssistantSession = {
    id: string;
    conversationId?: string;
    title: string;
    messages: CanvasAssistantMessage[];
    createdAt: string;
    updatedAt: string;
};

export type ConnectionHandle = {
    nodeId: string;
    handleType: "source" | "target";
};

export type SelectionBox = {
    startWorldX: number;
    startWorldY: number;
    currentWorldX: number;
    currentWorldY: number;
    additive: boolean;
    initialSelectedNodeIds: string[];
};

export type ContextMenuState =
    | {
          type: "node";
          x: number;
          y: number;
          nodeId: string;
      }
    | {
          type: "connection";
          x: number;
          y: number;
          connectionId: string;
      };
