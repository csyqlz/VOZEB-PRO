import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type MutableRefObject,
} from "react";
import {
  Box,
  Boxes,
  Camera,
  ChevronRight,
  Expand,
  Grid2X2,
  Grid3X3,
  Image,
  Move3D,
  Plus,
  Ratio,
  Route,
  Rotate3D,
  Scale3D,
  Trash2,
  UserPlus,
  Video,
  X,
  type LucideIcon,
} from "lucide-react";
import { requestViewportCapture } from "../io/captureBridge";
import { readLocalModelFile } from "../loaders/localModelImport";
import {
  inspectCharacterModelFile,
  type CharacterAssetInspection,
} from "../loaders/characterAssetInspection";
import {
  getCharacterImportPreviewSteps,
  type CharacterImportPreviewStep,
} from "../loaders/characterImportPreview";
import {
  getModelLibraryCharacterStatus,
  getModelLibraryItems,
  MODEL_LIBRARY_CATEGORIES,
  type ModelLibraryCategoryId,
  type ModelLibraryItem,
} from "../modelLibrary/modelLibraryCatalog";
import {
  VIEWPORT_ASPECT_RATIO_OPTIONS,
  type ViewportAspectRatio,
} from "../schema/viewportAspectRatio";
import {
  DIRECTOR_CHARACTER_BONE_PART_OPTIONS,
} from "../schema/semanticBody";
import { BODY_TYPE_OPTIONS, type CharacterBodyType } from "../runtime/mannequin/bodyTypes";
import { GEOMETRY_PRIMITIVE_OPTIONS, type GeometryPrimitiveType } from "../schema/directorProject";
import {
  useDirectorStore,
  type CameraShotSnapshot,
  type CrowdCharactersInput,
  type TransformMode,
} from "../store/directorStore";
import { canImportCharacterFromInspection } from "./characterImportPolicy";

export { canImportCharacterFromInspection } from "./characterImportPolicy";

type ToolbarAction = {
  label: string;
  icon: LucideIcon;
  mode?: TransformMode;
  pressed?: boolean;
  buttonRef?: MutableRefObject<HTMLButtonElement | null>;
  onClick: () => void;
};

const FLOATING_PANEL_GAP = 8;
const FLOATING_PANEL_MARGIN = 8;
const MIN_FLOATING_PANEL_HEIGHT = 80;
const CHARACTER_MENU_WIDTH = 132;
const GEOMETRY_MENU_WIDTH = 112;
const CROWD_PANEL_WIDTH = 260;
const MODEL_LIBRARY_PANEL_WIDTH = 500;
const ASPECT_RATIO_PANEL_WIDTH = 340;
const DEFAULT_CROWD_ROWS = 3;
const DEFAULT_CROWD_COLUMNS = 3;
const DEFAULT_CROWD_SPACING = 1.2;
const MIN_CROWD_GRID_SIZE = 1;
const MAX_CROWD_GRID_SIZE = 12;
const MIN_CROWD_SPACING = 0.1;
const MAX_CROWD_SPACING = 10;
const CHARACTER_IMPORT_PREVIEW_STEP_MS = 1800;

const CHARACTER_IMPORT_STATUS_LABELS = {
  ready: "可直接使用",
  "native-only": "仅自带动作",
  "manual-mapping": "需要手动映射",
  "static-only": "仅静态使用",
} as const;

function clampCrowdGridSize(value: number) {
  if (!Number.isFinite(value)) return MIN_CROWD_GRID_SIZE;
  return Math.min(MAX_CROWD_GRID_SIZE, Math.max(MIN_CROWD_GRID_SIZE, Math.round(value)));
}

function clampCrowdSpacing(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_CROWD_SPACING;
  return Math.min(MAX_CROWD_SPACING, Math.max(MIN_CROWD_SPACING, Number(value.toFixed(2))));
}

function waitForNextAnimationFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

export function ViewportToolbar({
  getViewportCameraSnapshot,
  toolbarContainerRef,
}: {
  getViewportCameraSnapshot?: () => CameraShotSnapshot;
  toolbarContainerRef?: MutableRefObject<HTMLDivElement | null>;
}) {
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const aspectRatioPanelRef = useRef<HTMLDivElement | null>(null);
  const characterTriggerRef = useRef<HTMLButtonElement | null>(null);
  const geometryTriggerRef = useRef<HTMLButtonElement | null>(null);
  const crowdTriggerRef = useRef<HTMLButtonElement | null>(null);
  const modelLibraryTriggerRef = useRef<HTMLButtonElement | null>(null);
  const aspectRatioTriggerRef = useRef<HTMLButtonElement | null>(null);
  const characterMenuRef = useRef<HTMLDivElement | null>(null);
  const geometryMenuRef = useRef<HTMLDivElement | null>(null);
  const crowdPanelRef = useRef<HTMLDivElement | null>(null);
  const modelLibraryPanelRef = useRef<HTMLDivElement | null>(null);
  const sceneLocalModelInputRef = useRef<HTMLInputElement | null>(null);
  const characterLocalModelInputRef = useRef<HTMLInputElement | null>(null);
  const libraryLocalModelInputRef = useRef<HTMLInputElement | null>(null);
  const [characterMenuOpen, setCharacterMenuOpen] = useState(false);
  const [geometryMenuOpen, setGeometryMenuOpen] = useState(false);
  const [crowdPanelOpen, setCrowdPanelOpen] = useState(false);
  const [modelLibraryOpen, setModelLibraryOpen] = useState(false);
  const [aspectRatioPanelOpen, setAspectRatioPanelOpen] = useState(false);
  const [pendingCharacterImport, setPendingCharacterImport] = useState<{
    file: File;
    report: CharacterAssetInspection;
    boneMap: NonNullable<CharacterAssetInspection["boneMap"]>;
  } | null>(null);
  const [characterImportError, setCharacterImportError] = useState<string | null>(null);
  const [characterImportBusy, setCharacterImportBusy] = useState(false);
  const [characterImportPreview, setCharacterImportPreviewState] = useState<{
    objectId: string;
    steps: CharacterImportPreviewStep[];
    stepIndex: number;
  } | null>(null);
  const characterImportPlaybackRestoreRef = useRef<{ playing: boolean; progress: number } | null>(null);
  const [characterMenuStyle, setCharacterMenuStyle] = useState<CSSProperties>({});
  const [geometryMenuStyle, setGeometryMenuStyle] = useState<CSSProperties>({});
  const [crowdPanelStyle, setCrowdPanelStyle] = useState<CSSProperties>({});
  const [modelLibraryPanelStyle, setModelLibraryPanelStyle] = useState<CSSProperties>({});
  const [aspectRatioPanelStyle, setAspectRatioPanelStyle] = useState<CSSProperties>({});
  const [crowdBodyType, setCrowdBodyType] = useState<CharacterBodyType>(BODY_TYPE_OPTIONS[0]?.bodyType ?? "mannequin");
  const [crowdRows, setCrowdRows] = useState(String(DEFAULT_CROWD_ROWS));
  const [crowdColumns, setCrowdColumns] = useState(String(DEFAULT_CROWD_COLUMNS));
  const [crowdSpacing, setCrowdSpacing] = useState(String(DEFAULT_CROWD_SPACING));
  const [activeModelLibraryCategoryId, setActiveModelLibraryCategoryId] =
    useState<ModelLibraryCategoryId>("convenience");
  const addImportedAsset = useDirectorStore((state) => state.addImportedAsset);
  const addImportedAnimationAsset = useDirectorStore((state) => state.addImportedAnimationAsset);
  const applyCharacterActionPreset = useDirectorStore((state) => state.applyCharacterActionPreset);
  const restartCameraMotionPlayback = useDirectorStore((state) => state.restartCameraMotionPlayback);
  const setCameraMotionPlaying = useDirectorStore((state) => state.setCameraMotionPlaying);
  const setCameraMotionProgress = useDirectorStore((state) => state.setCameraMotionProgress);
  const setCharacterActionPreview = useDirectorStore((state) => state.setCharacterActionPreview);
  const addObjectFromAsset = useDirectorStore((state) => state.addObjectFromAsset);
  const removeImportedAsset = useDirectorStore((state) => state.removeImportedAsset);
  const assets = useDirectorStore((state) => state.project.assets);
  const addPresetCharacter = useDirectorStore((state) => state.addPresetCharacter);
  const addCrowdCharacters = useDirectorStore((state) => state.addCrowdCharacters);
  const addGeometryPrimitive = useDirectorStore((state) => state.addGeometryPrimitive);
  const addCameraShot = useDirectorStore((state) => state.addCameraShot);
  const addCameraCaptures = useDirectorStore((state) => state.addCameraCaptures);
  const activeCameraId = useDirectorStore((state) => state.project.activeCameraId);
  const viewMode = useDirectorStore((state) => state.viewMode);
  const transformMode = useDirectorStore((state) => state.transformMode);
  const showCharacterRoutes = useDirectorStore((state) => state.showCharacterRoutes);
  const viewportAspectRatio = useDirectorStore((state) => state.viewportAspectRatio);
  const setViewMode = useDirectorStore((state) => state.setViewMode);
  const setTransformMode = useDirectorStore((state) => state.setTransformMode);
  const setShowCharacterRoutes = useDirectorStore((state) => state.setShowCharacterRoutes);
  const setViewportAspectRatio = useDirectorStore((state) => state.setViewportAspectRatio);
  const toggleViewportPanelsCollapsed = useDirectorStore((state) => state.toggleViewportPanelsCollapsed);

  function stopCharacterImportPreview() {
    setCharacterImportPreviewState(null);
    setCharacterActionPreview(null);
    const restore = characterImportPlaybackRestoreRef.current;
    characterImportPlaybackRestoreRef.current = null;
    if (restore) {
      setCameraMotionPlaying(false);
      setCameraMotionProgress(restore.progress);
      setCameraMotionPlaying(restore.playing);
    }
  }

  function startCharacterImportPreview(objectId: string, steps: CharacterImportPreviewStep[]) {
    if (!steps.length) return;
    const runtime = useDirectorStore.getState();
    characterImportPlaybackRestoreRef.current = {
      playing: runtime.cameraMotionPlaying,
      progress: runtime.cameraMotionProgress,
    };
    setCharacterImportPreviewState({ objectId, steps, stepIndex: 0 });
  }

  useEffect(() => {
    if (!characterImportPreview) return;
    const step = characterImportPreview.steps[characterImportPreview.stepIndex];
    if (!step) {
      stopCharacterImportPreview();
      return;
    }
    setCharacterActionPreview({
      objectId: characterImportPreview.objectId,
      actionPresetId: step.actionPresetId,
    });
    restartCameraMotionPlayback();
    const timeout = window.setTimeout(() => {
      if (characterImportPreview.stepIndex + 1 >= characterImportPreview.steps.length) {
        stopCharacterImportPreview();
        return;
      }
      setCharacterImportPreviewState((current) => current
        ? { ...current, stepIndex: current.stepIndex + 1 }
        : current);
    }, CHARACTER_IMPORT_PREVIEW_STEP_MS);
    return () => window.clearTimeout(timeout);
  }, [characterImportPreview, restartCameraMotionPlayback, setCharacterActionPreview]);

  useEffect(() => () => {
    setCharacterActionPreview(null);
  }, [setCharacterActionPreview]);

  useEffect(() => {
    if (!characterMenuOpen && !crowdPanelOpen && !modelLibraryOpen && !aspectRatioPanelOpen) return;

    function closeMenusOnOutsidePointerDown(event: PointerEvent) {
      if (event.target instanceof Node && toolbarRef.current?.contains(event.target)) return;
      if (event.target instanceof Node && characterMenuRef.current?.contains(event.target)) return;
      if (event.target instanceof Node && geometryMenuRef.current?.contains(event.target)) return;
      if (event.target instanceof Node && crowdPanelRef.current?.contains(event.target)) return;
      if (event.target instanceof Node && modelLibraryPanelRef.current?.contains(event.target)) return;
      if (event.target instanceof Node && aspectRatioPanelRef.current?.contains(event.target)) return;
      if (event.target instanceof Node && sceneLocalModelInputRef.current?.contains(event.target)) return;
      if (event.target instanceof Node && characterLocalModelInputRef.current?.contains(event.target)) return;
      if (event.target instanceof Node && libraryLocalModelInputRef.current?.contains(event.target)) return;

      setCharacterMenuOpen(false);
      setGeometryMenuOpen(false);
      setCrowdPanelOpen(false);
      setModelLibraryOpen(false);
      setAspectRatioPanelOpen(false);
    }

    document.addEventListener("pointerdown", closeMenusOnOutsidePointerDown);

    return () => {
      document.removeEventListener("pointerdown", closeMenusOnOutsidePointerDown);
    };
  }, [aspectRatioPanelOpen, characterMenuOpen, crowdPanelOpen, modelLibraryOpen]);

  useLayoutEffect(() => {
    const toolbarElement = toolbarRef.current;
    const frameElement = toolbarElement?.parentElement;
    if (!toolbarElement || !frameElement) return;

    const updateFloatingPositions = () => {
      const frameRect = frameElement.getBoundingClientRect();
      const toolbarRect = toolbarElement.getBoundingClientRect();
      const getCenteredPanelLeft = (
        anchorCenter: number,
        panel: HTMLElement | null,
        fallbackWidth: number
      ) => {
        const panelWidth = Math.min(
          panel?.offsetWidth || fallbackWidth,
          Math.max(0, frameRect.width - FLOATING_PANEL_MARGIN * 2)
        );
        const halfWidth = panelWidth / 2;
        const minimum = FLOATING_PANEL_MARGIN + halfWidth;
        const maximum = Math.max(minimum, frameRect.width - FLOATING_PANEL_MARGIN - halfWidth);
        return Math.min(maximum, Math.max(minimum, anchorCenter - frameRect.left));
      };
      const getSidePanelLeft = (
        triggerRect: DOMRect,
        panel: HTMLElement | null,
        fallbackWidth: number
      ) => {
        const panelWidth = Math.min(
          panel?.offsetWidth || fallbackWidth,
          Math.max(0, frameRect.width - FLOATING_PANEL_MARGIN * 2)
        );
        const rightPosition = triggerRect.right - frameRect.left + FLOATING_PANEL_GAP;
        const leftPosition = triggerRect.left - frameRect.left - panelWidth - FLOATING_PANEL_GAP;
        const preferred = rightPosition + panelWidth <= frameRect.width - FLOATING_PANEL_MARGIN
          ? rightPosition
          : leftPosition;
        return Math.min(
          Math.max(FLOATING_PANEL_MARGIN, frameRect.width - panelWidth - FLOATING_PANEL_MARGIN),
          Math.max(FLOATING_PANEL_MARGIN, preferred)
        );
      };

      if (characterMenuOpen && characterTriggerRef.current) {
        const triggerRect = characterTriggerRef.current.getBoundingClientRect();
        const availableHeight = Math.max(
          MIN_FLOATING_PANEL_HEIGHT,
          frameRect.bottom - toolbarRect.bottom - FLOATING_PANEL_GAP - FLOATING_PANEL_MARGIN
        );
        setCharacterMenuStyle({
          left: `${getCenteredPanelLeft(
            triggerRect.left + triggerRect.width / 2,
            characterMenuRef.current,
            CHARACTER_MENU_WIDTH
          )}px`,
          top: `${toolbarRect.bottom - frameRect.top + FLOATING_PANEL_GAP}px`,
          bottom: "auto",
          maxHeight: `${availableHeight}px`,
        });
      }

      if (geometryMenuOpen && geometryTriggerRef.current) {
        const triggerRect = geometryTriggerRef.current.getBoundingClientRect();
        const availableHeight = Math.max(
          MIN_FLOATING_PANEL_HEIGHT,
          frameRect.bottom - triggerRect.top - FLOATING_PANEL_MARGIN
        );
        setGeometryMenuStyle({
          left: `${getSidePanelLeft(
            triggerRect,
            geometryMenuRef.current,
            GEOMETRY_MENU_WIDTH
          )}px`,
          top: `${triggerRect.top - frameRect.top}px`,
          bottom: "auto",
          maxHeight: `${availableHeight}px`,
        });
      }

      if (crowdPanelOpen && crowdTriggerRef.current) {
        const triggerRect = crowdTriggerRef.current.getBoundingClientRect();
        const availableHeight = Math.max(
          MIN_FLOATING_PANEL_HEIGHT,
          frameRect.bottom - triggerRect.top - FLOATING_PANEL_MARGIN
        );
        setCrowdPanelStyle({
          left: `${getSidePanelLeft(
            triggerRect,
            crowdPanelRef.current,
            CROWD_PANEL_WIDTH
          )}px`,
          top: `${triggerRect.top - frameRect.top}px`,
          bottom: "auto",
          maxHeight: `${availableHeight}px`,
        });
      }

      if (modelLibraryOpen) {
        const availableHeight = Math.max(
          MIN_FLOATING_PANEL_HEIGHT,
          frameRect.bottom - toolbarRect.bottom - 10 - FLOATING_PANEL_MARGIN
        );
        setModelLibraryPanelStyle({
          left: `${getCenteredPanelLeft(
            toolbarRect.left + toolbarRect.width / 2,
            modelLibraryPanelRef.current,
            MODEL_LIBRARY_PANEL_WIDTH
          )}px`,
          top: `${toolbarRect.bottom - frameRect.top + 10}px`,
          bottom: "auto",
          maxHeight: `${availableHeight}px`,
        });
      }

      if (aspectRatioPanelOpen && aspectRatioTriggerRef.current) {
        const triggerRect = aspectRatioTriggerRef.current.getBoundingClientRect();
        const availableHeight = Math.max(
          MIN_FLOATING_PANEL_HEIGHT,
          frameRect.bottom - toolbarRect.bottom - FLOATING_PANEL_GAP - FLOATING_PANEL_MARGIN
        );
        setAspectRatioPanelStyle({
          left: `${getCenteredPanelLeft(
            triggerRect.left + triggerRect.width / 2,
            aspectRatioPanelRef.current,
            ASPECT_RATIO_PANEL_WIDTH
          )}px`,
          top: `${toolbarRect.bottom - frameRect.top + FLOATING_PANEL_GAP}px`,
          bottom: "auto",
          maxHeight: `${availableHeight}px`,
        });
      }
    };

    updateFloatingPositions();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateFloatingPositions);
      return () => {
        window.removeEventListener("resize", updateFloatingPositions);
      };
    }

    const resizeObserver = new ResizeObserver(updateFloatingPositions);
    resizeObserver.observe(frameElement);
    resizeObserver.observe(toolbarElement);
    if (characterTriggerRef.current) {
      resizeObserver.observe(characterTriggerRef.current);
    }
    if (geometryTriggerRef.current) {
      resizeObserver.observe(geometryTriggerRef.current);
    }
    if (crowdTriggerRef.current) {
      resizeObserver.observe(crowdTriggerRef.current);
    }
    if (modelLibraryTriggerRef.current) {
      resizeObserver.observe(modelLibraryTriggerRef.current);
    }
    if (aspectRatioTriggerRef.current) {
      resizeObserver.observe(aspectRatioTriggerRef.current);
    }
    window.addEventListener("resize", updateFloatingPositions);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateFloatingPositions);
    };
  }, [aspectRatioPanelOpen, characterMenuOpen, crowdPanelOpen, geometryMenuOpen, modelLibraryOpen]);

  async function handleLocalModelChange(
    event: ChangeEvent<HTMLInputElement>,
    addToScene: boolean
  ) {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    if (!files.length) return;

    try {
      for (const file of files) {
        const result = await readLocalModelFile(file);
        addImportedAsset({
          kind: "prop",
          ...result,
          addToScene,
          assetSource: "local",
        });
      }
    } catch {
      // The toolbar keeps file actions quiet; detailed import feedback lives in the side panel.
    } finally {
      input.value = "";
    }
  }

  async function handleCharacterModelChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setCharacterImportError(null);
    setCharacterImportBusy(true);

    try {
      const report = await inspectCharacterModelFile(file);
      setPendingCharacterImport({ file, report, boneMap: report.boneMap ?? {} });
      setCharacterMenuOpen(false);
    } catch (error) {
      setCharacterImportError(error instanceof Error ? error.message : "人物模型体检失败");
    } finally {
      setCharacterImportBusy(false);
      input.value = "";
    }
  }

  async function confirmCharacterImport(kind: "character" | "prop") {
    if (!pendingCharacterImport) return;
    setCharacterImportError(null);

    if (kind === "character" && !canImportCharacterFromInspection(
      pendingCharacterImport.report,
      pendingCharacterImport.boneMap
    )) {
      setCharacterImportError(
        pendingCharacterImport.report.readiness === "static-only"
          ? "该文件没有可用蒙皮骨架，只能作为静态道具加入"
          : "请先完成 15 个身体部位的骨骼映射"
      );
      return;
    }

    setCharacterImportBusy(true);

    try {
      const result = await readLocalModelFile(pendingCharacterImport.file);
      addImportedAsset({
        kind,
        ...result,
        assetSource: "local",
        characterRigProfile: pendingCharacterImport.report.rigProfile,
        characterImportReadiness: kind === "character" && pendingCharacterImport.report.readiness === "manual-mapping"
          ? "ready"
          : pendingCharacterImport.report.readiness,
        characterOrientationCorrection: pendingCharacterImport.report.orientationCorrection,
        characterBoneMap: pendingCharacterImport.boneMap,
      });
      const embeddedClips = pendingCharacterImport.report.animations.filter(
        (clip) => clip.duration > 0.05 && clip.trackCount > 0
      );
      let embeddedAnimationAssetId: string | null = null;
      if (kind === "character" && embeddedClips.length) {
        const animationAssetId = addImportedAnimationAsset({
          name: `${result.name} 自带动作`,
          fileName: result.fileName,
          url: result.url,
          modelFormat: pendingCharacterImport.report.format,
          storageKey: result.storageKey,
          byteLength: result.byteLength,
          rigProfile: pendingCharacterImport.report.rigProfile,
          sourceCharacterAssetId: result.storageKey ? `local_asset_${result.storageKey}` : undefined,
          clips: embeddedClips.map((clip, index) => ({
            id: `clip_${index + 1}`,
            name: clip.name,
            duration: clip.duration,
            trackCount: clip.trackCount,
          })),
        });
        embeddedAnimationAssetId = animationAssetId;
        const importedCharacterId = useDirectorStore.getState().selectedObjectId;
        if (importedCharacterId && pendingCharacterImport.report.readiness === "native-only") {
          applyCharacterActionPreset(importedCharacterId, null);
        }
      }
      const importedCharacterId = useDirectorStore.getState().selectedObjectId;
      if (kind === "character" && importedCharacterId) {
        startCharacterImportPreview(importedCharacterId, getCharacterImportPreviewSteps({
          animationAssetId: embeddedAnimationAssetId,
          clips: embeddedClips.map((clip, index) => ({
            id: `clip_${index + 1}`,
            name: clip.name,
            duration: clip.duration,
            trackCount: clip.trackCount,
          })),
          readiness: pendingCharacterImport.report.readiness,
        }));
      }
      setPendingCharacterImport(null);
    } catch (error) {
      setCharacterImportError(error instanceof Error ? error.message : "人物模型导入失败");
    } finally {
      setCharacterImportBusy(false);
    }
  }

  async function handleCapture(preset: "current" | "four" | "twelve") {
    try {
      const targetCameraId =
        viewMode === "director" ? addCameraShot(getViewportCameraSnapshot?.()) : activeCameraId;

      setViewMode("camera");
      await waitForNextAnimationFrame();

      const results = await requestViewportCapture({
        preset,
        source: "camera-panel",
        cameraId: targetCameraId,
      });
      addCameraCaptures(targetCameraId, results.map((result) => result.dataUrl));
    } catch {
      // Keep the capsule toolbar icon-only and free of transient status text.
    }
  }

  function selectTransformMode(mode: TransformMode) {
    setTransformMode(mode);
  }

  function toggleCharacterMenu() {
    setCharacterMenuOpen((isOpen) => !isOpen);
    setGeometryMenuOpen(false);
    setCrowdPanelOpen(false);
    setModelLibraryOpen(false);
    setAspectRatioPanelOpen(false);
  }

  function addCharacterWithBodyType(bodyType: CharacterBodyType) {
    addPresetCharacter(bodyType);
    setCharacterMenuOpen(false);
    setGeometryMenuOpen(false);
    setCrowdPanelOpen(false);
  }

  function addGeometryWithType(geometryType: GeometryPrimitiveType) {
    addGeometryPrimitive(geometryType);
    setCharacterMenuOpen(false);
    setGeometryMenuOpen(false);
    setCrowdPanelOpen(false);
  }

  function openCrowdPanel() {
    setCrowdPanelOpen(true);
    setGeometryMenuOpen(false);
  }

  function closeCrowdPanel() {
    setCrowdPanelOpen(false);
  }

  function getCrowdInputValue(): CrowdCharactersInput {
    return {
      bodyType: crowdBodyType,
      rows: clampCrowdGridSize(Number(crowdRows)),
      columns: clampCrowdGridSize(Number(crowdColumns)),
      spacing: clampCrowdSpacing(Number(crowdSpacing)),
    };
  }

  function applyCrowdValueDrafts(input: CrowdCharactersInput) {
    setCrowdRows(String(input.rows));
    setCrowdColumns(String(input.columns));
    setCrowdSpacing(String(input.spacing));
  }

  function addCrowd() {
    const nextInput = getCrowdInputValue();
    applyCrowdValueDrafts(nextInput);
    addCrowdCharacters(nextInput);
    setCharacterMenuOpen(false);
    setGeometryMenuOpen(false);
    setCrowdPanelOpen(false);
  }

  function toggleModelLibrary() {
    setModelLibraryOpen((isOpen) => !isOpen);
    setCharacterMenuOpen(false);
    setGeometryMenuOpen(false);
    setCrowdPanelOpen(false);
    setAspectRatioPanelOpen(false);
  }

  function addModelLibraryItem(item: ModelLibraryItem) {
    addImportedAsset({
      kind: item.kind ?? "prop",
      assetSource: "library",
      fileName: item.fileName,
      name: item.name,
      url: item.url,
      modelFormat: item.fileName.toLowerCase().endsWith(".glb") ? "glb" : item.fileName.toLowerCase().endsWith(".fbx") ? "fbx" : undefined,
      characterRigProfile: item.characterRigProfile,
      characterImportReadiness: item.characterImportReadiness,
      characterOrientationCorrection: item.characterOrientationCorrection,
    });
    setModelLibraryOpen(false);
  }

  async function handleMyModelsImport() {
    libraryLocalModelInputRef.current?.click();
  }

  const myModelLibraryItems: ModelLibraryItem[] = assets
    .filter((asset) => asset.sourceType === "model" && asset.assetSource === "local")
    .map(
      (asset) =>
        ({
          categoryId: "my-models",
          fileName: asset.fileName,
          id: asset.id,
          kind: asset.kind === "character" ? "character" : "prop",
          name: asset.name ?? asset.fileName.replace(/\.(fbx|obj|glb)$/i, ""),
          thumbUrl: undefined,
          url: asset.url,
        }) satisfies ModelLibraryItem
    );

  function addCameraFromViewport() {
    const snapshot = getViewportCameraSnapshot?.();
    addCameraShot(snapshot);
  }

  function toggleAspectRatioPanel() {
    setAspectRatioPanelOpen((isOpen) => !isOpen);
    setCharacterMenuOpen(false);
    setGeometryMenuOpen(false);
    setCrowdPanelOpen(false);
    setModelLibraryOpen(false);
  }

  function selectAspectRatio(ratio: ViewportAspectRatio) {
    setViewportAspectRatio(ratio);
    setAspectRatioPanelOpen(false);
  }

  const actions: ToolbarAction[] = [
    { label: "移动", icon: Move3D, mode: "translate", onClick: () => selectTransformMode("translate") },
    { label: "旋转", icon: Rotate3D, mode: "rotate", onClick: () => selectTransformMode("rotate") },
    { label: "缩放", icon: Scale3D, mode: "scale", onClick: () => selectTransformMode("scale") },
    {
      label: "显示人物路线",
      icon: Route,
      pressed: showCharacterRoutes,
      onClick: () => setShowCharacterRoutes(!showCharacterRoutes),
    },
    {
      label: "导入本地模型",
      icon: Box,
      onClick: () => {
        sceneLocalModelInputRef.current?.click();
      },
    },
    { label: "模型库", icon: Boxes, onClick: toggleModelLibrary },
    { label: "添加机位", icon: Video, onClick: addCameraFromViewport },
    {
      label: "选择画幅比例",
      icon: Ratio,
      buttonRef: aspectRatioTriggerRef,
      onClick: toggleAspectRatioPanel,
    },
    { label: "当前视角截图", icon: Camera, onClick: () => void handleCapture("current") },
    { label: "四方位截图", icon: Grid2X2, onClick: () => void handleCapture("four") },
    { label: "十二方位截图", icon: Grid3X3, onClick: () => void handleCapture("twelve") },
    { label: "全屏", icon: Expand, onClick: toggleViewportPanelsCollapsed },
  ];

  function renderActionButton(action: ToolbarAction) {
    const Icon = action.icon;
    const active = action.mode ? transformMode === action.mode : action.pressed ?? false;

    return (
      <button
        key={action.label}
        aria-label={action.label}
        aria-pressed={action.mode || action.pressed !== undefined ? active : undefined}
        className={`ui-icon-button viewport-toolbar-button${active ? " is-active" : ""}`}
        ref={action.buttonRef}
        type="button"
        onClick={action.onClick}
      >
        <Icon aria-hidden="true" size={17} strokeWidth={1.9} />
        <span className="viewport-toolbar-label">{action.label}</span>
      </button>
    );
  }

  const modelLibraryItems = getModelLibraryItems();
  const activeModelLibraryItems =
    activeModelLibraryCategoryId === "my-models"
      ? myModelLibraryItems
      : modelLibraryItems.filter((item) => item.categoryId === activeModelLibraryCategoryId);
  const crowdInputValue = getCrowdInputValue();
  const crowdTotalCount = crowdInputValue.rows * crowdInputValue.columns;

  function setToolbarElement(element: HTMLDivElement | null) {
    toolbarRef.current = element;
    if (toolbarContainerRef) {
      toolbarContainerRef.current = element;
    }
  }

  return (
    <>
      <div className="viewport-toolbar" role="group" aria-label="3D视口快捷工具" ref={setToolbarElement}>
        {actions.slice(0, 3).map(renderActionButton)}
        <div className="viewport-toolbar-menu-wrap">
          <button
            aria-expanded={characterMenuOpen}
            aria-label="添加角色"
            className="ui-icon-button viewport-toolbar-button"
            ref={characterTriggerRef}
            type="button"
            onClick={toggleCharacterMenu}
          >
            <UserPlus aria-hidden="true" size={17} strokeWidth={1.9} />
            <span className="viewport-toolbar-label">添加角色</span>
          </button>
        </div>
        {actions.slice(3).map((action) => {
          if (action.label !== "模型库") {
            return renderActionButton(action);
          }

          const Icon = action.icon;

          return (
            <button
              key={action.label}
              aria-label={action.label}
              className="ui-icon-button viewport-toolbar-button"
              ref={modelLibraryTriggerRef}
              type="button"
              onClick={action.onClick}
            >
              <Icon aria-hidden="true" size={17} strokeWidth={1.9} />
              <span className="viewport-toolbar-label">{action.label}</span>
            </button>
          );
        })}
      </div>
      {characterMenuOpen ? (
        <div
          ref={characterMenuRef}
          className="viewport-toolbar-menu"
          role="menu"
          aria-label="选择角色体型"
          style={characterMenuStyle}
        >
          {BODY_TYPE_OPTIONS.map((option) => (
            <button
              key={option.bodyType}
              role="menuitem"
              type="button"
              onClick={() => addCharacterWithBodyType(option.bodyType)}
              onMouseEnter={() => {
                setGeometryMenuOpen(false);
                setCrowdPanelOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
          <button
            className="viewport-toolbar-menu-item-inline"
            role="menuitem"
            type="button"
            onClick={() => characterLocalModelInputRef.current?.click()}
          >
            <UserPlus aria-hidden="true" size={14} strokeWidth={1.8} />
            <span>{characterImportBusy ? "正在体检..." : "导入绑骨人物"}</span>
          </button>
          <div
            className="viewport-toolbar-submenu-wrap"
            onMouseEnter={openCrowdPanel}
          >
            <button
              ref={crowdTriggerRef}
              aria-expanded={crowdPanelOpen}
              aria-haspopup="dialog"
              className="viewport-toolbar-menu-subtrigger"
              role="menuitem"
              type="button"
              onFocus={openCrowdPanel}
              onMouseEnter={openCrowdPanel}
            >
              <span>群众 (3x3)</span>
              <ChevronRight aria-hidden="true" size={14} strokeWidth={1.8} />
            </button>
          </div>
          <div
            className="viewport-toolbar-submenu-wrap"
            onMouseEnter={() => {
              setGeometryMenuOpen(true);
              setCrowdPanelOpen(false);
            }}
          >
            <button
              ref={geometryTriggerRef}
              aria-expanded={geometryMenuOpen}
              aria-haspopup="menu"
              className="viewport-toolbar-menu-subtrigger"
              role="menuitem"
              type="button"
              onMouseEnter={() => {
                setGeometryMenuOpen(true);
                setCrowdPanelOpen(false);
              }}
            >
              <span>几何模型</span>
              <ChevronRight aria-hidden="true" size={14} strokeWidth={1.8} />
            </button>
          </div>
        </div>
      ) : null}
      {crowdPanelOpen ? (
        <div
          ref={crowdPanelRef}
          className="viewport-toolbar-crowd-panel"
          role="dialog"
          aria-label="添加群众阵列"
          style={crowdPanelStyle}
        >
          <div className="viewport-toolbar-crowd-panel-header">
            <h2 className="viewport-toolbar-crowd-panel-title">添加群众阵列</h2>
            <span className="viewport-toolbar-crowd-panel-count">共{crowdTotalCount}人</span>
          </div>
          <div className="viewport-toolbar-crowd-grid">
            <label className="viewport-toolbar-crowd-field">
              <span>行数</span>
              <input
                className="ui-field"
                aria-label="群众行数"
                inputMode="numeric"
                type="number"
                min={MIN_CROWD_GRID_SIZE}
                max={MAX_CROWD_GRID_SIZE}
                value={crowdRows}
                onChange={(event) => setCrowdRows(event.currentTarget.value)}
              />
            </label>
            <span className="viewport-toolbar-crowd-separator" aria-hidden="true">
              ×
            </span>
            <label className="viewport-toolbar-crowd-field">
              <span>列数</span>
              <input
                className="ui-field"
                aria-label="群众列数"
                inputMode="numeric"
                type="number"
                min={MIN_CROWD_GRID_SIZE}
                max={MAX_CROWD_GRID_SIZE}
                value={crowdColumns}
                onChange={(event) => setCrowdColumns(event.currentTarget.value)}
              />
            </label>
            <label className="viewport-toolbar-crowd-field viewport-toolbar-crowd-field-spacing">
              <span>间距</span>
              <input
                className="ui-field"
                aria-label="群众间距"
                inputMode="decimal"
                type="number"
                min={MIN_CROWD_SPACING}
                max={MAX_CROWD_SPACING}
                step="0.1"
                value={crowdSpacing}
                onChange={(event) => setCrowdSpacing(event.currentTarget.value)}
              />
            </label>
          </div>
          <div className="viewport-toolbar-crowd-actions">
            <button className="viewport-toolbar-crowd-cancel camera-capture-clear-all" type="button" onClick={closeCrowdPanel}>
              取消
            </button>
            <button
              aria-label="添加群众"
              className="viewport-toolbar-crowd-confirm camera-capture-send-all"
              type="button"
              onClick={addCrowd}
            >
              添加
            </button>
          </div>
        </div>
      ) : null}
      {geometryMenuOpen ? (
        <div
          ref={geometryMenuRef}
          className="viewport-toolbar-submenu"
          role="menu"
          aria-label="选择几何模型"
          style={geometryMenuStyle}
        >
          {GEOMETRY_PRIMITIVE_OPTIONS.map((option) => (
            <button
              key={option.type}
              role="menuitem"
              type="button"
              onClick={() => addGeometryWithType(option.type)}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
      {modelLibraryOpen ? (
        <div
          ref={modelLibraryPanelRef}
          className="model-library-panel"
          role="dialog"
          aria-label="模型库"
          style={modelLibraryPanelStyle}
        >
          <div className="model-library-header">
            <h2 className="model-library-title">模型库</h2>
            <button
              aria-label="关闭模型库"
              className="top-bar-action-button model-library-close-button"
              type="button"
              onClick={() => setModelLibraryOpen(false)}
            >
              <X aria-hidden="true" size={16} strokeWidth={1.8} />
            </button>
          </div>
          <div className="model-library-tabs" role="tablist" aria-label="模型分类">
            {MODEL_LIBRARY_CATEGORIES.map((category) => {
              const active = category.id === activeModelLibraryCategoryId;

              return (
                <button
                  key={category.id}
                  aria-selected={active}
                  className={`model-library-tab${active ? " is-active" : ""}`}
                  role="tab"
                  type="button"
                  onClick={() => setActiveModelLibraryCategoryId(category.id)}
                >
                  {category.label}
                </button>
              );
            })}
          </div>
          {activeModelLibraryCategoryId === "my-models" && activeModelLibraryItems.length === 0 ? (
            <div className="model-library-empty-state object-search-empty-state" role="status" aria-label="暂无任何模型">
              <span className="object-search-empty-icon" data-testid="my-models-empty-icon">
                <Boxes aria-hidden="true" size={16} strokeWidth={1.8} />
              </span>
              <span>暂无任何模型</span>
              <button className="top-bar-action-button model-library-empty-action" type="button" onClick={() => void handleMyModelsImport()}>
                本地导入
              </button>
            </div>
          ) : (
            <div className="model-library-grid" role="list" aria-label="模型列表">
              {activeModelLibraryItems.map((item) => (
                activeModelLibraryCategoryId === "my-models" ? (
                  <div key={item.id} className="model-library-card-wrap">
                    <button
                      aria-label={`添加模型 ${item.name}`}
                      className="model-library-card"
                      type="button"
                      onClick={() => {
                        addObjectFromAsset(item.id);
                        setModelLibraryOpen(false);
                      }}
                    >
                      <span className="model-library-thumb" aria-hidden="true">
                        {item.thumbUrl ? (
                          <img
                            alt=""
                            aria-hidden="true"
                            className="model-library-thumb-image"
                            loading="lazy"
                            src={item.thumbUrl}
                          />
                        ) : (
                          <Boxes size={24} strokeWidth={1.6} />
                        )}
                      </span>
                      <span className="model-library-name">{item.name}</span>
                      {getModelLibraryCharacterStatus(item) ? (
                        <small className="model-library-character-status">{getModelLibraryCharacterStatus(item)}</small>
                      ) : null}
                    </button>
                    <button
                      aria-label={`删除模型 ${item.name}`}
                      className="model-library-card-delete"
                      type="button"
                      onClick={() => {
                        removeImportedAsset(item.id);
                      }}
                    >
                      <Trash2 aria-hidden="true" size={14} strokeWidth={1.9} />
                    </button>
                  </div>
                ) : (
                  <button
                    key={item.id}
                    aria-label={`添加模型 ${item.name}`}
                    className="model-library-card"
                    type="button"
                    onClick={() => {
                      addModelLibraryItem(item);
                    }}
                  >
                    <span className="model-library-thumb" aria-hidden="true">
                      {item.thumbUrl ? (
                        <img
                          alt=""
                          aria-hidden="true"
                          className="model-library-thumb-image"
                          loading="lazy"
                          src={item.thumbUrl}
                        />
                      ) : (
                        <Boxes size={24} strokeWidth={1.6} />
                      )}
                    </span>
                    <span className="model-library-name">{item.name}</span>
                    {getModelLibraryCharacterStatus(item) ? (
                      <small className="model-library-character-status">{getModelLibraryCharacterStatus(item)}</small>
                    ) : null}
                  </button>
                )
              ))}
              {activeModelLibraryCategoryId === "my-models" ? (
                <button
                  aria-label="本地导入"
                  className="model-library-card model-library-import-card"
                  type="button"
                  onClick={() => void handleMyModelsImport()}
                >
                  <span className="model-library-thumb model-library-thumb-import" aria-hidden="true">
                    <Plus size={28} strokeWidth={1.8} />
                  </span>
                  <span className="model-library-name">本地导入</span>
                </button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
      {aspectRatioPanelOpen ? (
        <div
          ref={aspectRatioPanelRef}
          className="viewport-aspect-panel"
          role="dialog"
          aria-label="比例"
          style={aspectRatioPanelStyle}
        >
          <h2 className="viewport-aspect-panel-title">比例</h2>
          <div className="viewport-aspect-panel-grid" role="group" aria-label="画幅比例选项">
            {VIEWPORT_ASPECT_RATIO_OPTIONS.map((option) => {
              const active = option.id === viewportAspectRatio;
              const frameClassName = `viewport-aspect-option-frame viewport-aspect-option-frame-${option.id.replace(":", "-")}`;

              return (
                <button
                  key={option.id}
                  aria-pressed={active}
                  className={`viewport-aspect-option${active ? " is-active" : ""}`}
                  type="button"
                  onClick={() => selectAspectRatio(option.id)}
                >
                  <span className={frameClassName} aria-hidden="true" />
                  <span className="viewport-aspect-option-label">{option.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      {pendingCharacterImport ? (
        <div className="character-import-dialog" role="dialog" aria-label="人物模型体检结果">
          <div className="character-import-dialog-header">
            <div>
              <h2>人物模型体检</h2>
              <p>{pendingCharacterImport.file.name}</p>
            </div>
            <button
              aria-label="关闭人物模型体检"
              className="top-bar-action-button"
              type="button"
              onClick={() => setPendingCharacterImport(null)}
            >
              <X aria-hidden="true" size={16} />
            </button>
          </div>
          <div className={`character-import-status is-${pendingCharacterImport.report.readiness}`}>
            {CHARACTER_IMPORT_STATUS_LABELS[pendingCharacterImport.report.readiness]}
          </div>
          {(() => {
            const boneMap = pendingCharacterImport.boneMap ?? {};
            const mappingCount = Object.keys(boneMap).length;
            const canAddAsCharacter = canImportCharacterFromInspection(
              pendingCharacterImport.report,
              boneMap
            );
            const boneNames = pendingCharacterImport.report.boneNames ?? [];

            return <>
          <dl className="character-import-metrics">
            <div><dt>骨架</dt><dd>{pendingCharacterImport.report.primaryBoneCount} 根骨骼</dd></div>
            <div><dt>身体识别</dt><dd>{mappingCount + 1}/16</dd></div>
            <div><dt>可播放动作</dt><dd>{pendingCharacterImport.report.playableAnimationCount} 个</dd></div>
            <div><dt>站立方向</dt><dd>{pendingCharacterImport.report.uprightAxis.toUpperCase()} 轴</dd></div>
          </dl>
          {pendingCharacterImport.report.readiness === "manual-mapping" ? (
            <section className="character-import-mapping" aria-label="手动骨架映射">
              <div className="character-import-mapping-header">
                <strong>补全骨架映射</strong>
                <span>{mappingCount}/15</span>
              </div>
              <p>只需把下面主要部位对应到模型骨骼，完成后即可跟拍和使用外部动作。</p>
              <div className="character-import-mapping-grid">
                {DIRECTOR_CHARACTER_BONE_PART_OPTIONS.map((part) => (
                  <label key={part.value}>
                    <span>{part.label}</span>
                    <select
                      aria-label={`映射 ${part.label}`}
                      value={boneMap[part.value] ?? ""}
                      onChange={(event) => setPendingCharacterImport((current) => current
                        ? {
                            ...current,
                            boneMap: {
                              ...current.boneMap,
                              [part.value]: event.target.value || undefined,
                            },
                          }
                        : current)}
                    >
                      <option value="">未映射</option>
                      {boneNames.map((boneName) => <option key={boneName} value={boneName}>{boneName}</option>)}
                    </select>
                  </label>
                ))}
              </div>
            </section>
          ) : null}
          {pendingCharacterImport.report.warnings.length ? (
            <ul className="character-import-warnings">
              {pendingCharacterImport.report.warnings.map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          ) : (
            <p className="character-import-ready-copy">骨架和身体部位识别完整，可以直接加入场景。</p>
          )}
          {characterImportError ? <p className="character-import-error">{characterImportError}</p> : null}
          <div className="character-import-actions">
            <button type="button" onClick={() => setPendingCharacterImport(null)}>取消</button>
            {canAddAsCharacter ? (
              <button
                className="is-primary"
                disabled={characterImportBusy}
                type="button"
                onClick={() => void confirmCharacterImport("character")}
              >
                {characterImportBusy ? "正在导入..." : "作为人物加入"}
              </button>
            ) : (
              <button
                className="is-primary"
                disabled={characterImportBusy || pendingCharacterImport.report.readiness === "manual-mapping"}
                type="button"
                onClick={() => void confirmCharacterImport("prop")}
              >
                {characterImportBusy ? "正在导入..." : pendingCharacterImport.report.readiness === "manual-mapping" ? "补全映射后作为人物加入" : "作为静态道具加入"}
              </button>
            )}
          </div>
            </>;
          })()}
        </div>
      ) : null}
      {characterImportError && !pendingCharacterImport ? (
        <div className="character-import-toast" role="alert">{characterImportError}</div>
      ) : null}
      {characterImportPreview ? (
        <div className="character-import-preview-bar" role="status" aria-label="人物动作自动自检">
          <div>
            <strong>人物动作自检</strong>
            <span>
              正在预览：{characterImportPreview.steps[characterImportPreview.stepIndex]?.label}
              {` ${characterImportPreview.stepIndex + 1}/${characterImportPreview.steps.length}`}
            </span>
          </div>
          <div className="character-import-preview-steps" aria-hidden="true">
            {characterImportPreview.steps.map((step, index) => (
              <i key={`${step.actionPresetId}-${index}`} className={index <= characterImportPreview.stepIndex ? "is-active" : undefined} />
            ))}
          </div>
          <button type="button" onClick={stopCharacterImportPreview}>跳过</button>
        </div>
      ) : null}
      <input
        ref={sceneLocalModelInputRef}
        aria-hidden="true"
        className="hidden-file-input"
        data-testid="scene-local-model-input"
        tabIndex={-1}
        accept=".fbx,.obj,.glb"
        type="file"
        onChange={(event) => void handleLocalModelChange(event, true)}
      />
      <input
        ref={characterLocalModelInputRef}
        aria-hidden="true"
        className="hidden-file-input"
        data-testid="character-local-model-input"
        tabIndex={-1}
        accept=".fbx,.glb"
        type="file"
        onChange={(event) => void handleCharacterModelChange(event)}
      />
      <input
        ref={libraryLocalModelInputRef}
        aria-hidden="true"
        className="hidden-file-input"
        data-testid="library-local-model-input"
        tabIndex={-1}
        accept=".fbx,.obj,.glb"
        multiple
        type="file"
        onChange={(event) => void handleLocalModelChange(event, false)}
      />
    </>
  );
}
