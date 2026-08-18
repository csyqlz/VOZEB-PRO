import type {
  CharacterBodyType,
  CharacterImportReadiness,
  CharacterRigProfile,
  DirectorAnimationAssetRef,
  DirectorAnimationClipRef,
  DirectorAssetKind,
  DirectorAssetRef,
  DirectorAssetSource,
  DirectorCameraCapture,
  DirectorCameraMotionKeyframe,
  DirectorCameraMotionPath,
  DirectorCameraShot,
  DirectorModelFormat,
  DirectorObject,
  DirectorObjectMotionKeyframe,
  DirectorObjectMotionPath,
  DirectorProject,
  DirectorTransform,
  GeometryPrimitiveType,
  PanoramaProjectionMode,
  SceneSettings,
  ViewMode,
} from "../schema/directorProject";
import type { PosePresetId } from "../schema/poseSchema";
import type { ViewportAspectRatio } from "../schema/viewportAspectRatio";
import type { PerformanceProfileId } from "../performance/performanceProfiles";

export type TransformMode = "translate" | "rotate" | "scale";
export type CameraPilotMode = "idle" | "pilot";

export interface ImportedAssetInput {
  kind: DirectorAssetKind;
  name: string;
  fileName: string;
  url: string;
  addToScene?: boolean;
  assetSource?: DirectorAssetSource;
  projectionMode?: PanoramaProjectionMode;
  modelFormat?: DirectorModelFormat;
  storageKey?: string;
  byteLength?: number;
  characterRigProfile?: CharacterRigProfile;
  characterImportReadiness?: CharacterImportReadiness;
  characterOrientationCorrection?: [number, number, number];
  characterBoneMap?: DirectorAssetRef["characterBoneMap"];
}

export interface ImportedAnimationAssetInput {
  name: string;
  fileName: string;
  url: string;
  modelFormat: "fbx" | "glb";
  storageKey?: string;
  byteLength?: number;
  rigProfile: CharacterRigProfile;
  sourceCharacterAssetId?: string;
  clips: DirectorAnimationClipRef[];
}

export interface PanoramaAssetInput {
  name: string;
  fileName: string;
  url: string;
  projectionMode: PanoramaProjectionMode;
  storageKey?: string;
  byteLength?: number;
}

export interface CameraShotSnapshot {
  fov: number;
  position: [number, number, number];
  target: [number, number, number];
}

export interface CrowdCharactersInput {
  bodyType?: CharacterBodyType;
  rows: number;
  columns: number;
  spacing: number;
}

export interface DirectorStateOptions {
  includePersistedLocalAssets?: boolean;
  includePersistedScene?: boolean;
  persistenceScopeId?: string | null;
}

export interface DirectorUiState {
  viewMode: ViewMode;
  selectedObjectId: string | null;
  selectedObjectIds: string[];
  selectedCrowdId: string | null;
  directorInspectorMode: "auto" | "scene";
  transformMode: TransformMode;
  viewportAspectRatio: ViewportAspectRatio;
  viewportRuleOfThirdsEnabled: boolean;
  viewportRotateSensitivity: number;
  viewportZoomSensitivity: number;
  viewportPanelsCollapsed: boolean;
  showCharacterRoutes: boolean;
  finishedShotFov: number | null;
  motionMonitorFov: number | null;
  motionStudioOpen: boolean;
  performanceProfile: PerformanceProfileId;
}

export interface DirectorState extends DirectorUiState {
  project: DirectorProject;
}

export interface DirectorClipboardEntry {
  object: DirectorObject;
  camera?: DirectorCameraShot;
}

export interface DirectorInternalState {
  clipboard: DirectorClipboardEntry[];
  clipboardPasteCount: number;
  undoStack: DirectorState[];
  undoBatchDepth: number;
  undoBatchSnapshot: DirectorState | null;
  undoBatchHasTrackedChanges: boolean;
  selectedCameraKeyframeId: string | null;
  selectedCameraKeyframeIds: string[];
  selectedObjectMotionKeyframeId: string | null;
  cameraMotionProgress: number;
  cameraMotionPlaying: boolean;
  cameraMotionPlaybackRevision: number;
  characterActionPreview: { objectId: string; actionPresetId: string } | null;
  cameraPilotMode: CameraPilotMode;
  cameraPilotEditKeyframeId: string | null;
  cameraPilotHoveredTargetId: string | null;
  cameraPilotLockedTargetId: string | null;
  cameraPilotLockedPoint: [number, number, number] | null;
  cameraPilotFollowTarget: boolean;
}

export interface DirectorActions {
  setViewMode: (mode: ViewMode) => void;
  setTransformMode: (mode: TransformMode) => void;
  setViewportAspectRatio: (ratio: ViewportAspectRatio) => void;
  setViewportRuleOfThirdsEnabled: (enabled: boolean) => void;
  setViewportRotateSensitivity: (sensitivity: number) => void;
  setViewportZoomSensitivity: (sensitivity: number) => void;
  resetViewportSensitivity: () => void;
  setPerformanceProfile: (profile: PerformanceProfileId) => void;
  toggleViewportPanelsCollapsed: () => void;
  setViewportPanelsCollapsed: (collapsed: boolean) => void;
  setShowCharacterRoutes: (visible: boolean) => void;
  setFinishedShotFov: (fov: number | null) => void;
  setMotionMonitorFov: (fov: number | null) => void;
  selectObject: (id: string | null) => void;
  selectCrowd: (crowdId: string | null) => void;
  toggleObjectSelection: (id: string) => void;
  openSceneInspector: () => void;
  updateScene: (patch: Partial<SceneSettings>) => void;
  removePanoramaAsset: () => void;
  setPanoramaAsset: (input: PanoramaAssetInput) => void;
  removeImportedAsset: (assetId: string) => void;
  updateObjectTransform: (id: string, patch: Partial<DirectorTransform>) => void;
  addCharacterRoutePoint: (characterId: string) => string | null;
  addObjectMotionKeyframe: (objectId: string, time: number) => string | null;
  insertObjectMotionKeyframeAfter: (objectId: string, keyframeId: string) => string | null;
  selectObjectMotionKeyframe: (keyframeId: string | null) => void;
  updateObjectMotionKeyframe: (
    objectId: string,
    keyframeId: string,
    patch: Omit<Partial<DirectorObjectMotionKeyframe>, "transform"> & { transform?: Partial<DirectorTransform> }
  ) => void;
  updateObjectMotionPath: (objectId: string, patch: Partial<DirectorObjectMotionPath>) => void;
  deleteObjectMotionKeyframe: (objectId: string, keyframeId: string) => void;
  updateCrowdTransform: (crowdId: string, patch: Partial<DirectorTransform>) => void;
  updateObjectName: (id: string, name: string) => void;
  updateCrowdLabel: (crowdId: string, label: string) => void;
  updateObjectColor: (id: string, color: string) => void;
  updateCrowdColor: (crowdId: string, color: string) => void;
  updateCharacterBodyType: (id: string, bodyType: CharacterBodyType) => void;
  updateUniformScale: (id: string, scale: number) => void;
  updateCrowdUniformScale: (crowdId: string, scale: number) => void;
  addImportedAsset: (input: ImportedAssetInput) => void;
  addImportedAnimationAsset: (input: ImportedAnimationAssetInput) => string;
  removeImportedAnimationAsset: (assetId: string) => void;
  addObjectFromAsset: (assetId: string) => string | null;
  addPresetCharacter: (bodyType?: CharacterBodyType) => void;
  addCrowdCharacters: (input: CrowdCharactersInput) => string[];
  addGeometryPrimitive: (geometryType: GeometryPrimitiveType) => void;
  addCameraShot: (snapshot?: CameraShotSnapshot) => string;
  ensureMotionCamera: (snapshot?: CameraShotSnapshot) => string;
  deleteSelectedObject: () => void;
  toggleObjectVisible: (id: string) => void;
  toggleObjectLocked: (id: string) => void;
  applyPosePreset: (id: string, presetId: PosePresetId) => void;
  applyCrowdPosePreset: (crowdId: string, presetId: PosePresetId) => void;
  applyCharacterActionPreset: (id: string, presetId: string | null) => void;
  applyCrowdActionPreset: (crowdId: string, presetId: string | null) => void;
  updatePoseControl: (id: string, key: string, value: number) => void;
  updateCrowdPoseControl: (crowdId: string, key: string, value: number) => void;
  setActiveCamera: (cameraId: string) => void;
  addCameraCaptures: (cameraId: string | null | undefined, dataUrls: string[]) => void;
  updateCamera: (
    cameraId: string,
    patch: Partial<DirectorCameraShot> & {
      transform?: DirectorTransform;
      target?: [number, number, number];
    }
  ) => void;
  selectCameraMotionKeyframe: (keyframeId: string | null) => void;
  setCameraMotionKeyframeSelection: (keyframeIds: string[]) => void;
  addCameraMotionKeyframe: (cameraId: string) => string | null;
  insertCameraMotionKeyframeAfter: (cameraId: string, keyframeId: string) => string | null;
  recordCameraMotionSnapshot: (
    cameraId: string,
    snapshot: CameraShotSnapshot,
    editKeyframeId?: string | null,
    timelineTime?: number | null
  ) => string | null;
  updateCameraMotionKeyframe: (
    cameraId: string,
    keyframeId: string,
    patch: Partial<DirectorCameraMotionKeyframe>
  ) => void;
  deleteCameraMotionKeyframe: (cameraId: string, keyframeId: string) => void;
  moveCameraMotionKeyframe: (cameraId: string, keyframeId: string, offset: -1 | 1) => void;
  translateSelectedCameraMotionKeyframes: (
    cameraId: string,
    offset: [number, number, number]
  ) => void;
  replaceCameraMotionKeyframes: (
    cameraId: string,
    keyframes: DirectorCameraMotionKeyframe[],
    duration?: number
  ) => void;
  updateCameraMotionPath: (cameraId: string, patch: Partial<DirectorCameraMotionPath>) => void;
  setCameraMotionProgress: (progress: number) => void;
  setCameraMotionPlaying: (playing: boolean) => void;
  restartCameraMotionPlayback: () => void;
  setCharacterActionPreview: (preview: { objectId: string; actionPresetId: string } | null) => void;
  setMotionStudioOpen: (open: boolean) => void;
  startCameraPilot: (mode?: Exclude<CameraPilotMode, "idle">, editKeyframeId?: string | null) => void;
  stopCameraPilot: () => void;
  setCameraPilotHoveredTarget: (objectId: string | null) => void;
  setCameraPilotLockedTarget: (objectId: string | null) => void;
  setCameraPilotLockedPoint: (point: [number, number, number] | null) => void;
  setCameraPilotFollowTarget: (follow: boolean) => void;
  beginUndoBatch: () => void;
  endUndoBatch: () => void;
  copySelectedObjects: () => void;
  pasteClipboardObjects: () => void;
  undo: () => void;
  openScopedScene: (scopeId: string | null | undefined) => void;
  replaceProject: (project: DirectorProject) => void;
  saveLatestSnapshot: () => void;
  restoreLatestSnapshot: () => void;
}

export type DirectorRuntimeState = DirectorState & DirectorInternalState;

export type DirectorStore = DirectorRuntimeState & DirectorActions;
