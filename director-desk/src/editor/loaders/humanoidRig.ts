import type { CharacterRigType } from "../schema/directorProject";

export function detectHumanoidRig(boneNames: string[]): CharacterRigType | null {
  const set = new Set(boneNames);

  if (set.has("Hips") && set.has("Spine") && set.has("Head")) return "mixamo";
  if (set.has("J_Bip_C_Hips") && set.has("J_Bip_C_Head")) return "vrm";
  return null;
}
