import { Box3, Vector3, type AnimationClip, type Object3D, type SkinnedMesh } from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { findSemanticBodyPartNode } from "../runtime/semanticBodyTracking";
import {
  DIRECTOR_CHARACTER_BONE_PART_OPTIONS,
  DIRECTOR_CAMERA_TARGET_BODY_PART_OPTIONS,
  type DirectorCharacterBoneMap,
  type DirectorCameraTargetBodyPart,
} from "../schema/semanticBody";
import type { CharacterImportReadiness, CharacterRigProfile } from "../schema/directorProject";

export type CharacterAssetFormat = "fbx" | "glb";

export interface CharacterAssetInspection {
  format: CharacterAssetFormat;
  readiness: CharacterImportReadiness;
  rigProfile: CharacterRigProfile;
  skinnedMeshCount: number;
  skeletonCount: number;
  primaryBoneCount: number;
  skeletonDepth: number;
  animationNames: string[];
  animations: Array<{ name: string; duration: number; trackCount: number }>;
  animationCount: number;
  playableAnimationCount: number;
  boneNames: string[];
  boneMap: DirectorCharacterBoneMap;
  mappedBodyParts: DirectorCameraTargetBodyPart[];
  missingBodyParts: DirectorCameraTargetBodyPart[];
  dimensions: [number, number, number];
  footOffsetY: number;
  uprightAxis: "x" | "y" | "z" | "unknown";
  orientationCorrection: [number, number, number];
  recommendedScale: number;
  warnings: string[];
}

export interface LoadedCharacterAsset {
  format: CharacterAssetFormat;
  scene: Object3D;
  animations: AnimationClip[];
}

const CHARACTER_EXTENSION_RE = /\.(fbx|glb)$/i;
const BODY_PARTS = DIRECTOR_CAMERA_TARGET_BODY_PART_OPTIONS.map((option) => option.value);

function normalizeBoneName(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getCharacterAssetFormat(fileName: string): CharacterAssetFormat {
  const extension = fileName.match(CHARACTER_EXTENSION_RE)?.[1]?.toLowerCase();
  if (extension === "fbx" || extension === "glb") return extension;
  throw new Error("人物模型目前仅支持 FBX / GLB 文件");
}

function parseGlb(buffer: ArrayBuffer) {
  return new Promise<GLTF>((resolve, reject) => {
    new GLTFLoader().parse(buffer, "", resolve, reject);
  });
}

export async function loadCharacterModelFile(file: File): Promise<LoadedCharacterAsset> {
  const format = getCharacterAssetFormat(file.name);
  const buffer = await file.arrayBuffer();

  try {
    if (format === "fbx") {
      const scene = new FBXLoader().parse(buffer, "");
      return { format, scene, animations: scene.animations ?? [] };
    }

    const gltf = await parseGlb(buffer);
    return { format, scene: gltf.scene, animations: gltf.animations ?? [] };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "文件内容无法解析";
    throw new Error(`人物模型读取失败：${detail}`);
  }
}

function collectSkinnedMeshes(scene: Object3D) {
  const meshes: SkinnedMesh[] = [];
  scene.traverse((node) => {
    if ("isSkinnedMesh" in node && node.isSkinnedMesh === true) meshes.push(node as SkinnedMesh);
  });
  return meshes;
}

function getSkeletonDepth(rootBone: Object3D | undefined) {
  if (!rootBone) return 0;
  let maxDepth = 0;
  const visit = (node: Object3D, depth: number) => {
    maxDepth = Math.max(maxDepth, depth);
    node.children.forEach((child) => visit(child, depth + 1));
  };
  visit(rootBone, 1);
  return maxDepth;
}

function inferRigProfile(boneNames: string[], mappedPartCount: number): CharacterRigProfile {
  const normalized = boneNames.map(normalizeBoneName);
  if (normalized.some((name) => name.includes("mixamorig1") && name.endsWith("hips"))) return "mixamo-alt";
  if (normalized.some((name) => name.includes("mixamorig") && name.endsWith("hips"))) return "mixamo";
  if (normalized.some((name) => name.startsWith("bip001") || name.startsWith("bip01"))) return "bip";
  if (normalized.some((name) => name.startsWith("ccbase"))) return "cc-base";
  if (mappedPartCount >= 9) return "generic-humanoid";
  return "unknown";
}

function inferOrientation(scene: Object3D, dimensions: Vector3) {
  const head = findSemanticBodyPartNode(scene, "head");
  const waist = findSemanticBodyPartNode(scene, "waist");
  if (head && waist) {
    scene.updateMatrixWorld(true);
    const delta = head.getWorldPosition(new Vector3()).sub(waist.getWorldPosition(new Vector3()));
    const absolute = [Math.abs(delta.x), Math.abs(delta.y), Math.abs(delta.z)];
    const largest = Math.max(...absolute);
    if (largest > 0.0001) {
      const axis = (["x", "y", "z"] as const)[absolute.indexOf(largest)];
      const signedValue = axis === "x" ? delta.x : axis === "y" ? delta.y : delta.z;
      const correction: [number, number, number] = axis === "x"
        ? [0, 0, signedValue > 0 ? Math.PI / 2 : -Math.PI / 2]
        : axis === "z"
          ? [signedValue > 0 ? -Math.PI / 2 : Math.PI / 2, 0, 0]
          : signedValue < 0
            ? [0, 0, Math.PI]
            : [0, 0, 0];
      return { axis, correction };
    }
  }

  const absoluteDimensions = [dimensions.x, dimensions.y, dimensions.z];
  const largest = Math.max(...absoluteDimensions);
  const axis: "x" | "y" | "z" | "unknown" = largest > 0.0001
    ? (["x", "y", "z"] as const)[absoluteDimensions.indexOf(largest)]
    : "unknown";
  const correction: [number, number, number] = axis === "x"
    ? [0, 0, Math.PI / 2]
    : axis === "z"
      ? [-Math.PI / 2, 0, 0]
      : [0, 0, 0];
  return { axis, correction };
}

function getReadiness(
  rigProfile: CharacterRigProfile,
  skinnedMeshCount: number,
  animationCount: number,
  mappedPartCount: number
): CharacterImportReadiness {
  if (skinnedMeshCount === 0) return "static-only";
  if (mappedPartCount === DIRECTOR_CHARACTER_BONE_PART_OPTIONS.length) return "ready";
  if (animationCount > 0) return "native-only";
  return "manual-mapping";
}

function getSafeBounds(scene: Object3D) {
  try {
    return new Box3().setFromObject(scene);
  } catch {
    return new Box3();
  }
}

export function inspectCharacterAsset(
  scene: Object3D,
  animations: AnimationClip[] = [],
  format: CharacterAssetFormat = "fbx"
): CharacterAssetInspection {
  scene.updateMatrixWorld(true);
  const meshes = collectSkinnedMeshes(scene);
  const primaryMesh = meshes.reduce<SkinnedMesh | null>(
    (best, mesh) => !best || mesh.skeleton.bones.length > best.skeleton.bones.length ? mesh : best,
    null
  );
  const skeletons = new Set(meshes.map((mesh) => mesh.skeleton));
  const boneNames = primaryMesh?.skeleton.bones.map((bone) => bone.name) ?? [];
  const boneMap = Object.fromEntries(
    DIRECTOR_CHARACTER_BONE_PART_OPTIONS.flatMap((option) => {
      const node = findSemanticBodyPartNode(scene, option.value);
      return node?.name ? [[option.value, node.name]] : [];
    })
  ) as DirectorCharacterBoneMap;
  const mappedBodyParts = BODY_PARTS.filter((bodyPart) => bodyPart === "center" || Boolean(boneMap[bodyPart]));
  const missingBodyParts = BODY_PARTS.filter((bodyPart) => !mappedBodyParts.includes(bodyPart));
  const rigProfile = inferRigProfile(boneNames, mappedBodyParts.length - 1);
  const bounds = getSafeBounds(scene);
  const dimensions = bounds.isEmpty() ? new Vector3() : bounds.getSize(new Vector3());
  const footOffsetY = bounds.isEmpty() ? 0 : bounds.min.y;
  const orientation = inferOrientation(scene, dimensions);
  const uprightAxis = orientation.axis;
  const playableAnimations = animations.filter((clip) => clip.duration > 0.05 && clip.tracks.length > 0);
  const readiness = getReadiness(rigProfile, meshes.length, playableAnimations.length, mappedBodyParts.length - 1);
  const recommendedScale = dimensions.y > 0.0001 ? 1.8 / dimensions.y : 1;
  const warnings: string[] = [];

  if (meshes.length === 0) warnings.push("没有检测到蒙皮骨架，只能作为静态模型使用");
  if (bounds.isEmpty()) warnings.push("无法计算模型尺寸，文件可能缺少有效几何数据");
  if (meshes.length > 0 && mappedBodyParts.length < 16) warnings.push("身体部位识别不完整，跟拍和外部动作可能受限");
  if (uprightAxis !== "y" && uprightAxis !== "unknown") warnings.push(`模型当前沿 ${uprightAxis.toUpperCase()} 轴站立，导入后需要自动转正`);
  if (animations.length === 0) warnings.push("模型没有自带动作");
  if (animations.length > 0 && playableAnimations.length === 0) warnings.push("检测到动画轨道，但没有可播放时长");
  if (mappedBodyParts.length < 16 && animations.length > 0) warnings.push("当前仅保证播放模型自带动作，补全骨架映射后才能使用外部动作");

  return {
    format,
    readiness,
    rigProfile,
    skinnedMeshCount: meshes.length,
    skeletonCount: skeletons.size,
    primaryBoneCount: primaryMesh?.skeleton.bones.length ?? 0,
    skeletonDepth: getSkeletonDepth(primaryMesh?.skeleton.bones[0]),
    animationNames: animations.map((clip, index) => clip.name.trim() || `动作 ${index + 1}`),
    animations: animations.map((clip, index) => ({
      name: clip.name.trim() || `动作 ${index + 1}`,
      duration: Number(Math.max(0, Number.isFinite(clip.duration) ? clip.duration : 0).toFixed(6)),
      trackCount: clip.tracks.length,
    })),
    animationCount: animations.length,
    playableAnimationCount: playableAnimations.length,
    boneNames,
    boneMap,
    mappedBodyParts,
    missingBodyParts,
    dimensions: dimensions.toArray().map((value) => Number(value.toFixed(4))) as [number, number, number],
    footOffsetY: Number(footOffsetY.toFixed(4)),
    uprightAxis,
    orientationCorrection: orientation.correction.map((value) => Number(value.toFixed(6))) as [number, number, number],
    recommendedScale: Number(recommendedScale.toFixed(6)),
    warnings,
  };
}

export async function inspectCharacterModelFile(file: File) {
  const loaded = await loadCharacterModelFile(file);
  return inspectCharacterAsset(loaded.scene, loaded.animations, loaded.format);
}
