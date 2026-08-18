import type { CharacterImportReadiness, CharacterRigProfile } from "../schema/directorProject";

export interface GuoCharacterCompatibility {
  readiness: CharacterImportReadiness;
  rigProfile: CharacterRigProfile;
  orientationCorrection: [number, number, number];
}

const MANUAL_MAPPING_IDS = new Set([
  "guo-skeleton-0034-female-mermaid",
  "guo-skeleton-0035-male-mermaid",
  "guo-skeleton-0037-wolf",
]);

const MIXAMO_ALT_IDS = new Set([
  "guo-skeleton-0038-male-skeleton",
  "guo-skeleton-0063-male-frame-mannequin",
  "guo-skeleton-0064-blocky-bot",
]);

export function getGuoCharacterCompatibility(id: string): GuoCharacterCompatibility {
  if (id === "guo-skeleton-0033-horse") {
    return {
      readiness: "manual-mapping",
      rigProfile: "unknown",
      orientationCorrection: [0, 0, 0],
    };
  }
  if (id === "guo-skeleton-0037-wolf") {
    return {
      readiness: "manual-mapping",
      rigProfile: "mixamo",
      orientationCorrection: [0, 0, 0],
    };
  }
  return {
    readiness: MANUAL_MAPPING_IDS.has(id) ? "manual-mapping" : "ready",
    rigProfile: MIXAMO_ALT_IDS.has(id) ? "mixamo-alt" : "mixamo",
    orientationCorrection: [0, 0, 0],
  };
}
