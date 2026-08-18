import type { CharacterBodyType } from "../mannequin/bodyTypes";
import { degreesToRadians, getBodyTypePoseLimit } from "../mannequin/mannequinPose";

export function resolveDirectorAssetUrl(baseUrl: string, assetPath: string) {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;

  return `${normalizedBase}${assetPath}`;
}

export const UE4_MANNEQUIN_MODEL_URL = resolveDirectorAssetUrl(
  import.meta.env.BASE_URL,
  "models/ue-mannequin-retopology.glb"
);

export const UE4_MANNEQUIN_BONE_MAP = {
  body: "Bip001_Pelvis_03",
  torso: "Bip001_Spine1_05",
  head: "Bip001_Head_055",
  leftShoulder: "Bip001_L_UpperArm_08",
  rightShoulder: "Bip001_R_UpperArm_032",
  leftElbow: "Bip001_L_Forearm_09",
  rightElbow: "Bip001_R_Forearm_033",
  leftHand: "Bip001_L_Hand_010",
  rightHand: "Bip001_R_Hand_034",
  leftHip: "Bip001_L_Thigh_057",
  rightHip: "Bip001_R_Thigh_061",
  leftKnee: "Bip001_L_Calf_058",
  rightKnee: "Bip001_R_Calf_062",
  leftFoot: "Bip001_L_Foot_059",
  rightFoot: "Bip001_R_Foot_063",
} as const;

export type UE4BoneScaleMap = Record<string, [number, number, number]>;
export type UE4BonePositionOffsetMap = Record<string, [number, number, number]>;
export type UE4BoneRotationMap = Record<string, [number, number, number]>;

const BIP001_LOCAL_UNITS_PER_WORLD_METER = 1 / 0.0254;

function clamp(value: number, bodyType?: CharacterBodyType) {
  const limit = getBodyTypePoseLimit(bodyType);
  return Math.min(limit, Math.max(-limit, value));
}

function radians(value: number, bodyType?: CharacterBodyType) {
  return degreesToRadians(clamp(value, bodyType));
}

function ue4SpineRotation(
  controls: Record<string, number>,
  prefix: string,
  bodyType?: CharacterBodyType
): [number, number, number] {
  return [
    radians(controls[`${prefix}.yaw`] ?? 0, bodyType),
    radians(controls[`${prefix}.roll`] ?? 0, bodyType),
    -radians(controls[`${prefix}.pitch`] ?? 0, bodyType),
  ];
}

function ue4HeadRotation(
  controls: Record<string, number>,
  bodyType?: CharacterBodyType
): [number, number, number] {
  return [
    radians(controls["head.yaw"] ?? 0, bodyType),
    radians(controls["head.roll"] ?? 0, bodyType),
    radians(controls["head.pitch"] ?? 0, bodyType),
  ];
}

function ue4ShoulderRotation(
  controls: Record<string, number>,
  prefix: "leftShoulder" | "rightShoulder",
  bodyType?: CharacterBodyType
): [number, number, number] {
  const spread = controls[`${prefix}.spread`] ?? 0;

  return [
    radians(controls[`${prefix}.twist`] ?? 0, bodyType),
    radians(spread, bodyType),
    -radians(controls[`${prefix}.pitch`] ?? 0, bodyType),
  ];
}

function ue4HipRotation(
  controls: Record<string, number>,
  prefix: "leftHip" | "rightHip",
  bodyType?: CharacterBodyType
): [number, number, number] {
  const spread = controls[`${prefix}.spread`] ?? 0;

  return [
    radians(controls[`${prefix}.twist`] ?? 0, bodyType),
    -radians(spread, bodyType),
    radians(controls[`${prefix}.pitch`] ?? 0, bodyType),
  ];
}

function ue4LimbBendRotation(
  controls: Record<string, number>,
  key: string,
  bodyType?: CharacterBodyType
): [number, number, number] {
  return [0, 0, -radians(controls[key] ?? 0, bodyType)];
}

function ue4HandRotation(
  controls: Record<string, number>,
  prefix: "leftHand" | "rightHand",
  bodyType?: CharacterBodyType
): [number, number, number] {
  return [
    radians(controls[`${prefix}.twist`] ?? 0, bodyType),
    radians(controls[`${prefix}.roll`] ?? 0, bodyType),
    radians(controls[`${prefix}.pitch`] ?? 0, bodyType),
  ];
}

function ue4FootRotation(
  controls: Record<string, number>,
  prefix: "leftFoot" | "rightFoot",
  bodyType?: CharacterBodyType
): [number, number, number] {
  return [
    radians(controls[`${prefix}.twist`] ?? 0, bodyType),
    radians(controls[`${prefix}.roll`] ?? 0, bodyType),
    radians(controls[`${prefix}.pitch`] ?? 0, bodyType),
  ];
}

function baseBoneScales(): UE4BoneScaleMap {
  return {
    Bip001_Head_055: [1, 1, 1],
    Bip001_Neck_06: [1, 1, 1],
    Bip001_Pelvis_03: [1, 1, 1],
    Bip001_Spine_04: [1, 1, 1],
    Bip001_Spine1_05: [1, 1.02, 1.02],
    Bip001_L_Clavicle_07: [1, 1, 1],
    Bip001_R_Clavicle_031: [1, 1, 1],
    Bip001_L_UpperArm_08: [1, 1, 1],
    Bip001_R_UpperArm_032: [1, 1, 1],
    Bip001_L_Forearm_09: [1, 1, 1],
    Bip001_R_Forearm_033: [1, 1, 1],
    Bip001_L_Hand_010: [1, 1, 1],
    Bip001_R_Hand_034: [1, 1, 1],
    Bip001_L_Thigh_057: [1, 1, 1],
    Bip001_R_Thigh_061: [1, 1, 1],
    Bip001_L_Calf_058: [1, 1, 1],
    Bip001_R_Calf_062: [1, 1, 1],
    Bip001_L_Foot_059: [1, 1, 1],
    Bip001_R_Foot_063: [1, 1, 1],
  };
}

export function getUE4ModelScale(bodyType?: CharacterBodyType): [number, number, number] {
  switch (bodyType) {
    case "teen":
      return [0.88, 0.88, 0.88];
    case "child":
      return [0.72, 0.72, 0.72];
    case "chibi":
      return [0.56, 0.56, 0.56];
    default:
      return [1, 1, 1];
  }
}

export function getUE4GroundedLabelY(bodyType?: CharacterBodyType): number {
  switch (bodyType) {
    case "female":
    case "slim":
      return 1.98;
    case "broad":
    case "muscular":
      return 2.08;
    case "teen":
      return 1.78;
    case "child":
      return 1.46;
    case "chibi":
      return 1.18;
    default:
      return 2.04;
  }
}

export function getUE4NeutralPoseBoneRotations(): UE4BoneRotationMap {
  return {
    Bip001_L_UpperArm_08: [0, degreesToRadians(25), 0],
    Bip001_R_UpperArm_032: [0, degreesToRadians(-25), 0],
    Bip001_L_Forearm_09: [0, 0, degreesToRadians(25)],
    Bip001_R_Forearm_033: [0, 0, degreesToRadians(25)],
  };
}

export function getUE4BodyBoneScales(bodyType: CharacterBodyType = "mannequin"): UE4BoneScaleMap {
  const scales = baseBoneScales();

  switch (bodyType) {
    case "female":
      scales.Bip001_Pelvis_03 = [1, 1.04, 1.04];
      scales.Bip001_Spine_04 = [0.98, 0.9, 0.94];
      scales.Bip001_Spine1_05 = [0.98, 1, 1];
      scales.Bip001_L_Clavicle_07 = [0.92, 1, 1];
      scales.Bip001_R_Clavicle_031 = [0.92, 1, 1];
      scales.Bip001_L_UpperArm_08 = [0.9, 0.9, 0.9];
      scales.Bip001_R_UpperArm_032 = [0.9, 0.9, 0.9];
      scales.Bip001_L_Forearm_09 = [1, 0.88, 0.9];
      scales.Bip001_R_Forearm_033 = [1, 0.88, 0.9];
      scales.Bip001_L_Thigh_057 = [1, 0.96, 0.96];
      scales.Bip001_R_Thigh_061 = [1, 0.96, 0.96];
      break;
    case "broad":
      scales.Bip001_Pelvis_03 = [1.02, 1.12, 1.08];
      scales.Bip001_Spine1_05 = [1.02, 1.22, 1.1];
      scales.Bip001_L_Clavicle_07 = [1.12, 1, 1];
      scales.Bip001_R_Clavicle_031 = [1.12, 1, 1];
      scales.Bip001_L_UpperArm_08 = [1, 1.12, 1.12];
      scales.Bip001_R_UpperArm_032 = [1, 1.12, 1.12];
      scales.Bip001_L_Forearm_09 = [1, 1.08, 1.08];
      scales.Bip001_R_Forearm_033 = [1, 1.08, 1.08];
      scales.Bip001_L_Thigh_057 = [1.02, 1.1, 1.08];
      scales.Bip001_R_Thigh_061 = [1.02, 1.1, 1.08];
      break;
    case "muscular":
      scales.Bip001_Pelvis_03 = [1, 1.04, 1.04];
      scales.Bip001_Spine_04 = [1.02, 1.1, 1.06];
      scales.Bip001_Spine1_05 = [1.02, 1.26, 1.1];
      scales.Bip001_L_Clavicle_07 = [1.16, 1, 1];
      scales.Bip001_R_Clavicle_031 = [1.16, 1, 1];
      scales.Bip001_L_UpperArm_08 = [1, 1.18, 1.18];
      scales.Bip001_R_UpperArm_032 = [1, 1.18, 1.18];
      scales.Bip001_L_Forearm_09 = [1, 1.12, 1.12];
      scales.Bip001_R_Forearm_033 = [1, 1.12, 1.12];
      scales.Bip001_L_Thigh_057 = [1, 1.12, 1.12];
      scales.Bip001_R_Thigh_061 = [1, 1.12, 1.12];
      break;
    case "slim":
      scales.Bip001_Pelvis_03 = [0.98, 0.75, 0.9];
      scales.Bip001_Spine_04 = [0.98, 1, 1];
      scales.Bip001_Spine1_05 = [0.98, 1, 1];
      scales.Bip001_L_Clavicle_07 = [0.9, 1, 0.9];
      scales.Bip001_R_Clavicle_031 = [0.9, 1, 0.9];
      scales.Bip001_L_UpperArm_08 = [0.96, 0.96, 0.96];
      scales.Bip001_R_UpperArm_032 = [0.96, 0.96, 0.96];
      scales.Bip001_L_Forearm_09 = [1, 1, 0.78];
      scales.Bip001_R_Forearm_033 = [1, 1, 0.78];
      scales.Bip001_L_Thigh_057 = [1, 0.84, 0.84];
      scales.Bip001_R_Thigh_061 = [1, 0.84, 0.84];
      scales.Bip001_L_Calf_058 = [1, 1, 1];
      scales.Bip001_R_Calf_062 = [1, 1, 1];
      break;
    case "teen":
      scales.Bip001_Head_055 = [1.12, 1.12, 1.12];
      scales.Bip001_Pelvis_03 = [0.96, 0.94, 0.94];
      scales.Bip001_Spine1_05 = [0.96, 0.94, 0.94];
      scales.Bip001_L_UpperArm_08 = [0.96, 0.9, 0.9];
      scales.Bip001_R_UpperArm_032 = [0.96, 0.9, 0.9];
      scales.Bip001_L_Thigh_057 = [0.96, 0.9, 0.9];
      scales.Bip001_R_Thigh_061 = [0.96, 0.9, 0.9];
      break;
    case "child":
      scales.Bip001_Head_055 = [1.34, 1.34, 1.34];
      scales.Bip001_Pelvis_03 = [0.88, 0.9, 0.9];
      scales.Bip001_Spine_04 = [1.2, 1.2, 1.2];
      scales.Bip001_Spine1_05 = [0.84, 0.86, 0.86];
      scales.Bip001_L_UpperArm_08 = [0.84, 1.1, 1.1];
      scales.Bip001_R_UpperArm_032 = [0.84, 1.1, 1.1];
      scales.Bip001_L_Forearm_09 = [1, 0.8, 0.8];
      scales.Bip001_R_Forearm_033 = [1, 0.8, 0.8];
      scales.Bip001_L_Thigh_057 = [0.7, 0.9, 0.9];
      scales.Bip001_R_Thigh_061 = [0.7, 0.9, 0.9];
      scales.Bip001_L_Calf_058 = [0.82, 0.9, 0.9];
      scales.Bip001_R_Calf_062 = [0.82, 0.9, 0.9];
      break;
    case "chibi":
      scales.Bip001_Head_055 = [4, 4, 4];
      scales.Bip001_Neck_06 = [0.72, 0.76, 0.76];
      scales.Bip001_Pelvis_03 = [0.92, 1.22, 1.22];
      scales.Bip001_Spine_04 = [0.68, 1, 1];
      scales.Bip001_Spine1_05 = [1, 0.9, 0.9];
      scales.Bip001_L_Clavicle_07 = [1.24, 0.9, 0.9];
      scales.Bip001_R_Clavicle_031 = [1.24, 0.9, 0.9];
      scales.Bip001_L_UpperArm_08 = [1.2, 1.3, 1.3];
      scales.Bip001_R_UpperArm_032 = [1.2, 1.3, 1.3];
      scales.Bip001_L_Forearm_09 = [0.7, 1, 1];
      scales.Bip001_R_Forearm_033 = [0.7, 1, 1];
      scales.Bip001_L_Hand_010 = [1.45, 1, 1];
      scales.Bip001_R_Hand_034 = [1.45, 1, 1];
      scales.Bip001_L_Thigh_057 = [0.62, 0.8, 0.8];
      scales.Bip001_R_Thigh_061 = [0.62, 0.8, 0.8];
      scales.Bip001_L_Calf_058 = [0.7, 0.9, 0.9];
      scales.Bip001_R_Calf_062 = [0.7, 0.9, 0.9];
      scales.Bip001_L_Foot_059 = [1.06, 0.82, 1.16];
      scales.Bip001_R_Foot_063 = [1.06, 0.82, 1.16];
      break;
    default:
      scales.Bip001_Pelvis_03 = [1, 1.02, 1.02];
      scales.Bip001_Spine1_05 = [1, 1.02, 1.02];
      break;
  }

  return scales;
}

export function getUE4PoseBonePositionOffsets(controls: Record<string, number>): UE4BonePositionOffsetMap {
  const bodyOffsetY = controls["body.offsetY"] ?? 0;

  if (bodyOffsetY === 0) return {};

  return {
    Bip001_Pelvis_03: [0, 0, bodyOffsetY * BIP001_LOCAL_UNITS_PER_WORLD_METER],
  };
}

export function getUE4PoseBoneRotations(
  controls: Record<string, number>,
  bodyType?: CharacterBodyType
): UE4BoneRotationMap {
  return {
    Bip001_Pelvis_03: ue4SpineRotation(controls, "body", bodyType),
    Bip001_Spine1_05: ue4SpineRotation(controls, "torso", bodyType),
    Bip001_Head_055: ue4HeadRotation(controls, bodyType),
    Bip001_L_UpperArm_08: ue4ShoulderRotation(controls, "leftShoulder", bodyType),
    Bip001_R_UpperArm_032: ue4ShoulderRotation(controls, "rightShoulder", bodyType),
    Bip001_L_Forearm_09: ue4LimbBendRotation(controls, "leftElbow.bend", bodyType),
    Bip001_R_Forearm_033: ue4LimbBendRotation(controls, "rightElbow.bend", bodyType),
    Bip001_L_Hand_010: ue4HandRotation(controls, "leftHand", bodyType),
    Bip001_R_Hand_034: ue4HandRotation(controls, "rightHand", bodyType),
    Bip001_L_Thigh_057: ue4HipRotation(controls, "leftHip", bodyType),
    Bip001_R_Thigh_061: ue4HipRotation(controls, "rightHip", bodyType),
    Bip001_L_Calf_058: ue4LimbBendRotation(controls, "leftKnee.bend", bodyType),
    Bip001_R_Calf_062: ue4LimbBendRotation(controls, "rightKnee.bend", bodyType),
    Bip001_L_Foot_059: ue4FootRotation(controls, "leftFoot", bodyType),
    Bip001_R_Foot_063: ue4FootRotation(controls, "rightFoot", bodyType),
  };
}
