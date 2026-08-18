export const DEFAULT_VIEWPORT_ROTATE_SENSITIVITY = 0.35;
export const DEFAULT_VIEWPORT_ZOOM_SENSITIVITY = 0.4;
export const VIEWPORT_SENSITIVITY_MIN = 0.1;
export const VIEWPORT_SENSITIVITY_MAX = 1.5;
export const VIEWPORT_SENSITIVITY_STEP = 0.05;

export function normalizeViewportSensitivity(value: unknown, fallback: number) {
  const numericValue = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const clampedValue = Math.min(VIEWPORT_SENSITIVITY_MAX, Math.max(VIEWPORT_SENSITIVITY_MIN, numericValue));
  const steppedValue = Math.round(clampedValue / VIEWPORT_SENSITIVITY_STEP) * VIEWPORT_SENSITIVITY_STEP;

  return Number(steppedValue.toFixed(2));
}
