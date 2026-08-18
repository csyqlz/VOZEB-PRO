import { getCharacterImportPreviewSteps, HUMANOID_IMPORT_PREVIEW_STEPS } from "../characterImportPreview";

it("previews walk, run, jump and wave for a compatible humanoid", () => {
  expect(getCharacterImportPreviewSteps({ readiness: "ready" })).toEqual(HUMANOID_IMPORT_PREVIEW_STEPS);
  expect(getCharacterImportPreviewSteps({ readiness: "manual-mapping" })).toEqual(HUMANOID_IMPORT_PREVIEW_STEPS);
});

it("only previews the native clips of a native-only character", () => {
  expect(getCharacterImportPreviewSteps({
    readiness: "native-only",
    animationAssetId: "native_actor",
    clips: [
      { id: "clip_1", name: "Walk Native", duration: 1.2, trackCount: 24 },
      { id: "bind", name: "Bind Pose", duration: 0.03, trackCount: 24 },
    ],
  })).toEqual([{
    actionPresetId: "imported-action:native_actor:clip_1",
    label: "Walk Native",
  }]);
});

it("does not animate a static-only character import", () => {
  expect(getCharacterImportPreviewSteps({ readiness: "static-only" })).toEqual([]);
});
