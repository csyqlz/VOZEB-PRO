import { PropertyBinding, type AnimationClip } from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";

export type CharacterAnimationFormat = "fbx" | "glb";

export type CharacterAnimationRigProfile =
  | "mixamo"
  | "mixamorig1"
  | "bip"
  | "cc-base"
  | "generic"
  | "unknown";

export interface CharacterAnimationClipInspection {
  name: string;
  duration: number;
  trackCount: number;
}

export interface CharacterAnimationInspection {
  format: CharacterAnimationFormat;
  clips: CharacterAnimationClipInspection[];
  clipCount: number;
  rigProfile: CharacterAnimationRigProfile;
  hasValidMotion: boolean;
  warnings: string[];
}

export interface LoadedCharacterAnimation {
  format: CharacterAnimationFormat;
  animations: AnimationClip[];
}

export const MIN_VALID_MOTION_DURATION = 0.05;

const CHARACTER_ANIMATION_EXTENSION_RE = /\.(fbx|glb)$/i;

function normalizeNodeName(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getTrackNodeName(trackName: string) {
  const propertySeparator = trackName.lastIndexOf(".");
  const rawNodeName = propertySeparator > 0 ? trackName.slice(0, propertySeparator) : trackName;
  if (/mixamorig1?:/i.test(rawNodeName)) return rawNodeName;

  try {
    return PropertyBinding.parseTrackName(trackName).nodeName;
  } catch {
    return rawNodeName;
  }
}

function hasGenericHumanoidLayout(normalizedNodeNames: string[]) {
  const matches = (patterns: RegExp[]) => normalizedNodeNames.some(
    (nodeName) => patterns.some((pattern) => pattern.test(nodeName))
  );
  const bodyPartSignals = [
    matches([/hips?/, /pelvis/, /^body$/, /^root$/]),
    matches([/spine/, /chest/, /torso/]),
    matches([/head/]),
    matches([/left.*arm/, /arm.*left/, /upperarml/, /lowerarml/, /shoulderl/]),
    matches([/right.*arm/, /arm.*right/, /upperarmr/, /lowerarmr/, /shoulderr/]),
    matches([/left.*leg/, /leg.*left/, /upperlegl/, /lowerlegl/, /thighl/, /calfl/, /footl/]),
    matches([/right.*leg/, /leg.*right/, /upperlegr/, /lowerlegr/, /thighr/, /calfr/, /footr/]),
  ];

  return bodyPartSignals.filter(Boolean).length >= 5;
}

function getExplicitProfiles(normalizedNodeNames: string[]) {
  const profiles = new Set<Exclude<CharacterAnimationRigProfile, "generic" | "unknown">>();

  for (const nodeName of normalizedNodeNames) {
    if (nodeName.startsWith("mixamorig1")) profiles.add("mixamorig1");
    else if (nodeName.startsWith("mixamorig")) profiles.add("mixamo");
    if (/^bip(?:ed)?\d*/.test(nodeName)) profiles.add("bip");
    if (nodeName.startsWith("ccbase")) profiles.add("cc-base");
  }

  return profiles;
}

function inferRigProfile(normalizedNodeNames: string[]): CharacterAnimationRigProfile {
  const explicitProfiles = getExplicitProfiles(normalizedNodeNames);
  const priority: CharacterAnimationRigProfile[] = ["mixamorig1", "mixamo", "bip", "cc-base"];
  const explicitProfile = priority.find((profile) => explicitProfiles.has(
    profile as Exclude<CharacterAnimationRigProfile, "generic" | "unknown">
  ));

  if (explicitProfile) return explicitProfile;
  if (hasGenericHumanoidLayout(normalizedNodeNames)) return "generic";
  return "unknown";
}

function roundDuration(duration: number) {
  if (!Number.isFinite(duration) || duration < 0) return 0;
  return Number(duration.toFixed(6));
}

export function getCharacterAnimationFormat(fileName: string): CharacterAnimationFormat {
  const extension = fileName.match(CHARACTER_ANIMATION_EXTENSION_RE)?.[1]?.toLowerCase();
  if (extension === "fbx" || extension === "glb") return extension;
  throw new Error("角色动画目前仅支持 FBX / GLB 文件");
}

function parseGlb(buffer: ArrayBuffer) {
  return new Promise<GLTF>((resolve, reject) => {
    new GLTFLoader().parse(buffer, "", resolve, reject);
  });
}

export async function loadCharacterAnimationFile(file: File): Promise<LoadedCharacterAnimation> {
  const format = getCharacterAnimationFormat(file.name);
  const buffer = await file.arrayBuffer();

  try {
    if (format === "fbx") {
      const scene = new FBXLoader().parse(buffer, "");
      return { format, animations: scene.animations ?? [] };
    }

    const gltf = await parseGlb(buffer);
    return { format, animations: gltf.animations ?? [] };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "文件内容无法解析";
    throw new Error(`角色动画读取失败：${detail}`);
  }
}

export function inspectCharacterAnimations(
  animations: AnimationClip[],
  format: CharacterAnimationFormat = "fbx"
): CharacterAnimationInspection {
  let hasUnnamedClip = false;
  let hasTracklessClip = false;
  let hasInvalidDuration = false;
  const normalizedNodeNames = new Set<string>();

  const clips = animations.map<CharacterAnimationClipInspection>((clip, index) => {
    const trimmedName = clip.name.trim();
    if (!trimmedName) hasUnnamedClip = true;
    if (clip.tracks.length === 0) hasTracklessClip = true;
    if (!Number.isFinite(clip.duration) || clip.duration < 0) hasInvalidDuration = true;

    for (const track of clip.tracks) {
      const nodeName = normalizeNodeName(getTrackNodeName(track.name));
      if (nodeName) normalizedNodeNames.add(nodeName);
    }

    return {
      name: trimmedName || `动作 ${index + 1}`,
      duration: roundDuration(clip.duration),
      trackCount: clip.tracks.length,
    };
  });

  const nodeNames = [...normalizedNodeNames];
  const rigProfile = inferRigProfile(nodeNames);
  const hasLongDurationClip = animations.some(
    (clip) => Number.isFinite(clip.duration) && clip.duration > MIN_VALID_MOTION_DURATION
  );
  const hasValidMotion = animations.some(
    (clip) => Number.isFinite(clip.duration)
      && clip.duration > MIN_VALID_MOTION_DURATION
      && clip.tracks.length > 0
  );
  const warnings: string[] = [];

  if (clips.length === 0) warnings.push("未检测到动画 clip");
  else if (!hasLongDurationClip) warnings.push("仅检测到时长不超过 0.05 秒的绑定帧，没有有效动作");
  if (rigProfile === "unknown") warnings.push("无法从动画轨道节点名识别骨架 profile");
  if (getExplicitProfiles(nodeNames).size > 1) warnings.push("动画轨道包含多种骨架命名约定，请确认动作来源一致");
  if (hasUnnamedClip) warnings.push("存在未命名的动画 clip，已生成占位名称");
  if (hasTracklessClip) warnings.push("存在不含轨道的动画 clip");
  if (hasInvalidDuration) warnings.push("存在时长无效的动画 clip，已按 0 秒处理");

  return {
    format,
    clips,
    clipCount: clips.length,
    rigProfile,
    hasValidMotion,
    warnings,
  };
}

export async function inspectCharacterAnimationFile(file: File) {
  const loaded = await loadCharacterAnimationFile(file);
  return inspectCharacterAnimations(loaded.animations, loaded.format);
}
