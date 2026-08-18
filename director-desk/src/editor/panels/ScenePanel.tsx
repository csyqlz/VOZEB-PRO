import { ImagePlus, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  InspectorAxisGroup,
  InspectorColorField,
  InspectorPanel,
  InspectorRangeNumberField,
  InspectorSection,
  InspectorSelectField,
} from "./InspectorControls";
import { useDirectorStore } from "../store/directorStore";
import { readPanoramaFile } from "../loaders/panoramaImport";
import { useResolvedLocalAssetUrl } from "../loaders/useResolvedLocalAssetUrl";
import { GROUND_MATERIAL_PRESETS } from "../canvas/groundMaterialPresets";
import type { GroundMaterialPresetId } from "../schema/directorProject";

const SCENE_SCALE_MIN = 0.1;
const SCENE_SCALE_MAX = 3;
const GROUND_HEIGHT_MIN = -5;
const GROUND_HEIGHT_MAX = 5;
const GROUND_TEXTURE_SCALE_MIN = 0.25;
const GROUND_TEXTURE_SCALE_MAX = 8;
const SCENE_BRIGHTNESS_MIN = 0;
const SCENE_BRIGHTNESS_MAX = 3;

function replaceAxis(tuple: [number, number, number], axis: 0 | 1 | 2, value: number): [number, number, number] {
  return tuple.map((item, index) => (index === axis ? value : item)) as [number, number, number];
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function ScenePanel() {
  const scene = useDirectorStore((state) => state.project.scene);
  const panoramaAsset = useDirectorStore((state) =>
    state.project.assets.find((asset) => asset.id === state.project.panoramaAssetId)
  );
  const updateScene = useDirectorStore((state) => state.updateScene);
  const setPanoramaAsset = useDirectorStore((state) => state.setPanoramaAsset);
  const removePanoramaAsset = useDirectorStore((state) => state.removePanoramaAsset);
  const resolvedPanoramaUrl = useResolvedLocalAssetUrl(panoramaAsset);
  const panoramaInputRef = useRef<HTMLInputElement>(null);
  const [sceneScaleDraft, setSceneScaleDraft] = useState(String(scene.scale));
  const [groundTextureScaleDraft, setGroundTextureScaleDraft] = useState(String(scene.groundTextureScale));
  const [groundHeightDraft, setGroundHeightDraft] = useState(String(scene.groundHeight));
  const [panoramaImporting, setPanoramaImporting] = useState(false);
  const [panoramaError, setPanoramaError] = useState<string | null>(null);

  useEffect(() => {
    setSceneScaleDraft(String(scene.scale));
  }, [scene.scale]);

  useEffect(() => {
    setGroundTextureScaleDraft(String(scene.groundTextureScale));
  }, [scene.groundTextureScale]);

  useEffect(() => {
    setGroundHeightDraft(String(scene.groundHeight));
  }, [scene.groundHeight]);

  function commitSceneScale(value: string) {
    const parsed = Number(value);
    const nextScale = Number.isFinite(parsed) ? clampNumber(parsed, SCENE_SCALE_MIN, SCENE_SCALE_MAX) : scene.scale;
    updateScene({ scale: nextScale });
    setSceneScaleDraft(String(nextScale));
  }

  function commitGroundHeight(value: string) {
    const parsed = Number(value);
    const nextHeight = Number.isFinite(parsed) ? clampNumber(parsed, GROUND_HEIGHT_MIN, GROUND_HEIGHT_MAX) : scene.groundHeight;
    updateScene({ groundHeight: nextHeight });
    setGroundHeightDraft(String(nextHeight));
  }

  function commitGroundTextureScale(value: string) {
    const parsed = Number(value);
    const nextScale = Number.isFinite(parsed)
      ? clampNumber(parsed, GROUND_TEXTURE_SCALE_MIN, GROUND_TEXTURE_SCALE_MAX)
      : scene.groundTextureScale;
    updateScene({ groundTextureScale: nextScale });
    setGroundTextureScaleDraft(String(nextScale));
  }

  async function importPanorama(file: File) {
    setPanoramaImporting(true);
    setPanoramaError(null);
    try {
      setPanoramaAsset(await readPanoramaFile(file));
    } catch (error) {
      setPanoramaError(error instanceof Error ? error.message : "全景图导入失败，请重新选择图片");
    } finally {
      setPanoramaImporting(false);
    }
  }

  return (
    <InspectorPanel title="3D场景" ariaLabel="3D场景右侧属性面板" className="scene-inspector">
      <InspectorRangeNumberField
        label="场景缩放"
        rangeAriaLabel="场景缩放滑杆"
        numberAriaLabel="场景缩放"
        max={SCENE_SCALE_MAX}
        min={SCENE_SCALE_MIN}
        step="0.01"
        value={sceneScaleDraft}
        onValueChange={commitSceneScale}
        onRangeChange={commitSceneScale}
        onNumberBlur={commitSceneScale}
        onNumberChange={(value) => {
          setSceneScaleDraft(value);
          if (value !== "") {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) {
              updateScene({ scale: parsed });
            }
          }
        }}
      />
      <InspectorAxisGroup
        label="场景平移"
        axes={[
          {
            axis: "X",
            ariaLabel: "场景平移 X",
            step: "0.1",
            value: scene.position[0],
            onChange: (value) => updateScene({ position: replaceAxis(scene.position, 0, Number(value)) }),
          },
          {
            axis: "Y",
            ariaLabel: "场景平移 Y",
            step: "0.1",
            value: scene.position[1],
            onChange: (value) => updateScene({ position: replaceAxis(scene.position, 1, Number(value)) }),
          },
          {
            axis: "Z",
            ariaLabel: "场景平移 Z",
            step: "0.1",
            value: scene.position[2],
            onChange: (value) => updateScene({ position: replaceAxis(scene.position, 2, Number(value)) }),
          },
        ]}
      />
      <InspectorAxisGroup
        label="场景旋转"
        axes={[
          {
            axis: "X",
            ariaLabel: "场景旋转 X",
            step: "1",
            value: scene.rotation[0],
            onChange: (value) => updateScene({ rotation: replaceAxis(scene.rotation, 0, Number(value)) }),
          },
          {
            axis: "Y",
            ariaLabel: "场景旋转 Y",
            step: "1",
            value: scene.rotation[1],
            onChange: (value) => updateScene({ rotation: replaceAxis(scene.rotation, 1, Number(value)) }),
          },
          {
            axis: "Z",
            ariaLabel: "场景旋转 Z",
            step: "1",
            value: scene.rotation[2],
            onChange: (value) => updateScene({ rotation: replaceAxis(scene.rotation, 2, Number(value)) }),
          },
        ]}
      />
      <InspectorSection title="背景">
        <div className="panorama-control-card">
          {panoramaAsset && resolvedPanoramaUrl ? (
            <div className="panorama-thumbnail-card">
              <img
                alt="当前全景图"
                className="panorama-thumbnail-image"
                src={resolvedPanoramaUrl}
              />
              <span className="panorama-thumbnail-name">{panoramaAsset.fileName}</span>
              <button
                aria-label="删除全景图"
                className="panorama-thumbnail-delete"
                title="删除全景图"
                type="button"
                onClick={() => {
                  removePanoramaAsset();
                  setPanoramaError(null);
                }}
              >
                <Trash2 aria-hidden="true" />
              </button>
            </div>
          ) : (
            <div className="panorama-empty-card">
              <span className="panorama-empty-icon"><ImagePlus aria-hidden="true" size={16} /></span>
              <span>可选：加入一张环境全景图</span>
            </div>
          )}
          <div className="panorama-action-row">
            <button
              className="inspector-action-button"
              disabled={panoramaImporting}
              type="button"
              onClick={() => panoramaInputRef.current?.click()}
            >
              <ImagePlus aria-hidden="true" size={15} />
              {panoramaImporting ? "正在处理..." : panoramaAsset ? "更换全景图" : "导入全景图"}
            </button>
            {panoramaAsset ? (
              <button
                aria-label="恢复全景默认方向"
                className="panorama-reset-button"
                disabled={scene.panoramaYaw === 0}
                title="恢复默认方向"
                type="button"
                onClick={() => updateScene({ panoramaYaw: 0 })}
              >
                <RotateCcw aria-hidden="true" size={15} />
              </button>
            ) : null}
          </div>
          <input
            ref={panoramaInputRef}
            aria-label="选择全景图文件"
            className="visually-hidden"
            accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
            type="file"
            onChange={(event) => {
              const input = event.currentTarget;
              const file = input.files?.[0];
              if (file) void importPanorama(file);
              input.value = "";
            }}
          />
          {panoramaError ? <p className="panorama-import-error" role="alert">{panoramaError}</p> : null}
        </div>
        <InspectorColorField
          label="天空颜色"
          colorAriaLabel="天空颜色"
          hexAriaLabel="天空颜色 HEX"
          value={scene.backgroundColor}
          onColorChange={(value) => updateScene({ backgroundColor: value })}
          onHexChange={(value) => updateScene({ backgroundColor: value })}
        />
        <InspectorRangeNumberField
          label={panoramaAsset ? "全景亮度" : "天空亮度"}
          rangeAriaLabel={panoramaAsset ? "全景亮度滑杆" : "天空亮度滑杆"}
          numberAriaLabel={panoramaAsset ? "全景亮度" : "天空亮度"}
          max={SCENE_BRIGHTNESS_MAX}
          min={SCENE_BRIGHTNESS_MIN}
          step="0.05"
          value={scene.backgroundBrightness}
          onValueChange={(value) => updateScene({ backgroundBrightness: Number(value) })}
        />
        {panoramaAsset ? (
          <InspectorRangeNumberField
            label="左右旋转"
            rangeAriaLabel="全景左右旋转滑杆"
            numberAriaLabel="全景左右旋转"
            max="180"
            min="-180"
            step="1"
            value={scene.panoramaYaw}
            onValueChange={(value) => updateScene({ panoramaYaw: Number(value) })}
          />
        ) : null}
      </InspectorSection>
      <InspectorSection title="开关项">
        <div className="scene-switch-row" role="group" aria-label="开关项设置">
          <div className="inspector-toggle-row">
            <input
              aria-label="角色标签"
              checked={scene.showLabels}
              type="checkbox"
              onChange={(event) => updateScene({ showLabels: event.target.checked })}
            />
            <span>角色标签</span>
          </div>
          <div className="inspector-toggle-row">
            <input
              aria-label="显示编辑网格"
              checked={scene.showGrid}
              type="checkbox"
              onChange={(event) => updateScene({ showGrid: event.target.checked })}
            />
            <span>编辑网格</span>
          </div>
          <div className="inspector-toggle-row">
            <input
              aria-label="移动时吸附网格"
              checked={scene.snapToGrid}
              type="checkbox"
              onChange={(event) => updateScene({ snapToGrid: event.target.checked })}
            />
            <span>移动吸附</span>
          </div>
          <div className="inspector-toggle-row">
            <input
              aria-label="显示地面"
              checked={scene.showGround}
              type="checkbox"
              onChange={(event) => updateScene({ showGround: event.target.checked })}
            />
            <span>显示地面</span>
          </div>
          <div className="inspector-toggle-row">
            <input
              aria-label="启用地面和场景碰撞"
              checked={scene.pathCollisionEnabled}
              type="checkbox"
              onChange={(event) => updateScene({ pathCollisionEnabled: event.target.checked })}
            />
            <span>路线防穿模</span>
          </div>
        </div>
      </InspectorSection>
      {scene.showGround ? (
        <InspectorSection title="地面">
          <InspectorSelectField
            ariaLabel="地面材质"
            label="材质"
            options={GROUND_MATERIAL_PRESETS.map((preset) => ({ value: preset.id, label: preset.label }))}
            value={scene.groundMaterialPreset}
            onChange={(value) => updateScene({ groundMaterialPreset: value as GroundMaterialPresetId })}
          />
          <InspectorColorField
            label="地面颜色"
            colorAriaLabel="地面颜色"
            hexAriaLabel="地面颜色 HEX"
            value={scene.groundColor}
            onColorChange={(value) => updateScene({ groundColor: value })}
            onHexChange={(value) => updateScene({ groundColor: value })}
          />
          <InspectorRangeNumberField
            label="纹理大小"
            rangeAriaLabel="地面纹理大小滑杆"
            numberAriaLabel="地面纹理大小"
            max={GROUND_TEXTURE_SCALE_MAX}
            min={GROUND_TEXTURE_SCALE_MIN}
            step="0.05"
            value={groundTextureScaleDraft}
            onValueChange={commitGroundTextureScale}
            onRangeChange={commitGroundTextureScale}
            onNumberBlur={commitGroundTextureScale}
            onNumberChange={(value) => {
              setGroundTextureScaleDraft(value);
              if (value !== "") {
                const parsed = Number(value);
                if (Number.isFinite(parsed)) updateScene({ groundTextureScale: parsed });
              }
            }}
          />
          <InspectorRangeNumberField
            label="地面亮度"
            rangeAriaLabel="地面亮度滑杆"
            numberAriaLabel="地面亮度"
            max={SCENE_BRIGHTNESS_MAX}
            min={SCENE_BRIGHTNESS_MIN}
            step="0.05"
            value={scene.groundBrightness}
            onValueChange={(value) => updateScene({ groundBrightness: Number(value) })}
          />
          <InspectorRangeNumberField
            label="透明度"
            rangeAriaLabel="地面透明度滑杆"
            numberAriaLabel="地面透明度"
            max="1"
            min="0"
            step="0.01"
            value={scene.groundOpacity}
            onValueChange={(value) => updateScene({ groundOpacity: Number(value) })}
          />
          <InspectorRangeNumberField
            label="高度"
            rangeAriaLabel="地面高度滑杆"
            numberAriaLabel="地面高度"
            max={GROUND_HEIGHT_MAX}
            min={GROUND_HEIGHT_MIN}
            step="0.1"
            value={groundHeightDraft}
            onValueChange={commitGroundHeight}
            onRangeChange={commitGroundHeight}
            onNumberBlur={commitGroundHeight}
            onNumberChange={(value) => {
              setGroundHeightDraft(value);
              if (value !== "") {
                const parsed = Number(value);
                if (Number.isFinite(parsed)) {
                  updateScene({ groundHeight: parsed });
                }
              }
            }}
          />
        </InspectorSection>
      ) : null}
    </InspectorPanel>
  );
}
