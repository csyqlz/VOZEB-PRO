import { describe, expect, it } from "vitest";
import { getPilotMovementIntent, isPilotMovementCode } from "../pilotControls";

describe("pilot keyboard controls", () => {
  it("uses E to rise and Q to descend", () => {
    expect(getPilotMovementIntent(new Set(["KeyE"])).vertical).toBe(1);
    expect(getPilotMovementIntent(new Set(["KeyQ"])).vertical).toBe(-1);
    expect(isPilotMovementCode("KeyE")).toBe(true);
    expect(isPilotMovementCode("KeyQ")).toBe(true);
  });

  it("reserves Space for action playback and does not use Shift for movement", () => {
    expect(getPilotMovementIntent(new Set(["Space"])).vertical).toBe(0);
    expect(getPilotMovementIntent(new Set(["ShiftLeft"])).vertical).toBe(0);
    expect(getPilotMovementIntent(new Set(["ShiftRight"])).vertical).toBe(0);
    expect(isPilotMovementCode("Space")).toBe(false);
    expect(isPilotMovementCode("ShiftLeft")).toBe(false);
    expect(isPilotMovementCode("ShiftRight")).toBe(false);
  });

  it("keeps WASD movement independent from vertical movement", () => {
    expect(getPilotMovementIntent(new Set(["KeyW", "KeyA", "KeyE"]))).toEqual({
      forward: 1,
      strafe: -1,
      vertical: 1,
    });
  });
});
