import type {
  DirectorCharacterBoneMap,
  DirectorCameraTargetBodyPart,
  DirectorCameraTargetFollowMode,
} from "./semanticBody";

export type ViewMode = "director" | "camera";
export type RightPanelKind = "scene" | "character" | "prop" | "camera";
export type DirectorObjectKind = "character" | "scene" | "prop" | "camera" | "panorama";
export const GEOMETRY_PRIMITIVE_OPTIONS = [
  { type: "box", label: "立方体" },
  { type: "sphere", label: "球体" },
  { type: "cylinder", label: "圆柱体" },
  { type: "torus", label: "环状体" },
  { type: "cone", label: "圆锥" },
  { type: "pyramid", label: "棱锥" },
] as const;
export type GeometryPrimitiveType = (typeof GEOMETRY_PRIMITIVE_OPTIONS)[number]["type"];
export type CharacterRigType = "mannequin" | "ue4-mannequin" | "mixamo" | "vrm" | "custom-humanoid";
export type CharacterBodyType =
  | "mannequin"
  | "female"
  | "broad"
  | "muscular"
  | "slim"
  | "teen"
  | "child"
  | "chibi";
export type DirectorAssetKind = "character" | "scene" | "prop" | "panorama";
export type DirectorAssetSource = "local" | "library";
export type PanoramaProjectionMode = "equirectangular" | "backdrop";
export type DirectorModelFormat = "fbx" | "obj" | "glb";
export type GroundMaterialPresetId = "studio" | "concrete" | "asphalt" | "wood" | "grass";
export type CharacterRigProfile = "mixamo" | "mixamo-alt" | "bip" | "cc-base" | "generic-humanoid" | "unknown";
export type CharacterImportReadiness = "ready" | "native-only" | "manual-mapping" | "static-only";

export interface DirectorTransform {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

export interface SceneSettings {
  scale: number;
  position: [number, number, number];
  rotation: [number, number, number];
  backgroundColor: string;
  backgroundBrightness: number;
  panoramaYaw: number;
  panoramaRadius: number;
  showLabels: boolean;
  snapToGrid: boolean;
  showGrid: boolean;
  showGround: boolean;
  groundMaterialPreset: GroundMaterialPresetId;
  /** Multiplier for the world-space size of each ground texture tile. */
  groundTextureScale: number;
  groundColor: string;
  groundBrightness: number;
  groundOpacity: number;
  groundHeight: number;
  pathCollisionEnabled: boolean;
}

export interface CharacterRigState {
  rigType: CharacterRigType;
  posePresetId: string | null;
  actionPresetId?: string | null;
  controls: Record<string, number>;
}

export interface DirectorAssetRef {
  id: string;
  kind: DirectorAssetKind;
  sourceType: "model" | "image";
  fileName: string;
  name?: string;
  url: string;
  assetSource?: DirectorAssetSource;
  projectionMode?: PanoramaProjectionMode;
  modelFormat?: DirectorModelFormat;
  storageKey?: string;
  byteLength?: number;
  characterRigProfile?: CharacterRigProfile;
  characterImportReadiness?: CharacterImportReadiness;
  characterOrientationCorrection?: [number, number, number];
  characterBoneMap?: DirectorCharacterBoneMap;
}

export interface DirectorAnimationClipRef {
  id: string;
  name: string;
  duration: number;
  trackCount: number;
}

export interface DirectorAnimationAssetRef {
  id: string;
  name: string;
  fileName: string;
  url: string;
  modelFormat: Extract<DirectorModelFormat, "fbx" | "glb">;
  storageKey?: string;
  byteLength?: number;
  rigProfile: CharacterRigProfile;
  sourceCharacterAssetId?: string;
  clips: DirectorAnimationClipRef[];
}

export interface DirectorObject {
  id: string;
  name: string;
  kind: DirectorObjectKind;
  visible: boolean;
  locked: boolean;
  transform: DirectorTransform;
  bodyType?: CharacterBodyType;
  color?: string;
  assetRefId?: string;
  geometryType?: GeometryPrimitiveType;
  crowdId?: string;
  crowdLabel?: string;
  linkedCameraId?: string | null;
  characterRig?: CharacterRigState;
  motionPath?: DirectorObjectMotionPath;
}

export interface DirectorObjectMotionKeyframe {
  id: string;
  time: number;
  transform: DirectorTransform;
  /** Character action played from this route point until the next point. */
  actionPresetId?: string | null;
  /** Path-facing turns toward the next route point; manual keeps the point rotation. */
  facingMode?: "path" | "manual";
  /** Pass-through keeps moving; hold pauses at this point for holdSeconds. */
  pointBehavior?: DirectorRoutePointBehavior;
  holdSeconds?: number;
  /** Character pose/action used while this point is holding. */
  holdAction?: DirectorRouteHoldAction;
  holdActionPresetId?: string | null;
}

export interface DirectorObjectMotionPath {
  interpolation: CameraMotionInterpolation;
  speedMode?: DirectorRouteSpeedMode;
  customEasing?: DirectorRouteCubicBezier;
  keyframes: DirectorObjectMotionKeyframe[];
}

export interface DirectorCameraCapture {
  id: string;
  index: number;
  name: string;
  dataUrl: string;
}

export type CameraMotionInterpolation = "linear" | "smooth";
export type CameraMotionEasing = "linear" | "ease-in-out";
export type DirectorRouteSpeedMode = "uniform" | "soft" | "custom";
export type DirectorRoutePointBehavior = "pass" | "hold";
export type DirectorRouteHoldAction = "stand" | "current" | "custom";
export type DirectorRouteCubicBezier = [number, number, number, number];

export interface DirectorCameraMotionKeyframe {
  id: string;
  time: number;
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
  /** Each waypoint may independently aim at a moving scene subject. */
  targetMode?: "manual" | "object";
  targetObjectId?: string | null;
  /** Semantic animated body part used when the target is a character. */
  targetBodyPart?: DirectorCameraTargetBodyPart;
  /** Immediate follows exactly; smooth applies temporal damping in each render view. */
  targetFollowMode?: DirectorCameraTargetFollowMode;
  /** Suppresses high-frequency body animation shake while retaining subject movement. */
  targetStabilizationEnabled?: boolean;
  /** Pass-through keeps moving; hold pauses at this point for holdSeconds. */
  pointBehavior?: DirectorRoutePointBehavior;
  holdSeconds?: number;
}

export interface DirectorCameraMotionPath {
  duration: number;
  loop: boolean;
  interpolation: CameraMotionInterpolation;
  easing: CameraMotionEasing;
  speedMode?: DirectorRouteSpeedMode;
  customEasing?: DirectorRouteCubicBezier;
  keyframes: DirectorCameraMotionKeyframe[];
}

export interface DirectorCameraShot {
  id: string;
  name: string;
  /** Internal camera created for the beginner motion workflow. It has no scene helper object. */
  isVirtual?: boolean;
  fov: number;
  transform: DirectorTransform;
  targetMode: "manual" | "object";
  targetObjectId?: string | null;
  target: [number, number, number];
  lastCaptureUrl?: string | null;
  captures?: DirectorCameraCapture[];
  motionPath?: DirectorCameraMotionPath;
}

export interface DirectorProject {
  version: 1;
  scene: SceneSettings;
  assets: DirectorAssetRef[];
  animationAssets?: DirectorAnimationAssetRef[];
  objects: DirectorObject[];
  cameras: DirectorCameraShot[];
  activeCameraId: string | null;
  panoramaAssetId: string | null;
}
