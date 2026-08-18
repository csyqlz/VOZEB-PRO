import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Vector3 } from "three";
import { DirectorCanvas } from "../../editor/canvas/DirectorCanvas";
import { ViewportBackground } from "../../editor/canvas/ViewportBackground";
import { requestCleanFrameExport } from "../../editor/io/cleanFrameExport";
import { requestReferenceVideoExport } from "../../editor/io/referenceVideoExport";
import type { DirectorAssetRef, DirectorCameraShot, DirectorProject } from "../../editor/schema/directorProject";
import { createInitialDirectorState, useDirectorStore } from "../../editor/store/directorStore";
import {
  comparePanoramaViewFingerprints,
  createPanoramaPixelFingerprint,
  getPanoramaPixelDelta,
  type PanoramaPixelFingerprint,
} from "./panoramaPixelAnalysis";
import "../../styles/index.css";
import "./style.css";

function createDirectionalPanoramaDataUrl() {
  const canvas = document.createElement("canvas");
  canvas.width = 2048;
  canvas.height = 1024;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器无法创建全景测试图");
  const horizontal = context.createLinearGradient(0, 0, canvas.width, 0);
  horizontal.addColorStop(0, "#ef405d");
  horizontal.addColorStop(0.25, "#f5b642");
  horizontal.addColorStop(0.5, "#39b77a");
  horizontal.addColorStop(0.75, "#287bd1");
  horizontal.addColorStop(1, "#ef405d");
  context.fillStyle = horizontal;
  context.fillRect(0, 0, canvas.width, canvas.height);
  const vertical = context.createLinearGradient(0, 0, 0, canvas.height);
  vertical.addColorStop(0, "rgba(255,255,255,0.38)");
  vertical.addColorStop(0.5, "rgba(255,255,255,0)");
  vertical.addColorStop(1, "rgba(0,0,0,0.48)");
  context.fillStyle = vertical;
  context.fillRect(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < 8; index += 1) {
    context.fillStyle = index % 2 === 0 ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.16)";
    context.fillRect(index * 256 + 36, 96, 92, 832);
  }
  return canvas.toDataURL("image/png");
}

const PANORAMA_ASSET: DirectorAssetRef = {
  id: "panorama-export-smoke-asset",
  kind: "panorama",
  sourceType: "image",
  fileName: "directional-panorama-smoke.png",
  name: "全景图导出自测",
  url: createDirectionalPanoramaDataUrl(),
  assetSource: "library",
  projectionMode: "equirectangular",
};

const VIEW_DEFINITIONS = [
  { id: "main", label: "导演主视口" },
  { id: "monitor", label: "成片监看小窗" },
  { id: "first-person", label: "第一视角" },
  { id: "finished-shot", label: "看成片" },
  { id: "export-preview", label: "导出预览" },
] as const;

type ViewId = (typeof VIEW_DEFINITIONS)[number]["id"];
type StageId = "baseline" | "rotated" | "dimmed";

interface PanoramaStageReport {
  brightness: number;
  id: StageId;
  luminance: number;
  maxViewDelta: number;
  passed: boolean;
  viewDeltas: Record<string, number>;
  yaw: number;
}

interface PanoramaExportReport {
  error: string | null;
  png: {
    deltaFromFinishedShot: number;
    height: number;
    luminance: number;
    passed: boolean;
    width: number;
  } | null;
  stages: PanoramaStageReport[];
  status: "failed" | "passed" | "running";
  transforms: {
    brightnessLuminanceRatio: number;
    rotationPixelDelta: number;
  } | null;
  video: {
    bytes: number;
    duration: number;
    frameDelta: number;
    frameLuminance: number;
    height: number;
    mimeType: string;
    passed: boolean;
    width: number;
  } | null;
  views: ViewId[];
}

declare global {
  interface Window {
    __PANORAMA_EXPORT_SMOKE__?: PanoramaExportReport;
  }
}

function createSmokeProject(): DirectorProject {
  const project = createInitialDirectorState({
    includePersistedLocalAssets: false,
    includePersistedScene: false,
  }).project;
  const camera: DirectorCameraShot = {
    id: "panorama-export-smoke-camera",
    name: "全景导出镜头",
    fov: 48,
    transform: { position: [0, 1.4, 4.8], rotation: [0, 0, 0], scale: [1, 1, 1] },
    targetMode: "manual" as const,
    target: [0, 1.4, 0] as [number, number, number],
    captures: [],
    motionPath: {
      duration: 0.5,
      loop: false,
      interpolation: "linear" as const,
      easing: "linear" as const,
      speedMode: "uniform" as const,
      keyframes: [
        { id: "panorama-start", time: 0, position: [0, 1.4, 4.8] as [number, number, number], target: [0, 1.4, 0] as [number, number, number], fov: 48 },
        { id: "panorama-end", time: 1, position: [0.35, 1.4, 4.8] as [number, number, number], target: [0.35, 1.4, 0] as [number, number, number], fov: 48 },
      ],
    },
  };
  return {
    ...project,
    scene: {
      ...project.scene,
      backgroundBrightness: 1,
      backgroundColor: "#000000",
      panoramaRadius: 60,
      panoramaYaw: 0,
      showGrid: false,
      showGround: false,
      showLabels: false,
    },
    assets: [PANORAMA_ASSET],
    objects: [],
    cameras: [camera],
    activeCameraId: camera.id,
    panoramaAssetId: PANORAMA_ASSET.id,
  };
}

function initializeStore() {
  const initialState = createInitialDirectorState({
    includePersistedLocalAssets: false,
    includePersistedScene: false,
  });
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...initialState,
    cameraMotionPlaying: false,
    cameraMotionProgress: 0,
    finishedShotFov: null,
    motionMonitorFov: null,
    motionStudioOpen: false,
    performanceProfile: "quality",
    project: createSmokeProject(),
    selectedObjectId: null,
    selectedObjectIds: [],
    viewMode: "director",
  });
}

function FixedCamera() {
  const camera = useThree((state) => state.camera);
  useEffect(() => {
    camera.position.set(0, 1.4, 4.8);
    camera.lookAt(new Vector3(0, 1.4, 0));
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  }, [camera]);
  return null;
}

function PixelProbe({ onSample, sampleKey, viewId }: {
  onSample: (viewId: ViewId, fingerprint: PanoramaPixelFingerprint) => void;
  sampleKey: string;
  viewId: ViewId;
}) {
  const gl = useThree((state) => state.gl);
  const framesRef = useRef(0);
  const reportedRef = useRef(false);
  useEffect(() => { framesRef.current = 0; reportedRef.current = false; }, [sampleKey]);
  useFrame(() => {
    if (reportedRef.current) return;
    framesRef.current += 1;
    if (framesRef.current < 8) return;
    try {
      const fingerprint = createPanoramaPixelFingerprint(gl.domElement);
      if (fingerprint.variance < 0.00002) return;
      reportedRef.current = true;
      onSample(viewId, fingerprint);
    } catch {
      // The texture may still be uploading; the next frame retries.
    }
  });
  return null;
}

function RuntimeView({ definition, onSample, sampleKey }: {
  definition: (typeof VIEW_DEFINITIONS)[number];
  onSample: (viewId: ViewId, fingerprint: PanoramaPixelFingerprint) => void;
  sampleKey: string;
}) {
  const scene = useDirectorStore((state) => state.project.scene);
  return (
    <article className="panorama-smoke__view">
      <header><span>{definition.label}</span><span>{scene.panoramaYaw}° / {scene.backgroundBrightness.toFixed(2)}</span></header>
      <div className="panorama-smoke__canvas">
        <Canvas camera={{ fov: 48, position: [0, 1.4, 4.8] }} dpr={1} gl={{ antialias: true, preserveDrawingBuffer: true }}>
          <ViewportBackground
            backgroundColor={scene.backgroundColor}
            backgroundBrightness={scene.backgroundBrightness}
            panoramaAsset={PANORAMA_ASSET}
            panoramaRadius={scene.panoramaRadius}
            panoramaYaw={scene.panoramaYaw}
          />
          <FixedCamera />
          <PixelProbe onSample={onSample} sampleKey={sampleKey} viewId={definition.id} />
        </Canvas>
      </div>
    </article>
  );
}

async function loadDataUrlFingerprint(dataUrl: string) {
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("PNG 导出结果无法解码"));
    image.src = dataUrl;
  });
  return createPanoramaPixelFingerprint(image);
}

async function loadVideoFingerprint(blob: Blob) {
  const url = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error("MP4 导出结果无法解码"));
      video.src = url;
      video.load();
    });
    if (Number.isFinite(video.duration) && video.duration > 0.1) {
      video.currentTime = Math.min(video.duration * 0.5, video.duration - 0.01);
      await new Promise<void>((resolve, reject) => {
        video.onseeked = () => resolve();
        video.onerror = () => reject(new Error("MP4 导出帧无法读取"));
      });
    }
    return createPanoramaPixelFingerprint(video);
  } finally {
    URL.revokeObjectURL(url);
  }
}

const STAGES = [
  { id: "baseline", yaw: 0, brightness: 1 },
  { id: "rotated", yaw: 120, brightness: 1 },
  { id: "dimmed", yaw: 120, brightness: 0.35 },
] as const;

function PanoramaExportSmoke() {
  const [stageIndex, setStageIndex] = useState(0);
  const [status, setStatus] = useState<PanoramaExportReport["status"]>("running");
  const [error, setError] = useState<string | null>(null);
  const [stageReports, setStageReports] = useState<PanoramaStageReport[]>([]);
  const [pngReport, setPngReport] = useState<PanoramaExportReport["png"]>(null);
  const [videoReport, setVideoReport] = useState<PanoramaExportReport["video"]>(null);
  const stageFingerprintsRef = useRef(new Map<StageId, Record<string, PanoramaPixelFingerprint>>());
  const reportsRef = useRef<PanoramaStageReport[]>([]);
  const stage = STAGES[stageIndex] ?? STAGES[STAGES.length - 1];

  const publish = useCallback((patch: Partial<PanoramaExportReport> = {}) => {
    const baseline = stageFingerprintsRef.current.get("baseline")?.main;
    const rotated = stageFingerprintsRef.current.get("rotated")?.main;
    const dimmed = stageFingerprintsRef.current.get("dimmed")?.main;
    const transforms = baseline && rotated && dimmed ? {
      brightnessLuminanceRatio: Number((dimmed.luminance / rotated.luminance).toFixed(6)),
      rotationPixelDelta: getPanoramaPixelDelta(baseline, rotated),
    } : null;
    window.__PANORAMA_EXPORT_SMOKE__ = {
      error,
      png: pngReport,
      stages: reportsRef.current,
      status,
      transforms,
      video: videoReport,
      views: VIEW_DEFINITIONS.map((view) => view.id),
      ...patch,
    };
  }, [error, pngReport, status, videoReport]);

  useEffect(() => publish(), [publish]);

  const fail = useCallback((message: string) => {
    setError(message);
    setStatus("failed");
    publish({ error: message, status: "failed" });
  }, [publish]);

  const runExports = useCallback(async () => {
    try {
      const finishedShot = stageFingerprintsRef.current.get("dimmed")?.["finished-shot"];
      if (!finishedShot) throw new Error("缺少看成片像素基线");
      const png = await requestCleanFrameExport({ fileName: "panorama-smoke.png", position: "current", quality: "720p" });
      const pngFingerprint = await loadDataUrlFingerprint(png.dataUrl);
      const nextPngReport = {
        deltaFromFinishedShot: getPanoramaPixelDelta(finishedShot, pngFingerprint),
        height: png.height,
        luminance: pngFingerprint.luminance,
        passed: png.width === 1280 && png.height === 720 && pngFingerprint.variance >= 0.00002,
        width: png.width,
      };
      setPngReport(nextPngReport);

      const video = await requestReferenceVideoExport({ fileName: "panorama-smoke.mp4", fps: 15, quality: "720p" });
      const videoFingerprint = await loadVideoFingerprint(video.blob);
      const nextVideoReport = {
        bytes: video.blob.size,
        duration: video.durationSeconds,
        frameDelta: getPanoramaPixelDelta(finishedShot, videoFingerprint),
        frameLuminance: videoFingerprint.luminance,
        height: video.height,
        mimeType: video.mimeType,
        passed: video.blob.size > 2_000 && video.width === 1280 && video.height === 720 && videoFingerprint.variance >= 0.00002,
        width: video.width,
      };
      setVideoReport(nextVideoReport);

      const baseline = stageFingerprintsRef.current.get("baseline")!.main;
      const rotated = stageFingerprintsRef.current.get("rotated")!.main;
      const dimmed = stageFingerprintsRef.current.get("dimmed")!.main;
      const rotationDelta = getPanoramaPixelDelta(baseline, rotated);
      const brightnessRatio = dimmed.luminance / rotated.luminance;
      const passed = reportsRef.current.every((report) => report.passed)
        && rotationDelta >= 0.05
        && brightnessRatio < 0.75
        && nextPngReport.passed
        && nextPngReport.deltaFromFinishedShot <= 0.035
        && nextVideoReport.passed
        && nextVideoReport.frameDelta <= 0.06;
      if (!passed) throw new Error("全景旋转、亮度或实际 PNG/MP4 导出结果未达到验收阈值");
      setStatus("passed");
      publish({ png: nextPngReport, status: "passed", video: nextVideoReport });
    } catch (caught) {
      fail(caught instanceof Error ? caught.message : "全景导出自测失败");
    }
  }, [fail, publish]);

  const onSample = useCallback((viewId: ViewId, fingerprint: PanoramaPixelFingerprint) => {
    const currentStage = STAGES[stageIndex];
    if (!currentStage || status !== "running") return;
    const fingerprints = stageFingerprintsRef.current.get(currentStage.id) ?? {};
    fingerprints[viewId] = fingerprint;
    stageFingerprintsRef.current.set(currentStage.id, fingerprints);
    if (Object.keys(fingerprints).length !== VIEW_DEFINITIONS.length) return;

    const comparison = comparePanoramaViewFingerprints(fingerprints, "main");
    const report: PanoramaStageReport = {
      brightness: currentStage.brightness,
      id: currentStage.id,
      luminance: fingerprints.main.luminance,
      maxViewDelta: comparison.maxDelta,
      passed: comparison.maxDelta <= 0.012 && fingerprints.main.variance >= 0.00002,
      viewDeltas: comparison.deltas,
      yaw: currentStage.yaw,
    };
    reportsRef.current = [...reportsRef.current, report];
    setStageReports(reportsRef.current);
    if (!report.passed) {
      fail(`${currentStage.id} 的五视图像素不一致或全景画面为空`);
      return;
    }
    if (stageIndex < STAGES.length - 1) {
      const nextIndex = stageIndex + 1;
      const nextStage = STAGES[nextIndex];
      useDirectorStore.setState((state) => ({
        project: {
          ...state.project,
          scene: { ...state.project.scene, backgroundBrightness: nextStage.brightness, panoramaYaw: nextStage.yaw },
        },
      }));
      setStageIndex(nextIndex);
      return;
    }
    window.setTimeout(() => void runExports(), 100);
  }, [fail, runExports, stageIndex, status]);

  const reportById = useMemo(() => new Map(stageReports.map((report) => [report.id, report])), [stageReports]);
  return (
    <main className="panorama-smoke" data-complete={status !== "running"} data-status={status}>
      <header className="panorama-smoke__header">
        <div><h1>全景图多视图与实际导出自测</h1><p>旋转、亮度、五视图、PNG 成片帧、MP4 参考视频</p></div>
        <div className="panorama-smoke__status" data-state={status} role="status">
          {status === "running" ? `正在检查 ${stage.id}` : status === "passed" ? "全部通过" : `失败：${error}`}
        </div>
      </header>
      <section className="panorama-smoke__grid" aria-label="五路全景图视图">
        {VIEW_DEFINITIONS.map((definition) => (
          <RuntimeView definition={definition} key={definition.id} onSample={onSample} sampleKey={stage.id} />
        ))}
      </section>
      <section className="panorama-smoke__results">
        {STAGES.map((item) => {
          const report = reportById.get(item.id);
          return <div className="panorama-smoke__result" key={item.id}><strong>{item.id}</strong><span>{report ? `亮度 ${report.luminance.toFixed(4)} · 最大视图差 ${report.maxViewDelta.toFixed(4)} · ${report.passed ? "通过" : "失败"}` : "等待采样"}</span></div>;
        })}
        <div className="panorama-smoke__result"><strong>实际导出</strong><span>{pngReport ? `PNG ${pngReport.width}×${pngReport.height}` : "PNG 等待"} · {videoReport ? `MP4 ${videoReport.bytes} bytes` : "MP4 等待"}</span></div>
      </section>
      <pre className="panorama-smoke__machine-report" id="panorama-export-report">{JSON.stringify(window.__PANORAMA_EXPORT_SMOKE__ ?? { status: "running" }, null, 2)}</pre>
      <div className="panorama-smoke__production" aria-hidden="true"><DirectorCanvas /></div>
    </main>
  );
}

initializeStore();
const root = createRoot(document.getElementById("root")!);
root.render(<PanoramaExportSmoke />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
