import type { DirectorAnimationClipRef } from "../schema/directorProject";
import type { CharacterImportReadiness } from "../schema/directorProject";
import { createImportedCharacterActionId } from "../schema/importedCharacterAction";

export interface CharacterImportPreviewStep {
  actionPresetId: string;
  label: string;
}

export const HUMANOID_IMPORT_PREVIEW_STEPS: CharacterImportPreviewStep[] = [
  { actionPresetId: "walk-cycle", label: "走路" },
  { actionPresetId: "run-cycle", label: "跑步" },
  { actionPresetId: "jump-cycle", label: "跳跃" },
  { actionPresetId: "wave-cycle", label: "挥手" },
];

export function getCharacterImportPreviewSteps({
  animationAssetId,
  clips = [],
  readiness,
}: {
  animationAssetId?: string | null;
  clips?: DirectorAnimationClipRef[];
  readiness: CharacterImportReadiness;
}): CharacterImportPreviewStep[] {
  if (readiness === "ready" || readiness === "manual-mapping") {
    return HUMANOID_IMPORT_PREVIEW_STEPS.map((step) => ({ ...step }));
  }
  if (readiness !== "native-only" || !animationAssetId) return [];

  return clips
    .filter((clip) => clip.duration > 0.05 && clip.trackCount > 0)
    .slice(0, 4)
    .map((clip) => ({
      actionPresetId: createImportedCharacterActionId(animationAssetId, clip.id),
      label: clip.name,
    }));
}
