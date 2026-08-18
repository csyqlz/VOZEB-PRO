import type { DirectorRouteCubicBezier } from "../schema/directorProject";

export type RouteCustomEasingPresetId = "linear" | "ease-in" | "ease-out" | "ease-in-out";

export const ROUTE_CUSTOM_EASING_PRESETS: Array<{
  id: RouteCustomEasingPresetId;
  label: string;
  curve: DirectorRouteCubicBezier;
}> = [
  { id: "linear", label: "直线", curve: [0, 0, 1, 1] },
  { id: "ease-in", label: "慢起", curve: [0.42, 0, 1, 1] },
  { id: "ease-out", label: "慢停", curve: [0, 0, 0.58, 1] },
  { id: "ease-in-out", label: "两头柔和", curve: [0.42, 0, 0.58, 1] },
];

function curvesEqual(left: DirectorRouteCubicBezier, right: DirectorRouteCubicBezier) {
  return left.every((value, index) => Math.abs(value - right[index]) <= 0.000001);
}

export function getRouteCustomEasingPreset(id: RouteCustomEasingPresetId) {
  return ROUTE_CUSTOM_EASING_PRESETS.find((preset) => preset.id === id) ?? ROUTE_CUSTOM_EASING_PRESETS[0];
}

export function findRouteCustomEasingPresetId(curve: DirectorRouteCubicBezier | undefined) {
  const normalized = curve ?? ROUTE_CUSTOM_EASING_PRESETS[0].curve;
  return ROUTE_CUSTOM_EASING_PRESETS.find((preset) => curvesEqual(preset.curve, normalized))?.id ?? "linear";
}
