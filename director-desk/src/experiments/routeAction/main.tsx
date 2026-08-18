import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Vector3 } from "three";
import { SceneRoot, type SceneRootRenderMode } from "../../editor/canvas/SceneRoot";
import { getRuntimePlaybackProgress, setRuntimePlaybackProgress } from "../../editor/runtime/playbackRuntime";
import {
  getDirectorObjectSceneNodeName,
  getSceneSemanticBodyPartTarget,
} from "../../editor/runtime/semanticBodyTracking";
import type { DirectorObject, DirectorProject } from "../../editor/schema/directorProject";
import {
  getObjectMotionActionSample,
  getObjectMotionTimingPlan,
} from "../../editor/schema/objectMotion";
import { createInitialDirectorState, useDirectorStore } from "../../editor/store/directorStore";
import {
  ACTION_RUNTIME_BODY_PARTS,
  type ActionRuntimePose,
} from "../actionRuntime/poseComparison";
import "../actionRuntime/style.css";
import {
  compareRouteActionReplay,
  compareRouteActionViewSamples,
  getRelativeRightHandDelta,
  type RouteActionSample,
} from "./routeActionComparison";

const CHARACTER_ID = "route-action-character";
const DURATION_SECONDS = 10;
const VIEW_DEFINITIONS: Array<{ id: string; label: string; renderMode: SceneRootRenderMode }> = [
  { id: "main", label: "导演主视口", renderMode: "interactive" },
  { id: "monitor", label: "成片监看小窗", renderMode: "clean-camera" },
  { id: "first-person", label: "第一视角", renderMode: "clean-camera" },
  { id: "finished-shot", label: "看成片", renderMode: "clean-camera" },
  { id: "export", label: "视频导出", renderMode: "clean-camera" },
];

function createRouteCharacter(): DirectorObject {
  return {
    id: CHARACTER_ID,
    name: "路线停留动作角色",
    kind: "character",
    visible: true,
    locked: true,
    assetRefId: "route-action-camille",
    bodyType: "mannequin",
    color: "#4F8EF7",
    transform: { position: [-2, 0, 0], rotation: [0, Math.PI / 2, 0], scale: [1, 1, 1] },
    characterRig: { rigType: "mixamo", posePresetId: "stand", actionPresetId: null, controls: {} },
    motionPath: {
      interpolation: "linear",
      speedMode: "uniform",
      keyframes: [
        {
          id: "route-start",
          time: 0,
          actionPresetId: "walk-cycle",
          facingMode: "path",
          transform: { position: [-2, 0, 0], rotation: [0, Math.PI / 2, 0], scale: [1, 1, 1] },
        },
        {
          id: "route-hold",
          time: 0.5,
          actionPresetId: "walk-cycle",
          facingMode: "path",
          pointBehavior: "hold",
          holdSeconds: 2,
          holdAction: "custom",
          holdActionPresetId: "wave-cycle",
          transform: { position: [0, 0, 0], rotation: [0, Math.PI / 2, 0], scale: [1, 1, 1] },
        },
        {
          id: "route-end",
          time: 1,
          actionPresetId: "walk-cycle",
          facingMode: "path",
          transform: { position: [2, 0, 0], rotation: [0, Math.PI / 2, 0], scale: [1, 1, 1] },
        },
      ],
    },
  };
}

function createSmokeProject(): DirectorProject {
  const project = createInitialDirectorState({ includePersistedLocalAssets: false, includePersistedScene: false }).project;
  return {
    ...project,
    scene: { ...project.scene, backgroundColor: "#05070a", showGrid: false, showGround: false, showLabels: false },
    assets: [{
      id: "route-action-camille",
      kind: "character",
      sourceType: "model",
      fileName: "camille.fbx",
      name: "Camille 路线动作自测",
      url: `${import.meta.env.BASE_URL}local-assets/mixamo/characters/camille.fbx`,
      assetSource: "library",
      modelFormat: "fbx",
      characterRigProfile: "mixamo",
      characterImportReadiness: "ready",
    }],
    objects: [createRouteCharacter()],
    cameras: [{
      id: "route-action-camera",
      name: "路线动作镜头",
      fov: 42,
      transform: { position: [0, 1.2, 5.2], rotation: [0, 0, 0], scale: [1, 1, 1] },
      targetMode: "manual",
      target: [0, 1, 0],
      captures: [],
      motionPath: {
        duration: DURATION_SECONDS,
        loop: false,
        interpolation: "linear",
        easing: "linear",
        speedMode: "uniform",
        keyframes: [
          { id: "camera-start", time: 0, position: [0, 1.2, 5.2], target: [0, 1, 0], fov: 42 },
          { id: "camera-end", time: 1, position: [0, 1.2, 5.2], target: [0, 1, 0], fov: 42 },
        ],
      },
    }],
    activeCameraId: "route-action-camera",
    panoramaAssetId: null,
  };
}

const ROUTE_CHARACTER = createRouteCharacter();
const TIMING_PLAN = getObjectMotionTimingPlan(ROUTE_CHARACTER, DURATION_SECONDS)!;
const HOLD_START = TIMING_PLAN.arrivals[1];
const HOLD_END = TIMING_PLAN.departures[1];
const STEPS = [
  { id: "move-before", progress: Math.max(0.05, HOLD_START - 0.12), phase: "move" as const },
  { id: "hold-start", progress: HOLD_START, phase: "hold-start" as const },
  { id: "hold-middle", progress: (HOLD_START + HOLD_END) / 2, phase: "hold" as const },
  { id: "move-after", progress: Math.min(0.95, HOLD_END + 0.12), phase: "move" as const },
  { id: "replay-hold", progress: (HOLD_START + HOLD_END) / 2, phase: "replay" as const },
];

interface StepReport {
  id: string;
  progress: number;
  actionPresetId: string | null;
  animationTimeSeconds: number;
  objectPosition: [number, number, number];
  maxPoseDelta: number;
  maxPositionDelta: number;
  rightHandDeltaFromMove: number;
  replayPoseDelta: number | null;
  replayPositionDelta: number | null;
  passed: boolean;
}

interface RouteActionReport {
  status: "running" | "passed" | "failed";
  arrivals: number[];
  departures: number[];
  holdSeconds: number;
  views: string[];
  steps: StepReport[];
  error: string | null;
}

declare global {
  interface Window { __ROUTE_ACTION_SMOKE__?: RouteActionReport; }
}

function initializeStore() {
  const initialState = createInitialDirectorState({ includePersistedLocalAssets: false, includePersistedScene: false });
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...initialState,
    viewMode: "director",
    cameraMotionPlaying: false,
    cameraMotionProgress: 0,
    selectedObjectId: null,
    selectedObjectIds: [],
    project: createSmokeProject(),
  });
  setRuntimePlaybackProgress(0);
}

function setProgress(progress: number) {
  setRuntimePlaybackProgress(progress);
  useDirectorStore.setState({ cameraMotionProgress: progress });
}

function FixedCamera() {
  const camera = useThree((state) => state.camera);
  useEffect(() => {
    camera.position.set(0, 1.2, 5.2);
    camera.lookAt(new Vector3(0, 1, 0));
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  }, [camera]);
  return null;
}

function Probe({ sampleKey, viewId, onSample }: {
  sampleKey: string;
  viewId: string;
  onSample: (sample: RouteActionSample) => void;
}) {
  const scene = useThree((state) => state.scene);
  const framesRef = useRef(0);
  const reportedRef = useRef(false);
  useEffect(() => { framesRef.current = 0; reportedRef.current = false; }, [sampleKey]);
  useFrame(() => {
    if (reportedRef.current) return;
    framesRef.current += 1;
    if (framesRef.current < 4) return;
    scene.updateMatrixWorld(true);
    const entries = ACTION_RUNTIME_BODY_PARTS.map((bodyPart) => [
      bodyPart,
      getSceneSemanticBodyPartTarget(scene, CHARACTER_ID, bodyPart),
    ] as const);
    const root = scene.getObjectByName(getDirectorObjectSceneNodeName(CHARACTER_ID));
    if (!root || entries.some(([, position]) => !position)) return;
    const pose = Object.fromEntries(entries) as ActionRuntimePose;
    reportedRef.current = true;
    onSample({
      viewId,
      pose,
      cameraTarget: pose.rightHand,
      objectPosition: [root.position.x, root.position.y, root.position.z],
    });
  });
  return null;
}

function RuntimeView({ definition, sampleKey, onSample }: {
  definition: (typeof VIEW_DEFINITIONS)[number];
  sampleKey: string;
  onSample: (sample: RouteActionSample) => void;
}) {
  return (
    <article className="action-smoke__view">
      <header><span>{definition.label}</span><span>{(getRuntimePlaybackProgress() * DURATION_SECONDS).toFixed(1)}s</span></header>
      <div className="action-smoke__canvas">
        <Canvas camera={{ fov: 42, position: [0, 1.2, 5.2] }} dpr={1} gl={{ antialias: true, preserveDrawingBuffer: true }}>
          <color attach="background" args={["#05070a"]} />
          <ambientLight intensity={1.4} />
          <directionalLight intensity={1.8} position={[4, 6, 5]} />
          <FixedCamera />
          <Suspense fallback={null}><SceneRoot renderMode={definition.renderMode} /></Suspense>
          <Probe sampleKey={sampleKey} viewId={definition.id} onSample={onSample} />
        </Canvas>
      </div>
    </article>
  );
}

function RouteActionSmoke() {
  const [stepIndex, setStepIndex] = useState(0);
  const [epoch, setEpoch] = useState(0);
  const [reports, setReports] = useState<StepReport[]>([]);
  const [status, setStatus] = useState<RouteActionReport["status"]>("running");
  const [error, setError] = useState<string | null>(null);
  const samplesRef = useRef(new Map<number, Map<string, RouteActionSample>>());
  const reportsRef = useRef<StepReport[]>([]);
  const movePoseRef = useRef<ActionRuntimePose | null>(null);
  const holdPoseRef = useRef<RouteActionSample | null>(null);
  const step = STEPS[stepIndex] ?? STEPS[STEPS.length - 1];

  const publish = useCallback((nextStatus: RouteActionReport["status"], nextReports: StepReport[], nextError: string | null) => {
    const report: RouteActionReport = {
      status: nextStatus,
      arrivals: TIMING_PLAN.arrivals,
      departures: TIMING_PLAN.departures,
      holdSeconds: TIMING_PLAN.effectiveHoldSeconds[1],
      views: VIEW_DEFINITIONS.map((view) => view.id),
      steps: nextReports,
      error: nextError,
    };
    window.__ROUTE_ACTION_SMOKE__ = report;
  }, []);

  useEffect(() => publish("running", [], null), [publish]);

  const onSample = useCallback((sample: RouteActionSample) => {
    const activeStep = STEPS[stepIndex];
    if (!activeStep) return;
    const viewSamples = samplesRef.current.get(stepIndex) ?? new Map<string, RouteActionSample>();
    viewSamples.set(sample.viewId, sample);
    samplesRef.current.set(stepIndex, viewSamples);
    if (viewSamples.size !== VIEW_DEFINITIONS.length) return;
    const ordered = VIEW_DEFINITIONS.map((view) => viewSamples.get(view.id)).filter(
      (item): item is RouteActionSample => Boolean(item),
    );
    const comparison = compareRouteActionViewSamples(ordered);
    const main = viewSamples.get("main")!;
    const actionSample = getObjectMotionActionSample(ROUTE_CHARACTER, activeStep.progress, DURATION_SECONDS);
    const expectedAction = activeStep.phase === "move" ? "walk-cycle" : "wave-cycle";
    const expectedX = activeStep.phase === "hold-start" || activeStep.phase === "hold" || activeStep.phase === "replay" ? 0 : null;
    const rightHandDeltaFromMove = movePoseRef.current ? getRelativeRightHandDelta(movePoseRef.current, main.pose) : 0;
    const replay = activeStep.phase === "replay" && holdPoseRef.current
      ? compareRouteActionReplay(holdPoseRef.current, main)
      : null;
    const holdStartsAtZero = activeStep.phase !== "hold-start" || actionSample.animationTimeSeconds <= 0.0005;
    const positionPassed = expectedX == null || Math.abs(main.objectPosition[0] - expectedX) <= 0.0005;
    const actionPosePassed = activeStep.phase === "hold" || activeStep.phase === "replay"
      ? rightHandDeltaFromMove >= 0.05
      : true;
    const replayPassed = !replay || (replay.poseDelta <= 0.0005 && replay.positionDelta <= 0.0005);
    const passed = comparison.passed
      && actionSample.actionPresetId === expectedAction
      && holdStartsAtZero
      && positionPassed
      && actionPosePassed
      && replayPassed;
    const report: StepReport = {
      id: activeStep.id,
      progress: activeStep.progress,
      actionPresetId: actionSample.actionPresetId,
      animationTimeSeconds: Number(actionSample.animationTimeSeconds.toFixed(6)),
      objectPosition: main.objectPosition,
      maxPoseDelta: comparison.poseComparison.maxDelta,
      maxPositionDelta: comparison.maxPositionDelta,
      rightHandDeltaFromMove,
      replayPoseDelta: replay?.poseDelta ?? null,
      replayPositionDelta: replay?.positionDelta ?? null,
      passed,
    };
    const nextReports = [...reportsRef.current, report];
    reportsRef.current = nextReports;
    setReports(nextReports);
    if (activeStep.id === "move-before") movePoseRef.current = main.pose;
    if (activeStep.id === "hold-middle") holdPoseRef.current = main;

    if (!passed) {
      const message = `${activeStep.id} 的路线位置、动作或跨视图结果不一致`;
      setError(message);
      setStatus("failed");
      publish("failed", nextReports, message);
      return;
    }
    if (stepIndex >= STEPS.length - 1) {
      setStatus("passed");
      publish("passed", nextReports, null);
      return;
    }
    window.requestAnimationFrame(() => {
      const nextIndex = stepIndex + 1;
      setProgress(STEPS[nextIndex].progress);
      setEpoch(0);
      setStepIndex(nextIndex);
    });
  }, [publish, stepIndex]);

  const reportById = useMemo(() => new Map(reports.map((report) => [report.id, report])), [reports]);
  return (
    <main className="action-smoke" data-complete={status !== "running"} data-status={status}>
      <header className="action-smoke__header">
        <div><h1>人物路线停留动作自测</h1><p>真实 Camille · 移动 → 停留挥手 2 秒 → 继续移动 · 五视图</p></div>
        <div className="action-smoke__status" data-state={status} role="status">
          {status === "running" ? `正在检查 ${step.id}` : status === "passed" ? "全部通过" : `失败：${error}`}
        </div>
      </header>
      <section className="action-smoke__grid" aria-label="五路路线动作视图">
        {VIEW_DEFINITIONS.map((definition) => (
          <RuntimeView definition={definition} key={definition.id} sampleKey={`${step.id}-${epoch}`} onSample={onSample} />
        ))}
      </section>
      <footer className="action-smoke__footer">
        <section className="action-smoke__panel">
          <h2>路线计时</h2>
          <div className="action-smoke__progress">
            {STEPS.map((item) => <span className={reportById.has(item.id) ? "is-done" : item.id === step.id ? "is-active" : ""} key={item.id}>{item.id}</span>)}
          </div>
        </section>
        <section className="action-smoke__panel">
          <h2>位置与动作结果</h2>
          <div className="action-smoke__results">
            {STEPS.map((item) => {
              const report = reportById.get(item.id);
              return <div className="action-smoke__result" key={item.id}><strong>{item.id}</strong><span>{report ? `${report.actionPresetId} · X ${report.objectPosition[0].toFixed(3)} · ${report.passed ? "通过" : "失败"}` : "等待采样"}</span></div>;
            })}
          </div>
        </section>
      </footer>
      <pre className="action-smoke__machine-report" id="route-action-report">{JSON.stringify(window.__ROUTE_ACTION_SMOKE__ ?? { status: "running" }, null, 2)}</pre>
    </main>
  );
}

initializeStore();
setProgress(STEPS[0].progress);
const root = createRoot(document.getElementById("root")!);
root.render(<RouteActionSmoke />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
