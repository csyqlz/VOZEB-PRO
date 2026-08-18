import { describe, expect, it } from "vitest";
import { CHARACTER_ACTION_PRESETS, sampleCharacterActionControls } from "../characterActionPresets";

describe("character action presets", () => {
  it("contains the six recovered action presets", () => {
    expect(CHARACTER_ACTION_PRESETS.map((preset) => preset.id)).toEqual([
      "walk-cycle",
      "run-cycle",
      "crouch-cycle",
      "side-step-left",
      "jump-cycle",
      "wave-cycle",
    ]);
  });

  it("interpolates and loops keyframes by elapsed seconds", () => {
    expect(sampleCharacterActionControls("wave-cycle", 0.3)["rightHand.roll"]).toBeCloseTo(-10);
    expect(sampleCharacterActionControls("wave-cycle", 1.5)["rightHand.roll"]).toBeCloseTo(-10);
  });
});
