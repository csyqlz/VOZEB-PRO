import type { EffectivePerformanceProfileId } from "./performanceProfiles";

export interface AutomaticPerformanceRuntimeSnapshot {
  averageFps: number | null;
  effectiveProfileId: EffectivePerformanceProfileId;
}

let snapshot: AutomaticPerformanceRuntimeSnapshot = {
  averageFps: null,
  effectiveProfileId: "balanced",
};
const listeners = new Set<() => void>();

export function getAutomaticPerformanceRuntimeSnapshot() {
  return snapshot;
}

export function subscribeAutomaticPerformanceRuntime(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishAutomaticPerformanceRuntime(next: AutomaticPerformanceRuntimeSnapshot) {
  if (
    next.effectiveProfileId === snapshot.effectiveProfileId
    && next.averageFps === snapshot.averageFps
  ) return;
  snapshot = next;
  listeners.forEach((listener) => listener());
}

export function resetAutomaticPerformanceRuntime(effectiveProfileId: EffectivePerformanceProfileId) {
  publishAutomaticPerformanceRuntime({ averageFps: null, effectiveProfileId });
}
