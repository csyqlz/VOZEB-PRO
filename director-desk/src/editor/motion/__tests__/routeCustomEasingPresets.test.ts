import { describe, expect, it } from "vitest";
import {
  findRouteCustomEasingPresetId,
  getRouteCustomEasingPreset,
} from "../routeCustomEasingPresets";

describe("route custom easing presets", () => {
  it("maps beginner labels to deterministic cubic bezier curves", () => {
    expect(getRouteCustomEasingPreset("linear").curve).toEqual([0, 0, 1, 1]);
    expect(getRouteCustomEasingPreset("ease-in").curve).toEqual([0.42, 0, 1, 1]);
    expect(getRouteCustomEasingPreset("ease-out").curve).toEqual([0, 0, 0.58, 1]);
    expect(getRouteCustomEasingPreset("ease-in-out").curve).toEqual([0.42, 0, 0.58, 1]);
  });

  it("recognizes persisted curves and falls back safely", () => {
    expect(findRouteCustomEasingPresetId([0.42, 0, 0.58, 1])).toBe("ease-in-out");
    expect(findRouteCustomEasingPresetId([0.2, 0.1, 0.8, 0.9])).toBe("linear");
    expect(findRouteCustomEasingPresetId(undefined)).toBe("linear");
  });
});
