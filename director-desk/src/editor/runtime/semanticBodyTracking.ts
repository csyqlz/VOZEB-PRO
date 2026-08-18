import { Vector3, type Object3D, type SkinnedMesh } from "three";
import type {
  DirectorCameraTargetBodyPart,
  DirectorCharacterBoneMap,
  DirectorCharacterBonePart,
} from "../schema/semanticBody";

export const DIRECTOR_OBJECT_SCENE_NODE_PREFIX = "director-object-";
export const DIRECTOR_CHARACTER_BONE_MAP_USER_DATA_KEY = "directorCharacterBoneMap";

const SEMANTIC_NODE_ALIASES: Record<Exclude<DirectorCameraTargetBodyPart, "center">, string[]> = {
  head: ["directorbodyparthead", "humanoidhead", "mixamorighead", "mixamorig1head", "bip001head055", "ccbasehead", "head"],
  chest: ["directorbodypartchest", "humanoidchest", "mixamorigspine2", "mixamorig1spine2", "bip001spine105", "ccbasespine02", "upperchest", "torso1", "torso", "chest", "spine2"],
  waist: ["directorbodypartwaist", "humanoidpelvis", "mixamorighips", "mixamorig1hips", "bip001pelvis03", "ccbasehip", "abdomen", "pelvis", "hips"],
  leftUpperArm: ["directorbodypartleftupperarm", "humanoidleftupperarm", "mixamorigleftarm", "mixamorig1leftarm", "bip001lupperarm08", "ccbase_l_upperarm", "upperarml", "leftupperarm", "leftarm"],
  leftForearm: ["directorbodypartleftforearm", "humanoidleftforearm", "mixamorigleftforearm", "mixamorig1leftforearm", "bip001lforearm09", "ccbase_l_forearm", "lowerarml", "leftforearm", "leftlowerarm"],
  leftHand: ["directorbodypartlefthand", "humanoidlefthand", "mixamoriglefthand", "mixamorig1lefthand", "bip001lhand010", "ccbase_l_hand", "palm1l", "lefthand"],
  rightUpperArm: ["directorbodypartrightupperarm", "humanoidrightupperarm", "mixamorigrightarm", "mixamorig1rightarm", "bip001rupperarm032", "ccbase_r_upperarm", "upperarmr", "rightupperarm", "rightarm"],
  rightForearm: ["directorbodypartrightforearm", "humanoidrightforearm", "mixamorigrightforearm", "mixamorig1rightforearm", "bip001rforearm033", "ccbase_r_forearm", "lowerarmr", "rightforearm", "rightlowerarm"],
  rightHand: ["directorbodypartrighthand", "humanoidrighthand", "mixamorigrighthand", "mixamorig1righthand", "bip001rhand034", "ccbase_r_hand", "palm1r", "righthand"],
  leftThigh: ["directorbodypartleftthigh", "humanoidleftthigh", "mixamorigleftupleg", "mixamorig1leftupleg", "bip001lthigh057", "ccbase_l_thigh", "upperlegl", "leftupleg", "leftthigh"],
  leftCalf: ["directorbodypartleftcalf", "humanoidleftcalf", "mixamorigleftleg", "mixamorig1leftleg", "bip001lcalf058", "ccbase_l_calf", "lowerlegl", "leftlowerleg", "leftcalf", "leftleg"],
  leftFoot: ["directorbodypartleftfoot", "humanoidleftfoot", "mixamorigleftfoot", "mixamorig1leftfoot", "bip001lfoot059", "ccbase_l_foot", "footl", "leftfoot"],
  rightThigh: ["directorbodypartrightthigh", "humanoidrightthigh", "mixamorigrightupleg", "mixamorig1rightupleg", "bip001rthigh061", "ccbase_r_thigh", "upperlegr", "rightupleg", "rightthigh"],
  rightCalf: ["directorbodypartrightcalf", "humanoidrightcalf", "mixamorigrightleg", "mixamorig1rightleg", "bip001rcalf062", "ccbase_r_calf", "lowerlegr", "rightlowerleg", "rightcalf", "rightleg"],
  rightFoot: ["directorbodypartrightfoot", "humanoidrightfoot", "mixamorigrightfoot", "mixamorig1rightfoot", "bip001rfoot063", "ccbase_r_foot", "footr", "rightfoot"],
};

function normalizeNodeName(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSemanticCandidate(node: Object3D) {
  return Boolean(
    ("isBone" in node && node.isBone === true)
    || node.name.startsWith("humanoid-")
    || node.name.startsWith("director-body-part-")
  );
}

function findPrimarySkinnedMesh(root: Object3D) {
  let primary: SkinnedMesh | null = null;
  root.traverse((node) => {
    if (!("isSkinnedMesh" in node) || node.isSkinnedMesh !== true) return;
    const mesh = node as SkinnedMesh;
    if (!primary || mesh.skeleton.bones.length > primary.skeleton.bones.length) primary = mesh;
  });
  return primary as SkinnedMesh | null;
}

function scoreNodeName(name: string, aliases: string[]) {
  const normalized = normalizeNodeName(name);
  if (aliases.includes(normalized)) return 3;
  if (aliases.some((alias) => alias.length >= 5 && normalized.endsWith(alias))) return 2;
  return 0;
}

export function getSemanticBodyPartForBoneName(name: string): DirectorCharacterBonePart | null {
  let bestPart: DirectorCharacterBonePart | null = null;
  let bestScore = 0;
  (Object.keys(SEMANTIC_NODE_ALIASES) as DirectorCharacterBonePart[]).forEach((bodyPart) => {
    const score = scoreNodeName(name, SEMANTIC_NODE_ALIASES[bodyPart].map(normalizeNodeName));
    if (score > bestScore) {
      bestPart = bodyPart;
      bestScore = score;
    }
  });
  return bestPart;
}

export function getDirectorObjectSceneNodeName(objectId: string) {
  return `${DIRECTOR_OBJECT_SCENE_NODE_PREFIX}${objectId}`;
}

export function findSemanticBodyPartNode(
  root: Object3D,
  bodyPart: DirectorCharacterBonePart,
  boneMap?: DirectorCharacterBoneMap | null
): Object3D | null {
  const mappedBoneName = boneMap?.[bodyPart];
  if (mappedBoneName) {
    const mappedNode = root.getObjectByName(mappedBoneName);
    if (mappedNode) return mappedNode;
  }
  const aliases = SEMANTIC_NODE_ALIASES[bodyPart].map(normalizeNodeName);
  const primaryMesh = findPrimarySkinnedMesh(root);
  if (primaryMesh) {
    let primaryBone: Object3D | null = null;
    let primaryScore = 0;
    primaryMesh.skeleton.bones.forEach((bone) => {
      const score = scoreNodeName(bone.name, aliases);
      if (score > primaryScore) {
        primaryBone = bone;
        primaryScore = score;
      }
    });
    if (primaryBone) return primaryBone;
  }
  let bestNode: Object3D | null = null;
  let bestScore = 0;

  root.traverse((node) => {
    if (!node.name || !isSemanticCandidate(node)) return;
    const score = scoreNodeName(node.name, aliases);
    if (score > bestScore) {
      bestNode = node;
      bestScore = score;
    }
  });

  return bestNode as Object3D | null;
}

export function getSemanticBodyPartWorldPosition(
  root: Object3D,
  bodyPart: DirectorCameraTargetBodyPart,
  output = new Vector3(),
  boneMap?: DirectorCharacterBoneMap | null
) {
  if (bodyPart === "center") return null;
  const node = findSemanticBodyPartNode(root, bodyPart, boneMap);
  if (!node) return null;
  node.getWorldPosition(output);
  return output;
}

export function getSceneSemanticBodyPartTarget(
  scene: Object3D,
  objectId: string,
  bodyPart: DirectorCameraTargetBodyPart
): [number, number, number] | null {
  if (bodyPart === "center") return null;
  const objectRoot = scene.getObjectByName(getDirectorObjectSceneNodeName(objectId));
  if (!objectRoot) return null;
  const boneMap = objectRoot.userData[DIRECTOR_CHARACTER_BONE_MAP_USER_DATA_KEY] as DirectorCharacterBoneMap | undefined;
  const position = getSemanticBodyPartWorldPosition(objectRoot, bodyPart, new Vector3(), boneMap);
  if (!position) return null;
  return [position.x, position.y, position.z].map((value) => Number(value.toFixed(6))) as [number, number, number];
}
