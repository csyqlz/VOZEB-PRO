import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { LocateFixed, MapPinPlus, Plus, Trash2, Upload } from "lucide-react";
import {
  InspectorAxisGroup,
  InspectorColorField,
  InspectorPanel,
  InspectorRangeNumberField,
  InspectorTextField,
  InspectorSection,
} from "./InspectorControls";
import { MANNEQUIN_POSE_PRESETS } from "../presets/mannequinPosePresets";
import { CHARACTER_ACTION_PRESETS } from "../presets/characterActionPresets";
import { getCameraMotionPath } from "../schema/cameraMotion";
import { getObjectMotionTimingPlan, normalizeObjectMotionPath } from "../schema/objectMotion";
import { getCrowdAnchorTransform, useDirectorStore } from "../store/directorStore";
import { inspectCharacterAnimationFile } from "../loaders/characterAnimationInspection";
import { readLocalModelFile } from "../loaders/localModelImport";
import { createImportedCharacterActionId } from "../schema/importedCharacterAction";
import type { CharacterRigProfile } from "../schema/directorProject";
import { isCompleteDirectorCharacterBoneMap } from "../schema/semanticBody";
import { RouteCustomEasingControl } from "../motion/RouteCustomEasingControl";
import {
  areAnimationProfilesCompatible,
  isNativeAnimationForCharacter,
  normalizeAnimationRigProfile,
} from "./characterAnimationCompatibility";

export { areAnimationProfilesCompatible, isNativeAnimationForCharacter } from "./characterAnimationCompatibility";

function replaceAxis(tuple: [number, number, number], axis: 0 | 1 | 2, value: number): [number, number, number] {
  return tuple.map((item, index) => (index === axis ? value : item)) as [number, number, number];
}

export function CharacterPanel() {
  const animationInputRef = useRef<HTMLInputElement | null>(null);
  const [activeTab, setActiveTab] = useState<"properties" | "pose" | "action" | "route">("properties");
  const [animationImportStatus, setAnimationImportStatus] = useState<string | null>(null);
  const [animationImportBusy, setAnimationImportBusy] = useState(false);
  const selectedCrowdId = useDirectorStore((state) => state.selectedCrowdId);
  const selectedObjectId = useDirectorStore((state) => state.selectedObjectId);
  const objects = useDirectorStore((state) => state.project.objects);
  const assets = useDirectorStore((state) => state.project.assets);
  const cameras = useDirectorStore((state) => state.project.cameras);
  const animationAssets = useDirectorStore((state) => state.project.animationAssets ?? []);
  const activeCameraId = useDirectorStore((state) => state.project.activeCameraId);
  const cameraMotionProgress = useDirectorStore((state) => state.cameraMotionProgress);
  const updateObjectName = useDirectorStore((state) => state.updateObjectName);
  const updateCrowdLabel = useDirectorStore((state) => state.updateCrowdLabel);
  const updateObjectTransform = useDirectorStore((state) => state.updateObjectTransform);
  const updateCrowdTransform = useDirectorStore((state) => state.updateCrowdTransform);
  const updateUniformScale = useDirectorStore((state) => state.updateUniformScale);
  const updateCrowdUniformScale = useDirectorStore((state) => state.updateCrowdUniformScale);
  const updateObjectColor = useDirectorStore((state) => state.updateObjectColor);
  const updateCrowdColor = useDirectorStore((state) => state.updateCrowdColor);
  const applyPosePreset = useDirectorStore((state) => state.applyPosePreset);
  const applyCrowdPosePreset = useDirectorStore((state) => state.applyCrowdPosePreset);
  const updatePoseControl = useDirectorStore((state) => state.updatePoseControl);
  const updateCrowdPoseControl = useDirectorStore((state) => state.updateCrowdPoseControl);
  const applyCharacterActionPreset = useDirectorStore((state) => state.applyCharacterActionPreset);
  const applyCrowdActionPreset = useDirectorStore((state) => state.applyCrowdActionPreset);
  const addImportedAnimationAsset = useDirectorStore((state) => state.addImportedAnimationAsset);
  const removeImportedAnimationAsset = useDirectorStore((state) => state.removeImportedAnimationAsset);
  const setCameraMotionProgress = useDirectorStore((state) => state.setCameraMotionProgress);
  const setCameraMotionPlaying = useDirectorStore((state) => state.setCameraMotionPlaying);
  const restartCameraMotionPlayback = useDirectorStore((state) => state.restartCameraMotionPlayback);
  const addCharacterRoutePoint = useDirectorStore((state) => state.addCharacterRoutePoint);
  const insertObjectMotionKeyframeAfter = useDirectorStore((state) => state.insertObjectMotionKeyframeAfter);
  const deleteObjectMotionKeyframe = useDirectorStore((state) => state.deleteObjectMotionKeyframe);
  const selectedObjectMotionKeyframeId = useDirectorStore((state) => state.selectedObjectMotionKeyframeId);
  const selectObjectMotionKeyframe = useDirectorStore((state) => state.selectObjectMotionKeyframe);
  const updateObjectMotionKeyframe = useDirectorStore((state) => state.updateObjectMotionKeyframe);
  const updateObjectMotionPath = useDirectorStore((state) => state.updateObjectMotionPath);

  const selection = useMemo(() => {
    const role = objects.find((item) => item.id === selectedObjectId && item.kind === "character");

    if (selectedCrowdId) {
      const crowdMembers = objects.filter((item) => item.kind === "character" && item.crowdId === selectedCrowdId);
      const crowdAnchor = getCrowdAnchorTransform(objects, selectedCrowdId);

      if (crowdMembers.length && crowdAnchor) {
        return {
          mode: "crowd" as const,
          crowdId: selectedCrowdId,
          crowdMembers,
          crowdAnchor,
          role: crowdMembers[crowdMembers.length - 1] ?? crowdMembers[0],
          name: crowdMembers[0]?.crowdLabel ?? "群众",
          color: crowdMembers[0]?.color ?? "#4F8EF7",
        };
      }
    }

    if (!role) return null;

    return {
      mode: "single" as const,
      crowdId: null,
      crowdMembers: [role],
      crowdAnchor: role.transform,
      role,
      name: role.name,
      color: role.color ?? "#4F8EF7",
    };
  }, [objects, selectedCrowdId, selectedObjectId]);

  if (!selection) return null;

  const role = selection.role;
  const roleAsset = assets.find((asset) => asset.id === role.assetRefId);
  const roleRigProfile: CharacterRigProfile = roleAsset?.characterRigProfile
    ?? (role.characterRig?.rigType === "mixamo" ? "mixamo" : role.characterRig?.rigType === "ue4-mannequin" ? "bip" : "unknown");
  const roleImportReadiness = roleAsset?.characterImportReadiness ?? "ready";
  const allowsHumanoidActions = roleImportReadiness === "ready";
  const roleHasCompleteBoneMap = isCompleteDirectorCharacterBoneMap(roleAsset?.characterBoneMap);
  const compatibleAnimationAssets = animationAssets.filter((animationAsset) =>
    isNativeAnimationForCharacter(animationAsset, roleAsset)
      || (allowsHumanoidActions && areAnimationProfilesCompatible(roleRigProfile, animationAsset.rigProfile, roleHasCompleteBoneMap))
  );
  const importedActionOptions = compatibleAnimationAssets.flatMap((animationAsset) =>
    animationAsset.clips.map((clip) => ({
      id: createImportedCharacterActionId(animationAsset.id, clip.id),
      label: `${animationAsset.name} · ${clip.name}`,
      displayLabel: clip.name,
      duration: clip.duration,
      asset: animationAsset,
    }))
  );

  async function handleAnimationImport(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setAnimationImportBusy(true);
    setAnimationImportStatus("正在检查动作文件...");

    try {
      const report = await inspectCharacterAnimationFile(file);
      const validClips = report.clips.filter((clip) => clip.duration > 0.05 && clip.trackCount > 0);
      if (!validClips.length) throw new Error(report.warnings[0] ?? "没有检测到可播放动作");
      const stored = await readLocalModelFile(file);
      const rigProfile = normalizeAnimationRigProfile(report.rigProfile);
      const animationAssetId = addImportedAnimationAsset({
        name: stored.name,
        fileName: stored.fileName,
        url: stored.url,
        modelFormat: report.format,
        storageKey: stored.storageKey,
        byteLength: stored.byteLength,
        rigProfile,
        clips: validClips.map((clip, index) => ({
          id: `clip_${index + 1}`,
          name: clip.name,
          duration: clip.duration,
          trackCount: clip.trackCount,
        })),
      });

      if (areAnimationProfilesCompatible(roleRigProfile, rigProfile, roleHasCompleteBoneMap)) {
        applyCharacterActionPreset(role.id, createImportedCharacterActionId(animationAssetId, "clip_1"));
        restartCameraMotionPlayback();
        setAnimationImportStatus(`已导入 ${validClips.length} 个动作，正在预览第一段`);
      } else {
        setAnimationImportStatus(`动作已保存，但与当前人物骨架不兼容（人物 ${roleRigProfile} / 动作 ${rigProfile}）`);
      }
    } catch (error) {
      setAnimationImportStatus(error instanceof Error ? error.message : "动作导入失败");
    } finally {
      setAnimationImportBusy(false);
      input.value = "";
    }
  }
  const roleColor = role.color ?? (roleAsset ? "#ffffff" : selection.color);
  const isRobotExpressive = /robot-expressive\.glb(?:$|[?#])/i.test(roleAsset?.url ?? "");
  const transform = selection.crowdAnchor;
  const isCrowd = selection.mode === "crowd";
  const routePath = normalizeObjectMotionPath(role.motionPath, role.transform);
  const selectedRoutePoint = routePath.keyframes.find((item) => item.id === selectedObjectMotionKeyframeId) ?? null;
  const activeCamera = cameras.find((item) => item.id === activeCameraId) ?? cameras[0];
  const timelineDuration = activeCamera ? getCameraMotionPath(activeCamera).duration : 6;
  const routeTimingPlan = getObjectMotionTimingPlan(role, timelineDuration);
  const selectedRoutePointIndex = selectedRoutePoint
    ? routePath.keyframes.indexOf(selectedRoutePoint)
    : -1;
  const selectedArrivalProgress = selectedRoutePointIndex >= 0
    ? routeTimingPlan?.arrivals[selectedRoutePointIndex] ?? selectedRoutePoint?.time ?? 0
    : 0;
  const selectedArrivalMinimum = selectedRoutePointIndex > 0
    ? routePath.keyframes[selectedRoutePointIndex - 1].time * timelineDuration
      + (routePath.keyframes[selectedRoutePointIndex - 1].pointBehavior === "hold"
        ? routePath.keyframes[selectedRoutePointIndex - 1].holdSeconds ?? 0
        : 0)
      + 0.1
    : 0;
  const selectedArrivalMaximum = selectedRoutePointIndex >= 0 && selectedRoutePointIndex < routePath.keyframes.length - 1
    ? routePath.keyframes[selectedRoutePointIndex + 1].time * timelineDuration - 0.1
    : timelineDuration;

  function setRouteSpeedMode(speedMode: "uniform" | "soft" | "custom") {
    const keyframes = speedMode === "custom" && routePath.speedMode !== "custom" && routeTimingPlan
      ? routePath.keyframes.map((keyframe, index) => ({
          ...keyframe,
          time: routeTimingPlan.arrivals[index] ?? keyframe.time,
        }))
      : routePath.keyframes;
    updateObjectMotionPath(role.id, {
      speedMode,
      ...(speedMode === "custom" ? { customEasing: [0, 0, 1, 1], keyframes } : {}),
    });
  }
  const poseGroups = [
    {
      title: "身体",
      controls: [
        { key: "body.pitch", label: "前倾" },
        { key: "body.yaw", label: "转身" },
        { key: "body.roll", label: "侧倾" },
      ],
    },
    {
      title: "躯干",
      controls: [
        { key: "torso.pitch", label: "前倾" },
        { key: "torso.yaw", label: "扭转" },
        { key: "torso.roll", label: "侧倾" },
      ],
    },
    {
      title: "头部",
      controls: [
        { key: "head.pitch", label: "点头" },
        { key: "head.yaw", label: "转头" },
        { key: "head.roll", label: "歪头" },
      ],
    },
    {
      title: "左肩",
      controls: [
        { key: "leftShoulder.pitch", label: "前举" },
        { key: "leftShoulder.spread", label: "外展" },
        { key: "leftShoulder.twist", label: "扭转" },
      ],
    },
    {
      title: "右肩",
      controls: [
        { key: "rightShoulder.pitch", label: "前举" },
        { key: "rightShoulder.spread", label: "外展" },
        { key: "rightShoulder.twist", label: "扭转" },
      ],
    },
    {
      title: "左肘",
      controls: [{ key: "leftElbow.bend", label: "弯曲" }],
    },
    {
      title: "右肘",
      controls: [{ key: "rightElbow.bend", label: "弯曲" }],
    },
    {
      title: "左髋",
      controls: [
        { key: "leftHip.pitch", label: "前抬" },
        { key: "leftHip.spread", label: "外展" },
        { key: "leftHip.twist", label: "扭转" },
      ],
    },
    {
      title: "右髋",
      controls: [
        { key: "rightHip.pitch", label: "前抬" },
        { key: "rightHip.spread", label: "外展" },
        { key: "rightHip.twist", label: "扭转" },
      ],
    },
    {
      title: "左膝",
      controls: [{ key: "leftKnee.bend", label: "弯曲" }],
    },
    {
      title: "右膝",
      controls: [{ key: "rightKnee.bend", label: "弯曲" }],
    },
  ] as const;

  return (
    <InspectorPanel
      title="角色"
      ariaLabel="角色右侧属性面板"
      className="character-inspector"
      tabs={[
        { label: "属性", active: activeTab === "properties", onClick: () => setActiveTab("properties") },
        { label: "姿势", active: activeTab === "pose", onClick: () => setActiveTab("pose") },
        { label: "动作", active: activeTab === "action", onClick: () => setActiveTab("action") },
        { label: "路线", active: activeTab === "route", onClick: () => setActiveTab("route") },
      ]}
    >
      {activeTab === "properties" ? (
        <>
          <InspectorTextField
            label="名称"
            ariaLabel="角色名称"
            value={selection.name}
            onChange={(value) => {
              if (isCrowd && selection.crowdId) {
                updateCrowdLabel(selection.crowdId, value);
                return;
              }

              updateObjectName(role.id, value);
            }}
          />
          <InspectorAxisGroup
            label="位置"
            axes={[
              {
                axis: "X",
                ariaLabel: "角色位置 X",
                value: transform.position[0],
                onChange: (value) =>
                  isCrowd && selection.crowdId
                    ? updateCrowdTransform(selection.crowdId, {
                        position: replaceAxis(transform.position, 0, Number(value)),
                      })
                    : updateObjectTransform(role.id, {
                        position: replaceAxis(transform.position, 0, Number(value)),
                      }),
              },
              {
                axis: "Y",
                ariaLabel: "角色位置 Y",
                value: transform.position[1],
                onChange: (value) =>
                  isCrowd && selection.crowdId
                    ? updateCrowdTransform(selection.crowdId, {
                        position: replaceAxis(transform.position, 1, Number(value)),
                      })
                    : updateObjectTransform(role.id, {
                        position: replaceAxis(transform.position, 1, Number(value)),
                      }),
              },
              {
                axis: "Z",
                ariaLabel: "角色位置 Z",
                value: transform.position[2],
                onChange: (value) =>
                  isCrowd && selection.crowdId
                    ? updateCrowdTransform(selection.crowdId, {
                        position: replaceAxis(transform.position, 2, Number(value)),
                      })
                    : updateObjectTransform(role.id, {
                        position: replaceAxis(transform.position, 2, Number(value)),
                      }),
              },
            ]}
          />
          <InspectorAxisGroup
            label="旋转"
            axes={[
              {
                axis: "X",
                ariaLabel: "角色旋转 X",
                value: transform.rotation[0],
                onChange: (value) =>
                  isCrowd && selection.crowdId
                    ? updateCrowdTransform(selection.crowdId, {
                        rotation: replaceAxis(transform.rotation, 0, Number(value)),
                      })
                    : updateObjectTransform(role.id, {
                        rotation: replaceAxis(transform.rotation, 0, Number(value)),
                      }),
              },
              {
                axis: "Y",
                ariaLabel: "角色旋转 Y",
                value: transform.rotation[1],
                onChange: (value) =>
                  isCrowd && selection.crowdId
                    ? updateCrowdTransform(selection.crowdId, {
                        rotation: replaceAxis(transform.rotation, 1, Number(value)),
                      })
                    : updateObjectTransform(role.id, {
                        rotation: replaceAxis(transform.rotation, 1, Number(value)),
                      }),
              },
              {
                axis: "Z",
                ariaLabel: "角色旋转 Z",
                value: transform.rotation[2],
                onChange: (value) =>
                  isCrowd && selection.crowdId
                    ? updateCrowdTransform(selection.crowdId, {
                        rotation: replaceAxis(transform.rotation, 2, Number(value)),
                      })
                    : updateObjectTransform(role.id, {
                        rotation: replaceAxis(transform.rotation, 2, Number(value)),
                      }),
              },
            ]}
          />
          <InspectorAxisGroup
            label="缩放"
            axes={[
              {
                axis: "X",
                ariaLabel: "角色缩放 X",
                step: "0.01",
                value: transform.scale[0],
                onChange: (value) =>
                  isCrowd && selection.crowdId
                    ? updateCrowdTransform(selection.crowdId, {
                        scale: replaceAxis(transform.scale, 0, Number(value)),
                      })
                    : updateObjectTransform(role.id, {
                        scale: replaceAxis(transform.scale, 0, Number(value)),
                      }),
              },
              {
                axis: "Y",
                ariaLabel: "角色缩放 Y",
                step: "0.01",
                value: transform.scale[1],
                onChange: (value) =>
                  isCrowd && selection.crowdId
                    ? updateCrowdTransform(selection.crowdId, {
                        scale: replaceAxis(transform.scale, 1, Number(value)),
                      })
                    : updateObjectTransform(role.id, {
                        scale: replaceAxis(transform.scale, 1, Number(value)),
                      }),
              },
              {
                axis: "Z",
                ariaLabel: "角色缩放 Z",
                step: "0.01",
                value: transform.scale[2],
                onChange: (value) =>
                  isCrowd && selection.crowdId
                    ? updateCrowdTransform(selection.crowdId, {
                        scale: replaceAxis(transform.scale, 2, Number(value)),
                      })
                    : updateObjectTransform(role.id, {
                        scale: replaceAxis(transform.scale, 2, Number(value)),
                      }),
              },
            ]}
          />
          <InspectorRangeNumberField
            label="统一缩放"
            rangeAriaLabel="角色统一缩放滑杆"
            numberAriaLabel="角色统一缩放"
            max="3"
            min="0.2"
            step="0.01"
            value={transform.scale[0]}
            onValueChange={(value) =>
              isCrowd && selection.crowdId
                ? updateCrowdUniformScale(selection.crowdId, Number(value))
                : updateUniformScale(role.id, Number(value))
            }
          />
          <InspectorColorField
            label="颜色"
            colorAriaLabel="角色颜色"
            hexAriaLabel="角色颜色 HEX"
            value={roleColor}
            onColorChange={(value) =>
              isCrowd && selection.crowdId ? updateCrowdColor(selection.crowdId, value) : updateObjectColor(role.id, value)
            }
            onHexChange={(value) =>
              isCrowd && selection.crowdId ? updateCrowdColor(selection.crowdId, value) : updateObjectColor(role.id, value)
            }
          />
        </>
      ) : activeTab === "pose" ? (
        <InspectorSection title="姿势预设" className="pose-preset-section">
          {role.characterRig && allowsHumanoidActions ? (
            <>
              <div className="preset-grid">
                {MANNEQUIN_POSE_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    className={role.characterRig?.posePresetId === preset.id ? "is-active" : undefined}
                    type="button"
                    onClick={() =>
                      isCrowd && selection.crowdId
                        ? applyCrowdPosePreset(selection.crowdId, preset.id)
                        : applyPosePreset(role.id, preset.id)
                    }
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <InspectorSection title="姿势调节" className="pose-adjust-section">
                <div className="pose-groups">
                  {poseGroups.map((group) => (
                    <section key={group.title} className="pose-group">
                      <h4>{group.title}</h4>
                      {group.controls.map((control) => (
                        <InspectorRangeNumberField
                          key={control.key}
                          label={control.label}
                          rangeAriaLabel={`${group.title} · ${control.label} 滑杆`}
                          numberAriaLabel={`${group.title} · ${control.label}`}
                          max="90"
                          min="-90"
                          step="1"
                          value={role.characterRig?.controls[control.key] ?? 0}
                          onValueChange={(value) =>
                            isCrowd && selection.crowdId
                              ? updateCrowdPoseControl(selection.crowdId, control.key, Number(value))
                              : updatePoseControl(role.id, control.key, Number(value))
                          }
                        />
                      ))}
                    </section>
                  ))}
                </div>
              </InspectorSection>
            </>
          ) : (
            <p className="character-action-compatibility" role="status">该模型尚未完成标准人形骨骼映射，暂不支持人形姿势编辑。</p>
          )}
        </InspectorSection>
      ) : activeTab === "action" ? (
        <InspectorSection title="动作预设" className="pose-preset-section">
          {!allowsHumanoidActions ? (
            <p className="character-action-compatibility" role="status">
              {roleImportReadiness === "native-only"
                ? "这个模型只保证播放自带动作，暂不套用人形走路、跑步等预设。"
                : roleImportReadiness === "manual-mapping"
                  ? "这个模型需要补全骨骼映射后，才能安全使用人形动作预设。"
                  : "这个模型只能静态使用。"}
            </p>
          ) : null}
          <div className="preset-grid">
            <button
              className={!role.characterRig?.actionPresetId ? "is-active" : undefined}
              type="button"
              onClick={() => {
                if (isCrowd && selection.crowdId) applyCrowdActionPreset(selection.crowdId, null);
                else applyCharacterActionPreset(role.id, null);
                setCameraMotionPlaying(false);
              }}
            >
              无动作
            </button>
            {allowsHumanoidActions ? CHARACTER_ACTION_PRESETS.map((preset) => (
              <button
                key={preset.id}
                className={role.characterRig?.actionPresetId === preset.id ? "is-active" : undefined}
                type="button"
                aria-label={`播放动作 ${preset.label}`}
                onClick={() => {
                  if (isCrowd && selection.crowdId) applyCrowdActionPreset(selection.crowdId, preset.id);
                  else applyCharacterActionPreset(role.id, preset.id);
                  restartCameraMotionPlayback();
                }}
              >
                <span>{preset.label}</span>
                  <small>{(
                  isRobotExpressive
                    ? preset.robotExpressiveDuration ?? preset.duration
                    : role.characterRig?.rigType === "mixamo"
                    ? preset.mixamoDuration ?? preset.duration
                    : preset.duration
                ).toFixed(2)} 秒</small>
              </button>
            )) : null}
            {!isCrowd ? importedActionOptions.map((action) => (
              <button
                key={action.id}
                className={`imported-action-preset${role.characterRig?.actionPresetId === action.id ? " is-active" : ""}`}
                type="button"
                aria-label={`播放导入动作 ${action.label}`}
                onClick={() => {
                  applyCharacterActionPreset(role.id, action.id);
                  restartCameraMotionPlayback();
                }}
              >
                <span>{action.displayLabel}</span>
                <small>{action.duration.toFixed(2)} 秒</small>
              </button>
            )) : null}
          </div>
          {!isCrowd ? (
            <div className="imported-action-section">
              <div className="imported-action-header">
                <div>
                  <strong>我的动作</strong>
                  <span>{animationAssets.length ? `${compatibleAnimationAssets.length}/${animationAssets.length} 个文件兼容` : "支持 FBX / GLB"}</span>
                </div>
                <button
                  className="imported-action-upload"
                  disabled={animationImportBusy || roleImportReadiness === "static-only"}
                  type="button"
                  onClick={() => animationInputRef.current?.click()}
                >
                  <Upload aria-hidden="true" size={14} />
                  {animationImportBusy ? "检查中" : "导入动作"}
                </button>
              </div>
              <input
                ref={animationInputRef}
                aria-label="选择人物动作文件"
                className="hidden-file-input"
                accept=".fbx,.glb"
                type="file"
                onChange={(event) => void handleAnimationImport(event)}
              />
              {animationImportStatus ? <p className="imported-action-status" role="status">{animationImportStatus}</p> : null}
              {animationAssets.length ? (
                <div className="imported-action-files">
                  {animationAssets.map((animationAsset) => {
                    const compatible = isNativeAnimationForCharacter(animationAsset, roleAsset)
                      || (allowsHumanoidActions && areAnimationProfilesCompatible(
                        roleRigProfile,
                        animationAsset.rigProfile,
                        roleHasCompleteBoneMap
                      ));
                    return (
                      <div key={animationAsset.id} className="imported-action-file">
                        <span>
                          <strong>{animationAsset.name}</strong>
                          <small>{compatible ? `${animationAsset.clips.length} 个动作` : `不兼容 · ${animationAsset.rigProfile}`}</small>
                        </span>
                        <button
                          aria-label={`删除动作文件 ${animationAsset.name}`}
                          type="button"
                          onClick={() => removeImportedAnimationAsset(animationAsset.id)}
                        >
                          <Trash2 aria-hidden="true" size={13} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : null}
        </InspectorSection>
      ) : (
        <InspectorSection title="人物路线" className="pose-preset-section">
          {isCrowd ? (
            <p>群众组暂不支持共用路线。请先选中单个人物。</p>
          ) : (
            <>
              <div className="character-route-toolbar" aria-label="路线编辑操作">
                <button
                  className="character-route-add"
                  type="button"
                  onClick={() => {
                    setCameraMotionPlaying(false);
                    const id = addCharacterRoutePoint(role.id);
                    if (id) selectObjectMotionKeyframe(id);
                  }}
                >
                  <MapPinPlus aria-hidden="true" size={14} />
                  添加点
                </button>
                <button
                  aria-label="预览当前路线点"
                  title="定位预览"
                  className="character-route-icon-button"
                  type="button"
                  disabled={!selectedRoutePoint}
                  onClick={() => {
                    if (selectedRoutePoint) setCameraMotionProgress(selectedArrivalProgress);
                  }}
                >
                  <LocateFixed aria-hidden="true" size={14} />
                </button>
                <button
                  aria-label="在当前路线点后插入"
                  title="在当前点后插入"
                  className="character-route-icon-button"
                  type="button"
                  disabled={!selectedRoutePoint || routePath.keyframes[routePath.keyframes.length - 1]?.id === selectedRoutePoint.id}
                  onClick={() => {
                    if (!selectedRoutePoint) return;
                    const id = insertObjectMotionKeyframeAfter(role.id, selectedRoutePoint.id);
                    if (id) selectObjectMotionKeyframe(id);
                  }}
                >
                  <Plus aria-hidden="true" size={15} />
                </button>
                <button
                  aria-label="删除当前路线点"
                  title="删除当前点"
                  className="character-route-icon-button is-danger"
                  type="button"
                  disabled={!selectedRoutePoint}
                  onClick={() => {
                    if (!selectedRoutePoint) return;
                    deleteObjectMotionKeyframe(role.id, selectedRoutePoint.id);
                    selectObjectMotionKeyframe(null);
                  }}
                >
                  <Trash2 aria-hidden="true" size={14} />
                </button>
              </div>
              <div className="character-route-shape" role="group" aria-label="路线形状">
                <span>形状</span>
                <button
                  type="button"
                  aria-pressed={routePath.interpolation === "smooth"}
                  onClick={() => updateObjectMotionPath(role.id, { interpolation: "smooth" })}
                >
                  平滑
                </button>
                <button
                  type="button"
                  aria-pressed={routePath.interpolation === "linear"}
                  onClick={() => updateObjectMotionPath(role.id, { interpolation: "linear" })}
                >
                  折线
                </button>
              </div>
              <div className="character-route-shape character-route-shape--speed" role="group" aria-label="路线速度">
                <span>速度</span>
                <button type="button" aria-pressed={routePath.speedMode === "uniform"} onClick={() => setRouteSpeedMode("uniform")}>匀速</button>
                <button type="button" aria-pressed={routePath.speedMode === "soft"} onClick={() => setRouteSpeedMode("soft")}>柔和</button>
                <button type="button" aria-pressed={(routePath.speedMode ?? "custom") === "custom"} onClick={() => setRouteSpeedMode("custom")}>自定义</button>
              </div>
              {routePath.speedMode === "custom" ? (
                <RouteCustomEasingControl
                  curve={routePath.customEasing}
                  label="人物段内节奏"
                  onChange={(customEasing) => updateObjectMotionPath(role.id, { customEasing })}
                />
              ) : null}
              <div className="character-route-points" role="group" aria-label="人物路线点列表">
                {routePath.keyframes.map((point, index) => (
                  <button
                    key={point.id}
                    className={point.id === selectedRoutePoint?.id ? "is-active" : undefined}
                    type="button"
                    aria-label={`选择路线点 ${index + 1}`}
                    aria-pressed={point.id === selectedRoutePoint?.id}
                    onClick={() => {
                      selectObjectMotionKeyframe(point.id);
                    }}
                  >
                    <strong>{index + 1}</strong>
                    <span>{((routeTimingPlan?.arrivals[index] ?? point.time) * timelineDuration).toFixed(1)} 秒</span>
                  </button>
                ))}
              </div>
              {selectedRoutePoint ? (
                <InspectorSection title={`路线点 ${routePath.keyframes.findIndex((point) => point.id === selectedRoutePoint.id) + 1}`} className="character-route-editor">
                  <InspectorRangeNumberField
                    label="到达时间"
                    rangeAriaLabel="路线点到达时间滑杆"
                    numberAriaLabel="路线点到达时间"
                    min={String(selectedArrivalMinimum)}
                    max={String(selectedArrivalMaximum)}
                    step="0.1"
                    disabled={routePath.speedMode !== "custom" || selectedRoutePointIndex <= 0 || selectedRoutePointIndex >= routePath.keyframes.length - 1}
                    value={Number((selectedArrivalProgress * timelineDuration).toFixed(1))}
                    onValueChange={(value) => updateObjectMotionKeyframe(role.id, selectedRoutePoint.id, {
                      time: Math.min(selectedArrivalMaximum, Math.max(selectedArrivalMinimum, Number(value))) / timelineDuration,
                    })}
                  />
                  <div className="inspector-field">
                    <span className="inspector-field-label">到点行为</span>
                    <div className="character-route-shape character-route-shape--compact" role="group" aria-label="人物路线点行为">
                      <button
                        type="button"
                        aria-pressed={(selectedRoutePoint.pointBehavior ?? "pass") === "pass"}
                        onClick={() => updateObjectMotionKeyframe(role.id, selectedRoutePoint.id, { pointBehavior: "pass", holdSeconds: 0 })}
                      >经过</button>
                      <button
                        type="button"
                        disabled={selectedRoutePointIndex === routePath.keyframes.length - 1}
                        aria-pressed={selectedRoutePoint.pointBehavior === "hold"}
                        onClick={() => updateObjectMotionKeyframe(role.id, selectedRoutePoint.id, {
                          pointBehavior: "hold",
                          holdSeconds: selectedRoutePoint.holdSeconds || 1,
                        })}
                      >停留</button>
                    </div>
                  </div>
                  {selectedRoutePoint.pointBehavior === "hold" ? (
                    <>
                      <InspectorRangeNumberField
                        label="停留时长"
                        rangeAriaLabel="路线点停留时长滑杆"
                        numberAriaLabel="路线点停留时长"
                        min="0.1"
                        max={String(timelineDuration)}
                        step="0.1"
                        value={selectedRoutePoint.holdSeconds ?? 1}
                        onValueChange={(value) => updateObjectMotionKeyframe(role.id, selectedRoutePoint.id, {
                          holdSeconds: Math.max(0.1, Number(value)),
                        })}
                      />
                      <label className="inspector-field">
                        <span className="inspector-field-label">停留动作</span>
                        <select
                          aria-label="路线点停留动作方式"
                          value={selectedRoutePoint.holdAction ?? "current"}
                          onChange={(event) => updateObjectMotionKeyframe(role.id, selectedRoutePoint.id, {
                            holdAction: event.currentTarget.value === "stand"
                              ? "stand"
                              : event.currentTarget.value === "custom"
                                ? "custom"
                                : "current",
                          })}
                        >
                          <option value="stand">站立</option>
                          <option value="current">保持当前动作</option>
                          <option value="custom">指定动作</option>
                        </select>
                      </label>
                      {selectedRoutePoint.holdAction === "custom" ? (
                        <label className="inspector-field">
                          <span className="inspector-field-label">指定动作</span>
                          <select
                            aria-label="路线点指定停留动作"
                            value={selectedRoutePoint.holdActionPresetId ?? ""}
                            onChange={(event) => updateObjectMotionKeyframe(role.id, selectedRoutePoint.id, {
                              holdActionPresetId: event.currentTarget.value || null,
                            })}
                          >
                            <option value="">站立</option>
                            {allowsHumanoidActions ? CHARACTER_ACTION_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>) : null}
                            {importedActionOptions.map((action) => <option key={action.id} value={action.id}>{action.label}</option>)}
                          </select>
                        </label>
                      ) : null}
                    </>
                  ) : null}
                  <InspectorAxisGroup
                    label="路线点位置"
                    axes={([0, 1, 2] as const).map((axis) => ({
                      axis: (["X", "Y", "Z"] as const)[axis],
                      ariaLabel: `路线点位置 ${(["X", "Y", "Z"] as const)[axis]}`,
                      value: selectedRoutePoint.transform.position[axis],
                      onChange: (value: string) => updateObjectMotionKeyframe(role.id, selectedRoutePoint.id, {
                        transform: { position: replaceAxis(selectedRoutePoint.transform.position, axis, Number(value)) },
                      }),
                    }))}
                  />
                  <label className="inspector-field">
                    <span className="inspector-field-label">本段动作</span>
                    <select
                      aria-label="路线点本段动作"
                      value={selectedRoutePoint.actionPresetId ?? ""}
                      onChange={(event) => updateObjectMotionKeyframe(role.id, selectedRoutePoint.id, {
                        actionPresetId: event.currentTarget.value || null,
                      })}
                    >
                      <option value="">自动行走</option>
                      {allowsHumanoidActions ? CHARACTER_ACTION_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>) : null}
                      {importedActionOptions.map((action) => <option key={action.id} value={action.id}>{action.label}</option>)}
                    </select>
                  </label>
                  <label className="inspector-field">
                    <span className="inspector-field-label">到点朝向</span>
                    <select
                      aria-label="路线点朝向方式"
                      value={selectedRoutePoint.facingMode ?? "manual"}
                      onChange={(event) => updateObjectMotionKeyframe(role.id, selectedRoutePoint.id, {
                        facingMode: event.currentTarget.value === "path" ? "path" : "manual",
                      })}
                    >
                      <option value="path">面向下一个点</option>
                      <option value="manual">手动朝向</option>
                    </select>
                  </label>
                  {selectedRoutePoint.facingMode !== "path" ? (
                    <InspectorRangeNumberField
                      label="手动朝向"
                      rangeAriaLabel="路线点手动朝向滑杆"
                      numberAriaLabel="路线点手动朝向"
                      min="-180"
                      max="180"
                      step="1"
                      value={selectedRoutePoint.transform.rotation[1] * 180 / Math.PI}
                      onValueChange={(value) => updateObjectMotionKeyframe(role.id, selectedRoutePoint.id, {
                        transform: {
                          rotation: replaceAxis(
                            selectedRoutePoint.transform.rotation,
                            1,
                            Number(value) * Math.PI / 180
                          ),
                        },
                      })}
                    />
                  ) : null}
                </InspectorSection>
              ) : <p>添加第一个路线点后，可在场景里拖动编号点继续摆路线。</p>}
            </>
          )}
        </InspectorSection>
      )}
    </InspectorPanel>
  );
}
