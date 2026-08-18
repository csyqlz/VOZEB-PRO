import { create } from "zustand";
import { MANNEQUIN_POSE_PRESETS } from "../presets/mannequinPosePresets";
import { GEOMETRY_PRIMITIVE_OPTIONS } from "../schema/directorProject";
import type {
  DirectorAssetRef,
  DirectorAssetSource,
  CharacterBodyType,
  DirectorAssetKind,
  DirectorCameraCapture,
  DirectorAnimationAssetRef,
  DirectorAnimationClipRef,
  DirectorCameraMotionKeyframe,
  DirectorCameraMotionPath,
  DirectorCameraShot,
  DirectorObject,
  DirectorObjectMotionKeyframe,
  DirectorObjectMotionPath,
  DirectorProject,
  DirectorTransform,
  GeometryPrimitiveType,
  GroundMaterialPresetId,
  DirectorModelFormat,
  CharacterImportReadiness,
  CharacterRigProfile,
  PanoramaProjectionMode,
  SceneSettings,
  ViewMode,
} from "../schema/directorProject";
import {
  DEFAULT_CAMERA_MOTION_PATH,
  createCameraMotionKeyframe,
  getCameraMotionSnapshot,
  normalizeCameraMotionPath,
  retimeCameraMotionKeyframes,
} from "../schema/cameraMotion";
import type { PosePresetId } from "../schema/poseSchema";
import { getDirectorObjectFocusTarget } from "../schema/cameraTarget";
import { DEFAULT_CHARACTER_BODY_TYPE, normalizeBodyType } from "../runtime/mannequin/bodyTypes";
import {
  DEFAULT_DIRECTOR_CAMERA_VIEW_SNAPSHOT,
  getCameraRigPositionFromViewSnapshot,
} from "../schema/cameraGeometry";
import type { ViewportAspectRatio } from "../schema/viewportAspectRatio";
import { getObjectMotionSnapshot, normalizeObjectMotionPath } from "../schema/objectMotion";
import {
  DEFAULT_VIEWPORT_ROTATE_SENSITIVITY,
  DEFAULT_VIEWPORT_ZOOM_SENSITIVITY,
  normalizeViewportSensitivity,
} from "../schema/viewportSensitivity";
import { parseImportedCharacterActionId } from "../schema/importedCharacterAction";
import { normalizePerformanceProfileId } from "../performance/performanceProfiles";
import { getRuntimePlaybackProgress, setRuntimePlaybackProgress } from "../runtime/playbackRuntime";

import type {
  CameraPilotMode,
  CameraShotSnapshot,
  DirectorClipboardEntry,
  DirectorRuntimeState,
  DirectorState,
  DirectorStateOptions,
  DirectorStore,
  DirectorUiState,
} from "./directorStore.types";
export type {
  CameraPilotMode,
  CameraShotSnapshot,
  CrowdCharactersInput,
  DirectorActions,
  DirectorClipboardEntry,
  DirectorState,
  DirectorStateOptions,
  DirectorStore,
  DirectorUiState,
  ImportedAnimationAssetInput,
  ImportedAssetInput,
  PanoramaAssetInput,
  TransformMode,
} from "./directorStore.types";



const DEFAULT_SCENE: SceneSettings = {
  scale: 1,
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  backgroundColor: "#000000",
  backgroundBrightness: 1,
  panoramaYaw: 0,
  panoramaRadius: 60,
  showLabels: true,
  snapToGrid: false,
  showGrid: true,
  showGround: true,
  groundMaterialPreset: "studio" as GroundMaterialPresetId,
  groundTextureScale: 1,
  groundColor: "#303640",
  groundBrightness: 1,
  groundOpacity: 0.4,
  groundHeight: 0,
  pathCollisionEnabled: false,
};

const CHARACTER_COLOR_PALETTE = [
  "#4F8EF7",
  "#E0524D",
  "#E91E63",
  "#F2A900",
  "#9C4DCC",
  "#12B886",
  "#00B8D9",
  "#FF7A45",
];
const GEOMETRY_PRIMITIVE_COLOR = "#d7e7ff";
const ADDED_MODEL_WORLD_SPACING = 1.25;
const COPY_PASTE_POSITION_OFFSET = 0.6;
const UNDO_STACK_LIMIT = 80;
const LOCAL_MODEL_LIBRARY_STORAGE_KEY = "storyai-3d-director-local-model-library";
const DIRECTOR_SCENE_STORAGE_KEY = "storyai-3d-director-desk-demo";
const DIRECTOR_SCENE_STORAGE_KEY_PREFIX = `${DIRECTOR_SCENE_STORAGE_KEY}:`;
const DEFAULT_UI_STATE: DirectorUiState = {
  viewMode: "director",
  selectedObjectId: null,
  selectedObjectIds: [],
  selectedCrowdId: null,
  directorInspectorMode: "auto",
  transformMode: "translate",
  viewportAspectRatio: "auto",
  viewportRuleOfThirdsEnabled: false,
  viewportRotateSensitivity: DEFAULT_VIEWPORT_ROTATE_SENSITIVITY,
  viewportZoomSensitivity: DEFAULT_VIEWPORT_ZOOM_SENSITIVITY,
  viewportPanelsCollapsed: false,
  showCharacterRoutes: true,
  finishedShotFov: null,
  motionMonitorFov: null,
  motionStudioOpen: false,
  performanceProfile: "auto",
};

function normalizeDirectorScenePersistenceScopeId(scopeId: string | null | undefined) {
  return typeof scopeId === "string" ? scopeId.trim() : "";
}

function getInitialDirectorScenePersistenceScopeId() {
  if (typeof window === "undefined") return null;

  try {
    const params = new URLSearchParams(window.location.search);
    return normalizeDirectorScenePersistenceScopeId(params.get("instanceId")) || null;
  } catch {
    return null;
  }
}

let directorScenePersistenceScopeId: string | null = getInitialDirectorScenePersistenceScopeId();

function getDirectorSceneStorageKey(scopeId: string | null | undefined = directorScenePersistenceScopeId) {
  const normalizedScopeId = normalizeDirectorScenePersistenceScopeId(scopeId);
  return normalizedScopeId ? `${DIRECTOR_SCENE_STORAGE_KEY_PREFIX}${normalizedScopeId}` : DIRECTOR_SCENE_STORAGE_KEY;
}

function setDirectorScenePersistenceScopeId(scopeId: string | null | undefined) {
  const normalizedScopeId = normalizeDirectorScenePersistenceScopeId(scopeId);
  directorScenePersistenceScopeId = normalizedScopeId || null;
}

function createTransform(
  position: [number, number, number],
  rotation: [number, number, number] = [0, 0, 0],
  scale: [number, number, number] = [1, 1, 1]
): DirectorTransform {
  return { position, rotation, scale };
}

function roundTransformValue(value: number) {
  return Number(value.toFixed(6));
}

function roundTransformTuple(values: [number, number, number]): [number, number, number] {
  return values.map((value) => roundTransformValue(value)) as [number, number, number];
}

function formatSceneItemName(prefix: "角色" | "机位", index: number) {
  return `${prefix}${String(index).padStart(2, "0")}`;
}

function getNextSequentialId(existingIds: string[], prefix: string, minimumIndex = 1) {
  let maxIndex = minimumIndex - 1;

  for (const id of existingIds) {
    if (!id.startsWith(prefix)) continue;

    const suffix = id.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;

    maxIndex = Math.max(maxIndex, Number.parseInt(suffix, 10));
  }

  return `${prefix}${maxIndex + 1}`;
}

function isLocalModelLibraryAsset(asset: DirectorAssetRef) {
  return asset.sourceType === "model" && asset.kind !== "panorama" && asset.assetSource === "local";
}

function getLocalStorageSafe() {
  if (typeof localStorage === "undefined") return null;

  return localStorage;
}

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readPersistedLocalModelAssets() {
  const storage = getLocalStorageSafe();
  if (!storage) return [];

  try {
    const snapshot = storage.getItem(LOCAL_MODEL_LIBRARY_STORAGE_KEY);
    if (!snapshot) return [];

    const parsed = JSON.parse(snapshot);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(
      (asset): asset is DirectorAssetRef =>
        asset &&
        typeof asset.id === "string" &&
        typeof asset.fileName === "string" &&
        typeof asset.url === "string" &&
        isLocalModelLibraryAsset(asset)
    );
  } catch {
    return [];
  }
}

function writePersistedLocalModelAssets(assets: DirectorAssetRef[]) {
  const storage = getLocalStorageSafe();
  if (!storage) return;

  try {
    storage.setItem(LOCAL_MODEL_LIBRARY_STORAGE_KEY, JSON.stringify(assets.filter(isLocalModelLibraryAsset)));
  } catch {
    // Local model files can exceed browser storage limits; keep the current scene usable if persistence fails.
  }
}

function persistLocalModelAsset(asset: DirectorAssetRef) {
  if (!isLocalModelLibraryAsset(asset)) return;

  const persistedAssets = readPersistedLocalModelAssets().filter((item) => item.id !== asset.id);
  writePersistedLocalModelAssets([...persistedAssets, asset]);
}

function removePersistedLocalModelAsset(assetId: string) {
  writePersistedLocalModelAssets(readPersistedLocalModelAssets().filter((asset) => asset.id !== assetId));
}

function isDirectorProjectShape(value: unknown): value is DirectorProject {
  if (!value || typeof value !== "object") return false;

  const project = value as Partial<DirectorProject>;
  return (
    project.version === 1 &&
    Array.isArray(project.assets) &&
    Array.isArray(project.objects) &&
    Array.isArray(project.cameras) &&
    Boolean(project.scene) &&
    typeof project.scene?.backgroundColor === "string"
  );
}

function withPersistedLocalAssets(project: DirectorProject, includePersistedLocalAssets = false): DirectorProject {
  if (!includePersistedLocalAssets) return project;

  const persistedAssets = readPersistedLocalModelAssets();
  if (!persistedAssets.length) return project;

  const existingAssetIds = new Set(project.assets.map((asset) => asset.id));

  return {
    ...project,
    assets: [...project.assets, ...persistedAssets.filter((asset) => !existingAssetIds.has(asset.id))],
  };
}

function normalizeSceneSettings(scene: SceneSettings): SceneSettings {
  return {
    ...DEFAULT_SCENE,
    ...scene,
    position: Array.isArray(scene.position) ? scene.position : DEFAULT_SCENE.position,
    rotation: Array.isArray(scene.rotation) ? scene.rotation : DEFAULT_SCENE.rotation,
    backgroundColor: typeof scene.backgroundColor === "string" ? scene.backgroundColor : DEFAULT_SCENE.backgroundColor,
    backgroundBrightness:
      typeof scene.backgroundBrightness === "number" ? scene.backgroundBrightness : DEFAULT_SCENE.backgroundBrightness,
    showGrid: typeof scene.showGrid === "boolean" ? scene.showGrid : DEFAULT_SCENE.showGrid,
    groundMaterialPreset:
      scene.groundMaterialPreset === "concrete"
      || scene.groundMaterialPreset === "asphalt"
      || scene.groundMaterialPreset === "wood"
      || scene.groundMaterialPreset === "grass"
        ? scene.groundMaterialPreset
        : DEFAULT_SCENE.groundMaterialPreset,
    groundTextureScale:
      typeof scene.groundTextureScale === "number" && Number.isFinite(scene.groundTextureScale)
        ? Math.min(8, Math.max(0.25, scene.groundTextureScale))
        : DEFAULT_SCENE.groundTextureScale,
    groundColor: typeof scene.groundColor === "string" ? scene.groundColor : DEFAULT_SCENE.groundColor,
    groundBrightness: typeof scene.groundBrightness === "number" ? scene.groundBrightness : DEFAULT_SCENE.groundBrightness,
  };
}

function migrateDirectorProject(project: DirectorProject): DirectorProject {
  return {
    ...project,
    scene: normalizeSceneSettings(project.scene),
    animationAssets: Array.isArray(project.animationAssets)
      ? project.animationAssets
      : [],
    cameras: project.cameras.map((camera) => ({
      ...camera,
      motionPath: normalizeCameraMotionPath(camera.motionPath, camera.target, camera),
    })),
    objects: project.objects.map((object) => {
      const withMotionPath = object.motionPath
        ? { ...object, motionPath: normalizeObjectMotionPath(object.motionPath, object.transform) }
        : object;
      if (withMotionPath.kind !== "character") return withMotionPath;

      const rig = withMotionPath.characterRig;
      if (rig?.rigType === "ue4-mannequin" || rig?.rigType === "mixamo") return withMotionPath;

      return {
        ...withMotionPath,
        characterRig: {
          rigType: "ue4-mannequin",
          posePresetId: rig?.posePresetId ?? "stand",
          controls: rig?.controls ?? {},
        },
      };
    }),
  };
}

function extractPersistedDirectorState(state: DirectorRuntimeState): DirectorState {
  return cloneJsonValue({
    viewMode: state.viewMode,
    selectedObjectId: state.selectedObjectId,
    selectedObjectIds: state.selectedObjectIds,
    selectedCrowdId: state.selectedCrowdId,
    directorInspectorMode: state.directorInspectorMode,
    transformMode: state.transformMode,
    viewportAspectRatio: state.viewportAspectRatio,
    viewportRuleOfThirdsEnabled: state.viewportRuleOfThirdsEnabled,
    viewportRotateSensitivity: state.viewportRotateSensitivity,
    viewportZoomSensitivity: state.viewportZoomSensitivity,
    viewportPanelsCollapsed: state.viewportPanelsCollapsed,
    showCharacterRoutes: state.showCharacterRoutes,
    finishedShotFov: state.finishedShotFov,
    motionMonitorFov: state.motionMonitorFov,
    motionStudioOpen: state.motionStudioOpen,
    performanceProfile: state.performanceProfile,
    project: state.project,
  });
}

function writePersistedDirectorState(state: DirectorState) {
  const storage = getLocalStorageSafe();
  if (!storage) return;

  try {
    storage.setItem(getDirectorSceneStorageKey(), JSON.stringify(state));
  } catch {
    // Keep the editor usable if the browser storage quota is exceeded.
  }
}

function createStateFromPersistedProject(project: DirectorProject, options: DirectorStateOptions = {}): DirectorState {
  return {
    ...DEFAULT_UI_STATE,
    project: withPersistedLocalAssets(migrateDirectorProject(cloneJsonValue(project)), options.includePersistedLocalAssets),
  };
}

function readPersistedDirectorState(options: DirectorStateOptions = {}): DirectorState | null {
  const storage = getLocalStorageSafe();
  if (!storage) return null;

  try {
    const snapshot = storage.getItem(getDirectorSceneStorageKey(options.persistenceScopeId));
    if (!snapshot) return null;

    const parsed = JSON.parse(snapshot) as unknown;

    if (isDirectorProjectShape(parsed)) {
      return createStateFromPersistedProject(parsed, options);
    }

    if (!parsed || typeof parsed !== "object") return null;

    const state = parsed as Partial<DirectorState>;
    if (!isDirectorProjectShape(state.project)) return null;

    return {
      viewMode: state.viewMode === "camera" ? "camera" : "director",
      selectedObjectId: typeof state.selectedObjectId === "string" ? state.selectedObjectId : null,
      selectedObjectIds: Array.isArray(state.selectedObjectIds)
        ? state.selectedObjectIds.filter((item): item is string => typeof item === "string")
        : [],
      selectedCrowdId: typeof state.selectedCrowdId === "string" ? state.selectedCrowdId : null,
      directorInspectorMode: state.directorInspectorMode === "scene" ? "scene" : "auto",
      transformMode:
        state.transformMode === "rotate" || state.transformMode === "scale" ? state.transformMode : "translate",
      viewportAspectRatio: state.viewportAspectRatio ?? "auto",
      viewportRuleOfThirdsEnabled: Boolean(state.viewportRuleOfThirdsEnabled),
      viewportRotateSensitivity: normalizeViewportSensitivity(
        state.viewportRotateSensitivity,
        DEFAULT_VIEWPORT_ROTATE_SENSITIVITY
      ),
      viewportZoomSensitivity: normalizeViewportSensitivity(
        state.viewportZoomSensitivity,
        DEFAULT_VIEWPORT_ZOOM_SENSITIVITY
      ),
      viewportPanelsCollapsed: Boolean(state.viewportPanelsCollapsed),
      showCharacterRoutes: state.showCharacterRoutes !== false,
      finishedShotFov:
        typeof state.finishedShotFov === "number" && Number.isFinite(state.finishedShotFov)
          ? Math.min(120, Math.max(10, state.finishedShotFov))
          : null,
      motionMonitorFov:
        typeof state.motionMonitorFov === "number" && Number.isFinite(state.motionMonitorFov)
          ? Math.min(120, Math.max(10, state.motionMonitorFov))
          : null,
      motionStudioOpen: false,
      performanceProfile: normalizePerformanceProfileId(state.performanceProfile),
      project: withPersistedLocalAssets(
        migrateDirectorProject(cloneJsonValue(state.project)),
        options.includePersistedLocalAssets
      ),
    };
  } catch {
    return null;
  }
}

function createRuntimeStateFromPersistedState(state: DirectorState): DirectorRuntimeState {
  const snapshot = cloneJsonValue(state);

  return {
    ...snapshot,
    clipboard: [],
    clipboardPasteCount: 0,
    undoStack: [],
    undoBatchDepth: 0,
    undoBatchSnapshot: null,
    undoBatchHasTrackedChanges: false,
    selectedCameraKeyframeId: null,
    selectedCameraKeyframeIds: [],
    selectedObjectMotionKeyframeId: null,
    cameraMotionProgress: 0,
    cameraMotionPlaying: false,
    cameraMotionPlaybackRevision: 0,
    characterActionPreview: null,
    motionStudioOpen: false,
    cameraPilotMode: "idle",
    cameraPilotEditKeyframeId: null,
    cameraPilotHoveredTargetId: null,
    cameraPilotLockedTargetId: null,
    cameraPilotLockedPoint: null,
    cameraPilotFollowTarget: false,
  };
}

function createUndoStackEntry(state: DirectorRuntimeState) {
  return extractPersistedDirectorState(state);
}

export function createDefaultDirectorProject({
  includePersistedLocalAssets = false,
}: {
  includePersistedLocalAssets?: boolean;
} = {}): DirectorProject {
  const camera: DirectorCameraShot = {
    id: "cam_1",
    name: formatSceneItemName("机位", 1),
    fov: DEFAULT_DIRECTOR_CAMERA_VIEW_SNAPSHOT.fov,
    transform: createTransform(getCameraRigPositionFromViewSnapshot(DEFAULT_DIRECTOR_CAMERA_VIEW_SNAPSHOT)),
    targetMode: "manual",
    target: DEFAULT_DIRECTOR_CAMERA_VIEW_SNAPSHOT.target,
    lastCaptureUrl: null,
    captures: [],
    motionPath: { ...DEFAULT_CAMERA_MOTION_PATH, keyframes: [] },
  };

  const role: DirectorObject = {
    id: "char_default_a",
    name: formatSceneItemName("角色", 1),
    kind: "character",
    visible: true,
    locked: false,
    bodyType: DEFAULT_CHARACTER_BODY_TYPE,
    color: "#4F8EF7",
    transform: createTransform([0, 0, 0]),
    characterRig: {
      rigType: "ue4-mannequin",
      posePresetId: "stand",
      controls: {},
    },
  };

  const cameraObject: DirectorObject = {
    id: "cam_object_1",
    name: camera.name,
    kind: "camera",
    visible: true,
    locked: false,
    linkedCameraId: camera.id,
    transform: camera.transform,
  };

  return {
    version: 1,
    scene: DEFAULT_SCENE,
    assets: includePersistedLocalAssets ? readPersistedLocalModelAssets() : [],
    animationAssets: [],
    objects: [role, cameraObject],
    cameras: [camera],
    activeCameraId: camera.id,
    panoramaAssetId: null,
  };
}

export function createInitialDirectorState(options: DirectorStateOptions = {}): DirectorState {
  const persistedState = options.includePersistedScene ? readPersistedDirectorState(options) : null;

  if (persistedState) {
    return persistedState;
  }

  return {
    ...DEFAULT_UI_STATE,
    project: createDefaultDirectorProject({ includePersistedLocalAssets: options.includePersistedLocalAssets }),
  };
}

function updateObjectById(
  objects: DirectorObject[],
  id: string,
  updater: (item: DirectorObject) => DirectorObject
) {
  return objects.map((item) => (item.id === id ? updater(item) : item));
}

function getNextCharacterColor(objects: DirectorObject[]) {
  const usedColors = new Set(objects.filter((item) => item.kind === "character").map((item) => item.color));
  const unusedColor = CHARACTER_COLOR_PALETTE.find((color) => !usedColors.has(color));

  if (unusedColor) return unusedColor;

  const characterCount = objects.filter((item) => item.kind === "character").length;
  return CHARACTER_COLOR_PALETTE[characterCount % CHARACTER_COLOR_PALETTE.length];
}

function getGeometryPrimitiveLabel(geometryType: GeometryPrimitiveType) {
  return GEOMETRY_PRIMITIVE_OPTIONS.find((option) => option.type === geometryType)?.label ?? "几何模型";
}

function getAddedModelColumnOffset(index: number) {
  const side = index % 2 === 1 ? -1 : 1;
  const step = Math.ceil(index / 2);

  return side * step * ADDED_MODEL_WORLD_SPACING;
}

function getCrowdCharacterPositions(rows: number, columns: number, spacing: number) {
  const safeRows = Math.max(1, rows);
  const safeColumns = Math.max(1, columns);
  const safeSpacing = Math.max(0.1, spacing);
  const xOffset = ((safeColumns - 1) * safeSpacing) / 2;
  const zOffset = ((safeRows - 1) * safeSpacing) / 2;
  const positions: Array<[number, number, number]> = [];

  for (let rowIndex = 0; rowIndex < safeRows; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < safeColumns; columnIndex += 1) {
      positions.push([
        Number((columnIndex * safeSpacing - xOffset).toFixed(4)),
        0,
        Number((rowIndex * safeSpacing - zOffset).toFixed(4)),
      ]);
    }
  }

  return positions;
}

function getCrowdCharacterOffset(objects: DirectorObject[], spacing: number): [number, number, number] {
  const safeSpacing = Math.max(0.1, spacing);
  const characterPositions = objects
    .filter((item) => item.kind === "character")
    .map((item) => item.transform.position);
  const maxZ = characterPositions.length ? Math.max(...characterPositions.map((position) => position[2])) : 0;

  return [0, 0, Number((maxZ + safeSpacing * 2).toFixed(4))];
}

function formatCrowdLabel(rows: number, columns: number) {
  return `群众（${rows}x${columns}）`;
}

function buildPresetCharacterObject(
  state: DirectorRuntimeState,
  bodyType: CharacterBodyType,
  position: [number, number, number],
  crowdMetadata?: {
    crowdId: string;
    crowdLabel: string;
  }
) {
  const characterCount = state.project.objects.filter((item) => item.kind === "character").length;
  const characterIndex = characterCount + 1;
  const objectId = getNextSequentialId(
    state.project.objects.map((item) => item.id),
    "char_preset_",
    characterIndex
  );
  const normalizedBodyType = normalizeBodyType(bodyType);

  return {
    id: objectId,
    name: formatSceneItemName("角色", characterIndex),
    kind: "character" as const,
    visible: true,
    locked: false,
    bodyType: normalizedBodyType,
    color: getNextCharacterColor(state.project.objects),
    crowdId: crowdMetadata?.crowdId,
    crowdLabel: crowdMetadata?.crowdLabel,
    transform: createTransform(position),
    characterRig: {
      rigType: "ue4-mannequin" as const,
      posePresetId: "stand",
      controls: {},
    },
  } satisfies DirectorObject;
}

function formatCameraCaptureName(cameraName: string, captureIndex: number) {
  return `${cameraName}-截图${String(captureIndex).padStart(2, "0")}`;
}

function buildCameraCaptures(camera: DirectorCameraShot, dataUrls: string[]) {
  const existingCaptures = camera.captures ?? [];

  return dataUrls.map((dataUrl, indexOffset): DirectorCameraCapture => {
    const captureIndex = existingCaptures.length + indexOffset + 1;

    return {
      id: `${camera.id}-capture-${String(captureIndex).padStart(2, "0")}`,
      index: captureIndex,
      name: formatCameraCaptureName(camera.name, captureIndex),
      dataUrl,
    };
  });
}

function createDisplayNameFromFileName(fileName: string) {
  return fileName.replace(/\.(fbx|obj|jpe?g|png|webp)$/i, "");
}

function createSceneObjectFromAsset(asset: DirectorAssetRef, existingObjects: DirectorObject[]) {
  const nextObjectId = getNextSequentialId(
    existingObjects.map((item) => item.id),
    "obj_",
    existingObjects.length + 1
  );

  const sameKindCount = existingObjects.filter((item) => item.kind === asset.kind).length;
  const initialPosition: [number, number, number] = asset.kind === "character" && sameKindCount > 0
    ? [getAddedModelColumnOffset(sameKindCount), 0, 0]
    : [0, 0, 0];
  const object = {
    id: nextObjectId,
    name: asset.name ?? createDisplayNameFromFileName(asset.fileName),
    kind: asset.kind,
    visible: true,
    locked: false,
    assetRefId: asset.id,
    color: "#ffffff",
    transform: createTransform(initialPosition),
  } satisfies DirectorObject;

  if (asset.kind !== "character") return object;

  return {
    ...object,
    bodyType: "mannequin",
    characterRig: {
      rigType: "mixamo",
      posePresetId: "stand",
      actionPresetId: null,
      controls: {},
    },
  } satisfies DirectorObject;
}

function refreshCamerasFocusedOnObject(cameras: DirectorCameraShot[], object: DirectorObject) {
  return cameras.map((camera) =>
    camera.targetMode === "object" && camera.targetObjectId === object.id
      ? {
          ...camera,
          target: getDirectorObjectFocusTarget(object),
        }
      : camera
  );
}

function refreshCamerasFocusedOnObjects(
  cameras: DirectorCameraShot[],
  objects: DirectorObject[],
  focusedObjectIds: Iterable<string>
) {
  const focusedIdSet = new Set(focusedObjectIds);
  if (focusedIdSet.size === 0) return cameras;

  const objectsById = new Map(objects.map((item) => [item.id, item]));

  return cameras.map((camera) => {
    if (camera.targetMode !== "object" || !camera.targetObjectId || !focusedIdSet.has(camera.targetObjectId)) {
      return camera;
    }

    const targetObject = objectsById.get(camera.targetObjectId);
    if (!targetObject) {
      return {
        ...camera,
        targetMode: "manual" as const,
        targetObjectId: null,
      };
    }

    return {
      ...camera,
      target: getDirectorObjectFocusTarget(targetObject),
    };
  });
}

function getCrowdMemberObjects(objects: DirectorObject[], crowdId: string) {
  return objects.filter((item) => item.kind === "character" && item.crowdId === crowdId);
}

function getCrowdMemberIds(objects: DirectorObject[], crowdId: string) {
  return getCrowdMemberObjects(objects, crowdId).map((item) => item.id);
}

export function getCrowdAnchorTransform(objects: DirectorObject[], crowdId: string): DirectorTransform | null {
  const crowdMembers = getCrowdMemberObjects(objects, crowdId);
  if (!crowdMembers.length) return null;

  const position = crowdMembers.reduce(
    (accumulator, item) => {
      accumulator[0] += item.transform.position[0];
      accumulator[1] += item.transform.position[1];
      accumulator[2] += item.transform.position[2];
      return accumulator;
    },
    [0, 0, 0] as [number, number, number]
  );
  const memberCount = crowdMembers.length;
  const anchorPosition = roundTransformTuple([
    position[0] / memberCount,
    position[1] / memberCount,
    position[2] / memberCount,
  ]);
  const referenceMember = crowdMembers[0];

  return createTransform(
    anchorPosition,
    [...referenceMember.transform.rotation] as [number, number, number],
    [...referenceMember.transform.scale] as [number, number, number]
  );
}

function getNextCrowdId(objects: DirectorObject[]) {
  return getNextSequentialId(
    objects.map((item) => item.crowdId).filter((item): item is string => typeof item === "string"),
    "crowd_",
    1
  );
}

function applyCrowdTransformPatch(
  objects: DirectorObject[],
  crowdId: string,
  patch: Partial<DirectorTransform>
) {
  const anchor = getCrowdAnchorTransform(objects, crowdId);
  if (!anchor) {
    return {
      objects,
      changedObjectIds: [],
    };
  }

  const nextPosition = patch.position ?? anchor.position;
  const nextRotation = patch.rotation ?? anchor.rotation;
  const nextScale = patch.scale ?? anchor.scale;
  const deltaRotation: [number, number, number] = [
    nextRotation[0] - anchor.rotation[0],
    nextRotation[1] - anchor.rotation[1],
    nextRotation[2] - anchor.rotation[2],
  ];
  const scaleRatio: [number, number, number] = [
    anchor.scale[0] === 0 ? 1 : nextScale[0] / anchor.scale[0],
    anchor.scale[1] === 0 ? 1 : nextScale[1] / anchor.scale[1],
    anchor.scale[2] === 0 ? 1 : nextScale[2] / anchor.scale[2],
  ];
  const anchorPosition = anchor.position;
  const changedObjectIds = getCrowdMemberIds(objects, crowdId);
  const changedIdSet = new Set(changedObjectIds);

  return {
    changedObjectIds,
    objects: objects.map((item) => {
      if (!changedIdSet.has(item.id)) return item;

      const offsetX = (item.transform.position[0] - anchorPosition[0]) * scaleRatio[0];
      const offsetY = (item.transform.position[1] - anchorPosition[1]) * scaleRatio[1];
      const offsetZ = (item.transform.position[2] - anchorPosition[2]) * scaleRatio[2];
      const cosX = Math.cos(deltaRotation[0]);
      const sinX = Math.sin(deltaRotation[0]);
      const cosY = Math.cos(deltaRotation[1]);
      const sinY = Math.sin(deltaRotation[1]);
      const cosZ = Math.cos(deltaRotation[2]);
      const sinZ = Math.sin(deltaRotation[2]);

      const x1 = offsetX;
      const y1 = offsetY * cosX - offsetZ * sinX;
      const z1 = offsetY * sinX + offsetZ * cosX;

      const x2 = x1 * cosY + z1 * sinY;
      const y2 = y1;
      const z2 = -x1 * sinY + z1 * cosY;

      const x3 = x2 * cosZ - y2 * sinZ;
      const y3 = x2 * sinZ + y2 * cosZ;
      const z3 = z2;

      return {
        ...item,
        transform: {
          position: roundTransformTuple([
            nextPosition[0] + x3,
            nextPosition[1] + y3,
            nextPosition[2] + z3,
          ]),
          rotation: roundTransformTuple([
            item.transform.rotation[0] + deltaRotation[0],
            item.transform.rotation[1] + deltaRotation[1],
            item.transform.rotation[2] + deltaRotation[2],
          ]),
          scale: roundTransformTuple([
            item.transform.scale[0] * scaleRatio[0],
            item.transform.scale[1] * scaleRatio[1],
            item.transform.scale[2] * scaleRatio[2],
          ]),
        },
      };
    }),
  };
}

function getOrderedSelectedObjectIds(state: DirectorState) {
  if (state.selectedObjectIds.length) return state.selectedObjectIds;
  return state.selectedObjectId ? [state.selectedObjectId] : [];
}

function createObjectIdForDuplicate(existingObjects: DirectorObject[], source: DirectorObject) {
  if (source.kind === "camera") {
    return getNextSequentialId(
      existingObjects.map((item) => item.id),
      "cam_object_",
      existingObjects.filter((item) => item.kind === "camera").length + 1
    );
  }

  if (source.kind === "character") {
    return getNextSequentialId(
      existingObjects.map((item) => item.id),
      "char_paste_",
      existingObjects.filter((item) => item.kind === "character").length + 1
    );
  }

  if (source.geometryType) {
    return getNextSequentialId(
      existingObjects.map((item) => item.id),
      `geo_${source.geometryType}_copy_`,
      existingObjects.length + 1
    );
  }

  return getNextSequentialId(existingObjects.map((item) => item.id), "obj_", existingObjects.length + 1);
}

function applyPositionOffset(position: [number, number, number], offset: number): [number, number, number] {
  return [position[0] + offset, position[1], position[2] + offset];
}

function applyOffsetToTransform(transform: DirectorTransform, offset: number): DirectorTransform {
  return {
    ...transform,
    position: applyPositionOffset(transform.position, offset),
  };
}

function buildClipboardEntries(state: DirectorState): DirectorClipboardEntry[] {
  const selectedObjectIds = getOrderedSelectedObjectIds(state);
  if (!selectedObjectIds.length) return [];

  return selectedObjectIds.flatMap((objectId) => {
    const object = state.project.objects.find((item) => item.id === objectId);
    if (!object) return [];

    const camera =
      object.kind === "camera" && object.linkedCameraId
        ? state.project.cameras.find((item) => item.id === object.linkedCameraId)
        : undefined;

    return [
      {
        object: cloneJsonValue(object),
        camera: camera ? cloneJsonValue(camera) : undefined,
      },
    ];
  });
}

function pasteClipboardEntries(state: DirectorRuntimeState): DirectorRuntimeState {
  if (state.clipboard.length === 0) return state;

  const pasteIteration = state.clipboardPasteCount + 1;
  const offset = COPY_PASTE_POSITION_OFFSET * pasteIteration;
  const nextObjects = [...state.project.objects];
  const nextCameras = [...state.project.cameras];
  const idMap = new Map<string, string>();
  const crowdIdMap = new Map<string, string>();
  const pastedObjectIds: string[] = [];

  function getPastedCrowdId(sourceCrowdId: string) {
    const existing = crowdIdMap.get(sourceCrowdId);
    if (existing) return existing;

    const nextCrowdId = getNextCrowdId(nextObjects);
    crowdIdMap.set(sourceCrowdId, nextCrowdId);
    return nextCrowdId;
  }

  state.clipboard.forEach((entry) => {
    if (entry.object.kind === "camera" && entry.camera) {
      const cameraIndex = nextCameras.length + 1;
      const nextCameraId = getNextSequentialId(
        nextCameras.map((item) => item.id),
        "cam_",
        cameraIndex
      );
      const nextObjectId = createObjectIdForDuplicate(nextObjects, entry.object);
      idMap.set(entry.object.id, nextObjectId);
      if (entry.object.linkedCameraId) {
        idMap.set(entry.object.linkedCameraId, nextCameraId);
      }

      const targetObjectId = entry.camera.targetObjectId ? idMap.get(entry.camera.targetObjectId) : null;
      const nextCamera: DirectorCameraShot = {
        ...entry.camera,
        id: nextCameraId,
        name: formatSceneItemName("机位", cameraIndex),
        transform: applyOffsetToTransform(entry.camera.transform, offset),
        target:
          entry.camera.targetMode === "manual" ? applyPositionOffset(entry.camera.target, offset) : entry.camera.target,
        targetObjectId: targetObjectId ?? entry.camera.targetObjectId ?? null,
        captures: [],
        lastCaptureUrl: null,
      };
      const nextCameraObject: DirectorObject = {
        ...entry.object,
        id: nextObjectId,
        name: nextCamera.name,
        linkedCameraId: nextCamera.id,
        transform: nextCamera.transform,
      };

      nextCameras.push(nextCamera);
      nextObjects.push(nextCameraObject);
      pastedObjectIds.push(nextObjectId);
      return;
    }

    const nextObjectId = createObjectIdForDuplicate(nextObjects, entry.object);
    idMap.set(entry.object.id, nextObjectId);
    const nextCharacterCount =
      entry.object.kind === "character" ? nextObjects.filter((item) => item.kind === "character").length + 1 : null;
    const duplicatedObject: DirectorObject = {
      ...entry.object,
      id: nextObjectId,
      name:
        entry.object.kind === "character" && nextCharacterCount
          ? formatSceneItemName("角色", nextCharacterCount)
          : entry.object.name,
      crowdId: entry.object.crowdId ? getPastedCrowdId(entry.object.crowdId) : entry.object.crowdId,
      transform: applyOffsetToTransform(entry.object.transform, offset),
    };

    nextObjects.push(duplicatedObject);
    pastedObjectIds.push(nextObjectId);
  });

  const nextObjectsById = new Map(nextObjects.map((item) => [item.id, item]));
  const normalizedCameras = nextCameras.map((camera) => {
    if (camera.targetMode !== "object" || !camera.targetObjectId) return camera;

    const mappedTargetObjectId = idMap.get(camera.targetObjectId) ?? camera.targetObjectId;
    const targetObject = nextObjectsById.get(mappedTargetObjectId);
    if (!targetObject) {
      return {
        ...camera,
        targetMode: "manual" as const,
        targetObjectId: null,
      };
    }

    return {
      ...camera,
      targetObjectId: mappedTargetObjectId,
      target: getDirectorObjectFocusTarget(targetObject),
    };
  });
  const lastPastedObject = pastedObjectIds.length
    ? nextObjects.find((item) => item.id === pastedObjectIds[pastedObjectIds.length - 1])
    : null;
  const pastedCrowdIds = Array.from(
    new Set(
      pastedObjectIds
        .map((objectId) => nextObjects.find((item) => item.id === objectId)?.crowdId)
        .filter((crowdId): crowdId is string => typeof crowdId === "string")
    )
  );

  return {
    ...state,
    selectedObjectId: pastedObjectIds[pastedObjectIds.length - 1] ?? null,
    selectedObjectIds: pastedObjectIds,
    selectedCrowdId: pastedCrowdIds.length === 1 ? pastedCrowdIds[0] : null,
    directorInspectorMode: "auto",
    clipboardPasteCount: pasteIteration,
    project: {
      ...state.project,
      objects: nextObjects,
      cameras: normalizedCameras,
      activeCameraId:
        lastPastedObject?.kind === "camera"
          ? lastPastedObject.linkedCameraId ?? state.project.activeCameraId
          : state.project.activeCameraId,
    },
  };
}

function isSameDirectorState(a: DirectorState, b: DirectorState) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function trimUndoStack(stack: DirectorState[]) {
  return stack.length > UNDO_STACK_LIMIT ? stack.slice(stack.length - UNDO_STACK_LIMIT) : stack;
}

export const useDirectorStore = create<DirectorStore>((set, get) => {
  const initialRuntimeState = createRuntimeStateFromPersistedState(
    createInitialDirectorState({ includePersistedLocalAssets: true, includePersistedScene: false })
  );

  function commitMutation(
    updater: (state: DirectorRuntimeState) => DirectorRuntimeState,
    options: { trackUndo?: boolean; persist?: boolean } = {}
  ) {
    const { trackUndo = true, persist = true } = options;

    set((state) => {
      const currentState = state as DirectorRuntimeState;
      const previousSnapshot = createUndoStackEntry(currentState);
      const nextState = updater(currentState);
      const nextSnapshot = extractPersistedDirectorState(nextState);
      const didChange = !isSameDirectorState(previousSnapshot, nextSnapshot);

      if (!didChange) {
        return {
          ...nextState,
          undoStack: trackUndo ? currentState.undoStack : nextState.undoStack,
          undoBatchDepth: nextState.undoBatchDepth,
          undoBatchSnapshot: nextState.undoBatchSnapshot,
          undoBatchHasTrackedChanges: nextState.undoBatchHasTrackedChanges,
        };
      }

      const shouldCaptureUndoBatchSnapshot =
        trackUndo && currentState.undoBatchDepth > 0 && currentState.undoBatchSnapshot === null;
      const nextUndoStack =
        trackUndo && currentState.undoBatchDepth === 0
          ? trimUndoStack([...currentState.undoStack, previousSnapshot])
          : nextState.undoStack;
      const runtimeState: DirectorRuntimeState = {
        ...nextState,
        undoStack: nextUndoStack,
        undoBatchSnapshot: shouldCaptureUndoBatchSnapshot ? previousSnapshot : nextState.undoBatchSnapshot,
        undoBatchHasTrackedChanges:
          trackUndo && currentState.undoBatchDepth > 0 ? true : nextState.undoBatchHasTrackedChanges,
      };

      if (persist) {
        writePersistedDirectorState(extractPersistedDirectorState(runtimeState));
      }

      return runtimeState;
    });
  }

  function commitUiMutation(updater: (state: DirectorRuntimeState) => DirectorRuntimeState) {
    commitMutation(updater, { trackUndo: false, persist: true });
  }

  return {
    ...initialRuntimeState,
    beginUndoBatch: () => {
      set((state) => {
        const currentState = state as DirectorRuntimeState;

        return {
          ...currentState,
          undoBatchDepth: currentState.undoBatchDepth + 1,
          undoBatchSnapshot: currentState.undoBatchDepth === 0 ? createUndoStackEntry(currentState) : currentState.undoBatchSnapshot,
          undoBatchHasTrackedChanges: currentState.undoBatchDepth === 0 ? false : currentState.undoBatchHasTrackedChanges,
        };
      });
    },
    endUndoBatch: () => {
      set((state) => {
        const currentState = state as DirectorRuntimeState;
        if (currentState.undoBatchDepth === 0) return currentState;

        const nextUndoBatchDepth = currentState.undoBatchDepth - 1;
        if (nextUndoBatchDepth > 0) {
          return {
            ...currentState,
            undoBatchDepth: nextUndoBatchDepth,
          };
        }

        const currentSnapshot = extractPersistedDirectorState(currentState);
        const shouldPushUndoEntry =
          currentState.undoBatchHasTrackedChanges &&
          currentState.undoBatchSnapshot !== null &&
          !isSameDirectorState(currentState.undoBatchSnapshot, currentSnapshot);

        return {
          ...currentState,
          undoStack: shouldPushUndoEntry
            ? trimUndoStack([...currentState.undoStack, currentState.undoBatchSnapshot!])
            : currentState.undoStack,
          undoBatchDepth: 0,
          undoBatchSnapshot: null,
          undoBatchHasTrackedChanges: false,
        };
      });
    },
    setTransformMode: (mode) =>
      commitUiMutation((state) => ({
        ...state,
        transformMode: mode,
      })),
    setViewportAspectRatio: (ratio) =>
      commitUiMutation((state) => ({
        ...state,
        viewportAspectRatio: ratio,
      })),
    setShowCharacterRoutes: (visible) =>
      commitUiMutation((state) => ({
        ...state,
        showCharacterRoutes: visible,
      })),
    setFinishedShotFov: (fov) =>
      commitUiMutation((state) => ({
        ...state,
        finishedShotFov:
          typeof fov === "number" && Number.isFinite(fov) ? Math.min(120, Math.max(10, fov)) : null,
      })),
    setMotionMonitorFov: (fov) =>
      commitUiMutation((state) => ({
        ...state,
        motionMonitorFov:
          typeof fov === "number" && Number.isFinite(fov) ? Math.min(120, Math.max(10, fov)) : null,
      })),
    setViewportRuleOfThirdsEnabled: (enabled) =>
      commitUiMutation((state) => ({
        ...state,
        viewportRuleOfThirdsEnabled: enabled,
      })),
    setViewportRotateSensitivity: (sensitivity) =>
      commitUiMutation((state) => ({
        ...state,
        viewportRotateSensitivity: normalizeViewportSensitivity(
          sensitivity,
          DEFAULT_VIEWPORT_ROTATE_SENSITIVITY
        ),
      })),
    setViewportZoomSensitivity: (sensitivity) =>
      commitUiMutation((state) => ({
        ...state,
        viewportZoomSensitivity: normalizeViewportSensitivity(
          sensitivity,
          DEFAULT_VIEWPORT_ZOOM_SENSITIVITY
        ),
      })),
    resetViewportSensitivity: () =>
      commitUiMutation((state) => ({
        ...state,
        viewportRotateSensitivity: DEFAULT_VIEWPORT_ROTATE_SENSITIVITY,
        viewportZoomSensitivity: DEFAULT_VIEWPORT_ZOOM_SENSITIVITY,
      })),
    setPerformanceProfile: (profile) =>
      commitUiMutation((state) => ({
        ...state,
        performanceProfile: normalizePerformanceProfileId(profile),
      })),
    toggleViewportPanelsCollapsed: () =>
      commitUiMutation((state) => ({
        ...state,
        viewportPanelsCollapsed: !state.viewportPanelsCollapsed,
      })),
    setViewportPanelsCollapsed: (collapsed) =>
      commitUiMutation((state) => ({
        ...state,
        viewportPanelsCollapsed: collapsed,
      })),
    setViewMode: (mode) =>
      commitUiMutation((state) => ({
        ...state,
        viewMode: mode,
        cameraMotionPlaying: mode === "camera" ? state.cameraMotionPlaying : false,
        cameraPilotMode: mode === "camera" ? "idle" : state.cameraPilotMode,
        cameraPilotEditKeyframeId: mode === "camera" ? null : state.cameraPilotEditKeyframeId,
        project: {
          ...state.project,
          activeCameraId:
            mode === "camera"
              ? state.project.activeCameraId ?? state.project.cameras[0]?.id ?? null
              : state.project.activeCameraId,
        },
      })),
    selectObject: (id) =>
      commitUiMutation((state) => {
        const selectedObject = state.project.objects.find((item) => item.id === id);

        return {
          ...state,
          selectedObjectId: id,
          selectedObjectIds: id ? [id] : [],
          selectedCrowdId: null,
          directorInspectorMode: "auto",
          selectedCameraKeyframeId: selectedObject?.kind === "camera" ? null : state.selectedCameraKeyframeId,
          selectedCameraKeyframeIds: selectedObject?.kind === "camera" ? [] : state.selectedCameraKeyframeIds,
          selectedObjectMotionKeyframeId: null,
          cameraMotionProgress: selectedObject?.kind === "camera" ? 0 : state.cameraMotionProgress,
          cameraMotionPlaying: false,
          project: {
            ...state.project,
            activeCameraId:
              selectedObject?.kind === "camera" && selectedObject.linkedCameraId
                ? selectedObject.linkedCameraId
                : state.project.activeCameraId,
          },
        };
      }),
    selectCrowd: (crowdId) =>
      commitUiMutation((state) => {
        if (!crowdId) {
          return {
            ...state,
            selectedCrowdId: null,
            selectedObjectId: null,
            selectedObjectIds: [],
          };
        }

        const crowdMemberIds = getCrowdMemberIds(state.project.objects, crowdId);
        if (!crowdMemberIds.length) return state;

        return {
          ...state,
          selectedCrowdId: crowdId,
          selectedObjectId: crowdMemberIds[crowdMemberIds.length - 1] ?? null,
          selectedObjectIds: crowdMemberIds,
          directorInspectorMode: "auto",
        };
      }),
    toggleObjectSelection: (id) =>
      commitUiMutation((state) => {
        const selectedObject = state.project.objects.find((item) => item.id === id);
        if (!selectedObject) return state;

        const selectedObjectIds = getOrderedSelectedObjectIds(state);
        const nextSelectedObjectIds = selectedObjectIds.includes(id)
          ? selectedObjectIds.filter((itemId) => itemId !== id)
          : [...selectedObjectIds, id];
        const nextSelectedObjectId = nextSelectedObjectIds[nextSelectedObjectIds.length - 1] ?? null;

        return {
          ...state,
          selectedObjectId: nextSelectedObjectId,
          selectedObjectIds: nextSelectedObjectIds,
          selectedCrowdId: null,
          directorInspectorMode: "auto",
          project: {
            ...state.project,
            activeCameraId:
              selectedObject.kind === "camera" && selectedObject.linkedCameraId
                ? selectedObject.linkedCameraId
                : state.project.activeCameraId,
          },
        };
      }),
    openSceneInspector: () =>
      commitUiMutation((state) => ({
        ...state,
        directorInspectorMode: "scene",
        selectedObjectId: null,
        selectedObjectIds: [],
        selectedCrowdId: null,
      })),
    updateScene: (patch) =>
      commitMutation((state) => ({
        ...state,
        project: {
          ...state.project,
          scene: {
            ...state.project.scene,
            ...patch,
          },
        },
      })),
    removePanoramaAsset: () =>
      commitMutation((state) => {
        const panoramaAssetId = state.project.panoramaAssetId;
        if (!panoramaAssetId) return state;

        return {
          ...state,
          project: {
            ...state.project,
            assets: state.project.assets.filter((item) => item.id !== panoramaAssetId),
            panoramaAssetId: null,
          },
        };
      }),
    setPanoramaAsset: (input) =>
      commitMutation((state) => {
        const assetId = input.storageKey
          ? `local_panorama_${input.storageKey}`
          : `panorama_${crypto.randomUUID()}`;
        const panoramaAsset = {
          id: assetId,
          kind: "panorama",
          sourceType: "image",
          fileName: input.fileName,
          name: input.name,
          url: input.url,
          assetSource: "local",
          projectionMode: input.projectionMode,
          storageKey: input.storageKey,
          byteLength: input.byteLength,
        } satisfies DirectorAssetRef;

        return {
          ...state,
          directorInspectorMode: "scene",
          selectedObjectId: null,
          selectedObjectIds: [],
          selectedCrowdId: null,
          project: {
            ...state.project,
            scene: {
              ...state.project.scene,
              panoramaYaw: 0,
            },
            assets: [
              ...state.project.assets.filter((asset) => asset.kind !== "panorama"),
              panoramaAsset,
            ],
            panoramaAssetId: panoramaAsset.id,
          },
        };
      }),
    removeImportedAsset: (assetId) =>
      commitMutation((state) => {
        const targetAsset = state.project.assets.find((item) => item.id === assetId);
        if (!targetAsset || targetAsset.sourceType !== "model") return state;

        removePersistedLocalModelAsset(assetId);

        const removedObjectIds = new Set(
          state.project.objects.filter((item) => item.assetRefId === assetId).map((item) => item.id)
        );
        const nextObjects = state.project.objects.filter((item) => item.assetRefId !== assetId);
        const nextCameras = state.project.cameras.map((camera) =>
          camera.targetObjectId && removedObjectIds.has(camera.targetObjectId)
            ? {
                ...camera,
                targetMode: "manual" as const,
                targetObjectId: null,
              }
            : camera
        );
        const selectedObjectIds = state.selectedObjectIds.filter((id) => !removedObjectIds.has(id));
        const selectedObjectId =
          state.selectedObjectId && removedObjectIds.has(state.selectedObjectId)
            ? selectedObjectIds[selectedObjectIds.length - 1] ?? null
            : state.selectedObjectId;

        return {
          ...state,
          selectedObjectId,
          selectedObjectIds,
          selectedCrowdId: null,
          project: {
            ...state.project,
            assets: state.project.assets.filter((item) => item.id !== assetId),
            objects: nextObjects,
            cameras: nextCameras,
          },
        };
      }),
    updateObjectTransform: (id, patch) =>
      commitMutation((state) => {
        const currentObject = state.project.objects.find((item) => item.id === id);
        const nextTransform = currentObject
          ? {
              position: patch.position ?? currentObject.transform.position,
              rotation: patch.rotation ?? currentObject.transform.rotation,
              scale: patch.scale ?? currentObject.transform.scale,
            }
          : null;
        const nextObject = currentObject && nextTransform ? { ...currentObject, transform: nextTransform } : null;

        return {
          ...state,
          project: {
            ...state.project,
            objects: updateObjectById(state.project.objects, id, (item) => ({
              ...item,
              transform: {
                position: patch.position ?? item.transform.position,
                rotation: patch.rotation ?? item.transform.rotation,
                scale: patch.scale ?? item.transform.scale,
              },
            })),
            cameras:
              currentObject?.kind === "camera" && currentObject.linkedCameraId && nextTransform
                ? state.project.cameras.map((camera) =>
                    camera.id === currentObject.linkedCameraId
                      ? {
                          ...camera,
                          transform: nextTransform,
                        }
                      : camera
                  )
                : nextObject
                  ? refreshCamerasFocusedOnObject(state.project.cameras, nextObject)
                  : state.project.cameras,
          },
        };
      }),
    addObjectMotionKeyframe: (objectId, time) => {
      let recordedId: string | null = null;
      commitMutation((state) => {
        const object = state.project.objects.find((item) => item.id === objectId);
        if (!object || object.kind === "camera" || object.kind === "panorama") return state;
        const motionPath = normalizeObjectMotionPath(object.motionPath, object.transform);
        const normalizedTime = Math.min(1, Math.max(0, time));
        const existing = motionPath.keyframes.find((item) => Math.abs(item.time - normalizedTime) <= 0.005);
        recordedId = existing?.id ?? getNextSequentialId(
          motionPath.keyframes.map((item) => item.id),
          `${objectId}_motion_key_`,
          motionPath.keyframes.length + 1
        );
        const transform: DirectorTransform = {
          position: [...object.transform.position],
          rotation: [...object.transform.rotation],
          scale: [...object.transform.scale],
        };
        const keyframe: DirectorObjectMotionKeyframe = {
          id: recordedId,
          time: normalizedTime,
          transform,
          actionPresetId: existing?.actionPresetId ?? object.characterRig?.actionPresetId ?? null,
          facingMode: existing?.facingMode ?? (object.kind === "character" ? "path" : "manual"),
          pointBehavior: existing?.pointBehavior ?? "pass",
          holdSeconds: existing?.holdSeconds ?? 0,
          holdAction: existing?.holdAction ?? "current",
          holdActionPresetId: existing?.holdActionPresetId ?? null,
        };
        const keyframes = existing
          ? motionPath.keyframes.map((item) => item.id === existing.id ? keyframe : item)
          : [...motionPath.keyframes, keyframe].sort((a, b) => a.time - b.time);

        return {
          ...state,
          project: {
            ...state.project,
            objects: state.project.objects.map((item) =>
              item.id === objectId ? { ...item, motionPath: { ...motionPath, keyframes } } : item
            ),
          },
        };
      });
      return recordedId;
    },
    addCharacterRoutePoint: (characterId) => {
      let routePointId: string | null = null;
      commitMutation((state) => {
        const character = state.project.objects.find((item) => item.id === characterId && item.kind === "character");
        if (!character) return state;
        const motionPath = normalizeObjectMotionPath(character.motionPath, character.transform);
        const existing = motionPath.keyframes;
        routePointId = getNextSequentialId(
          existing.map((item) => item.id),
          `${characterId}_motion_key_`,
          existing.length + 1
        );
        const last = existing[existing.length - 1];
        const previous = existing[existing.length - 2];
        const existingDirection = last && previous
          ? [last.transform.position[0] - previous.transform.position[0], last.transform.position[2] - previous.transform.position[2]] as const
          : [Math.sin(last?.transform.rotation[1] ?? character.transform.rotation[1]), Math.cos(last?.transform.rotation[1] ?? character.transform.rotation[1])] as const;
        const directionLength = Math.hypot(existingDirection[0], existingDirection[1]) || 1;
        const nextPosition: [number, number, number] = last
          ? [
              last.transform.position[0] + (existingDirection[0] / directionLength) * 1.5,
              last.transform.position[1],
              last.transform.position[2] + (existingDirection[1] / directionLength) * 1.5,
            ]
          : [...character.transform.position];
        const nextKeyframe: DirectorObjectMotionKeyframe = {
          id: routePointId,
          time: existing.length === 0 ? 0 : 1,
          transform: {
            position: nextPosition,
            rotation: [...(last?.transform.rotation ?? character.transform.rotation)],
            scale: [...(last?.transform.scale ?? character.transform.scale)],
          },
          actionPresetId: null,
          facingMode: "path",
          pointBehavior: "pass",
          holdSeconds: 0,
          holdAction: "current",
          holdActionPresetId: null,
        };
        const keyframes = existing.length === 0
          ? [nextKeyframe]
          : [...existing.map((item, index) => ({ ...item, time: index / existing.length })), nextKeyframe];
        return {
          ...state,
          selectedObjectMotionKeyframeId: routePointId,
          cameraMotionProgress: nextKeyframe.time,
          cameraMotionPlaying: false,
          project: {
            ...state.project,
            objects: state.project.objects.map((item) =>
              item.id === characterId ? { ...item, motionPath: { ...motionPath, keyframes } } : item
            ),
          },
        };
      });
      return routePointId;
    },
    insertObjectMotionKeyframeAfter: (objectId, keyframeId) => {
      let insertedId: string | null = null;
      commitMutation((state) => {
        const object = state.project.objects.find((item) => item.id === objectId);
        if (!object) return state;
        const motionPath = normalizeObjectMotionPath(object.motionPath, object.transform);
        const currentIndex = motionPath.keyframes.findIndex((item) => item.id === keyframeId);
        const current = motionPath.keyframes[currentIndex];
        const next = motionPath.keyframes[currentIndex + 1];
        if (!current || !next) return state;
        insertedId = getNextSequentialId(
          motionPath.keyframes.map((item) => item.id),
          `${objectId}_motion_key_`,
          motionPath.keyframes.length + 1
        );
        const time = (current.time + next.time) / 2;
        const activeCamera = state.project.cameras.find((camera) => camera.id === state.project.activeCameraId)
          ?? state.project.cameras[0];
        const duration = activeCamera
          ? normalizeCameraMotionPath(activeCamera.motionPath, activeCamera.target, activeCamera).duration
          : DEFAULT_CAMERA_MOTION_PATH.duration;
        const transform = getObjectMotionSnapshot(object, time, duration);
        const inserted: DirectorObjectMotionKeyframe = {
          id: insertedId,
          time,
          transform,
          actionPresetId: current.actionPresetId ?? null,
          facingMode: current.facingMode ?? "manual",
          pointBehavior: "pass",
          holdSeconds: 0,
          holdAction: "current",
          holdActionPresetId: null,
        };
        return {
          ...state,
          selectedObjectMotionKeyframeId: insertedId,
          project: {
            ...state.project,
            objects: state.project.objects.map((item) =>
              item.id === objectId
                ? { ...item, motionPath: { ...motionPath, keyframes: [...motionPath.keyframes, inserted].sort((a, b) => a.time - b.time) } }
                : item
            ),
          },
        };
      });
      return insertedId;
    },
    selectObjectMotionKeyframe: (keyframeId) =>
      commitUiMutation((state) => ({ ...state, selectedObjectMotionKeyframeId: keyframeId })),
    updateObjectMotionKeyframe: (objectId, keyframeId, patch) =>
      commitMutation((state) => ({
        ...state,
        project: {
          ...state.project,
          objects: state.project.objects.map((object) => {
            if (object.id !== objectId) return object;
            const motionPath = normalizeObjectMotionPath(object.motionPath, object.transform);
            const activatesNewTiming = typeof patch.time === "number"
              || (!motionPath.speedMode && ("pointBehavior" in patch || "holdSeconds" in patch));
            const keyframes = motionPath.keyframes
              .map((keyframe) =>
                keyframe.id === keyframeId
                  ? {
                      ...keyframe,
                      actionPresetId:
                        "actionPresetId" in patch ? patch.actionPresetId ?? null : keyframe.actionPresetId,
                      facingMode: "facingMode" in patch ? patch.facingMode ?? "manual" : keyframe.facingMode,
                      pointBehavior:
                        "pointBehavior" in patch ? patch.pointBehavior ?? "pass" : keyframe.pointBehavior,
                      holdSeconds:
                        "holdSeconds" in patch
                          ? Math.max(0, Number.isFinite(patch.holdSeconds) ? patch.holdSeconds ?? 0 : 0)
                          : keyframe.holdSeconds,
                      holdAction:
                        "holdAction" in patch ? patch.holdAction ?? "current" : keyframe.holdAction,
                      holdActionPresetId:
                        "holdActionPresetId" in patch
                          ? patch.holdActionPresetId ?? null
                          : keyframe.holdActionPresetId,
                      time: typeof patch.time === "number" ? Math.min(1, Math.max(0, patch.time)) : keyframe.time,
                      transform: patch.transform
                        ? {
                            position: patch.transform.position ?? keyframe.transform.position,
                            rotation: patch.transform.rotation ?? keyframe.transform.rotation,
                            scale: patch.transform.scale ?? keyframe.transform.scale,
                          }
                        : keyframe.transform,
                    }
                  : keyframe
              )
              .sort((left, right) => left.time - right.time);
            return {
              ...object,
              motionPath: {
                ...motionPath,
                ...(activatesNewTiming ? { speedMode: "custom" as const } : {}),
                keyframes,
              },
            };
          }),
        },
      })),
    updateObjectMotionPath: (objectId, patch) =>
      commitMutation((state) => ({
        ...state,
        project: {
          ...state.project,
          objects: state.project.objects.map((object) => {
            if (object.id !== objectId) return object;
            const motionPath = normalizeObjectMotionPath(object.motionPath, object.transform);
            return { ...object, motionPath: normalizeObjectMotionPath({ ...motionPath, ...patch }, object.transform) };
          }),
        },
      })),
    deleteObjectMotionKeyframe: (objectId, keyframeId) =>
      commitMutation((state) => ({
        ...state,
        selectedObjectMotionKeyframeId:
          state.selectedObjectMotionKeyframeId === keyframeId ? null : state.selectedObjectMotionKeyframeId,
        project: {
          ...state.project,
          objects: state.project.objects.map((object) => {
            if (object.id !== objectId) return object;
            const motionPath = normalizeObjectMotionPath(object.motionPath, object.transform);
            return {
              ...object,
              motionPath: {
                ...motionPath,
                keyframes: motionPath.keyframes.filter((item) => item.id !== keyframeId),
              },
            };
          }),
        },
      })),
    updateCrowdTransform: (crowdId, patch) =>
      commitMutation((state) => {
        const nextTransformState = applyCrowdTransformPatch(state.project.objects, crowdId, patch);
        if (nextTransformState.changedObjectIds.length === 0) return state;

        return {
          ...state,
          project: {
            ...state.project,
            objects: nextTransformState.objects,
            cameras: refreshCamerasFocusedOnObjects(
              state.project.cameras,
              nextTransformState.objects,
              nextTransformState.changedObjectIds
            ),
          },
        };
      }),
    updateObjectName: (id, name) =>
      commitMutation((state) => ({
        ...state,
        project: {
          ...state.project,
          objects: updateObjectById(state.project.objects, id, (item) => ({
            ...item,
            name,
          })),
        },
      })),
    updateCrowdLabel: (crowdId, label) =>
      commitMutation((state) => ({
        ...state,
        project: {
          ...state.project,
          objects: state.project.objects.map((item) =>
            item.kind === "character" && item.crowdId === crowdId
              ? {
                  ...item,
                  crowdLabel: label,
                }
              : item
          ),
        },
      })),
    updateObjectColor: (id, color) =>
      commitMutation((state) => ({
        ...state,
        project: {
          ...state.project,
          objects: updateObjectById(state.project.objects, id, (item) => ({
            ...item,
            color,
          })),
        },
      })),
    updateCrowdColor: (crowdId, color) =>
      commitMutation((state) => ({
        ...state,
        project: {
          ...state.project,
          objects: state.project.objects.map((item) =>
            item.kind === "character" && item.crowdId === crowdId
              ? {
                  ...item,
                  color,
                }
              : item
          ),
        },
      })),
    updateCharacterBodyType: (id, bodyType) =>
      commitMutation((state) => {
        const normalizedBodyType = normalizeBodyType(bodyType);
        const currentObject = state.project.objects.find((item) => item.id === id);
        const nextObject =
          currentObject?.kind === "character"
            ? {
                ...currentObject,
                bodyType: normalizedBodyType,
              }
            : null;

        return {
          ...state,
          project: {
            ...state.project,
            objects: updateObjectById(state.project.objects, id, (item) =>
              item.kind === "character"
                ? {
                    ...item,
                    bodyType: normalizedBodyType,
                  }
                : item
            ),
            cameras: nextObject ? refreshCamerasFocusedOnObject(state.project.cameras, nextObject) : state.project.cameras,
          },
        };
      }),
    updateUniformScale: (id, scale) =>
      commitMutation((state) => {
        const currentObject = state.project.objects.find((item) => item.id === id);
        const nextObject = currentObject
          ? {
              ...currentObject,
              transform: {
                ...currentObject.transform,
                scale: [scale, scale, scale] as [number, number, number],
              },
            }
          : null;

        return {
          ...state,
          project: {
            ...state.project,
            objects: updateObjectById(state.project.objects, id, (item) => ({
              ...item,
              transform: {
                ...item.transform,
                scale: [scale, scale, scale],
              },
            })),
            cameras: nextObject ? refreshCamerasFocusedOnObject(state.project.cameras, nextObject) : state.project.cameras,
          },
        };
      }),
    updateCrowdUniformScale: (crowdId, scale) =>
      commitMutation((state) => {
        const nextTransformState = applyCrowdTransformPatch(state.project.objects, crowdId, {
          scale: [scale, scale, scale],
        });
        if (nextTransformState.changedObjectIds.length === 0) return state;

        return {
          ...state,
          project: {
            ...state.project,
            objects: nextTransformState.objects,
            cameras: refreshCamerasFocusedOnObjects(
              state.project.cameras,
              nextTransformState.objects,
              nextTransformState.changedObjectIds
            ),
          },
        };
      }),
    addImportedAsset: (input) =>
      commitMutation((state) => {
        if (input.kind === "panorama") return state;

        const assetId = input.storageKey
          ? `local_asset_${input.storageKey}`
          : getNextSequentialId(
              state.project.assets.map((item) => item.id),
              "asset_",
              state.project.assets.length + 1
            );
        const nextAsset = {
          id: assetId,
          kind: input.kind,
          sourceType: "model",
          fileName: input.fileName,
          name: input.name,
          url: input.url,
          assetSource: input.assetSource ?? "local",
          projectionMode: input.projectionMode,
          modelFormat: input.modelFormat,
          storageKey: input.storageKey,
          byteLength: input.byteLength,
          characterRigProfile: input.characterRigProfile,
          characterImportReadiness: input.characterImportReadiness,
          characterOrientationCorrection: input.characterOrientationCorrection,
          characterBoneMap: input.characterBoneMap,
        } satisfies DirectorAssetRef;

        if (input.addToScene === false) {
          persistLocalModelAsset(nextAsset);

          return {
            ...state,
            project: {
              ...state.project,
              assets: [...state.project.assets, nextAsset],
            },
          };
        }

        const nextObject = createSceneObjectFromAsset(nextAsset, state.project.objects);

        return {
          ...state,
          selectedObjectId: nextObject.id,
          selectedObjectIds: [nextObject.id],
          selectedCrowdId: null,
          directorInspectorMode: "auto",
          project: {
            ...state.project,
            assets: [...state.project.assets, nextAsset],
            objects: [...state.project.objects, nextObject],
          },
        };
      }),
    addImportedAnimationAsset: (input) => {
      let animationAssetId = input.storageKey
        ? `local_animation_${input.storageKey}`
        : `local_animation_${crypto.randomUUID()}`;

      commitMutation((state) => {
        const existing = (state.project.animationAssets ?? []).find((asset) => asset.id === animationAssetId);
        if (existing) animationAssetId = existing.id;
        const nextAsset = {
          id: animationAssetId,
          name: input.name,
          fileName: input.fileName,
          url: input.url,
          modelFormat: input.modelFormat,
          storageKey: input.storageKey,
          byteLength: input.byteLength,
          rigProfile: input.rigProfile,
          sourceCharacterAssetId: input.sourceCharacterAssetId,
          clips: input.clips,
        } satisfies DirectorAnimationAssetRef;

        return {
          ...state,
          project: {
            ...state.project,
            animationAssets: [
              ...(state.project.animationAssets ?? []).filter((asset) => asset.id !== animationAssetId),
              nextAsset,
            ],
          },
        };
      });

      return animationAssetId;
    },
    removeImportedAnimationAsset: (assetId) =>
      commitMutation((state) => {
        if (!(state.project.animationAssets ?? []).some((asset) => asset.id === assetId)) return state;
        const belongsToAsset = (actionId: string | null | undefined) =>
          parseImportedCharacterActionId(actionId)?.animationAssetId === assetId;

        return {
          ...state,
          project: {
            ...state.project,
            animationAssets: (state.project.animationAssets ?? []).filter((asset) => asset.id !== assetId),
            objects: state.project.objects.map((object) => ({
              ...object,
              characterRig: object.characterRig
                ? {
                    ...object.characterRig,
                    actionPresetId: belongsToAsset(object.characterRig.actionPresetId)
                      ? null
                      : object.characterRig.actionPresetId,
                  }
                : undefined,
              motionPath: object.motionPath
                ? {
                    ...object.motionPath,
                    keyframes: object.motionPath.keyframes.map((keyframe) => ({
                      ...keyframe,
                      actionPresetId: belongsToAsset(keyframe.actionPresetId) ? null : keyframe.actionPresetId,
                      holdActionPresetId: belongsToAsset(keyframe.holdActionPresetId)
                        ? null
                        : keyframe.holdActionPresetId,
                    })),
                  }
                : undefined,
            })),
          },
        };
      }),
    addObjectFromAsset: (assetId) => {
      let nextObjectId: string | null = null;

      commitMutation((state) => {
        const asset = state.project.assets.find((item) => item.id === assetId);
        if (!asset || asset.sourceType !== "model" || asset.kind === "panorama") return state;

        const nextObject = createSceneObjectFromAsset(asset, state.project.objects);
        nextObjectId = nextObject.id;

        return {
          ...state,
          selectedObjectId: nextObject.id,
          selectedObjectIds: [nextObject.id],
          selectedCrowdId: null,
          directorInspectorMode: "auto",
          project: {
            ...state.project,
            objects: [...state.project.objects, nextObject],
          },
        };
      });

      return nextObjectId;
    },
    addPresetCharacter: (bodyType = DEFAULT_CHARACTER_BODY_TYPE) =>
      commitMutation((state) => {
        const presetCharacterCount = state.project.objects.filter(
          (item) => item.kind === "character" && item.id.startsWith("char_preset_")
        ).length;
        const presetCharacterIndex = presetCharacterCount + 1;
        const row = Math.floor((presetCharacterIndex - 1) / 4);
        const x = getAddedModelColumnOffset(presetCharacterIndex - row * 4);
        const z = row * 0.8;
        const nextObject = buildPresetCharacterObject(state, bodyType, [x, 0, z]);

        return {
          ...state,
          selectedObjectId: nextObject.id,
          selectedObjectIds: [nextObject.id],
          selectedCrowdId: null,
          directorInspectorMode: "auto",
          project: {
            ...state.project,
            objects: [...state.project.objects, nextObject],
          },
        };
      }),
    addCrowdCharacters: ({ bodyType = DEFAULT_CHARACTER_BODY_TYPE, rows, columns, spacing }) => {
      const createdIds: string[] = [];

      commitMutation((state) => {
        const positions = getCrowdCharacterPositions(rows, columns, spacing);
        const offset = getCrowdCharacterOffset(state.project.objects, spacing);
        const nextObjects = [...state.project.objects];
        const crowdLabel = formatCrowdLabel(rows, columns);
        const crowdId = getNextCrowdId(state.project.objects);

        positions.forEach((position) => {
          const nextState = {
            ...state,
            project: {
              ...state.project,
              objects: nextObjects,
            },
          } as DirectorRuntimeState;
          const nextObject = buildPresetCharacterObject(nextState, bodyType, [
            Number((position[0] + offset[0]).toFixed(4)),
            Number((position[1] + offset[1]).toFixed(4)),
            Number((position[2] + offset[2]).toFixed(4)),
          ], {
            crowdId,
            crowdLabel,
          });
          nextObjects.push(nextObject);
          createdIds.push(nextObject.id);
        });

        if (!createdIds.length) return state;

        return {
          ...state,
          selectedObjectId: createdIds[createdIds.length - 1] ?? null,
          selectedObjectIds: createdIds,
          selectedCrowdId: crowdId,
          directorInspectorMode: "auto",
          project: {
            ...state.project,
            objects: nextObjects,
          },
        };
      });

      return createdIds;
    },
    addGeometryPrimitive: (geometryType) =>
      commitMutation((state) => {
        const geometryObjects = state.project.objects.filter((item) => item.kind === "prop" && item.geometryType);
        const geometryIndex = geometryObjects.length + 1;
        const sameTypeCount = geometryObjects.filter((item) => item.geometryType === geometryType).length;
        const row = Math.floor((geometryIndex - 1) / 4);
        const column = (geometryIndex - 1) % 4;
        const x = column * 1.15 - 1.725;
        const z = row * 0.75 + 1.15;
        const label = getGeometryPrimitiveLabel(geometryType);
        const objectId = getNextSequentialId(
          state.project.objects.map((item) => item.id),
          `geo_${geometryType}_`,
          geometryIndex
        );
        const nextObject: DirectorObject = {
          id: objectId,
          name: sameTypeCount === 0 ? label : `${label}${String(sameTypeCount + 1).padStart(2, "0")}`,
          kind: "prop",
          visible: true,
          locked: false,
          geometryType,
          color: GEOMETRY_PRIMITIVE_COLOR,
          transform: createTransform([x, 0, z]),
        };

        return {
          ...state,
          selectedObjectId: objectId,
          selectedObjectIds: [objectId],
          selectedCrowdId: null,
          directorInspectorMode: "auto",
          project: {
            ...state.project,
            objects: [...state.project.objects, nextObject],
          },
        };
      }),
    addCameraShot: (snapshot) => {
      let nextCameraId = "";

      commitMutation((state) => {
        const cameraIndex = state.project.cameras.length + 1;
        const cameraId = getNextSequentialId(
          state.project.cameras.map((item) => item.id),
          "cam_",
          cameraIndex
        );
        const objectId = getNextSequentialId(
          state.project.objects.map((item) => item.id),
          "cam_object_",
          cameraIndex
        );
        nextCameraId = cameraId;
        const transform = createTransform(
          snapshot ? getCameraRigPositionFromViewSnapshot(snapshot) : [cameraIndex * 1.2, 2.2, 9]
        );
        const nextCamera: DirectorCameraShot = {
          id: cameraId,
          name: formatSceneItemName("机位", cameraIndex),
          fov: snapshot?.fov ?? 50,
          transform,
          targetMode: "manual",
          target: snapshot?.target ?? [0, 1.2, 0],
          lastCaptureUrl: null,
          captures: [],
          motionPath: { ...DEFAULT_CAMERA_MOTION_PATH, keyframes: [] },
        };
        const nextCameraObject: DirectorObject = {
          id: objectId,
          name: nextCamera.name,
          kind: "camera",
          visible: true,
          locked: false,
          linkedCameraId: cameraId,
          transform,
        };

        return {
          ...state,
          selectedObjectId: objectId,
          selectedObjectIds: [objectId],
          selectedCrowdId: null,
          directorInspectorMode: "auto",
          project: {
            ...state.project,
            cameras: [...state.project.cameras, nextCamera],
            activeCameraId: cameraId,
            objects: [...state.project.objects, nextCameraObject],
          },
        };
      });

      return nextCameraId;
    },
    ensureMotionCamera: (snapshot) => {
      let motionCameraId = "";

      commitUiMutation((state) => {
        const activeCamera = state.project.cameras.find(
          (camera) => camera.id === state.project.activeCameraId
        );
        const existingCamera = activeCamera ?? state.project.cameras[0];

        if (existingCamera) {
          motionCameraId = existingCamera.id;
          if (state.project.activeCameraId === existingCamera.id) return state;

          return {
            ...state,
            project: {
              ...state.project,
              activeCameraId: existingCamera.id,
            },
          };
        }

        const cameraId = getNextSequentialId(
          state.project.cameras.map((camera) => camera.id),
          "motion_cam_",
          1
        );
        const viewSnapshot = snapshot ?? DEFAULT_DIRECTOR_CAMERA_VIEW_SNAPSHOT;
        const motionCamera: DirectorCameraShot = {
          id: cameraId,
          name: "自动运镜镜头",
          isVirtual: true,
          fov: viewSnapshot.fov,
          transform: createTransform(getCameraRigPositionFromViewSnapshot(viewSnapshot)),
          targetMode: "manual",
          target: [...viewSnapshot.target] as [number, number, number],
          lastCaptureUrl: null,
          captures: [],
          motionPath: { ...DEFAULT_CAMERA_MOTION_PATH, keyframes: [] },
        };
        motionCameraId = cameraId;

        return {
          ...state,
          project: {
            ...state.project,
            cameras: [...state.project.cameras, motionCamera],
            activeCameraId: cameraId,
          },
        };
      });

      return motionCameraId;
    },
    deleteSelectedObject: () =>
      commitMutation((state) => {
        const selectedObjectIds = getOrderedSelectedObjectIds(state);
        if (!selectedObjectIds.length) return state;

        const selectedObjects = state.project.objects.filter((item) => selectedObjectIds.includes(item.id));
        if (!selectedObjects.length) {
          return {
            ...state,
            selectedObjectId: null,
            selectedObjectIds: [],
          };
        }

        const linkedCameraIds = new Set(
          selectedObjects
            .filter((item) => item.kind === "camera" && item.linkedCameraId)
            .map((item) => item.linkedCameraId)
        );
        const nextCameras = linkedCameraIds.size
          ? state.project.cameras.filter((camera) => !linkedCameraIds.has(camera.id))
          : state.project.cameras;
        const selectedObjectIdSet = new Set(selectedObjectIds);
        const nextFocusedCameras = nextCameras.map((camera) =>
          camera.targetObjectId && selectedObjectIdSet.has(camera.targetObjectId)
            ? {
                ...camera,
                targetMode: "manual" as const,
                targetObjectId: null,
              }
            : camera
        );
        const nextActiveCameraId =
          state.project.activeCameraId && linkedCameraIds.has(state.project.activeCameraId)
            ? nextFocusedCameras[0]?.id ?? null
            : state.project.activeCameraId;
        const nextObjects = state.project.objects.filter((item) => !selectedObjectIds.includes(item.id));
        const assetsById = new Map(state.project.assets.map((item) => [item.id, item]));
        const remainingAssetRefIds = new Set(
          nextObjects.map((item) => item.assetRefId).filter((assetRefId): assetRefId is string => Boolean(assetRefId))
        );
        const removedAssetRefIds = new Set(
          selectedObjects
            .map((item) => item.assetRefId)
            .filter(
              (assetRefId): assetRefId is string => {
                if (typeof assetRefId !== "string" || remainingAssetRefIds.has(assetRefId)) return false;
                return assetsById.get(assetRefId)?.assetSource !== "local";
              }
            )
        );

        return {
          ...state,
          selectedObjectId: null,
          selectedObjectIds: [],
          selectedCrowdId: null,
          directorInspectorMode: "auto",
          project: {
            ...state.project,
            assets: state.project.assets.filter((item) => !removedAssetRefIds.has(item.id)),
            objects: nextObjects,
            cameras: nextFocusedCameras,
            activeCameraId: nextActiveCameraId,
          },
        };
      }),
    toggleObjectVisible: (id) =>
      commitMutation((state) => ({
        ...state,
        project: {
          ...state.project,
          objects: updateObjectById(state.project.objects, id, (item) => ({
            ...item,
            visible: !item.visible,
          })),
        },
      })),
    toggleObjectLocked: (id) =>
      commitMutation((state) => ({
        ...state,
        project: {
          ...state.project,
          objects: updateObjectById(state.project.objects, id, (item) => ({
            ...item,
            locked: !item.locked,
          })),
        },
      })),
    applyPosePreset: (id, presetId) =>
      commitMutation((state) => {
        const preset = MANNEQUIN_POSE_PRESETS.find((item) => item.id === presetId);

        return {
          ...state,
          project: {
            ...state.project,
            objects: updateObjectById(state.project.objects, id, (item) => ({
              ...item,
              characterRig: item.characterRig
                ? {
                    ...item.characterRig,
                    posePresetId: presetId,
                    actionPresetId: null,
                    controls: preset ? { ...preset.controls } : item.characterRig.controls,
                  }
                : item.characterRig,
            })),
          },
        };
      }),
    applyCrowdPosePreset: (crowdId, presetId) =>
      commitMutation((state) => {
        const preset = MANNEQUIN_POSE_PRESETS.find((item) => item.id === presetId);

        return {
          ...state,
          project: {
            ...state.project,
            objects: state.project.objects.map((item) =>
              item.kind === "character" && item.crowdId === crowdId
                ? {
                    ...item,
                    characterRig: item.characterRig
                      ? {
                          ...item.characterRig,
                          posePresetId: presetId,
                          actionPresetId: null,
                          controls: preset ? { ...preset.controls } : item.characterRig.controls,
                        }
                      : item.characterRig,
                  }
                : item
            ),
          },
        };
      }),
    applyCharacterActionPreset: (id, presetId) =>
      commitMutation((state) => ({
        ...state,
        project: {
          ...state.project,
          objects: updateObjectById(state.project.objects, id, (item) => ({
            ...item,
            characterRig: item.characterRig
              ? { ...item.characterRig, actionPresetId: presetId }
              : item.characterRig,
          })),
        },
      })),
    applyCrowdActionPreset: (crowdId, presetId) =>
      commitMutation((state) => ({
        ...state,
        project: {
          ...state.project,
          objects: state.project.objects.map((item) =>
            item.kind === "character" && item.crowdId === crowdId && item.characterRig
              ? { ...item, characterRig: { ...item.characterRig, actionPresetId: presetId } }
              : item
          ),
        },
      })),
    updatePoseControl: (id, key, value) =>
      commitMutation((state) => ({
        ...state,
        project: {
          ...state.project,
          objects: updateObjectById(state.project.objects, id, (item) => ({
            ...item,
            characterRig: item.characterRig
              ? {
                  ...item.characterRig,
                  controls: {
                    ...item.characterRig.controls,
                    [key]: value,
                  },
                }
              : item.characterRig,
            })),
        },
      })),
    updateCrowdPoseControl: (crowdId, key, value) =>
      commitMutation((state) => ({
        ...state,
        project: {
          ...state.project,
          objects: state.project.objects.map((item) =>
            item.kind === "character" && item.crowdId === crowdId
              ? {
                  ...item,
                  characterRig: item.characterRig
                    ? {
                        ...item.characterRig,
                        controls: {
                          ...item.characterRig.controls,
                          [key]: value,
                        },
                      }
                    : item.characterRig,
                }
              : item
          ),
        },
      })),
    setActiveCamera: (cameraId) =>
      commitUiMutation((state) => {
        const selectedObjectId =
          state.project.objects.find((item) => item.kind === "camera" && item.linkedCameraId === cameraId)?.id ??
          null;

        return {
          ...state,
          project: {
            ...state.project,
            activeCameraId: cameraId,
          },
          selectedObjectId,
          selectedObjectIds: selectedObjectId ? [selectedObjectId] : [],
          selectedCrowdId: null,
          selectedCameraKeyframeId: null,
          selectedCameraKeyframeIds: [],
          cameraMotionProgress: 0,
          cameraMotionPlaying: false,
        };
      }),
    addCameraCaptures: (cameraId, dataUrls) =>
      commitMutation((state) => {
        if (dataUrls.length === 0) return state;

        const targetCameraId = cameraId ?? state.project.activeCameraId ?? state.project.cameras[0]?.id ?? null;
        if (!targetCameraId) return state;

        let updated = false;
        const cameras = state.project.cameras.map((camera) => {
          if (camera.id !== targetCameraId) return camera;

          updated = true;
          const nextCaptures = buildCameraCaptures(camera, dataUrls);

          return {
            ...camera,
            lastCaptureUrl: nextCaptures[nextCaptures.length - 1]?.dataUrl ?? camera.lastCaptureUrl ?? null,
            captures: [...(camera.captures ?? []), ...nextCaptures],
          };
        });

        if (!updated) return state;

        return {
          ...state,
          project: {
            ...state.project,
            cameras,
          },
        };
      }),
    updateCamera: (cameraId, patch) =>
      commitMutation((state) => ({
        ...state,
        project: {
          ...state.project,
          cameras: state.project.cameras.map((item) =>
            item.id === cameraId
              ? {
                  ...item,
                  ...patch,
                  transform: patch.transform ?? item.transform,
                  target: patch.target ?? item.target,
                  motionPath: patch.motionPath
                    ? normalizeCameraMotionPath(patch.motionPath, patch.target ?? item.target, item)
                    : item.motionPath,
                }
              : item
          ),
          objects: state.project.objects.map((item) =>
            item.kind === "camera" && item.linkedCameraId === cameraId && patch.transform
              ? { ...item, transform: patch.transform }
              : item
          ),
        },
      })),
    selectCameraMotionKeyframe: (keyframeId) =>
      set((state) => ({
        ...(state as DirectorRuntimeState),
        selectedCameraKeyframeId: keyframeId,
        selectedCameraKeyframeIds: keyframeId ? [keyframeId] : [],
      })),
    setCameraMotionKeyframeSelection: (keyframeIds) =>
      set((state) => {
        const uniqueIds = Array.from(new Set(keyframeIds.filter((id) => typeof id === "string" && id)));
        return {
          ...(state as DirectorRuntimeState),
          selectedCameraKeyframeId: uniqueIds[uniqueIds.length - 1] ?? null,
          selectedCameraKeyframeIds: uniqueIds,
          cameraMotionPlaying: false,
        };
      }),
    addCameraMotionKeyframe: (cameraId) => {
      let nextKeyframeId: string | null = null;

      commitMutation((state) => {
        const camera = state.project.cameras.find((item) => item.id === cameraId);
        if (!camera) return state;
        const motionPath = normalizeCameraMotionPath(camera.motionPath, camera.target, camera);
        nextKeyframeId = getNextSequentialId(
          motionPath.keyframes.map((item) => item.id),
          `${cameraId}_motion_key_`,
          motionPath.keyframes.length + 1
        );
        const nextKeyframe = createCameraMotionKeyframe(camera, nextKeyframeId);
        const keyframes = retimeCameraMotionKeyframes([...motionPath.keyframes, nextKeyframe]);
        const nextMotionPath = normalizeCameraMotionPath({ ...motionPath, keyframes }, camera.target);

        return {
          ...state,
          selectedCameraKeyframeId: nextKeyframeId,
          selectedCameraKeyframeIds: nextKeyframeId ? [nextKeyframeId] : [],
          cameraMotionProgress: nextMotionPath.keyframes.find((item) => item.id === nextKeyframeId)?.time ?? 0,
          cameraMotionPlaying: false,
          project: {
            ...state.project,
            cameras: state.project.cameras.map((item) =>
              item.id === cameraId
                ? { ...item, motionPath: nextMotionPath }
                : item
            ),
          },
        };
      });

      return nextKeyframeId;
    },
    insertCameraMotionKeyframeAfter: (cameraId, keyframeId) => {
      let insertedKeyframeId: string | null = null;

      commitMutation((state) => {
        const camera = state.project.cameras.find((item) => item.id === cameraId);
        if (!camera) return state;
        const motionPath = normalizeCameraMotionPath(camera.motionPath, camera.target, camera);
        const currentIndex = motionPath.keyframes.findIndex((item) => item.id === keyframeId);
        const nextKeyframe = motionPath.keyframes[currentIndex + 1];
        if (currentIndex < 0 || !nextKeyframe) return state;

        const currentKeyframe = motionPath.keyframes[currentIndex];
        const time = (currentKeyframe.time + nextKeyframe.time) / 2;
        insertedKeyframeId = getNextSequentialId(
          motionPath.keyframes.map((item) => item.id),
          `${cameraId}_motion_key_`,
          motionPath.keyframes.length + 1
        );
        const snapshot = getCameraMotionSnapshot(camera, time);
        const insertedKeyframe: DirectorCameraMotionKeyframe = {
          id: insertedKeyframeId,
          time,
          position: roundTransformTuple(snapshot.position),
          target: roundTransformTuple(snapshot.target),
          fov: Number(snapshot.fov.toFixed(6)),
          targetMode:
            currentKeyframe.targetMode === nextKeyframe.targetMode &&
            currentKeyframe.targetObjectId === nextKeyframe.targetObjectId
              ? currentKeyframe.targetMode
              : "manual",
          targetObjectId:
            currentKeyframe.targetMode === "object" &&
            currentKeyframe.targetObjectId === nextKeyframe.targetObjectId
              ? currentKeyframe.targetObjectId ?? null
              : null,
          targetBodyPart:
            currentKeyframe.targetMode === "object" &&
            currentKeyframe.targetObjectId === nextKeyframe.targetObjectId &&
            currentKeyframe.targetBodyPart === nextKeyframe.targetBodyPart
              ? currentKeyframe.targetBodyPart ?? "center"
              : "center",
          targetFollowMode:
            currentKeyframe.targetFollowMode === nextKeyframe.targetFollowMode
              ? currentKeyframe.targetFollowMode ?? "immediate"
              : "immediate",
          targetStabilizationEnabled:
            currentKeyframe.targetStabilizationEnabled === nextKeyframe.targetStabilizationEnabled
              ? Boolean(currentKeyframe.targetStabilizationEnabled)
              : false,
          pointBehavior: "pass",
          holdSeconds: 0,
        };
        const nextMotionPath = normalizeCameraMotionPath({
          ...motionPath,
          keyframes: [...motionPath.keyframes, insertedKeyframe],
        }, camera.target);

        return {
          ...state,
          selectedCameraKeyframeId: insertedKeyframeId,
          selectedCameraKeyframeIds: [insertedKeyframeId],
          cameraMotionProgress: time,
          cameraMotionPlaying: false,
          project: {
            ...state.project,
            cameras: state.project.cameras.map((item) =>
              item.id === cameraId ? { ...item, motionPath: nextMotionPath } : item
            ),
          },
        };
      });

      return insertedKeyframeId;
    },
    recordCameraMotionSnapshot: (cameraId, snapshot, editKeyframeId = null, timelineTime = null) => {
      let recordedKeyframeId: string | null = null;

      commitMutation((state) => {
        const camera = state.project.cameras.find((item) => item.id === cameraId);
        if (!camera) return state;
        const motionPath = normalizeCameraMotionPath(camera.motionPath, camera.target, camera);
        const preservePlayback = typeof timelineTime === "number" && Number.isFinite(timelineTime);
        const editableKeyframe = editKeyframeId
          ? motionPath.keyframes.find((item) => item.id === editKeyframeId)
          : null;

        if (editableKeyframe) {
          recordedKeyframeId = editableKeyframe.id;
          const keyframes = motionPath.keyframes.map((item) =>
            item.id === editableKeyframe.id
              ? {
                  ...item,
                  position: [...snapshot.position] as [number, number, number],
                  target: [...snapshot.target] as [number, number, number],
                  fov: snapshot.fov,
                }
              : item
          );

          return {
            ...state,
            selectedCameraKeyframeId: editableKeyframe.id,
            selectedCameraKeyframeIds: [editableKeyframe.id],
            cameraMotionProgress: editableKeyframe.time,
            cameraMotionPlaying: preservePlayback ? state.cameraMotionPlaying : false,
            project: {
              ...state.project,
              cameras: state.project.cameras.map((item) =>
                item.id === cameraId
                  ? { ...item, motionPath: normalizeCameraMotionPath({ ...motionPath, keyframes }, camera.target) }
                  : item
              ),
            },
          };
        }

        const normalizedTimelineTime =
          typeof timelineTime === "number" && Number.isFinite(timelineTime)
            ? Math.min(1, Math.max(0, timelineTime))
            : null;
        recordedKeyframeId = getNextSequentialId(
          motionPath.keyframes.map((item) => item.id),
          `${cameraId}_motion_key_`,
          motionPath.keyframes.length + 1
        );
        const nextKeyframe = {
          ...createCameraMotionKeyframe(camera, recordedKeyframeId, snapshot),
          time: normalizedTimelineTime ?? 0,
        };
        const keyframes = normalizedTimelineTime === null
          ? retimeCameraMotionKeyframes([...motionPath.keyframes, nextKeyframe])
          : [...motionPath.keyframes, nextKeyframe].sort((left, right) => left.time - right.time);
        const nextMotionPath = normalizeCameraMotionPath({ ...motionPath, keyframes }, camera.target);
        const selected = nextMotionPath.keyframes.find((item) => item.id === recordedKeyframeId);

        return {
          ...state,
          selectedCameraKeyframeId: recordedKeyframeId,
          selectedCameraKeyframeIds: recordedKeyframeId ? [recordedKeyframeId] : [],
          cameraMotionProgress: selected?.time ?? 0,
          cameraMotionPlaying: preservePlayback ? state.cameraMotionPlaying : false,
          project: {
            ...state.project,
            cameras: state.project.cameras.map((item) =>
              item.id === cameraId ? { ...item, motionPath: nextMotionPath } : item
            ),
          },
        };
      });

      return recordedKeyframeId;
    },
    updateCameraMotionKeyframe: (cameraId, keyframeId, patch) =>
      commitMutation((state) => ({
        ...state,
        project: {
          ...state.project,
          cameras: state.project.cameras.map((camera) => {
            if (camera.id !== cameraId) return camera;
            const motionPath = normalizeCameraMotionPath(camera.motionPath, camera.target, camera);
            const activatesNewTiming = typeof patch.time === "number"
              || (!motionPath.speedMode && ("pointBehavior" in patch || "holdSeconds" in patch));
            return {
              ...camera,
              motionPath: normalizeCameraMotionPath({
                ...motionPath,
                ...(activatesNewTiming ? { speedMode: "custom" as const } : {}),
                keyframes: motionPath.keyframes.map((keyframe) =>
                  keyframe.id === keyframeId
                    ? {
                        ...keyframe,
                        ...patch,
                        position: patch.position ?? keyframe.position,
                        target: patch.target ?? keyframe.target,
                      }
                    : keyframe
                ),
              }, camera.target),
            };
          }),
        },
      })),
    deleteCameraMotionKeyframe: (cameraId, keyframeId) =>
      commitMutation((state) => {
        const camera = state.project.cameras.find((item) => item.id === cameraId);
        if (!camera) return state;
        const motionPath = normalizeCameraMotionPath(camera.motionPath, camera.target, camera);
        const index = motionPath.keyframes.findIndex((item) => item.id === keyframeId);
        const keyframes = retimeCameraMotionKeyframes(
          motionPath.keyframes.filter((item) => item.id !== keyframeId)
        );
        const nextSelected = keyframes[Math.min(Math.max(index, 0), keyframes.length - 1)] ?? null;

        return {
          ...state,
          selectedCameraKeyframeId: nextSelected?.id ?? null,
          selectedCameraKeyframeIds: nextSelected ? [nextSelected.id] : [],
          cameraMotionProgress: nextSelected?.time ?? 0,
          cameraMotionPlaying: false,
          project: {
            ...state.project,
            cameras: state.project.cameras.map((item) =>
              item.id === cameraId
                ? { ...item, motionPath: { ...motionPath, keyframes } }
                : item
            ),
          },
        };
      }),
    moveCameraMotionKeyframe: (cameraId, keyframeId, offset) =>
      commitMutation((state) => {
        const camera = state.project.cameras.find((item) => item.id === cameraId);
        if (!camera) return state;
        const motionPath = normalizeCameraMotionPath(camera.motionPath, camera.target, camera);
        const currentIndex = motionPath.keyframes.findIndex((item) => item.id === keyframeId);
        if (currentIndex < 0) return state;
        const nextIndex = Math.min(motionPath.keyframes.length - 1, Math.max(0, currentIndex + offset));
        if (nextIndex === currentIndex) return state;

        const reordered = [...motionPath.keyframes];
        const [keyframe] = reordered.splice(currentIndex, 1);
        reordered.splice(nextIndex, 0, keyframe);
        const keyframes = retimeCameraMotionKeyframes(reordered);

        return {
          ...state,
          cameraMotionProgress: keyframes.find((item) => item.id === keyframeId)?.time ?? state.cameraMotionProgress,
          cameraMotionPlaying: false,
          project: {
            ...state.project,
            cameras: state.project.cameras.map((item) =>
              item.id === cameraId ? { ...item, motionPath: { ...motionPath, keyframes } } : item
            ),
          },
        };
      }),
    translateSelectedCameraMotionKeyframes: (cameraId, offset) =>
      commitMutation((state) => {
        const selectedIds = new Set(state.selectedCameraKeyframeIds);
        if (selectedIds.size === 0) return state;
        const delta: [number, number, number] = offset.map((value) =>
          Number.isFinite(value) ? value : 0
        ) as [number, number, number];
        if (delta.every((value) => Math.abs(value) <= 0.000001)) return state;

        let changed = false;
        const cameras = state.project.cameras.map((camera) => {
          if (camera.id !== cameraId) return camera;
          const motionPath = normalizeCameraMotionPath(camera.motionPath, camera.target, camera);
          const keyframes = motionPath.keyframes.map((keyframe) => {
            if (!selectedIds.has(keyframe.id)) return keyframe;
            changed = true;
            return {
              ...keyframe,
              position: roundTransformTuple([
                keyframe.position[0] + delta[0],
                keyframe.position[1] + delta[1],
                keyframe.position[2] + delta[2],
              ]),
              target: roundTransformTuple([
                keyframe.target[0] + delta[0],
                keyframe.target[1] + delta[1],
                keyframe.target[2] + delta[2],
              ]),
            };
          });
          return changed ? { ...camera, motionPath: { ...motionPath, keyframes } } : camera;
        });

        if (!changed) return state;
        return {
          ...state,
          cameraMotionPlaying: false,
          project: { ...state.project, cameras },
        };
      }),
    replaceCameraMotionKeyframes: (cameraId, keyframes, duration) =>
      commitMutation((state) => {
        const camera = state.project.cameras.find((item) => item.id === cameraId);
        if (!camera) return state;
        const motionPath = normalizeCameraMotionPath(camera.motionPath, camera.target, camera);
        const nextMotionPath = normalizeCameraMotionPath(
          {
            ...motionPath,
            duration: duration ?? motionPath.duration,
            keyframes,
          },
          camera.target
        );

        return {
          ...state,
          selectedCameraKeyframeId: nextMotionPath.keyframes[0]?.id ?? null,
          selectedCameraKeyframeIds: nextMotionPath.keyframes[0] ? [nextMotionPath.keyframes[0].id] : [],
          cameraMotionProgress: 0,
          cameraMotionPlaying: false,
          project: {
            ...state.project,
            cameras: state.project.cameras.map((item) =>
              item.id === cameraId ? { ...item, motionPath: nextMotionPath } : item
            ),
          },
        };
      }),
    updateCameraMotionPath: (cameraId, patch) =>
      commitMutation((state) => ({
        ...state,
        project: {
          ...state.project,
          cameras: state.project.cameras.map((camera) =>
            camera.id === cameraId
              ? {
                  ...camera,
                  motionPath: normalizeCameraMotionPath({
                    ...normalizeCameraMotionPath(camera.motionPath, camera.target, camera),
                    ...patch,
                  }, camera.target),
                }
              : camera
          ),
        },
      })),
    setCameraMotionProgress: (progress) =>
      set((state) => {
        const nextProgress = setRuntimePlaybackProgress(progress);
        return {
          ...(state as DirectorRuntimeState),
          cameraMotionProgress: nextProgress,
        };
      }),
    setCameraMotionPlaying: (playing) =>
      set((state) => {
        const runtimeProgress = getRuntimePlaybackProgress();
        return {
          ...(state as DirectorRuntimeState),
          cameraMotionPlaying: playing,
          cameraMotionProgress: playing ? state.cameraMotionProgress : runtimeProgress,
        };
      }),
    restartCameraMotionPlayback: () =>
      set((state) => {
        setRuntimePlaybackProgress(0);
        return {
          ...(state as DirectorRuntimeState),
          cameraMotionProgress: 0,
          cameraMotionPlaying: true,
          cameraMotionPlaybackRevision: state.cameraMotionPlaybackRevision + 1,
        };
      }),
    setCharacterActionPreview: (preview) =>
      set((state) => ({
        ...(state as DirectorRuntimeState),
        characterActionPreview: preview,
      })),
    setMotionStudioOpen: (open) =>
      set((state) => ({
        ...(state as DirectorRuntimeState),
        motionStudioOpen: open,
        cameraPilotMode: open ? state.cameraPilotMode : "idle",
        cameraPilotEditKeyframeId: open ? state.cameraPilotEditKeyframeId : null,
        cameraPilotHoveredTargetId: open ? state.cameraPilotHoveredTargetId : null,
        cameraPilotLockedTargetId: open ? state.cameraPilotLockedTargetId : null,
        cameraPilotLockedPoint: open ? state.cameraPilotLockedPoint : null,
      })),
    startCameraPilot: (mode = "pilot", editKeyframeId = null) =>
      set((state) => ({
        ...(state as DirectorRuntimeState),
        viewMode: "director",
        motionStudioOpen: true,
        cameraPilotMode: mode,
        cameraPilotEditKeyframeId: editKeyframeId,
        cameraMotionPlaying: false,
      })),
    stopCameraPilot: () =>
      set((state) => ({
        ...(state as DirectorRuntimeState),
        cameraPilotMode: "idle",
        cameraPilotEditKeyframeId: null,
        cameraPilotHoveredTargetId: null,
        cameraPilotLockedTargetId: null,
        cameraPilotLockedPoint: null,
      })),
    setCameraPilotHoveredTarget: (objectId) =>
      set((state) => ({
        ...(state as DirectorRuntimeState),
        cameraPilotHoveredTargetId: objectId,
      })),
    setCameraPilotLockedTarget: (objectId) =>
      set((state) => ({
        ...(state as DirectorRuntimeState),
        cameraPilotLockedTargetId: objectId,
        cameraPilotLockedPoint: null,
      })),
    setCameraPilotLockedPoint: (point) =>
      set((state) => ({
        ...(state as DirectorRuntimeState),
        cameraPilotLockedTargetId: null,
        cameraPilotLockedPoint: point ? [...point] : null,
      })),
    setCameraPilotFollowTarget: (follow) =>
      set((state) => ({
        ...(state as DirectorRuntimeState),
        cameraPilotFollowTarget: follow,
      })),
    copySelectedObjects: () => {
      const currentState = get() as DirectorRuntimeState;
      const clipboard = buildClipboardEntries(currentState);
      set({
        ...currentState,
        clipboard,
        clipboardPasteCount: 0,
      });
    },
    pasteClipboardObjects: () => commitMutation((state) => pasteClipboardEntries(state)),
    undo: () => {
      const currentState = get() as DirectorRuntimeState;
      if (currentState.undoBatchDepth > 0 && currentState.undoBatchSnapshot) {
        const runtimeState = createRuntimeStateFromPersistedState(currentState.undoBatchSnapshot);
        set({
          ...runtimeState,
          clipboard: currentState.clipboard,
          clipboardPasteCount: currentState.clipboardPasteCount,
          undoStack: currentState.undoStack,
          undoBatchDepth: 0,
          undoBatchSnapshot: null,
          undoBatchHasTrackedChanges: false,
        });
        writePersistedDirectorState(currentState.undoBatchSnapshot);
        return;
      }
      const previousState = currentState.undoStack[currentState.undoStack.length - 1];
      if (!previousState) return;

      const runtimeState = createRuntimeStateFromPersistedState(previousState);
      set({
        ...runtimeState,
        clipboard: currentState.clipboard,
        clipboardPasteCount: currentState.clipboardPasteCount,
        undoStack: currentState.undoStack.slice(0, -1),
      });
      writePersistedDirectorState(previousState);
    },
    openScopedScene: (scopeId) => {
      const currentState = get() as DirectorRuntimeState;
      setDirectorScenePersistenceScopeId(scopeId);
      const snapshot = createInitialDirectorState({
        includePersistedLocalAssets: true,
        includePersistedScene: true,
        persistenceScopeId: directorScenePersistenceScopeId,
      });
      const runtimeState = createRuntimeStateFromPersistedState(snapshot);

      set({
        ...runtimeState,
        clipboard: currentState.clipboard,
        clipboardPasteCount: currentState.clipboardPasteCount,
        undoStack: [],
      });
      writePersistedDirectorState(snapshot);
    },
    replaceProject: (project) =>
      commitMutation((state) => ({
        ...state,
        project: migrateDirectorProject(cloneJsonValue(project)),
        selectedObjectId: null,
        selectedObjectIds: [],
        selectedCrowdId: null,
        directorInspectorMode: "auto",
        selectedCameraKeyframeId: null,
        selectedCameraKeyframeIds: [],
        cameraMotionProgress: 0,
        cameraMotionPlaying: false,
      })),
    saveLatestSnapshot: () => {
      writePersistedDirectorState(extractPersistedDirectorState(get() as DirectorRuntimeState));
    },
    restoreLatestSnapshot: () => {
      const snapshot = readPersistedDirectorState({ includePersistedLocalAssets: true, includePersistedScene: true });
      if (!snapshot) return;

      set({
        ...createRuntimeStateFromPersistedState(snapshot),
        clipboard: (get() as DirectorRuntimeState).clipboard,
        clipboardPasteCount: (get() as DirectorRuntimeState).clipboardPasteCount,
        undoStack: [],
      });
      writePersistedDirectorState(snapshot);
    },
  };
});

useDirectorStore.subscribe((state, previousState) => {
  if (state.cameraMotionProgress !== previousState.cameraMotionProgress) {
    setRuntimePlaybackProgress(state.cameraMotionProgress);
  }
});
