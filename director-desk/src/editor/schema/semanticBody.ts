export const DIRECTOR_CAMERA_TARGET_BODY_PART_OPTIONS = [
  { value: "center", label: "整体中心" },
  { value: "head", label: "头部" },
  { value: "chest", label: "胸口" },
  { value: "waist", label: "腰部" },
  { value: "leftUpperArm", label: "左上臂" },
  { value: "leftForearm", label: "左前臂" },
  { value: "leftHand", label: "左手" },
  { value: "rightUpperArm", label: "右上臂" },
  { value: "rightForearm", label: "右前臂" },
  { value: "rightHand", label: "右手" },
  { value: "leftThigh", label: "左大腿" },
  { value: "leftCalf", label: "左小腿" },
  { value: "leftFoot", label: "左脚" },
  { value: "rightThigh", label: "右大腿" },
  { value: "rightCalf", label: "右小腿" },
  { value: "rightFoot", label: "右脚" },
] as const;

export type DirectorCameraTargetBodyPart =
  (typeof DIRECTOR_CAMERA_TARGET_BODY_PART_OPTIONS)[number]["value"];

export type DirectorCharacterBonePart = Exclude<DirectorCameraTargetBodyPart, "center">;
export type DirectorCharacterBoneMap = Partial<Record<DirectorCharacterBonePart, string>>;

export const DIRECTOR_CHARACTER_BONE_PART_OPTIONS = DIRECTOR_CAMERA_TARGET_BODY_PART_OPTIONS.filter(
  (option): option is (typeof DIRECTOR_CAMERA_TARGET_BODY_PART_OPTIONS)[number] & { value: DirectorCharacterBonePart } =>
    option.value !== "center"
);

export function normalizeDirectorCharacterBoneMap(value: unknown): DirectorCharacterBoneMap {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    DIRECTOR_CHARACTER_BONE_PART_OPTIONS.flatMap((option) => {
      const boneName = source[option.value];
      return typeof boneName === "string" && boneName.trim()
        ? [[option.value, boneName.trim()]]
        : [];
    })
  ) as DirectorCharacterBoneMap;
}

export function isCompleteDirectorCharacterBoneMap(value: unknown) {
  const map = normalizeDirectorCharacterBoneMap(value);
  const mappedBoneNames = DIRECTOR_CHARACTER_BONE_PART_OPTIONS.map((option) => map[option.value]).filter(
    (boneName): boneName is string => Boolean(boneName)
  );
  return mappedBoneNames.length === DIRECTOR_CHARACTER_BONE_PART_OPTIONS.length
    && new Set(mappedBoneNames).size === mappedBoneNames.length;
}

export type DirectorCameraTargetFollowMode = "immediate" | "smooth";

const BODY_PART_SET = new Set<string>(
  DIRECTOR_CAMERA_TARGET_BODY_PART_OPTIONS.map((option) => option.value)
);

export function isDirectorCameraTargetBodyPart(value: unknown): value is DirectorCameraTargetBodyPart {
  return typeof value === "string" && BODY_PART_SET.has(value);
}

export function normalizeDirectorCameraTargetBodyPart(value: unknown): DirectorCameraTargetBodyPart {
  return isDirectorCameraTargetBodyPart(value) ? value : "center";
}

export function normalizeDirectorCameraTargetFollowMode(value: unknown): DirectorCameraTargetFollowMode {
  return value === "smooth" ? "smooth" : "immediate";
}
