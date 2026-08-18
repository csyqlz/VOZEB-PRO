import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Download,
  Gauge,
  LocateFixed,
  MousePointer2,
  Move3D,
  Pause,
  Play,
  Plus,
  Route,
  SlidersHorizontal,
  Trash2,
  Users,
  Video,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  downloadReferenceVideo,
  requestReferenceVideoExport,
  type ReferenceVideoExportQuality,
} from "../io/referenceVideoExport";
import { getCameraMotionPath, getCameraMotionTimingPlan, getCameraMotionTimingSample } from "../schema/cameraMotion";
import {
  getAnimatedCameraFocusTarget,
  getDirectorObjectFocusTarget,
  isCameraFocusableObject,
} from "../schema/cameraTarget";
import { getObjectMotionSnapshot } from "../schema/objectMotion";
import type { CameraShotSnapshot } from "../store/directorStore";
import { useDirectorStore } from "../store/directorStore";
import {
  CAMERA_MOTION_PRESETS,
  findMatchingCameraMotionPreset,
  getCameraMotionPresetPatch,
} from "./cameraMotionPresets";
import {
  CAMERA_PATH_TEMPLATES,
  createCameraPathTemplate,
  getCameraPathTemplatesByGroup,
  type CameraPathTemplateId,
} from "./cameraPathTemplates";
import {
  DIRECTOR_CAMERA_TARGET_BODY_PART_OPTIONS,
  type DirectorCameraTargetBodyPart,
  type DirectorCameraTargetFollowMode,
} from "../schema/semanticBody";
import { RouteCustomEasingControl } from "./RouteCustomEasingControl";

export function getActiveCameraWaypointIndex(progress: number, times: number[]) {
  if (times.length === 0) return -1;
  let active = 0;
  for (let index = 1; index < times.length; index += 1) {
    if (progress + 0.0001 < times[index]) break;
    active = index;
  }
  return active;
}

export function MotionStudio({
  getViewportCameraSnapshot,
  onLoadCameraSnapshot,
  onStartPilot,
}: {
  getViewportCameraSnapshot: () => CameraShotSnapshot;
  onLoadCameraSnapshot?: (snapshot: CameraShotSnapshot) => void;
  onStartPilot?: (editKeyframeId?: string | null) => void;
}) {
  const open = useDirectorStore((state) => state.motionStudioOpen);
  const viewMode = useDirectorStore((state) => state.viewMode);
  const cameraPilotMode = useDirectorStore((state) => state.cameraPilotMode);
  const activeCamera = useDirectorStore((state) =>
    state.project.cameras.find((item) => item.id === state.project.activeCameraId) ?? state.project.cameras[0]
  );
  const selectedCameraKeyframeId = useDirectorStore((state) => state.selectedCameraKeyframeId);
  const selectedCameraKeyframeIds = useDirectorStore((state) => state.selectedCameraKeyframeIds);
  const cameraMotionProgress = useDirectorStore((state) => state.cameraMotionProgress);
  const cameraMotionPlaying = useDirectorStore((state) => state.cameraMotionPlaying);
  const cameraPilotFollowTarget = useDirectorStore((state) => state.cameraPilotFollowTarget);
  const selectedObjectId = useDirectorStore((state) => state.selectedObjectId);
  const sceneObjects = useDirectorStore((state) => state.project.objects);
  const setMotionStudioOpen = useDirectorStore((state) => state.setMotionStudioOpen);
  const setViewMode = useDirectorStore((state) => state.setViewMode);
  const ensureMotionCamera = useDirectorStore((state) => state.ensureMotionCamera);
  const startCameraPilot = useDirectorStore((state) => state.startCameraPilot);
  const recordCameraMotionSnapshot = useDirectorStore((state) => state.recordCameraMotionSnapshot);
  const selectCameraMotionKeyframe = useDirectorStore((state) => state.selectCameraMotionKeyframe);
  const setCameraMotionKeyframeSelection = useDirectorStore((state) => state.setCameraMotionKeyframeSelection);
  const setCameraMotionProgress = useDirectorStore((state) => state.setCameraMotionProgress);
  const setCameraMotionPlaying = useDirectorStore((state) => state.setCameraMotionPlaying);
  const updateCameraMotionPath = useDirectorStore((state) => state.updateCameraMotionPath);
  const updateCameraMotionKeyframe = useDirectorStore((state) => state.updateCameraMotionKeyframe);
  const deleteCameraMotionKeyframe = useDirectorStore((state) => state.deleteCameraMotionKeyframe);
  const moveCameraMotionKeyframe = useDirectorStore((state) => state.moveCameraMotionKeyframe);
  const insertCameraMotionKeyframeAfter = useDirectorStore((state) => state.insertCameraMotionKeyframeAfter);
  const setCameraPilotFollowTarget = useDirectorStore((state) => state.setCameraPilotFollowTarget);
  const beginUndoBatch = useDirectorStore((state) => state.beginUndoBatch);
  const endUndoBatch = useDirectorStore((state) => state.endUndoBatch);
  const [batchSelectionEnabled, setBatchSelectionEnabled] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFps, setExportFps] = useState(30);
  const [exportQuality, setExportQuality] = useState<ReferenceVideoExportQuality>("720p");
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [arrivalTimeDraft, setArrivalTimeDraft] = useState("");
  const [templateTargetObjectId, setTemplateTargetObjectId] = useState("");
  const [templateScale, setTemplateScale] = useState(1);
  const [templateGroup, setTemplateGroup] = useState<"official" | "community">("official");
  const [activeTemplateId, setActiveTemplateId] = useState<CameraPathTemplateId | null>(null);
  const activeTemplateRef = useRef<{
    snapshot: CameraShotSnapshot;
    targetObjectId: string;
    templateId: CameraPathTemplateId;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    ensureMotionCamera(getViewportCameraSnapshot());
  }, [ensureMotionCamera, open]);

  useEffect(() => {
    if (selectedObjectId && sceneObjects.some((object) => object.id === selectedObjectId && isCameraFocusableObject(object))) {
      setTemplateTargetObjectId(selectedObjectId);
    }
  }, [selectedObjectId]);

  const activeMotionPath = activeCamera ? getCameraMotionPath(activeCamera) : null;
  const activeSelectedKeyframe = activeMotionPath?.keyframes.find((item) => item.id === selectedCameraKeyframeId) ?? null;
  const activeTimingPlan = activeCamera ? getCameraMotionTimingPlan(activeCamera) : null;
  const activeSelectedIndex = activeMotionPath && activeSelectedKeyframe
    ? activeMotionPath.keyframes.indexOf(activeSelectedKeyframe)
    : -1;
  const activeSelectedArrival = activeSelectedIndex >= 0
    ? activeTimingPlan?.arrivals[activeSelectedIndex] ?? activeSelectedKeyframe?.time ?? 0
    : 0;

  useEffect(() => {
    setArrivalTimeDraft(
      activeSelectedKeyframe && activeMotionPath
        ? (activeSelectedArrival * activeMotionPath.duration).toFixed(1)
        : ""
    );
  }, [activeMotionPath?.duration, activeSelectedArrival, activeSelectedKeyframe?.id]);

  if (!open || !activeCamera) return null;

  const motionPath = activeMotionPath!;
  const trackableObjects = sceneObjects.filter(isCameraFocusableObject);
  const canPlay = motionPath.keyframes.length >= 2 || sceneObjects.some((item) => (item.motionPath?.keyframes?.length ?? 0) >= 2);
  const selectedKeyframe = motionPath.keyframes.find((item) => item.id === selectedCameraKeyframeId) ?? null;
  const trackingObjectId = selectedKeyframe?.targetMode === "object"
    ? selectedKeyframe.targetObjectId ?? ""
    : "";
  const trackingObject = trackableObjects.find((object) => object.id === trackingObjectId) ?? null;
  const trackingBodyPart = selectedKeyframe?.targetBodyPart ?? "center";
  const trackingFollowMode = selectedKeyframe?.targetFollowMode ?? "immediate";
  const trackingStabilizationEnabled = selectedKeyframe?.targetStabilizationEnabled ?? false;
  const stabilizedWaypointCount = motionPath.keyframes.filter((keyframe) => keyframe.targetStabilizationEnabled).length;
  const allWaypointsStabilized = motionPath.keyframes.length > 0
    && stabilizedWaypointCount === motionPath.keyframes.length;
  const matchingPreset = findMatchingCameraMotionPreset(motionPath);
  const timingSample = getCameraMotionTimingSample(activeCamera, cameraMotionProgress);
  const activeIndex = timingSample?.holdingPointIndex
    ?? timingSample?.segment
    ?? getActiveCameraWaypointIndex(cameraMotionProgress, motionPath.keyframes.map((item) => item.time));
  const timelinePreviewActive = cameraMotionPlaying || cameraMotionProgress > 0.0001;
  const visiblePathTemplates = getCameraPathTemplatesByGroup(templateGroup);
  const activeTemplate = CAMERA_PATH_TEMPLATES.find((template) => template.id === activeTemplateId) ?? null;

  function addCurrentView() {
    recordCameraMotionSnapshot(activeCamera.id, getViewportCameraSnapshot());
  }

  function selectWaypoint(id: string, time: number) {
    if (batchSelectionEnabled) {
      const nextSelection = selectedCameraKeyframeIds.includes(id)
        ? selectedCameraKeyframeIds.filter((item) => item !== id)
        : [...selectedCameraKeyframeIds, id];
      setCameraMotionKeyframeSelection(nextSelection);
      if (nextSelection.includes(id)) setCameraMotionProgress(time);
      return;
    }
    selectCameraMotionKeyframe(id);
    setCameraMotionProgress(time);
    setCameraMotionPlaying(false);
  }

  function toggleBatchSelection() {
    if (batchSelectionEnabled) {
      selectCameraMotionKeyframe(selectedCameraKeyframeId);
      setBatchSelectionEnabled(false);
      return;
    }
    setBatchSelectionEnabled(true);
  }

  function setTrackingObject(objectId: string) {
    if (!selectedKeyframe) return;
    if (!objectId) {
      const currentTrackingTarget = getAnimatedCameraFocusTarget(
        activeCamera,
        sceneObjects,
        selectedKeyframe.time
      );
      updateCameraMotionKeyframe(activeCamera.id, selectedKeyframe.id, {
        targetMode: "manual",
        targetObjectId: null,
        targetBodyPart: "center",
        targetFollowMode: "immediate",
        targetStabilizationEnabled: false,
        target: currentTrackingTarget ?? selectedKeyframe.target,
      });
      return;
    }

    const targetObject = trackableObjects.find((object) => object.id === objectId);
    if (!targetObject) return;
    const target = getDirectorObjectFocusTarget({
      ...targetObject,
      transform: getObjectMotionSnapshot(targetObject, selectedKeyframe.time, motionPath.duration),
    });
    updateCameraMotionKeyframe(activeCamera.id, selectedKeyframe.id, {
      targetMode: "object",
      targetObjectId: targetObject.id,
      targetBodyPart: targetObject.kind === "character" ? "chest" : "center",
      targetFollowMode: "immediate",
      targetStabilizationEnabled: false,
      target,
    });
  }

  function setTrackingBodyPart(bodyPart: DirectorCameraTargetBodyPart) {
    if (!selectedKeyframe || trackingObject?.kind !== "character") return;
    updateCameraMotionKeyframe(activeCamera.id, selectedKeyframe.id, { targetBodyPart: bodyPart });
  }

  function setTrackingFollowMode(targetFollowMode: DirectorCameraTargetFollowMode) {
    if (!selectedKeyframe || !trackingObjectId) return;
    updateCameraMotionKeyframe(activeCamera.id, selectedKeyframe.id, { targetFollowMode });
  }

  function setTrackingStabilization(targetStabilizationEnabled: boolean) {
    if (!selectedKeyframe || !trackingObjectId) return;
    updateCameraMotionKeyframe(activeCamera.id, selectedKeyframe.id, { targetStabilizationEnabled });
  }

  function setAllTrackingStabilization(targetStabilizationEnabled: boolean) {
    if (motionPath.keyframes.length === 0) return;
    setCameraMotionPlaying(false);
    updateCameraMotionPath(activeCamera.id, {
      keyframes: motionPath.keyframes.map((keyframe) => ({
        ...keyframe,
        targetStabilizationEnabled,
      })),
    });
  }

  function applyMotionPreset(presetId: string) {
    const patch = getCameraMotionPresetPatch(presetId);
    if (patch) updateCameraMotionPath(activeCamera.id, patch);
  }

  function generatePathTemplate({
    scale,
    snapshot,
    targetObjectId,
    templateId,
  }: {
    scale: number;
    snapshot: CameraShotSnapshot;
    targetObjectId: string;
    templateId: CameraPathTemplateId;
  }) {
    const targetObject = trackableObjects.find((object) => object.id === targetObjectId) ?? null;
    const focusAt = targetObject
      ? (progress: number) => getDirectorObjectFocusTarget({
          ...targetObject,
          transform: getObjectMotionSnapshot(targetObject, progress, motionPath.duration),
        })
      : () => [...snapshot.target] as [number, number, number];
    const generatedPath = createCameraPathTemplate({
      cameraId: activeCamera.id,
      focusAt,
      scale,
      snapshot,
      targetObjectId: targetObject?.id ?? null,
      targetBodyPart: targetObject?.kind === "character" ? "chest" : "center",
      templateId,
    });

    setCameraMotionPlaying(false);
    setCameraMotionProgress(0);
    setBatchSelectionEnabled(false);
    updateCameraMotionPath(activeCamera.id, generatedPath);
    selectCameraMotionKeyframe(generatedPath.keyframes[0]?.id ?? null);
  }

  function applyPathTemplate(templateId: CameraPathTemplateId) {
    const context = {
      snapshot: getViewportCameraSnapshot(),
      targetObjectId: templateTargetObjectId,
      templateId,
    };
    activeTemplateRef.current = context;
    setActiveTemplateId(templateId);
    generatePathTemplate({ ...context, scale: templateScale });
  }

  function updateTemplateScale(scale: number) {
    setTemplateScale(scale);
    const context = activeTemplateRef.current;
    if (context) generatePathTemplate({ ...context, scale });
  }

  function updateTemplateTarget(targetObjectId: string) {
    setTemplateTargetObjectId(targetObjectId);
    const context = activeTemplateRef.current;
    if (!context) return;
    const nextContext = { ...context, targetObjectId };
    activeTemplateRef.current = nextContext;
    generatePathTemplate({ ...nextContext, scale: templateScale });
  }

  function editSelectedWaypoint() {
    if (!selectedKeyframe) return;
    onLoadCameraSnapshot?.({
      position: [...selectedKeyframe.position],
      target: [...selectedKeyframe.target],
      fov: selectedKeyframe.fov,
    });
    if (onStartPilot) {
      onStartPilot(selectedKeyframe.id);
    } else {
      startCameraPilot("pilot", selectedKeyframe.id);
    }
  }

  function previewInView(mode: "director" | "camera") {
    if (!canPlay) return;
    if (cameraMotionPlaying && viewMode === mode) {
      setCameraMotionPlaying(false);
      return;
    }

    setViewMode(mode);
    if (cameraMotionProgress >= 0.999) setCameraMotionProgress(0);
    setCameraMotionPlaying(true);
  }

  function updateSelectedArrivalTime(seconds: number) {
    if (!selectedKeyframe) return;
    const index = motionPath.keyframes.indexOf(selectedKeyframe);
    if (index <= 0 || index >= motionPath.keyframes.length - 1) return;
    const previous = motionPath.keyframes[index - 1];
    const next = motionPath.keyframes[index + 1];
    const minimum = previous.time * motionPath.duration
      + (previous.pointBehavior === "hold" ? previous.holdSeconds ?? 0 : 0)
      + 0.1;
    const maximum = next.time * motionPath.duration - 0.1;
    const clamped = Math.min(maximum, Math.max(minimum, seconds));
    updateCameraMotionKeyframe(activeCamera.id, selectedKeyframe.id, {
      time: clamped / motionPath.duration,
    });
    setCameraMotionProgress(clamped / motionPath.duration);
    setArrivalTimeDraft(clamped.toFixed(1));
  }

  function setCameraSpeedMode(speedMode: "uniform" | "soft" | "custom") {
    const keyframes = speedMode === "custom" && motionPath.speedMode !== "custom" && activeTimingPlan
      ? motionPath.keyframes.map((keyframe, index) => ({
          ...keyframe,
          time: activeTimingPlan.arrivals[index] ?? keyframe.time,
        }))
      : motionPath.keyframes;
    updateCameraMotionPath(activeCamera.id, {
      speedMode,
      easing: speedMode === "uniform" ? "linear" : "ease-in-out",
      ...(speedMode === "custom" ? { customEasing: [0, 0, 1, 1], keyframes } : {}),
    });
  }

  function commitArrivalTimeDraft() {
    const seconds = Number(arrivalTimeDraft);
    if (Number.isFinite(seconds)) updateSelectedArrivalTime(seconds);
    else if (selectedKeyframe) setArrivalTimeDraft((selectedKeyframe.time * motionPath.duration).toFixed(1));
  }

  async function exportReferenceVideo() {
    if (motionPath.keyframes.length < 2 || exporting) return;
    setExporting(true);
    setExportStatus("正在录制参考视频...");
    try {
      const result = await requestReferenceVideoExport({
        fileName: `${activeCamera.name || "运镜"}-参考视频.mp4`,
        fps: exportFps,
        quality: exportQuality,
      });
      downloadReferenceVideo(result);
      setExportStatus("MP4 参考视频已下载");
    } catch (error) {
      setExportStatus(error instanceof Error ? error.message : "参考视频导出失败");
    } finally {
      setExporting(false);
    }
  }

  return (
    <section className={`motion-studio${cameraPilotMode !== "idle" ? " is-piloting" : ""}`} aria-label="运镜工作台">
      <header className="motion-studio-header">
        <div className="motion-studio-heading">
          <span className="motion-studio-icon"><Route aria-hidden="true" size={17} /></span>
          <div>
            <h2>运镜工作台</h2>
            <p>侧边栏不挡画面 · 无需摆放机位</p>
          </div>
        </div>
        <div className="motion-studio-header-actions">
          <button type="button" className="motion-studio-export" aria-label="导出运镜" aria-expanded={exportOpen} onClick={() => setExportOpen((current) => !current)}>
            <Download aria-hidden="true" size={14} />导出
          </button>
          <button type="button" className="motion-studio-close" aria-label="关闭运镜工作台" onClick={() => setMotionStudioOpen(false)}>
            <X aria-hidden="true" size={16} />
          </button>
        </div>
      </header>

      {exportOpen ? (
        <section className="motion-export-panel" aria-label="导出运镜设置">
          <div><strong>导出 MP4 参考视频</strong><small>导出干净的第一视角运镜，不包含轨迹线和操作界面</small></div>
          <label><span>画质</span><select aria-label="参考视频画质" value={exportQuality} onChange={(event) => setExportQuality(event.currentTarget.value as ReferenceVideoExportQuality)}><option value="720p">720p</option><option value="1080p">1080p</option></select></label>
          <label><span>帧率</span><select aria-label="参考视频帧率" value={exportFps} onChange={(event) => setExportFps(Number(event.currentTarget.value))}><option value="24">24 FPS</option><option value="30">30 FPS</option><option value="60">60 FPS</option></select></label>
          <button type="button" className="motion-export-confirm" disabled={motionPath.keyframes.length < 2 || exporting} onClick={() => void exportReferenceVideo()}><Download aria-hidden="true" size={14} />{exporting ? "正在录制" : "导出 MP4"}</button>
          {exportStatus ? <output className="motion-export-status" role="status">{exportStatus}</output> : null}
        </section>
      ) : null}

      <section className="motion-preview-panel" aria-label="运镜预览方式">
        <div className="motion-block-heading">
          <strong>你想怎么看？</strong>
          <small>路线检查和最终镜头分开预览</small>
        </div>
        <div className="motion-preview-options">
          <button
            type="button"
            className={`motion-preview-option is-director${viewMode === "director" ? " is-active" : ""}`}
            disabled={!canPlay}
            aria-label={cameraMotionPlaying && viewMode === "director" ? "暂停导演视角预演" : "播放导演视角预演"}
            aria-pressed={viewMode === "director"}
            onClick={() => previewInView("director")}
          >
            <Route aria-hidden="true" size={17} />
            <span><strong>{cameraMotionPlaying && viewMode === "director" ? "暂停" : "看路线"}</strong><small>导演视角看轨迹点</small></span>
            {cameraMotionPlaying && viewMode === "director" ? <Pause aria-hidden="true" size={14} /> : <Play aria-hidden="true" size={14} />}
          </button>
          <button
            type="button"
            className={`motion-preview-option is-camera${viewMode === "camera" ? " is-active" : ""}`}
            disabled={!canPlay}
            aria-label={cameraMotionPlaying && viewMode === "camera" ? "暂停第一视角运镜预演" : "播放第一视角运镜预演"}
            aria-pressed={viewMode === "camera"}
            onClick={() => previewInView("camera")}
          >
            <Video aria-hidden="true" size={17} />
            <span><strong>{cameraMotionPlaying && viewMode === "camera" ? "暂停" : "看成片"}</strong><small>第一视角看最终镜头</small></span>
            {cameraMotionPlaying && viewMode === "camera" ? <Pause aria-hidden="true" size={14} /> : <Play aria-hidden="true" size={14} />}
          </button>
        </div>
      </section>

      <div className="motion-studio-body">
        <section className="motion-template-panel" aria-label="镜头预设">
          <div className="motion-block-heading">
            <strong>一键镜头</strong>
            <small>选择主体和幅度，再套用镜头</small>
          </div>
          <div className="motion-template-tabs" role="group" aria-label="镜头预设分类">
            <button
              type="button"
              aria-pressed={templateGroup === "official"}
              className={templateGroup === "official" ? "is-active" : undefined}
              onClick={() => setTemplateGroup("official")}
              aria-label="基础预设"
            >基础预设 <small>{getCameraPathTemplatesByGroup("official").length}</small></button>
            <button
              type="button"
              aria-pressed={templateGroup === "community"}
              className={templateGroup === "community" ? "is-active" : undefined}
              onClick={() => setTemplateGroup("community")}
              aria-label="群友预设"
            ><Users aria-hidden="true" size={12} />群友预设 <small>{getCameraPathTemplatesByGroup("community").length}</small></button>
          </div>
          <div className="motion-template-controls">
            <label>
              <span><LocateFixed aria-hidden="true" size={13} />跟踪主体</span>
              <select
                aria-label="镜头预设跟踪主体"
                value={templateTargetObjectId}
                onChange={(event) => updateTemplateTarget(event.currentTarget.value)}
              >
                <option value="">固定当前画面中心</option>
                {trackableObjects.map((object) => (
                  <option key={object.id} value={object.id}>{object.name}</option>
                ))}
              </select>
            </label>
            <label>
              <span><Move3D aria-hidden="true" size={13} />轨迹范围</span>
              <input
                aria-label="镜头预设轨迹范围"
                type="range"
                min="0.5"
                max="3"
                step="0.25"
                value={templateScale}
                onPointerDown={beginUndoBatch}
                onPointerUp={endUndoBatch}
                onPointerCancel={endUndoBatch}
                onBlur={endUndoBatch}
                onChange={(event) => updateTemplateScale(Number(event.currentTarget.value))}
              />
              <output>{Math.round(templateScale * 100)}%</output>
            </label>
          </div>
          <div className="motion-template-grid">
            {visiblePathTemplates.map((template) => (
              <button
                type="button"
                key={template.id}
                className={activeTemplateId === template.id ? "is-active" : undefined}
                aria-label={`套用${template.label}镜头预设`}
                aria-pressed={activeTemplateId === template.id}
                title={template.description}
                onClick={() => applyPathTemplate(template.id)}
              >
                {template.label}
              </button>
            ))}
          </div>
          {templateGroup === "community" ? (
            <div className="motion-community-template-meta" aria-label="群友预设资料">
              {activeTemplate?.group === "community" ? (
                <>
                  <strong>{activeTemplate.label} · v{activeTemplate.version}</strong>
                  <span>{activeTemplate.description}；适合：{activeTemplate.suitableFor}</span>
                  <span>贡献者：{activeTemplate.contribution?.contributorName ?? "待群主补充"}</span>
                  <span>许可：{activeTemplate.contribution?.license}</span>
                  {activeTemplate.contribution?.contact ? <span>联系：{activeTemplate.contribution.contact}</span> : null}
                  {activeTemplate.contribution?.sourceUrl ? <a href={activeTemplate.contribution.sourceUrl} target="_blank" rel="noreferrer">查看来源</a> : null}
                </>
              ) : (
                <span>选择一个群友预设后显示贡献者、来源、版本和许可资料。</span>
              )}
            </div>
          ) : null}
        </section>

        <div className="motion-studio-primary-actions">
          <div className="motion-block-heading">
            <strong>制作镜头</strong>
            <small>移动镜头，按 Enter 添加轨迹点</small>
          </div>
          <button
            type="button"
            className="motion-primary-button"
            aria-label="开始掌镜"
            onClick={() => onStartPilot ? onStartPilot(null) : startCameraPilot("pilot")}
          >
            <MousePointer2 aria-hidden="true" size={17} />
            <span><strong>开始掌镜</strong><small>WASD 自由走镜头</small></span>
          </button>
          <button type="button" className="motion-add-current" aria-label="添加当前视角为轨迹点" onClick={addCurrentView}>
            <Plus aria-hidden="true" size={16} />
            添加当前视角
          </button>
        </div>

        <div className="motion-key-help" aria-label="掌镜键位说明">
          <span><kbd>WASD</kbd><small>移动</small></span>
          <span><kbd>E</kbd><small>上升</small></span>
          <span><kbd>Q</kbd><small>下降</small></span>
          <span><kbd>空格</kbd><small>播放 / 暂停人物</small></span>
          <span><kbd>鼠标</kbd><small>看向</small></span>
          <span><kbd>F</kbd><small>锁定</small></span>
          <span><kbd>Enter</kbd><small>记录</small></span>
        </div>

        <div className="motion-route-column">
          <div className="motion-route-title">
            <div><Video aria-hidden="true" size={15} /><strong>镜头路线</strong><span>{motionPath.keyframes.length} 个点</span></div>
            {motionPath.keyframes.length > 0 ? (
              <button
                type="button"
                className={batchSelectionEnabled ? "is-active" : undefined}
                aria-label="批量选择并移动轨迹点"
                aria-pressed={batchSelectionEnabled}
                onClick={toggleBatchSelection}
              >
                <Move3D aria-hidden="true" size={13} />
                批量移动
              </button>
            ) : null}
          </div>

          {batchSelectionEnabled ? (
            <div className="motion-batch-selection" aria-label="批量轨迹点选择工具">
              <span>已选 {selectedCameraKeyframeIds.length} 个点</span>
              <small>点下面的数字，可选 1、3、6</small>
              <button
                type="button"
                aria-label="全选所有轨迹点"
                onClick={() => setCameraMotionKeyframeSelection(motionPath.keyframes.map((item) => item.id))}
              >全选</button>
              <button
                type="button"
                aria-label="清空轨迹点选择"
                onClick={() => setCameraMotionKeyframeSelection([])}
              >清空</button>
            </div>
          ) : null}

          {motionPath.keyframes.length === 0 ? (
            <div className="motion-route-empty" role="status">
              <Route aria-hidden="true" size={20} />
              <span>还没有轨迹点</span>
              <small>点“开始掌镜”，走到合适的位置按 Enter。</small>
            </div>
          ) : (
            <div className="motion-waypoint-strip" role="list" aria-label="可编辑轨迹点">
              {motionPath.keyframes.map((keyframe, index) => {
                const selected = selectedKeyframe?.id === keyframe.id;
                const reached = timelinePreviewActive && index <= activeIndex;
                const approaching = timelinePreviewActive && index === activeIndex + 1;
                const trackedObjectName = keyframe.targetMode === "object"
                  ? sceneObjects.find((object) => object.id === keyframe.targetObjectId)?.name ?? null
                  : null;
                return (
                  <div className="motion-waypoint-wrap" key={keyframe.id} role="listitem">
                    {index > 0 ? (
                      <span className="motion-waypoint-link-wrap">
                        <span className={`motion-waypoint-link${timelinePreviewActive && index <= activeIndex ? " is-lit" : ""}`} />
                        <button
                          type="button"
                          className="motion-waypoint-insert"
                          aria-label={`在轨迹点 ${index} 和 ${index + 1} 之间插入轨迹点`}
                          title={`在 ${index} 和 ${index + 1} 中间插入`}
                          onClick={() => {
                            setBatchSelectionEnabled(false);
                            insertCameraMotionKeyframeAfter(activeCamera.id, motionPath.keyframes[index - 1].id);
                          }}
                        >
                          <Plus aria-hidden="true" size={11} />
                        </button>
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className={`motion-waypoint${(batchSelectionEnabled ? selectedCameraKeyframeIds.includes(keyframe.id) : selected) ? " is-selected" : ""}${reached ? " is-reached" : ""}${approaching ? " is-approaching" : ""}${trackedObjectName ? " has-tracking" : ""}`}
                      aria-label={batchSelectionEnabled ? `批量选择轨迹点 ${index + 1}` : `选择轨迹点 ${index + 1}`}
                      aria-pressed={batchSelectionEnabled ? selectedCameraKeyframeIds.includes(keyframe.id) : selected}
                      title={trackedObjectName ? `轨迹点 ${index + 1} · 跟踪 ${trackedObjectName}` : `轨迹点 ${index + 1} · 固定朝向`}
                      onClick={() => selectWaypoint(keyframe.id, activeTimingPlan?.arrivals[index] ?? keyframe.time)}
                    >
                      <span>{index + 1}</span>
                      <small>{((activeTimingPlan?.arrivals[index] ?? keyframe.time) * motionPath.duration).toFixed(1)}s{trackedObjectName ? " · 跟" : ""}</small>
                    </button>
                  </div>
                );
              })}
              <button type="button" className="motion-waypoint-add" aria-label="添加当前视角为轨迹点" onClick={addCurrentView}>
                <Plus aria-hidden="true" size={16} />
              </button>
            </div>
          )}

          {selectedKeyframe && !batchSelectionEnabled ? (
            <div className="motion-selected-actions" aria-label="当前轨迹点操作">
              <span>轨迹点 {motionPath.keyframes.indexOf(selectedKeyframe) + 1}</span>
              {motionPath.keyframes.indexOf(selectedKeyframe) > 0 && motionPath.keyframes.indexOf(selectedKeyframe) < motionPath.keyframes.length - 1 ? (
                <label className="motion-waypoint-arrival">
                  到达
                  <input
                    aria-label="当前轨迹点到达时间"
                    type="number"
                    min={(
                      motionPath.keyframes[motionPath.keyframes.indexOf(selectedKeyframe) - 1].time * motionPath.duration
                      + (motionPath.keyframes[motionPath.keyframes.indexOf(selectedKeyframe) - 1].pointBehavior === "hold"
                        ? motionPath.keyframes[motionPath.keyframes.indexOf(selectedKeyframe) - 1].holdSeconds ?? 0
                        : 0)
                      + 0.1
                    ).toFixed(1)}
                    max={(motionPath.keyframes[motionPath.keyframes.indexOf(selectedKeyframe) + 1].time * motionPath.duration - 0.1).toFixed(1)}
                    step="0.1"
                    value={arrivalTimeDraft}
                    disabled={motionPath.speedMode !== "custom"}
                    onChange={(event) => setArrivalTimeDraft(event.currentTarget.value)}
                    onBlur={commitArrivalTimeDraft}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                  />秒{motionPath.speedMode !== "custom" ? <small>自动</small> : null}
                </label>
              ) : null}
              <button type="button" onClick={editSelectedWaypoint}><MousePointer2 aria-hidden="true" size={13} />进入此点调整</button>
              <button
                type="button"
                aria-label="轨迹点前移"
                disabled={motionPath.keyframes.indexOf(selectedKeyframe) === 0}
                onClick={() => moveCameraMotionKeyframe(activeCamera.id, selectedKeyframe.id, -1)}
              ><ChevronUp aria-hidden="true" size={14} /></button>
              <button
                type="button"
                aria-label="轨迹点后移"
                disabled={motionPath.keyframes.indexOf(selectedKeyframe) === motionPath.keyframes.length - 1}
                onClick={() => moveCameraMotionKeyframe(activeCamera.id, selectedKeyframe.id, 1)}
              ><ChevronDown aria-hidden="true" size={14} /></button>
              <button type="button" className="is-danger" aria-label="删除当前轨迹点" onClick={() => deleteCameraMotionKeyframe(activeCamera.id, selectedKeyframe.id)}>
                <Trash2 aria-hidden="true" size={14} />
              </button>
            </div>
          ) : batchSelectionEnabled ? (
            <div className="motion-batch-move-hint" role="status">
              <Move3D aria-hidden="true" size={14} />
              {selectedCameraKeyframeIds.length > 0
                ? "在画面里拖动 XYZ 箭头，所选轨迹点会一起移动"
                : "请先点选要一起移动的轨迹点"}
            </div>
          ) : null}
        </div>

        <div className="motion-settings-column">
          <div className="motion-block-heading">
            <strong>运镜细节</strong>
            <small>速度、平滑和主体锁定</small>
          </div>
          <label className="motion-setting-row motion-preset-row">
            <span><SlidersHorizontal aria-hidden="true" size={14} />速度与节奏</span>
            <select
              className="motion-tracking-select"
              aria-label="运镜参数预设"
              value={matchingPreset?.id ?? "custom"}
              onChange={(event) => applyMotionPreset(event.currentTarget.value)}
            >
              <option value="custom" disabled>自定义</option>
              {CAMERA_MOTION_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>{preset.label}</option>
              ))}
            </select>
            <small className="motion-tracking-status">
              {matchingPreset?.description ?? "选择预设不会改变已经摆好的轨迹点"}
            </small>
          </label>
          <label className="motion-setting-row">
            <span><Gauge aria-hidden="true" size={14} />整段时长</span>
            <input
              aria-label="整段运镜时长"
              type="range"
              min="0.5"
              max="30"
              step="0.5"
              value={motionPath.duration}
              onPointerDown={beginUndoBatch}
              onPointerUp={endUndoBatch}
              onPointerCancel={endUndoBatch}
              onBlur={endUndoBatch}
              onChange={(event) => updateCameraMotionPath(activeCamera.id, { duration: Number(event.currentTarget.value) })}
            />
            <output>{motionPath.duration.toFixed(1)}s</output>
          </label>
          <div className="motion-setting-row">
            <span><SlidersHorizontal aria-hidden="true" size={14} />轨迹形状</span>
            <div className="motion-mini-segmented" role="group" aria-label="轨迹形状">
              <button type="button" aria-pressed={motionPath.interpolation === "smooth"} onClick={() => updateCameraMotionPath(activeCamera.id, { interpolation: "smooth" })}>平滑</button>
              <button type="button" aria-pressed={motionPath.interpolation === "linear"} onClick={() => updateCameraMotionPath(activeCamera.id, { interpolation: "linear" })}>折线</button>
            </div>
          </div>
          <div className="motion-setting-row">
            <span><ArrowUp aria-hidden="true" size={14} /><ArrowDown aria-hidden="true" size={14} />速度曲线</span>
            <div className="motion-mini-segmented" role="group" aria-label="速度曲线">
              <button type="button" aria-pressed={(motionPath.speedMode ?? (motionPath.easing === "linear" ? "uniform" : "soft")) === "uniform"} onClick={() => setCameraSpeedMode("uniform")}>匀速</button>
              <button type="button" aria-pressed={(motionPath.speedMode ?? (motionPath.easing === "linear" ? "uniform" : "soft")) === "soft"} onClick={() => setCameraSpeedMode("soft")}>柔和</button>
              <button type="button" aria-pressed={motionPath.speedMode === "custom"} onClick={() => setCameraSpeedMode("custom")}>自定义</button>
            </div>
          </div>
          {motionPath.speedMode === "custom" ? (
            <RouteCustomEasingControl
              curve={motionPath.customEasing}
              label="镜头段内节奏"
              onChange={(customEasing) => updateCameraMotionPath(activeCamera.id, { customEasing })}
            />
          ) : null}
          <div className="motion-setting-row">
            <span><LocateFixed aria-hidden="true" size={14} />全线防抖</span>
            <div className="motion-mini-segmented" role="group" aria-label="整条镜头路线防抖">
              <button
                type="button"
                disabled={motionPath.keyframes.length === 0}
                aria-pressed={motionPath.keyframes.length > 0 && stabilizedWaypointCount === 0}
                onClick={() => setAllTrackingStabilization(false)}
              >全部关闭</button>
              <button
                type="button"
                disabled={motionPath.keyframes.length === 0}
                aria-pressed={allWaypointsStabilized}
                onClick={() => setAllTrackingStabilization(true)}
              >全部开启</button>
            </div>
            <small className="motion-tracking-status">
              {motionPath.keyframes.length === 0
                ? "生成轨迹后可一键设置全部点"
                : `已开启 ${stabilizedWaypointCount} / ${motionPath.keyframes.length} 个点，仍可在下方单独修改`}
            </small>
          </div>
          <div className="motion-setting-row">
            <span><LocateFixed aria-hidden="true" size={14} />此点行为</span>
            <div className="motion-mini-segmented" role="group" aria-label="轨迹点行为">
              <button
                type="button"
                disabled={!selectedKeyframe}
                aria-pressed={(selectedKeyframe?.pointBehavior ?? "pass") === "pass"}
                onClick={() => selectedKeyframe && updateCameraMotionKeyframe(activeCamera.id, selectedKeyframe.id, { pointBehavior: "pass", holdSeconds: 0 })}
              >经过</button>
              <button
                type="button"
                disabled={!selectedKeyframe || motionPath.keyframes.indexOf(selectedKeyframe) === motionPath.keyframes.length - 1}
                aria-pressed={selectedKeyframe?.pointBehavior === "hold"}
                onClick={() => selectedKeyframe && updateCameraMotionKeyframe(activeCamera.id, selectedKeyframe.id, { pointBehavior: "hold", holdSeconds: selectedKeyframe.holdSeconds || 1 })}
              >停留</button>
            </div>
            <small className="motion-tracking-status">
              {!selectedKeyframe ? "先选择一个轨迹点" : selectedKeyframe.pointBehavior === "hold" ? "镜头到这里后暂停" : "镜头连续通过，不会自动刹停"}
            </small>
          </div>
          {selectedKeyframe?.pointBehavior === "hold" ? (
            <label className="motion-setting-row">
              <span><Pause aria-hidden="true" size={14} />停留时长</span>
              <input
                aria-label="轨迹点停留时长"
                type="range"
                min="0.1"
                max={motionPath.duration}
                step="0.1"
                value={selectedKeyframe.holdSeconds ?? 1}
                onPointerDown={beginUndoBatch}
                onPointerUp={endUndoBatch}
                onPointerCancel={endUndoBatch}
                onBlur={endUndoBatch}
                onChange={(event) => updateCameraMotionKeyframe(activeCamera.id, selectedKeyframe.id, { holdSeconds: Number(event.currentTarget.value) })}
              />
              <output>{(selectedKeyframe.holdSeconds ?? 1).toFixed(1)}s</output>
            </label>
          ) : null}
          <div className="motion-setting-row">
            <span><MousePointer2 aria-hidden="true" size={14} />此点跟踪</span>
            <select
              className="motion-tracking-select"
              aria-label="轨迹点跟踪主体"
              value={trackingObjectId}
              disabled={!selectedKeyframe}
              onChange={(event) => setTrackingObject(event.currentTarget.value)}
            >
              <option value="">不跟踪（固定朝向）</option>
              {trackableObjects.map((object) => (
                <option key={object.id} value={object.id}>{object.name}</option>
              ))}
            </select>
            <small className="motion-tracking-status">
              {!selectedKeyframe
                ? "先在上方选择一个轨迹点"
                : trackingObjectId
                  ? "这个点会实时看向所选主体"
                  : "这个点使用自己保存的固定朝向"}
            </small>
          </div>
          {trackingObject?.kind === "character" ? (
            <label className="motion-setting-row">
              <span><LocateFixed aria-hidden="true" size={14} />跟踪部位</span>
              <select
                className="motion-tracking-select"
                aria-label="轨迹点跟踪身体部位"
                value={trackingBodyPart}
                onChange={(event) => setTrackingBodyPart(event.currentTarget.value as DirectorCameraTargetBodyPart)}
              >
                {DIRECTOR_CAMERA_TARGET_BODY_PART_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <small className="motion-tracking-status">读取当前动作执行后的真实骨骼位置</small>
            </label>
          ) : trackingObject ? (
            <div className="motion-setting-row">
              <span><LocateFixed aria-hidden="true" size={14} />跟踪部位</span>
              <strong>物体中心</strong>
              <small className="motion-tracking-status">普通物体会跟踪整体中心</small>
            </div>
          ) : null}
          {trackingObject ? (
            <div className="motion-setting-row">
              <span><Gauge aria-hidden="true" size={14} />响应速度</span>
              <div className="motion-mini-segmented" role="group" aria-label="轨迹点跟随响应速度">
                <button
                  type="button"
                  aria-pressed={trackingFollowMode === "immediate"}
                  onClick={() => setTrackingFollowMode("immediate")}
                >立即</button>
                <button
                  type="button"
                  aria-pressed={trackingFollowMode === "smooth"}
                  onClick={() => setTrackingFollowMode("smooth")}
                >柔和</button>
              </div>
              <small className="motion-tracking-status">
                {trackingFollowMode === "smooth" ? "柔和追上目标，镜头转向更舒缓" : "立即看向目标，响应最快"}
              </small>
            </div>
          ) : null}
          {trackingObject?.kind === "character" ? (
            <div className="motion-setting-row">
              <span><LocateFixed aria-hidden="true" size={14} />镜头防抖</span>
              <div className="motion-mini-segmented" role="group" aria-label="镜头跟踪抖动">
                <button
                  type="button"
                  aria-pressed={!trackingStabilizationEnabled}
                  onClick={() => setTrackingStabilization(false)}
                >保留抖动</button>
                <button
                  type="button"
                  aria-pressed={trackingStabilizationEnabled}
                  onClick={() => setTrackingStabilization(true)}
                >开启防抖</button>
              </div>
              <small className="motion-tracking-status">
                {trackingStabilizationEnabled ? "过滤走路和肢体动作造成的细碎晃动" : "保留身体部位的真实运动感"}
              </small>
            </div>
          ) : null}
          <div className="motion-setting-row">
            <span><MousePointer2 aria-hidden="true" size={14} />掌镜锁定</span>
            <div className="motion-mini-segmented" role="group" aria-label="主体锁定方式">
              <button
                type="button"
                aria-label="锁定后只保持看向主体"
                aria-pressed={!cameraPilotFollowTarget}
                onClick={() => setCameraPilotFollowTarget(false)}
              >只看向</button>
              <button
                type="button"
                aria-label="锁定后跟随主体移动"
                aria-pressed={cameraPilotFollowTarget}
                onClick={() => setCameraPilotFollowTarget(true)}
              >跟随移动</button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
