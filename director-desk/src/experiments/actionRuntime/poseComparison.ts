export const ACTION_RUNTIME_PROGRESS_POINTS = [0, 0.25, 0.5, 0.75, 1] as const;
export const ACTION_RUNTIME_BODY_PARTS = [
  "head",
  "waist",
  "leftHand",
  "rightHand",
  "leftFoot",
  "rightFoot",
] as const;

export type ActionRuntimeBodyPart = (typeof ACTION_RUNTIME_BODY_PARTS)[number];
export type ActionRuntimePose = Record<ActionRuntimeBodyPart, [number, number, number]>;
export type ActionRuntimeCameraTarget = [number, number, number];

export interface ActionRuntimeViewSample {
  viewId: string;
  pose: ActionRuntimePose;
  cameraTarget: ActionRuntimeCameraTarget;
}

export interface ActionRuntimePoseComparison {
  passed: boolean;
  maxDelta: number;
  viewDeltas: Record<string, number>;
}

export interface ActionRuntimeCameraTargetComparison {
  passed: boolean;
  maxDelta: number;
  viewDeltas: Record<string, number>;
}

function distance(left: [number, number, number], right: [number, number, number]) {
  return Math.hypot(
    left[0] - right[0],
    left[1] - right[1],
    left[2] - right[2],
  );
}

export function getActionRuntimePoseDelta(left: ActionRuntimePose, right: ActionRuntimePose) {
  return Number(ACTION_RUNTIME_BODY_PARTS.reduce((largest, bodyPart) => (
    Math.max(largest, distance(left[bodyPart], right[bodyPart]))
  ), 0).toFixed(6));
}

export function compareActionRuntimeViewSamples(
  samples: ActionRuntimeViewSample[],
  tolerance = 0.0005,
): ActionRuntimePoseComparison {
  if (samples.length < 2) return { passed: false, maxDelta: Number.POSITIVE_INFINITY, viewDeltas: {} };
  const baseline = samples[0];
  const viewDeltas: Record<string, number> = { [baseline.viewId]: 0 };
  let maxDelta = 0;

  for (const sample of samples.slice(1)) {
    const sampleDelta = getActionRuntimePoseDelta(baseline.pose, sample.pose);
    viewDeltas[sample.viewId] = Number(sampleDelta.toFixed(6));
    maxDelta = Math.max(maxDelta, sampleDelta);
  }

  return {
    passed: maxDelta <= tolerance,
    maxDelta: Number(maxDelta.toFixed(6)),
    viewDeltas,
  };
}

export function compareActionRuntimeCameraTargets(
  samples: ActionRuntimeViewSample[],
  tolerance = 0.0005,
): ActionRuntimeCameraTargetComparison {
  if (samples.length < 2) return { passed: false, maxDelta: Number.POSITIVE_INFINITY, viewDeltas: {} };
  const baseline = samples[0];
  const viewDeltas: Record<string, number> = { [baseline.viewId]: 0 };
  let maxDelta = 0;

  for (const sample of samples.slice(1)) {
    const sampleDelta = Number(distance(baseline.cameraTarget, sample.cameraTarget).toFixed(6));
    viewDeltas[sample.viewId] = sampleDelta;
    maxDelta = Math.max(maxDelta, sampleDelta);
  }

  return { passed: maxDelta <= tolerance, maxDelta: Number(maxDelta.toFixed(6)), viewDeltas };
}

export function getActionRuntimeCameraTargetDelta(
  target: ActionRuntimeCameraTarget,
  pose: ActionRuntimePose,
  bodyPart: ActionRuntimeBodyPart = "rightHand",
) {
  return Number(distance(target, pose[bodyPart]).toFixed(6));
}

export function getActionRuntimeTargetTravel(targets: ActionRuntimeCameraTarget[]) {
  if (targets.length < 2) return 0;
  const first = targets[0];
  return Number(Math.max(...targets.slice(1).map((target) => distance(first, target))).toFixed(6));
}

export function getActionRuntimePoseTravel(poses: ActionRuntimePose[]) {
  if (poses.length < 2) return 0;
  const first = poses[0];
  return Number(Math.max(...poses.slice(1).flatMap((pose) => (
    ACTION_RUNTIME_BODY_PARTS.map((bodyPart) => distance(first[bodyPart], pose[bodyPart]))
  ))).toFixed(6));
}
