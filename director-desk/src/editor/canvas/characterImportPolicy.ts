import type { CharacterAssetInspection } from "../loaders/characterAssetInspection";
import { isCompleteDirectorCharacterBoneMap } from "../schema/semanticBody";

export function canImportCharacterFromInspection(
  report: CharacterAssetInspection,
  boneMap: CharacterAssetInspection["boneMap"] = report.boneMap
) {
  if (report.readiness === "static-only") return false;
  if (report.readiness === "manual-mapping") return isCompleteDirectorCharacterBoneMap(boneMap);
  return true;
}
