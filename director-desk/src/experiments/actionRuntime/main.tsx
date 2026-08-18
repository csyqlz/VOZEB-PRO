import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Vector3 } from "three";
import { SceneRoot, type SceneRootRenderMode } from "../../editor/canvas/SceneRoot";
import {
  getSceneSemanticBodyPartTarget,
} from "../../editor/runtime/semanticBodyTracking";
import { createCameraTrackingSmoothingState, getRuntimeCameraPlaybackSnapshot } from "../../editor/runtime/cameraBodyTracking";
import { setRuntimePlaybackProgress } from "../../editor/runtime/playbackRuntime";
import type { DirectorProject } from "../../editor/schema/directorProject";
import { createInitialDirectorState, useDirectorStore } from "../../editor/store/directorStore";
import {
  ACTION_RUNTIME_BODY_PARTS,
  ACTION_RUNTIME_PROGRESS_POINTS,
  compareActionRuntimeCameraTargets,
  compareActionRuntimeViewSamples,
  getActionRuntimeCameraTargetDelta,
  getActionRuntimePoseDelta,
  getActionRuntimePoseTravel,
  getActionRuntimeTargetTravel,
  type ActionRuntimePose,
  type ActionRuntimeViewSample,
} from "./poseComparison";
import "./style.css";

const CHARACTER_ID = "action-runtime-character";
const ACTION_DURATION_SECONDS = 3.7;
const ACTION_PRESET_LABELS = {
  "walk-cycle": "走路",
  "run-cycle": "跑步",
  "jump-cycle": "跳跃",
  "wave-cycle": "挥手",
} as const;
type SmokeActionPresetId = keyof typeof ACTION_PRESET_LABELS;
const requestedActionPresetId = new URLSearchParams(window.location.search).get("action");
const ACTION_PRESET_ID: SmokeActionPresetId = requestedActionPresetId && requestedActionPresetId in ACTION_PRESET_LABELS
  ? requestedActionPresetId as SmokeActionPresetId
  : "wave-cycle";
const ACTION_RUNTIME_STEPS = [
  { id: "warmup-base", progress: 0, type: "warmup-base" as const },
  { id: "warmup-motion", progress: 0.37, type: "warmup-motion" as const },
  ...ACTION_RUNTIME_PROGRESS_POINTS.map((progress) => ({ id: `point-${progress}`, progress, type: "point" as const })),
  { id: "scrub-back-50", progress: 0.5, type: "lifecycle" as const },
  { id: "replay-start", progress: 0, type: "lifecycle" as const },
  { id: "replay-50", progress: 0.5, type: "lifecycle" as const },
];
const VIEW_DEFINITIONS: Array<{ id: string; label: string; renderMode: SceneRootRenderMode }> = [
  { id: "main", label: "导演主视口", renderMode: "interactive" },
  { id: "monitor", label: "成片监看小窗", renderMode: "clean-camera" },
  { id: "first-person", label: "第一视角", renderMode: "clean-camera" },
  { id: "finished-shot", label: "看成片", renderMode: "clean-camera" },
  { id: "export", label: "视频导出", renderMode: "clean-camera" },
];

interface ActionRuntimePointReport {
  progress: number;
  passed: boolean;
  maxDelta: number;
  viewDeltas: Record<string, number>;
  targetMaxDelta: number;
  targetViewDeltas: Record<string, number>;
  targetToRightHandDelta: number;
  mainCameraTarget: [number, number, number] | null;
  mainPose: ActionRuntimePose | null;
}

interface ActionRuntimeLifecycleReport extends ActionRuntimePointReport {
  id: string;
  baselineDelta: number;
  baselineTargetDelta: number;
}

interface ActionRuntimeSmokeReport {
  status: "running" | "passed" | "failed";
  model: string;
  action: string;
  bodyParts: readonly string[];
  views: string[];
  points: ActionRuntimePointReport[];
  lifecycle: ActionRuntimeLifecycleReport[];
  poseTravel: number;
  targetTravel: number;
  actionReadyDelta: number;
  error: string | null;
}

declare global {
  interface Window {
    __ACTION_RUNTIME_SMOKE__?: ActionRuntimeSmokeReport;
  }
}

function createSmokeProject(): DirectorProject {
  const project = createInitialDirectorState({ includePersistedLocalAssets: false, includePersistedScene: false }).project;
  return {
    ...project,
    scene: {
      ...project.scene,
      backgroundColor: "#05070a",
      showGrid: false,
      showGround: false,
      showLabels: false,
    },
    assets: [{
      id: "action-runtime-camille",
      kind: "character",
      sourceType: "model",
      fileName: "camille.fbx",
      name: "Camille 动作自测",
      url: `${import.meta.env.BASE_URL}local-assets/mixamo/characters/camille.fbx`,
      assetSource: "library",
      modelFormat: "fbx",
      characterRigProfile: "mixamo",
      characterImportReadiness: "ready",
    }],
    objects: [{
      id: CHARACTER_ID,
      name: "动作一致性角色",
      kind: "character",
      visible: true,
      locked: true,
      assetRefId: "action-runtime-camille",
      bodyType: "mannequin",
      color: "#4F8EF7",
      transform: { position: [0, 0, 0], rotation: [0, Math.PI, 0], scale: [1, 1, 1] },
      characterRig: {
        rigType: "mixamo",
        posePresetId: "stand",
        actionPresetId: ACTION_PRESET_ID,
        controls: {},
      },
    }],
    cameras: [{
      id: "action-runtime-camera",
      name: "动作一致性镜头",
      fov: 40,
      transform: { position: [0, 1.05, 4.3], rotation: [0, 0, 0], scale: [1, 1, 1] },
      targetMode: "object",
      targetObjectId: CHARACTER_ID,
      target: [0, 0.95, 0],
      captures: [],
      motionPath: {
        duration: ACTION_DURATION_SECONDS,
        loop: false,
        interpolation: "linear",
        easing: "linear",
        speedMode: "uniform",
        keyframes: [
          { id: "smoke-start", time: 0, position: [0, 1.05, 4.3], target: [0, 0.95, 0], fov: 40, targetMode: "object", targetObjectId: CHARACTER_ID, targetBodyPart: "rightHand", targetFollowMode: "immediate" },
          { id: "smoke-end", time: 1, position: [0, 1.05, 4.3], target: [0, 0.95, 0], fov: 40, targetMode: "object", targetObjectId: CHARACTER_ID, targetBodyPart: "rightHand", targetFollowMode: "immediate" },
        ],
      },
    }],
    activeCameraId: "action-runtime-camera",
    panoramaAssetId: null,
  };
}

function initializeActionRuntimeSmokeStore() {
  const initialState = createInitialDirectorState({
    includePersistedLocalAssets: false,
    includePersistedScene: false,
  });
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...initialState,
    viewMode: "director",
    selectedObjectId: null,
    selectedObjectIds: [],
    cameraMotionPlaying: false,
    cameraMotionProgress: 0,
    project: createSmokeProject(),
  });
  setRuntimePlaybackProgress(0);
}

function setActionRuntimeSmokeProgress(progress: number) {
  setRuntimePlaybackProgress(progress);
  useDirectorStore.setState({ cameraMotionProgress: progress });
}

function FixedCamera() {
  const camera = useThree((state) => state.camera);
  useEffect(() => {
    camera.position.set(0, 1.05, 4.3);
    camera.lookAt(new Vector3(0, 0.95, 0));
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  }, [camera]);
  return null;
}

function PoseProbe({
  progress,
  sampleKey,
  viewId,
  onPose,
}: {
  progress: number;
  sampleKey: string;
  viewId: string;
  onPose: (sample: ActionRuntimeViewSample, progress: number) => void;
}) {
  const scene = useThree((state) => state.scene);
  const frameCountRef = useRef(0);
  const reportedProgressRef = useRef<number | null>(null);
  const trackingStateRef = useRef(createCameraTrackingSmoothingState());

  useEffect(() => {
    frameCountRef.current = 0;
    reportedProgressRef.current = null;
  }, [sampleKey]);

  useFrame(() => {
    if (reportedProgressRef.current === progress) return;
    frameCountRef.current += 1;
    if (frameCountRef.current < 3) return;
    scene.updateMatrixWorld(true);
    const entries = ACTION_RUNTIME_BODY_PARTS.map((bodyPart) => [
      bodyPart,
      getSceneSemanticBodyPartTarget(scene, CHARACTER_ID, bodyPart),
    ] as const);
    if (entries.some(([, position]) => !position)) return;
    const state = useDirectorStore.getState();
    const activeCamera = state.project.cameras.find((camera) => camera.id === state.project.activeCameraId) ?? state.project.cameras[0];
    if (!activeCamera) return;
    const cameraTarget = getRuntimeCameraPlaybackSnapshot({
      camera: activeCamera,
      objects: state.project.objects,
      progress,
      scene,
      sceneSettings: state.project.scene,
      smoothingState: trackingStateRef.current,
    }).target;
    reportedProgressRef.current = progress;
    onPose({
      viewId,
      pose: Object.fromEntries(entries) as ActionRuntimePose,
      cameraTarget,
    }, progress);
  });
  return null;
}

function RuntimeView({
  definition,
  progress,
  sampleKey,
  onPose,
}: {
  definition: (typeof VIEW_DEFINITIONS)[number];
  progress: number;
  sampleKey: string;
  onPose: (sample: ActionRuntimeViewSample, progress: number) => void;
}) {
  return (
    <article className="action-smoke__view">
      <header><span>{definition.label}</span><span>{Math.round(progress * 100)}%</span></header>
      <div className="action-smoke__canvas">
        <Canvas
          camera={{ fov: 40, position: [0, 1.05, 4.3] }}
          dpr={1}
          gl={{ antialias: true, preserveDrawingBuffer: true }}
        >
          <color attach="background" args={["#05070a"]} />
          <ambientLight intensity={1.4} />
          <directionalLight intensity={1.8} position={[4, 6, 5]} />
          <FixedCamera />
          <Suspense fallback={null}>
            <SceneRoot renderMode={definition.renderMode} />
          </Suspense>
          <PoseProbe onPose={onPose} progress={progress} sampleKey={sampleKey} viewId={definition.id} />
        </Canvas>
      </div>
    </article>
  );
}

function ActionRuntimeSmoke() {
  const [stepIndex, setStepIndex] = useState(0);
  const [sampleEpoch, setSampleEpoch] = useState(0);
  const [pointReports, setPointReports] = useState<ActionRuntimePointReport[]>([]);
  const [lifecycleReports, setLifecycleReports] = useState<ActionRuntimeLifecycleReport[]>([]);
  const [status, setStatus] = useState<ActionRuntimeSmokeReport["status"]>("running");
  const [error, setError] = useState<string | null>(null);
  const [machineReport, setMachineReport] = useState<ActionRuntimeSmokeReport>({
    status: "running",
    model: "camille.fbx",
    action: ACTION_PRESET_ID,
    bodyParts: ACTION_RUNTIME_BODY_PARTS,
    views: VIEW_DEFINITIONS.map((view) => view.id),
    points: [],
    lifecycle: [],
    poseTravel: 0,
    targetTravel: 0,
    actionReadyDelta: 0,
    error: null,
  });
  const samplesRef = useRef(new Map<number, Map<string, ActionRuntimeViewSample>>());
  const pointReportsRef = useRef<ActionRuntimePointReport[]>([]);
  const lifecycleReportsRef = useRef<ActionRuntimeLifecycleReport[]>([]);
  const canonicalPosesRef = useRef(new Map<number, ActionRuntimePose>());
  const canonicalTargetsRef = useRef(new Map<number, [number, number, number]>());
  const warmupBasePoseRef = useRef<ActionRuntimePose | null>(null);
  const warmupAttemptsRef = useRef(0);
  const actionReadyDeltaRef = useRef(0);
  const baselinePosesRef = useRef<ActionRuntimePose[]>([]);
  const baselineTargetsRef = useRef<[number, number, number][]>([]);
  const activeStep = ACTION_RUNTIME_STEPS[stepIndex] ?? ACTION_RUNTIME_STEPS[ACTION_RUNTIME_STEPS.length - 1];
  const progress = activeStep.progress;

  useEffect(() => {
    const initialReport: ActionRuntimeSmokeReport = {
      status: "running",
      model: "camille.fbx",
      action: ACTION_PRESET_ID,
      bodyParts: ACTION_RUNTIME_BODY_PARTS,
      views: VIEW_DEFINITIONS.map((view) => view.id),
      points: [],
      lifecycle: [],
      poseTravel: 0,
      targetTravel: 0,
      actionReadyDelta: 0,
      error: null,
    };
    window.__ACTION_RUNTIME_SMOKE__ = initialReport;
    setMachineReport(initialReport);
  }, []);

  const onPose = useCallback((sample: ActionRuntimeViewSample, sampleProgress: number) => {
    const step = ACTION_RUNTIME_STEPS[stepIndex];
    if (!step || sampleProgress !== step.progress) return;
    const pointSamples = samplesRef.current.get(stepIndex) ?? new Map<string, ActionRuntimeViewSample>();
    pointSamples.set(sample.viewId, sample);
    samplesRef.current.set(stepIndex, pointSamples);
    if (pointSamples.size !== VIEW_DEFINITIONS.length) return;

    const orderedSamples = VIEW_DEFINITIONS.map((view) => pointSamples.get(view.id)).filter(
      (item): item is ActionRuntimeViewSample => Boolean(item)
    );
    const comparison = compareActionRuntimeViewSamples(orderedSamples);
    const targetComparison = compareActionRuntimeCameraTargets(orderedSamples);
    if (step.type === "warmup-base") {
      warmupBasePoseRef.current = pointSamples.get("main")?.pose ?? null;
      window.requestAnimationFrame(() => {
        const nextStepIndex = stepIndex + 1;
        setActionRuntimeSmokeProgress(ACTION_RUNTIME_STEPS[nextStepIndex].progress);
        setSampleEpoch(0);
        setStepIndex(nextStepIndex);
      });
      return;
    }
    if (step.type === "warmup-motion") {
      const warmupPose = pointSamples.get("main")?.pose;
      const poseDelta = warmupPose && warmupBasePoseRef.current
        ? getActionRuntimePoseDelta(warmupBasePoseRef.current, warmupPose)
        : 0;
      if (poseDelta >= 0.05) {
        actionReadyDeltaRef.current = poseDelta;
        window.requestAnimationFrame(() => {
          const nextStepIndex = stepIndex + 1;
          setActionRuntimeSmokeProgress(ACTION_RUNTIME_STEPS[nextStepIndex].progress);
          setSampleEpoch(0);
          setStepIndex(nextStepIndex);
        });
        return;
      }
      warmupAttemptsRef.current += 1;
      if (warmupAttemptsRef.current >= 40) {
        const message = "等待真实 FBX 动作加载超时";
        setError(message);
        setStatus("failed");
        const failedReport: ActionRuntimeSmokeReport = {
          ...window.__ACTION_RUNTIME_SMOKE__!,
          status: "failed",
          error: message,
        };
        window.__ACTION_RUNTIME_SMOKE__ = failedReport;
        setMachineReport(failedReport);
        return;
      }
      window.setTimeout(() => {
        samplesRef.current.delete(stepIndex);
        setSampleEpoch((epoch) => epoch + 1);
      }, 100);
      return;
    }
    const pointReport: ActionRuntimePointReport = {
      progress: sampleProgress,
      passed: comparison.passed && targetComparison.passed,
      maxDelta: comparison.maxDelta,
      viewDeltas: comparison.viewDeltas,
      targetMaxDelta: targetComparison.maxDelta,
      targetViewDeltas: targetComparison.viewDeltas,
      targetToRightHandDelta: 0,
      mainCameraTarget: pointSamples.get("main")?.cameraTarget ?? null,
      mainPose: pointSamples.get("main")?.pose ?? null,
    };
    const mainPose = pointSamples.get("main")?.pose;
    let nextPointReports = pointReportsRef.current;
    let nextLifecycleReports = lifecycleReportsRef.current;
    const mainSample = pointSamples.get("main");
    const targetToHandDelta = mainSample
      ? getActionRuntimeCameraTargetDelta(mainSample.cameraTarget, mainSample.pose)
      : Number.POSITIVE_INFINITY;
    pointReport.targetToRightHandDelta = targetToHandDelta;
    pointReport.passed = pointReport.passed && targetToHandDelta <= 0.0005;
    let stepPassed = comparison.passed && targetComparison.passed && targetToHandDelta <= 0.0005;

    if (step.type === "point") {
      nextPointReports = [...pointReportsRef.current, pointReport];
      pointReportsRef.current = nextPointReports;
      setPointReports(nextPointReports);
      if (mainPose) {
        baselinePosesRef.current.push(mainPose);
        baselineTargetsRef.current.push(mainSample!.cameraTarget);
        canonicalPosesRef.current.set(sampleProgress, mainPose);
        canonicalTargetsRef.current.set(sampleProgress, mainSample!.cameraTarget);
      }
    } else {
      const canonicalPose = canonicalPosesRef.current.get(sampleProgress);
      const canonicalTarget = canonicalTargetsRef.current.get(sampleProgress);
      const baselineDelta = mainPose && canonicalPose
        ? getActionRuntimePoseDelta(canonicalPose, mainPose)
        : Number.POSITIVE_INFINITY;
      const baselineTargetDelta = mainSample && canonicalTarget
        ? Math.hypot(
            mainSample.cameraTarget[0] - canonicalTarget[0],
            mainSample.cameraTarget[1] - canonicalTarget[1],
            mainSample.cameraTarget[2] - canonicalTarget[2],
          )
        : Number.POSITIVE_INFINITY;
      stepPassed = comparison.passed
        && targetComparison.passed
        && targetToHandDelta <= 0.0005
        && baselineDelta <= 0.0005
        && baselineTargetDelta <= 0.0005;
      const lifecycleReport: ActionRuntimeLifecycleReport = {
        ...pointReport,
        id: step.id,
        baselineDelta,
        baselineTargetDelta: Number(baselineTargetDelta.toFixed(6)),
        passed: stepPassed,
      };
      nextLifecycleReports = [...lifecycleReportsRef.current, lifecycleReport];
      lifecycleReportsRef.current = nextLifecycleReports;
      setLifecycleReports(nextLifecycleReports);
    }

    if (!stepPassed) {
      const message = step.type === "point"
        ? `${Math.round(sampleProgress * 100)}% 时间点跨视图骨骼或右手跟拍结果不一致`
        : `${step.id} 的重播姿态或右手跟拍目标与首次采样不一致`;
      setError(message);
      setStatus("failed");
      const failedReport: ActionRuntimeSmokeReport = {
        ...window.__ACTION_RUNTIME_SMOKE__!,
        status: "failed",
        points: nextPointReports,
        lifecycle: nextLifecycleReports,
        poseTravel: getActionRuntimePoseTravel(baselinePosesRef.current),
        targetTravel: getActionRuntimeTargetTravel(baselineTargetsRef.current),
        actionReadyDelta: actionReadyDeltaRef.current,
        error: message,
      };
      window.__ACTION_RUNTIME_SMOKE__ = failedReport;
      setMachineReport(failedReport);
      return;
    }

    if (stepIndex < ACTION_RUNTIME_STEPS.length - 1) {
      window.requestAnimationFrame(() => {
        const nextStepIndex = stepIndex + 1;
        setActionRuntimeSmokeProgress(ACTION_RUNTIME_STEPS[nextStepIndex].progress);
        setSampleEpoch(0);
        setStepIndex(nextStepIndex);
      });
      return;
    }

    const poseTravel = getActionRuntimePoseTravel(baselinePosesRef.current);
    const targetTravel = getActionRuntimeTargetTravel(baselineTargetsRef.current);
    const finalStatus = poseTravel >= 0.05 && targetTravel >= 0.05 ? "passed" : "failed";
    const finalError = finalStatus === "failed" ? "五个时间点的动作或右手跟拍目标没有产生足够变化" : null;
    setError(finalError);
    setStatus(finalStatus);
    const completedReport: ActionRuntimeSmokeReport = {
      ...window.__ACTION_RUNTIME_SMOKE__!,
      status: finalStatus,
      points: nextPointReports,
      lifecycle: nextLifecycleReports,
      poseTravel,
      targetTravel,
      actionReadyDelta: actionReadyDeltaRef.current,
      error: finalError,
    };
    window.__ACTION_RUNTIME_SMOKE__ = completedReport;
    setMachineReport(completedReport);
  }, [stepIndex]);

  const reportByProgress = useMemo(
    () => new Map(pointReports.map((report) => [report.progress, report])),
    [pointReports]
  );

  return (
    <main className="action-smoke" data-complete={status !== "running"} data-status={status}>
      <header className="action-smoke__header">
        <div>
          <h1>动作跨视图一致性自测</h1>
          <p>真实 Camille FBX + {ACTION_PRESET_LABELS[ACTION_PRESET_ID]}动作 · 五个独立 Canvas · 六个语义骨骼点</p>
        </div>
        <div className="action-smoke__status" data-state={status} role="status">
          {status === "running" ? activeStep.type.startsWith("warmup") ? "正在等待真实模型和动作就绪" : `正在检查 ${activeStep.id}` : status === "passed" ? "全部通过" : `失败：${error}`}
        </div>
      </header>

      <section className="action-smoke__grid" aria-label="五路动作视图">
        {VIEW_DEFINITIONS.map((definition) => (
          <RuntimeView definition={definition} key={definition.id} onPose={onPose} progress={progress} sampleKey={`${activeStep.id}-${sampleEpoch}`} />
        ))}
      </section>

      <footer className="action-smoke__footer">
        <section className="action-smoke__panel">
          <h2>五个时间点</h2>
          <div className="action-smoke__progress">
            {ACTION_RUNTIME_PROGRESS_POINTS.map((item, index) => (
              <span className={reportByProgress.has(item) ? "is-done" : activeStep.type === "point" && activeStep.progress === item ? "is-active" : ""} key={item}>
                {Math.round(item * 100)}%
              </span>
            ))}
          </div>
        </section>
        <section className="action-smoke__panel">
          <h2>骨骼与右手跟拍一致性</h2>
          <div className="action-smoke__results">
            {ACTION_RUNTIME_PROGRESS_POINTS.map((item) => {
              const report = reportByProgress.get(item);
              return (
                <div className="action-smoke__result" key={item}>
                  <strong>{Math.round(item * 100)}%</strong>
                  <span>{report ? `骨骼 ${report.maxDelta.toFixed(6)} · 跟拍 ${report.targetMaxDelta.toFixed(6)} · ${report.passed ? "通过" : "失败"}` : "等待采样"}</span>
                </div>
              );
            })}
          </div>
        </section>
      </footer>
      <div className="action-smoke__machine-report" aria-hidden="true">
        生命周期复验：{lifecycleReports.length}/3
      </div>
      <pre className="action-smoke__machine-report" id="action-runtime-report">
        {JSON.stringify(machineReport, null, 2)}
      </pre>
    </main>
  );
}

const root = createRoot(document.getElementById("root")!);
initializeActionRuntimeSmokeStore();
root.render(<ActionRuntimeSmoke />);

if (import.meta.hot) {
  import.meta.hot.dispose(() => root.unmount());
}
