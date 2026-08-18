import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import guoCharactersManifest from "../../modelLibrary/guoCharactersManifest.json";
import { inspectCharacterModelFile, type CharacterAssetInspection } from "../characterAssetInspection";

declare const process: { cwd: () => string };

interface GuoCharacterManifestEntry {
  boneCount: number;
  categoryIds: string[];
  id: string;
  label: string;
  localModelPath: string;
  sha256: string;
}

function createFile(binary: string, name: string) {
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new File([buffer], name, { type: "application/octet-stream" });
}

describe("GUO 37-character package validation", () => {
  it("parses every real FBX through the production character inspector", async () => {
    const entries = guoCharactersManifest.items as GuoCharacterManifestEntry[];
    expect(entries).toHaveLength(37);
    const reports: Array<{
      entry: GuoCharacterManifestEntry;
      inspection: CharacterAssetInspection;
    }> = [];

    for (const entry of entries) {
      const path = `${process.cwd()}/public/local-assets/guo-3d-assets/guo-skeleton-models/${entry.localModelPath}`;
      const binary = readFileSync(path, "binary");
      expect(binary.length, entry.id).toBeGreaterThan(0);
      expect(entry.sha256, entry.id).toMatch(/^[a-f0-9]{64}$/);
      const inspection = await inspectCharacterModelFile(createFile(binary, entry.localModelPath.split("/").pop()!));
      reports.push({ entry, inspection });
      expect(inspection.format, entry.id).toBe("fbx");
      expect(inspection.skinnedMeshCount, entry.id).toBeGreaterThan(0);
      expect(inspection.primaryBoneCount, entry.id).toBeGreaterThan(0);
      expect(inspection.primaryBoneCount, entry.id).toBeLessThanOrEqual(entry.boneCount);
      expect(inspection.dimensions.every((value) => Number.isFinite(value) && value >= 0), entry.id).toBe(true);
      expect(Number.isFinite(inspection.recommendedScale), entry.id).toBe(true);
    }

    const humanoids = reports.filter(({ entry }) => (
      entry.categoryIds.includes("male") || entry.categoryIds.includes("female")
    ));
    expect(humanoids).toHaveLength(32);
    expect(humanoids.filter(({ inspection }) => inspection.readiness === "ready")).toHaveLength(30);
    expect(humanoids.filter(({ inspection }) => inspection.readiness === "manual-mapping").map(({ entry }) => entry.id)).toEqual([
      "guo-skeleton-0034-female-mermaid",
      "guo-skeleton-0035-male-mermaid",
    ]);

    const nonHumanoids = reports.filter(({ entry }) => entry.categoryIds.includes("animal-creature"));
    expect(nonHumanoids).toHaveLength(5);
    expect(nonHumanoids.every(({ inspection }) => inspection.skinnedMeshCount > 0)).toBe(true);
    expect(reports.filter(({ inspection }) => inspection.readiness === "ready")).toHaveLength(33);
    expect(reports.filter(({ inspection }) => inspection.readiness === "manual-mapping").map(({ entry }) => entry.id)).toEqual([
      "guo-skeleton-0033-horse",
      "guo-skeleton-0034-female-mermaid",
      "guo-skeleton-0035-male-mermaid",
      "guo-skeleton-0037-wolf",
    ]);
    expect(reports.filter(({ inspection }) => inspection.playableAnimationCount > 0)).toHaveLength(0);
  }, 120_000);
});
