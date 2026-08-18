import { afterEach, beforeEach, vi } from "vitest";
import { createDefaultDirectorProject, createInitialDirectorState, useDirectorStore } from "../directorStore";
import { selectRightPanelKind } from "../directorSelectors";
import { getCameraRigPositionFromViewSnapshot } from "../../schema/cameraGeometry";
import {
  DEFAULT_VIEWPORT_ROTATE_SENSITIVITY,
  DEFAULT_VIEWPORT_ZOOM_SENSITIVITY,
} from "../../schema/viewportSensitivity";
import { getRuntimePlaybackProgress, setRuntimePlaybackProgress } from "../../runtime/playbackRuntime";

function createMemoryStorage(): Storage {
  const storage = new Map<string, string>();

  return {
    get length() {
      return storage.size;
    },
    clear: () => storage.clear(),
    getItem: (key) => storage.get(key) ?? null,
    key: (index) => Array.from(storage.keys())[index] ?? null,
    removeItem: (key) => {
      storage.delete(key);
    },
    setItem: (key, value) => {
      storage.set(key, String(value));
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  useDirectorStore.getState().openScopedScene(null);
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
    clipboard: [],
    clipboardPasteCount: 0,
    undoStack: [],
    undoBatchDepth: 0,
    undoBatchSnapshot: null,
    undoBatchHasTrackedChanges: false,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("seeds the demo with one mannequin role and one camera", () => {
  const state = createInitialDirectorState();
  const defaultCharacter = state.project.objects.find((item) => item.kind === "character");
  const defaultCameraObject = state.project.objects.find((item) => item.kind === "camera");

  expect(state.viewMode).toBe("director");
  expect(state.viewportAspectRatio).toBe("auto");
  expect(state.viewportRuleOfThirdsEnabled).toBe(false);
  expect(state.viewportRotateSensitivity).toBe(DEFAULT_VIEWPORT_ROTATE_SENSITIVITY);
  expect(state.viewportZoomSensitivity).toBe(DEFAULT_VIEWPORT_ZOOM_SENSITIVITY);
  expect(state.project.scene.backgroundColor).toBe("#000000");
  expect(defaultCharacter?.name).toBe("角色01");
  expect(defaultCameraObject?.name).toBe("机位01");
  expect(state.project.cameras[0]?.name).toBe("机位01");
  expect(state.project.objects.some((item) => item.kind === "character")).toBe(true);
  expect(state.project.cameras).toHaveLength(1);
  expect(state.project.cameras[0]?.motionPath).toEqual({
    duration: 6,
    loop: false,
    interpolation: "smooth",
    easing: "ease-in-out",
    speedMode: "soft",
    customEasing: [0, 0, 1, 1],
    keyframes: [],
  });
});

it("records live pilot snapshots as ordered camera waypoints", () => {
  useDirectorStore.setState(createInitialDirectorState());

  const firstId = useDirectorStore.getState().recordCameraMotionSnapshot("cam_1", {
    position: [1, 2, 3],
    target: [0, 1, 0],
    fov: 48,
  });
  const secondId = useDirectorStore.getState().recordCameraMotionSnapshot("cam_1", {
    position: [4, 5, 6],
    target: [2, 1, 0],
    fov: 36,
  });

  expect(firstId).toBe("cam_1_motion_key_1");
  expect(secondId).toBe("cam_1_motion_key_2");
  expect(useDirectorStore.getState().project.cameras[0].motionPath?.keyframes).toMatchObject([
    { id: firstId, time: 0, position: [1, 2, 3], target: [0, 1, 0], fov: 48 },
    { id: secondId, time: 1, position: [4, 5, 6], target: [2, 1, 0], fov: 36 },
  ]);
});

it("updates a waypoint entered for adjustment without appending a duplicate", () => {
  useDirectorStore.setState(createInitialDirectorState());
  const keyframeId = useDirectorStore.getState().recordCameraMotionSnapshot("cam_1", {
    position: [1, 2, 3],
    target: [0, 1, 0],
    fov: 48,
  });

  useDirectorStore.getState().recordCameraMotionSnapshot(
    "cam_1",
    { position: [9, 8, 7], target: [1, 1, 1], fov: 30 },
    keyframeId
  );

  expect(useDirectorStore.getState().project.cameras[0].motionPath?.keyframes).toMatchObject([
    { id: keyframeId, time: 0, position: [9, 8, 7], target: [1, 1, 1], fov: 30 },
  ]);
});

it("records pilot waypoints at the shared action time without pausing playback", () => {
  useDirectorStore.setState({
    ...createInitialDirectorState(),
    cameraMotionPlaying: true,
    cameraMotionProgress: 0.4,
  });

  const firstId = useDirectorStore.getState().recordCameraMotionSnapshot(
    "cam_1",
    { position: [2, 3, 7], target: [0, 1, 0], fov: 46 },
    null,
    0.4
  );
  const secondId = useDirectorStore.getState().recordCameraMotionSnapshot(
    "cam_1",
    { position: [5, 2, 4], target: [1, 1, 0], fov: 38 },
    null,
    0.75
  );

  expect(useDirectorStore.getState().cameraMotionPlaying).toBe(true);
  expect(useDirectorStore.getState().project.cameras[0].motionPath?.keyframes).toMatchObject([
    { id: firstId, time: 0.4, position: [2, 3, 7] },
    { id: secondId, time: 0.75, position: [5, 2, 4] },
  ]);
});

it("appends another waypoint at a nearby shared time unless an edit id was explicitly supplied", () => {
  useDirectorStore.setState({
    ...createInitialDirectorState(),
    cameraMotionPlaying: true,
  });
  const keyframeId = useDirectorStore.getState().recordCameraMotionSnapshot(
    "cam_1",
    { position: [1, 2, 3], target: [0, 1, 0], fov: 48 },
    null,
    0.5
  );

  const updatedId = useDirectorStore.getState().recordCameraMotionSnapshot(
    "cam_1",
    { position: [9, 8, 7], target: [1, 1, 1], fov: 30 },
    null,
    0.503
  );

  expect(updatedId).not.toBe(keyframeId);
  expect(useDirectorStore.getState().cameraMotionPlaying).toBe(true);
  expect(useDirectorStore.getState().project.cameras[0].motionPath?.keyframes).toMatchObject([
    { id: keyframeId, time: 0.5, position: [1, 2, 3], target: [0, 1, 0], fov: 48 },
    { id: updatedId, time: 0.503, position: [9, 8, 7], target: [1, 1, 1], fov: 30 },
  ]);
});

it("moves a waypoint and retimes the route in its new order", () => {
  useDirectorStore.setState(createInitialDirectorState());
  const store = useDirectorStore.getState();
  const firstId = store.recordCameraMotionSnapshot("cam_1", { position: [1, 0, 0], target: [0, 0, 0], fov: 50 });
  const secondId = useDirectorStore.getState().recordCameraMotionSnapshot("cam_1", { position: [2, 0, 0], target: [0, 0, 0], fov: 50 });
  const thirdId = useDirectorStore.getState().recordCameraMotionSnapshot("cam_1", { position: [3, 0, 0], target: [0, 0, 0], fov: 50 });

  useDirectorStore.getState().moveCameraMotionKeyframe("cam_1", thirdId!, -1);

  expect(useDirectorStore.getState().project.cameras[0].motionPath?.keyframes.map((item) => [item.id, item.time])).toEqual([
    [firstId, 0],
    [thirdId, 0.5],
    [secondId, 1],
  ]);
});

it("records character and prop transforms on the shared camera timeline", () => {
  useDirectorStore.setState(createInitialDirectorState());
  const characterId = "char_default_a";

  useDirectorStore.getState().addObjectMotionKeyframe(characterId, 0);
  useDirectorStore.getState().updateObjectTransform(characterId, { position: [6, 0, -2] });
  useDirectorStore.getState().addObjectMotionKeyframe(characterId, 0.75);

  expect(useDirectorStore.getState().project.objects.find((item) => item.id === characterId)?.motionPath?.keyframes).toMatchObject([
    { time: 0, transform: { position: [0, 0, 0] } },
    { time: 0.75, transform: { position: [6, 0, -2] } },
  ]);
});

it("updates an object keyframe when recording again at the same time", () => {
  useDirectorStore.setState(createInitialDirectorState());
  const characterId = "char_default_a";
  useDirectorStore.getState().addObjectMotionKeyframe(characterId, 0.4);
  useDirectorStore.getState().updateObjectTransform(characterId, { position: [2, 0, 1] });
  useDirectorStore.getState().addObjectMotionKeyframe(characterId, 0.4);

  const keyframes = useDirectorStore.getState().project.objects.find((item) => item.id === characterId)?.motionPath?.keyframes;
  expect(keyframes).toHaveLength(1);
  expect(keyframes?.[0].transform.position).toEqual([2, 0, 1]);
});

it("inserts and edits a character route point", () => {
  useDirectorStore.setState(createInitialDirectorState());
  const characterId = "char_default_a";
  const startId = useDirectorStore.getState().addObjectMotionKeyframe(characterId, 0)!;
  useDirectorStore.getState().updateObjectTransform(characterId, { position: [6, 0, 0] });
  useDirectorStore.getState().addObjectMotionKeyframe(characterId, 1);

  const insertedId = useDirectorStore.getState().insertObjectMotionKeyframeAfter(characterId, startId)!;
  useDirectorStore.getState().updateObjectMotionKeyframe(characterId, insertedId, {
    actionPresetId: "run-cycle",
    facingMode: "manual",
    transform: { position: [2, 0, 1] },
  });

  const keyframes = useDirectorStore.getState().project.objects.find((item) => item.id === characterId)?.motionPath?.keyframes;
  expect(keyframes).toMatchObject([
    { id: startId, time: 0, facingMode: "path" },
    { id: insertedId, time: .5, actionPresetId: "run-cycle", facingMode: "manual", transform: { position: [2, 0, 1] } },
    { time: 1 },
  ]);
  expect(useDirectorStore.getState().selectedObjectMotionKeyframeId).toBe(insertedId);
});

it("adds character route points without overwriting an existing point", () => {
  useDirectorStore.setState(createInitialDirectorState());
  const characterId = "char_default_a";
  const firstId = useDirectorStore.getState().addCharacterRoutePoint(characterId);
  const secondId = useDirectorStore.getState().addCharacterRoutePoint(characterId);
  const path = useDirectorStore.getState().project.objects.find((item) => item.id === characterId)?.motionPath;

  expect(path?.keyframes).toMatchObject([
    { id: firstId, time: 0, transform: { position: [0, 0, 0] } },
    { id: secondId, time: 1, facingMode: "path", transform: { position: [0, 0, 1.5] } },
  ]);
  expect(useDirectorStore.getState().selectedObjectMotionKeyframeId).toBe(secondId);
});

it("stores character point holds and switches manual arrival edits to custom timing", () => {
  useDirectorStore.setState(createInitialDirectorState());
  const characterId = "char_default_a";
  const firstId = useDirectorStore.getState().addCharacterRoutePoint(characterId)!;
  useDirectorStore.getState().addCharacterRoutePoint(characterId);

  useDirectorStore.getState().updateObjectMotionKeyframe(characterId, firstId, {
    time: 0.15,
    pointBehavior: "hold",
    holdSeconds: 1.5,
    holdAction: "custom",
    holdActionPresetId: "wave-cycle",
  });

  const path = useDirectorStore.getState().project.objects.find((item) => item.id === characterId)?.motionPath;
  expect(path?.speedMode).toBe("custom");
  expect(path?.keyframes.find((keyframe) => keyframe.id === firstId)).toMatchObject({
    time: 0.15,
    pointBehavior: "hold",
    holdSeconds: 1.5,
    holdAction: "custom",
    holdActionPresetId: "wave-cycle",
  });
});

it("updates the viewport aspect ratio selection in ui state", () => {
  useDirectorStore.setState(createInitialDirectorState());

  useDirectorStore.getState().setViewportAspectRatio("9:16");

  expect(useDirectorStore.getState().viewportAspectRatio).toBe("9:16");
});

it("updates the viewport rule-of-thirds guide toggle in ui state", () => {
  useDirectorStore.setState(createInitialDirectorState());

  useDirectorStore.getState().setViewportRuleOfThirdsEnabled(true);

  expect(useDirectorStore.getState().viewportRuleOfThirdsEnabled).toBe(true);
});

it("stores and clamps the finished-shot FOV override and can return to waypoint FOV", () => {
  useDirectorStore.getState().setFinishedShotFov(200);
  expect(useDirectorStore.getState().finishedShotFov).toBe(120);

  useDirectorStore.getState().setFinishedShotFov(35);
  expect(useDirectorStore.getState().finishedShotFov).toBe(35);

  useDirectorStore.getState().setFinishedShotFov(null);
  expect(useDirectorStore.getState().finishedShotFov).toBeNull();
});

it("stores the monitor FOV separately from the finished-shot FOV", () => {
  useDirectorStore.getState().setFinishedShotFov(35);
  useDirectorStore.getState().setMotionMonitorFov(200);

  expect(useDirectorStore.getState().finishedShotFov).toBe(35);
  expect(useDirectorStore.getState().motionMonitorFov).toBe(120);

  useDirectorStore.getState().setMotionMonitorFov(null);
  expect(useDirectorStore.getState().motionMonitorFov).toBeNull();
  expect(useDirectorStore.getState().finishedShotFov).toBe(35);
});

it("undoes an active drag batch immediately without leaving the batch stuck", () => {
  const characterId = "char_default_a";
  useDirectorStore.getState().beginUndoBatch();
  useDirectorStore.getState().updateObjectTransform(characterId, { position: [8, 0, 0] });

  useDirectorStore.getState().undo();

  const state = useDirectorStore.getState();
  expect(state.project.objects.find((item) => item.id === characterId)?.transform.position).toEqual([0, 0, 0]);
  expect((state as unknown as { undoBatchDepth: number }).undoBatchDepth).toBe(0);
});

it("updates, clamps, and resets the saved viewport sensitivity", () => {
  useDirectorStore.setState(createInitialDirectorState());

  useDirectorStore.getState().setViewportRotateSensitivity(0.8);
  useDirectorStore.getState().setViewportZoomSensitivity(0.65);

  expect(useDirectorStore.getState().viewportRotateSensitivity).toBe(0.8);
  expect(useDirectorStore.getState().viewportZoomSensitivity).toBe(0.65);

  useDirectorStore.getState().setViewportRotateSensitivity(99);
  useDirectorStore.getState().setViewportZoomSensitivity(-99);

  expect(useDirectorStore.getState().viewportRotateSensitivity).toBe(1.5);
  expect(useDirectorStore.getState().viewportZoomSensitivity).toBe(0.1);

  useDirectorStore.getState().resetViewportSensitivity();

  expect(useDirectorStore.getState().viewportRotateSensitivity).toBe(DEFAULT_VIEWPORT_ROTATE_SENSITIVITY);
  expect(useDirectorStore.getState().viewportZoomSensitivity).toBe(DEFAULT_VIEWPORT_ZOOM_SENSITIVITY);
});

it("persists and normalizes the performance profile", () => {
  useDirectorStore.setState(createInitialDirectorState());
  expect(useDirectorStore.getState().performanceProfile).toBe("auto");

  useDirectorStore.getState().setPerformanceProfile("fluid");
  expect(useDirectorStore.getState().performanceProfile).toBe("fluid");

  const persisted = JSON.parse(localStorage.getItem("storyai-3d-director-desk-demo") ?? "{}") as {
    performanceProfile?: string;
  };
  expect(persisted.performanceProfile).toBe("fluid");
});

it("toggles the viewport side panel collapse flag in ui state", () => {
  useDirectorStore.setState(createInitialDirectorState());

  type CollapseUiState = ReturnType<typeof useDirectorStore.getState> & {
    viewportPanelsCollapsed?: boolean;
    toggleViewportPanelsCollapsed?: () => void;
  };
  const state = useDirectorStore.getState() as CollapseUiState;

  expect(state.viewportPanelsCollapsed ?? false).toBe(false);

  state.toggleViewportPanelsCollapsed?.();

  expect((useDirectorStore.getState() as CollapseUiState).viewportPanelsCollapsed ?? false).toBe(true);
});

it("routes the right panel by object type and view mode", () => {
  const state = createInitialDirectorState();
  const characterId = state.project.objects.find((item) => item.kind === "character")!.id;
  const cameraObjectId = state.project.objects.find((item) => item.kind === "camera")!.id;
  const propState = {
    ...state,
    selectedObjectId: "prop_model_1",
    project: {
      ...state.project,
      objects: [
        ...state.project.objects,
        {
          id: "prop_model_1",
          name: "自动取款机",
          kind: "prop" as const,
          visible: true,
          locked: false,
          assetRefId: "asset_model_1",
          transform: {
            position: [0, 0, 0] as [number, number, number],
            rotation: [0, 0, 0] as [number, number, number],
            scale: [1, 1, 1] as [number, number, number],
          },
        },
      ],
      assets: [
        ...state.project.assets,
        {
          id: "asset_model_1",
          kind: "prop" as const,
          sourceType: "model" as const,
          fileName: "ATM_low.fbx",
          url: "blob:atm",
        },
      ],
    },
  };

  expect(selectRightPanelKind(state)).toBe("scene");
  expect(selectRightPanelKind({ ...state, selectedObjectId: characterId })).toBe("character");
  expect(selectRightPanelKind({ ...state, selectedObjectId: cameraObjectId })).toBe("camera");
  expect(selectRightPanelKind(propState)).toBe("prop");
  expect(selectRightPanelKind({ ...state, viewMode: "camera", selectedObjectId: null })).toBe("camera");
});

it("routes a selected crowd group to the role panel", () => {
  const state = createInitialDirectorState();

  expect(selectRightPanelKind({ ...state, selectedCrowdId: "crowd_1" })).toBe("character");
});

it("routes older model-backed scene objects to the model panel", () => {
  const state = createInitialDirectorState();

  expect(
    selectRightPanelKind({
      ...state,
      selectedObjectId: "obj_scene_model_1",
      project: {
        ...state.project,
        assets: [
          {
            id: "asset_scene_model_1",
            kind: "scene",
            sourceType: "model",
            fileName: "microwave_low.fbx",
            url: "blob:microwave",
          },
        ],
        objects: [
          ...state.project.objects,
          {
            id: "obj_scene_model_1",
            name: "微波炉",
            kind: "scene",
            visible: true,
            locked: false,
            assetRefId: "asset_scene_model_1",
            transform: {
              position: [0, 0, 0],
              rotation: [0, 0, 0],
              scale: [1, 1, 1],
            },
          },
        ],
      },
    })
  ).toBe("prop");
});

it("defaults generated characters to the male mannequin body type", () => {
  const project = createDefaultDirectorProject();
  const character = project.objects.find((item) => item.kind === "character");

  expect(character?.bodyType).toBe("mannequin");
});

it("adds preset characters with a requested body type", () => {
  useDirectorStore.setState(createInitialDirectorState());

  useDirectorStore.getState().addPresetCharacter("female");

  const characters = useDirectorStore.getState().project.objects.filter((item) => item.kind === "character");
  const added = characters[characters.length - 1];

  expect(added?.bodyType).toBe("female");
  expect(added?.name).toBe("角色02");
  expect(added?.characterRig?.rigType).toBe("ue4-mannequin");
  expect(useDirectorStore.getState().selectedObjectId).toBe(added?.id);
});

it("adds camera shots with two-digit camera names", () => {
  useDirectorStore.setState(createInitialDirectorState());

  useDirectorStore.getState().addCameraShot();

  const state = useDirectorStore.getState();

  expect(state.project.cameras.map((camera) => camera.name)).toEqual(["机位01", "机位02"]);
  expect(state.project.objects.filter((item) => item.kind === "camera").map((item) => item.name)).toEqual([
    "机位01",
    "机位02",
  ]);
  expect(state.project.cameras[1]?.motionPath?.keyframes).toEqual([]);
});

it("creates one hidden motion camera without adding a scene camera object", () => {
  const state = createInitialDirectorState();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...state,
    project: {
      ...state.project,
      cameras: [],
      activeCameraId: null,
      objects: state.project.objects.filter((item) => item.kind !== "camera"),
    },
  });

  const firstId = useDirectorStore.getState().ensureMotionCamera({
    position: [4, 3, 2],
    target: [0, 1, -1],
    fov: 45,
  });
  const secondId = useDirectorStore.getState().ensureMotionCamera();
  const nextState = useDirectorStore.getState();

  expect(secondId).toBe(firstId);
  expect(nextState.project.cameras).toHaveLength(1);
  expect(nextState.project.cameras[0]).toMatchObject({ id: firstId, isVirtual: true, name: "自动运镜镜头" });
  expect(nextState.project.objects.some((item) => item.kind === "camera")).toBe(false);
});

it("captures camera positions as evenly timed motion keyframes", () => {
  useDirectorStore.setState(createInitialDirectorState());

  const firstKeyframeId = useDirectorStore.getState().addCameraMotionKeyframe("cam_1");
  const camera = useDirectorStore.getState().project.cameras[0];
  useDirectorStore.getState().updateCamera("cam_1", {
    transform: {
      ...camera.transform,
      position: [4, 3, -2],
    },
    fov: 36,
  });
  const secondKeyframeId = useDirectorStore.getState().addCameraMotionKeyframe("cam_1");

  const state = useDirectorStore.getState();
  const keyframes = state.project.cameras[0].motionPath?.keyframes ?? [];

  expect(firstKeyframeId).toBe("cam_1_motion_key_1");
  expect(secondKeyframeId).toBe("cam_1_motion_key_2");
  expect(keyframes.map((keyframe) => keyframe.time)).toEqual([0, 1]);
  expect(keyframes[0].position).toEqual(camera.transform.position);
  expect(keyframes[1]).toMatchObject({ position: [4, 3, -2], fov: 36 });
  expect(state.selectedCameraKeyframeId).toBe(secondKeyframeId);
  expect(state.cameraMotionProgress).toBe(1);
});

it("updates and deletes camera motion keyframes while keeping timing normalized", () => {
  useDirectorStore.setState(createInitialDirectorState());

  const firstKeyframeId = useDirectorStore.getState().addCameraMotionKeyframe("cam_1")!;
  const camera = useDirectorStore.getState().project.cameras[0];
  useDirectorStore.getState().updateCamera("cam_1", {
    transform: { ...camera.transform, position: [2, 4, 1] },
  });
  const middleKeyframeId = useDirectorStore.getState().addCameraMotionKeyframe("cam_1")!;
  useDirectorStore.getState().updateCamera("cam_1", {
    transform: { ...camera.transform, position: [-3, 2, -4] },
  });
  const lastKeyframeId = useDirectorStore.getState().addCameraMotionKeyframe("cam_1")!;

  useDirectorStore.getState().updateCameraMotionKeyframe("cam_1", middleKeyframeId, {
    position: [8, 6, 4],
    fov: 28,
  });

  expect(
    useDirectorStore
      .getState()
      .project.cameras[0].motionPath?.keyframes.find((keyframe) => keyframe.id === middleKeyframeId)
  ).toMatchObject({ position: [8, 6, 4], fov: 28 });

  useDirectorStore.getState().deleteCameraMotionKeyframe("cam_1", middleKeyframeId);

  const remaining = useDirectorStore.getState().project.cameras[0].motionPath?.keyframes ?? [];
  expect(remaining.map((keyframe) => keyframe.id)).toEqual([firstKeyframeId, lastKeyframeId]);
  expect(remaining.map((keyframe) => keyframe.time)).toEqual([0, 1]);
  expect(useDirectorStore.getState().selectedCameraKeyframeId).toBe(lastKeyframeId);
});

it("stores camera waypoint holds and switches manual arrival edits to custom timing", () => {
  useDirectorStore.setState(createInitialDirectorState());
  const firstId = useDirectorStore.getState().addCameraMotionKeyframe("cam_1")!;
  useDirectorStore.getState().updateCamera("cam_1", {
    transform: { ...useDirectorStore.getState().project.cameras[0].transform, position: [4, 2, 0] },
  });
  useDirectorStore.getState().addCameraMotionKeyframe("cam_1");

  useDirectorStore.getState().updateCameraMotionKeyframe("cam_1", firstId, {
    time: 0.1,
    pointBehavior: "hold",
    holdSeconds: 1.25,
  });

  const path = useDirectorStore.getState().project.cameras[0].motionPath;
  expect(path?.speedMode).toBe("custom");
  expect(path?.keyframes.find((keyframe) => keyframe.id === firstId)).toMatchObject({
    time: 0.1,
    pointBehavior: "hold",
    holdSeconds: 1.25,
  });
});

it("inserts a camera waypoint halfway between two existing points without retiming the rest", () => {
  useDirectorStore.setState(createInitialDirectorState());
  const firstId = useDirectorStore.getState().recordCameraMotionSnapshot(
    "cam_1",
    { position: [0, 2, 8], target: [0, 1, 0], fov: 50 },
    null,
    0
  )!;
  useDirectorStore.getState().recordCameraMotionSnapshot(
    "cam_1",
    { position: [8, 4, 0], target: [2, 1, 0], fov: 30 },
    null,
    1
  );
  useDirectorStore.getState().updateCameraMotionPath("cam_1", {
    interpolation: "linear",
    easing: "linear",
  });

  const insertedId = useDirectorStore.getState().insertCameraMotionKeyframeAfter("cam_1", firstId);
  const state = useDirectorStore.getState();
  const keyframes = state.project.cameras[0].motionPath?.keyframes ?? [];

  expect(insertedId).toBeTruthy();
  expect(keyframes.map((keyframe) => keyframe.time)).toEqual([0, 0.5, 1]);
  expect(keyframes[1]).toMatchObject({
    id: insertedId,
    position: [4, 3, 4],
    target: [1, 1, 0],
    fov: 40,
  });
  expect(state.selectedCameraKeyframeIds).toEqual([insertedId]);
  expect(state.cameraMotionProgress).toBe(0.5);
});

it("preserves matching body tracking when inserting a camera waypoint", () => {
  useDirectorStore.setState(createInitialDirectorState());
  const firstId = useDirectorStore.getState().recordCameraMotionSnapshot(
    "cam_1",
    { position: [0, 2, 8], target: [0, 1, 0], fov: 50 },
    null,
    0
  )!;
  const secondId = useDirectorStore.getState().recordCameraMotionSnapshot(
    "cam_1",
    { position: [4, 2, 4], target: [0, 1, 0], fov: 50 },
    null,
    1
  )!;
  for (const keyframeId of [firstId, secondId]) {
    useDirectorStore.getState().updateCameraMotionKeyframe("cam_1", keyframeId, {
      targetMode: "object",
      targetObjectId: "char_default_a",
      targetBodyPart: "rightHand",
      targetFollowMode: "smooth",
    });
  }

  const insertedId = useDirectorStore.getState().insertCameraMotionKeyframeAfter("cam_1", firstId);
  const inserted = useDirectorStore.getState().project.cameras[0].motionPath?.keyframes
    .find((keyframe) => keyframe.id === insertedId);

  expect(inserted).toMatchObject({
    targetMode: "object",
    targetObjectId: "char_default_a",
    targetBodyPart: "rightHand",
    targetFollowMode: "smooth",
  });
});

it("moves any selected camera waypoints together while preserving their direction and timing", () => {
  useDirectorStore.setState(createInitialDirectorState());
  const firstId = useDirectorStore.getState().recordCameraMotionSnapshot(
    "cam_1",
    { position: [0, 2, 8], target: [0, 1, 0], fov: 50 },
    null,
    0
  )!;
  const middleId = useDirectorStore.getState().recordCameraMotionSnapshot(
    "cam_1",
    { position: [3, 3, 4], target: [1, 1, 0], fov: 45 },
    null,
    0.5
  )!;
  const lastId = useDirectorStore.getState().recordCameraMotionSnapshot(
    "cam_1",
    { position: [6, 2, 0], target: [2, 1, 0], fov: 40 },
    null,
    1
  )!;
  useDirectorStore.getState().setCameraMotionKeyframeSelection([firstId, lastId]);

  useDirectorStore.getState().translateSelectedCameraMotionKeyframes("cam_1", [2, -1, 3]);

  const keyframes = useDirectorStore.getState().project.cameras[0].motionPath?.keyframes ?? [];
  expect(keyframes.find((item) => item.id === firstId)).toMatchObject({
    time: 0,
    position: [2, 1, 11],
    target: [2, 0, 3],
  });
  expect(keyframes.find((item) => item.id === middleId)).toMatchObject({
    time: 0.5,
    position: [3, 3, 4],
    target: [1, 1, 0],
  });
  expect(keyframes.find((item) => item.id === lastId)).toMatchObject({
    time: 1,
    position: [8, 1, 3],
    target: [4, 0, 3],
  });
});

it("keeps the default character blue and gives newly added characters distinct colors", () => {
  useDirectorStore.setState(createInitialDirectorState());

  useDirectorStore.getState().addPresetCharacter("female");
  useDirectorStore.getState().addPresetCharacter("teen");

  const characters = useDirectorStore.getState().project.objects.filter((item) => item.kind === "character");

  expect(characters[0].color).toBe("#4F8EF7");
  expect(new Set(characters.map((item) => item.color)).size).toBe(characters.length);
});

it("places newly added preset characters far enough from the default role to avoid overlap", () => {
  useDirectorStore.setState(createInitialDirectorState());

  useDirectorStore.getState().addPresetCharacter("female");
  useDirectorStore.getState().addPresetCharacter("teen");

  const characters = useDirectorStore.getState().project.objects.filter((item) => item.kind === "character");
  const defaultRole = characters.find((item) => item.id === "char_default_a");
  const role02 = characters.find((item) => item.name === "角色02");
  const role03 = characters.find((item) => item.name === "角色03");

  expect(defaultRole?.transform.position).toEqual([0, 0, 0]);
  expect(role02?.transform.position).toEqual([-1.25, 0, 0]);
  expect(role03?.transform.position).toEqual([1.25, 0, 0]);
});

it("adds selected geometry primitives as light blue-white prop objects", () => {
  useDirectorStore.setState(createInitialDirectorState());

  useDirectorStore.getState().addGeometryPrimitive("torus");

  const prop = useDirectorStore.getState().project.objects.find((item) => item.kind === "prop");

  expect(prop?.name).toBe("环状体");
  expect(prop?.geometryType).toBe("torus");
  expect(prop?.color).toBe("#d7e7ff");
  expect(useDirectorStore.getState().selectedObjectId).toBe(prop?.id);
});

it("deletes the selected list object and linked camera data", () => {
  useDirectorStore.setState(createInitialDirectorState());
  useDirectorStore.getState().addCameraShot();

  expect(useDirectorStore.getState().project.cameras).toHaveLength(2);

  useDirectorStore.getState().deleteSelectedObject();

  const state = useDirectorStore.getState();

  expect(state.selectedObjectId).toBeNull();
  expect(state.project.objects.some((item) => item.id === "cam_object_2")).toBe(false);
  expect(state.project.cameras.some((item) => item.id === "cam_2")).toBe(false);
  expect(state.project.activeCameraId).toBe("cam_1");
});

it("supports multi-selecting objects and deleting the selected set", () => {
  useDirectorStore.setState(createInitialDirectorState());
  useDirectorStore.getState().addPresetCharacter("female");

  useDirectorStore.getState().selectObject("char_default_a");
  useDirectorStore.getState().toggleObjectSelection("char_preset_2");

  expect(useDirectorStore.getState().selectedObjectId).toBe("char_preset_2");
  expect(useDirectorStore.getState().selectedObjectIds).toEqual(["char_default_a", "char_preset_2"]);

  useDirectorStore.getState().deleteSelectedObject();

  const state = useDirectorStore.getState();

  expect(state.selectedObjectId).toBeNull();
  expect(state.selectedObjectIds).toEqual([]);
  expect(state.project.objects.some((item) => item.id === "char_default_a")).toBe(false);
  expect(state.project.objects.some((item) => item.id === "char_preset_2")).toBe(false);
});

it("updates a character body type without changing transform or color", () => {
  useDirectorStore.setState(createInitialDirectorState());
  const character = useDirectorStore.getState().project.objects.find((item) => item.kind === "character");
  expect(character).toBeTruthy();

  useDirectorStore.getState().updateObjectColor(character!.id, "#123456");
  useDirectorStore.getState().updateObjectTransform(character!.id, { position: [1, 2, 3] });
  useDirectorStore.getState().updateCharacterBodyType(character!.id, "chibi");

  const updated = useDirectorStore.getState().project.objects.find((item) => item.id === character!.id);
  expect(updated?.bodyType).toBe("chibi");
  expect(updated?.color).toBe("#123456");
  expect(updated?.transform.position).toEqual([1, 2, 3]);
});

it("keeps imported local models separate from procedural body types", () => {
  useDirectorStore.setState(createInitialDirectorState());

  useDirectorStore.getState().addImportedAsset({
    kind: "prop",
    name: "本地道具",
    fileName: "cube.obj",
    url: "blob:local-model",
  });

  const imported = useDirectorStore.getState().project.objects.find((item) => item.assetRefId);

  expect(imported?.kind).toBe("prop");
  expect(imported?.bodyType).toBeUndefined();
  expect(imported?.characterRig).toBeUndefined();
});

it("places newly added character models beside existing characters instead of overlapping them", () => {
  useDirectorStore.setState(createInitialDirectorState());

  useDirectorStore.getState().addImportedAsset({
    kind: "character",
    name: "人物模型 A",
    fileName: "character-a.fbx",
    url: "blob:character-a",
  });
  useDirectorStore.getState().addImportedAsset({
    kind: "character",
    name: "人物模型 B",
    fileName: "character-b.fbx",
    url: "blob:character-b",
  });

  const characters = useDirectorStore.getState().project.objects.filter((item) => item.kind === "character");
  expect(characters.map((character) => character.transform.position)).toEqual([
    [0, 0, 0],
    [-1.25, 0, 0],
    [1.25, 0, 0],
  ]);
});

it("keeps imported model object ids unique after deleting an earlier model", () => {
  useDirectorStore.setState(createInitialDirectorState());

  useDirectorStore.getState().addImportedAsset({
    kind: "prop",
    name: "模型A",
    fileName: "model-a.fbx",
    url: "blob:model-a",
  });
  const firstModelId = useDirectorStore.getState().selectedObjectId;

  useDirectorStore.getState().addImportedAsset({
    kind: "prop",
    name: "模型B",
    fileName: "model-b.fbx",
    url: "blob:model-b",
  });
  const secondModelId = useDirectorStore.getState().selectedObjectId;

  useDirectorStore.getState().selectObject(firstModelId);
  useDirectorStore.getState().deleteSelectedObject();

  useDirectorStore.getState().addImportedAsset({
    kind: "prop",
    name: "模型C",
    fileName: "model-c.fbx",
    url: "blob:model-c",
  });
  const thirdModelId = useDirectorStore.getState().selectedObjectId;
  const modelObjectIds = useDirectorStore
    .getState()
    .project.objects.filter((item) => item.assetRefId)
    .map((item) => item.id);

  expect(thirdModelId).not.toBe(secondModelId);
  expect(modelObjectIds).toHaveLength(2);
  expect(new Set(modelObjectIds).size).toBe(modelObjectIds.length);
});

it("adds a new camera from the current viewport snapshot", () => {
  useDirectorStore.setState(createInitialDirectorState());

  useDirectorStore.getState().addCameraShot({
    fov: 62,
    position: [4, 3, 2],
    target: [0.5, 1.1, -2],
  });

  const state = useDirectorStore.getState();
  const addedCamera = state.project.cameras[state.project.cameras.length - 1];
  const addedObject = state.project.objects.find((item) => item.linkedCameraId === addedCamera?.id);
  const rigPosition = getCameraRigPositionFromViewSnapshot({
    fov: 62,
    position: [4, 3, 2],
    target: [0.5, 1.1, -2],
  });

  expect(addedCamera?.fov).toBe(62);
  expect(addedCamera?.transform.position).toEqual(rigPosition);
  expect(addedCamera?.target).toEqual([0.5, 1.1, -2]);
  expect(addedObject?.transform.position).toEqual(rigPosition);
  expect(state.project.activeCameraId).toBe(addedCamera?.id);
  expect(state.selectedObjectId).toBe(addedObject?.id);
});

it("keeps object-focused cameras centered when the target model moves", () => {
  useDirectorStore.setState(createInitialDirectorState());

  useDirectorStore.getState().addGeometryPrimitive("box");
  const targetObject = useDirectorStore.getState().project.objects.find((item) => item.name === "立方体");
  expect(targetObject).toBeTruthy();

  useDirectorStore.getState().updateCamera("cam_1", {
    targetMode: "object",
    targetObjectId: targetObject!.id,
    target: [-1.725, 0.5, 1.15],
  });
  useDirectorStore.getState().updateObjectTransform(targetObject!.id, { position: [2, 0, -3] });

  const camera = useDirectorStore.getState().project.cameras[0];

  expect(camera.targetMode).toBe("object");
  expect(camera.targetObjectId).toBe(targetObject!.id);
  expect(camera.target).toEqual([2, 0.5, -3]);
});

it("appends camera captures with sequential camera-shot names", () => {
  useDirectorStore.setState(createInitialDirectorState());

  useDirectorStore.getState().addCameraCaptures("cam_1", ["data:image/png;base64,a"]);
  useDirectorStore.getState().addCameraCaptures("cam_1", [
    "data:image/png;base64,b",
    "data:image/png;base64,c",
  ]);

  const camera = useDirectorStore.getState().project.cameras[0];

  expect(camera.captures).toEqual([
    {
      id: "cam_1-capture-01",
      index: 1,
      name: "机位01-截图01",
      dataUrl: "data:image/png;base64,a",
    },
    {
      id: "cam_1-capture-02",
      index: 2,
      name: "机位01-截图02",
      dataUrl: "data:image/png;base64,b",
    },
    {
      id: "cam_1-capture-03",
      index: 3,
      name: "机位01-截图03",
      dataUrl: "data:image/png;base64,c",
    },
  ]);
  expect(camera.lastCaptureUrl).toBe("data:image/png;base64,c");
});

it("auto-persists the latest director scene snapshot after scene changes", () => {
  useDirectorStore.getState().setViewportAspectRatio("16:9");
  useDirectorStore.getState().setViewportRotateSensitivity(0.75);
  useDirectorStore.getState().setViewportZoomSensitivity(0.6);
  useDirectorStore.getState().toggleViewportPanelsCollapsed();
  useDirectorStore.getState().addPresetCharacter("female");
  useDirectorStore.getState().updateScene({ backgroundColor: "#151515" });

  const snapshot = localStorage.getItem("storyai-3d-director-desk-demo");
  expect(snapshot).not.toBeNull();

  const parsed = JSON.parse(snapshot ?? "{}") as {
    viewportAspectRatio?: string;
    viewportPanelsCollapsed?: boolean;
    viewportRotateSensitivity?: number;
    viewportZoomSensitivity?: number;
    project?: {
      scene?: {
        backgroundColor?: string;
      };
      objects?: Array<{ id: string; name: string }>;
    };
  };

  expect(parsed.viewportAspectRatio).toBe("16:9");
  expect(parsed.viewportPanelsCollapsed).toBe(true);
  expect(parsed.viewportRotateSensitivity).toBe(0.75);
  expect(parsed.viewportZoomSensitivity).toBe(0.6);
  expect(parsed.project?.scene?.backgroundColor).toBe("#151515");
  expect(parsed.project?.objects?.some((item) => item.name === "角色02")).toBe(true);
});

it("persists only stable local model metadata instead of duplicating model bytes in localStorage", () => {
  useDirectorStore.getState().addImportedAsset({
    kind: "character",
    name: "本地演员",
    fileName: "actor.glb",
    url: "director-asset://local/actor-storage-key",
    assetSource: "local",
    modelFormat: "glb",
    storageKey: "actor-storage-key",
    byteLength: 25_000_000,
    characterRigProfile: "mixamo",
    characterImportReadiness: "ready",
  });

  const snapshot = localStorage.getItem("storyai-3d-director-desk-demo");
  expect(snapshot).not.toBeNull();
  expect(snapshot).toContain("actor-storage-key");
  expect(snapshot).toContain("director-asset://local/actor-storage-key");
  expect(snapshot?.length).toBeLessThan(20_000);

  const restored = createInitialDirectorState({ includePersistedScene: true });
  const asset = restored.project.assets.find((item) => item.storageKey === "actor-storage-key");
  expect(asset).toMatchObject({
    id: "local_asset_actor-storage-key",
    kind: "character",
    fileName: "actor.glb",
    modelFormat: "glb",
    byteLength: 25_000_000,
    characterRigProfile: "mixamo",
    characterImportReadiness: "ready",
  });
});

it("clears imported animation references from character state and route points when the file is removed", () => {
  const animationAssetId = useDirectorStore.getState().addImportedAnimationAsset({
    name: "走路动作",
    fileName: "walk.fbx",
    url: "director-asset://local/walk-key",
    modelFormat: "fbx",
    storageKey: "walk-key",
    byteLength: 2048,
    rigProfile: "mixamo",
    clips: [{ id: "clip_1", name: "Walk", duration: 1.1, trackCount: 52 }],
  });
  const actionId = `imported-action:${encodeURIComponent(animationAssetId)}:clip_1`;
  useDirectorStore.getState().applyCharacterActionPreset("char_default_a", actionId);
  const pointId = useDirectorStore.getState().addCharacterRoutePoint("char_default_a")!;
  useDirectorStore.getState().updateObjectMotionKeyframe("char_default_a", pointId, {
    actionPresetId: actionId,
    holdActionPresetId: actionId,
  });

  useDirectorStore.getState().removeImportedAnimationAsset(animationAssetId);
  const role = useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a");
  expect(useDirectorStore.getState().project.animationAssets).toEqual([]);
  expect(role?.characterRig?.actionPresetId).toBeNull();
  expect(role?.motionPath?.keyframes[0]?.actionPresetId).toBeNull();
  expect(role?.motionPath?.keyframes[0]?.holdActionPresetId).toBeNull();
});

it("keeps persisted director scenes isolated per canvas card instance", () => {
  useDirectorStore.getState().openScopedScene("node_director_a");
  useDirectorStore.getState().setViewportAspectRatio("16:9");
  useDirectorStore.getState().updateScene({ backgroundColor: "#151515" });

  expect(localStorage.getItem("storyai-3d-director-desk-demo:node_director_a")).not.toBeNull();

  useDirectorStore.getState().openScopedScene("node_director_b");

  expect(useDirectorStore.getState().viewportAspectRatio).toBe("auto");
  expect(useDirectorStore.getState().project.scene.backgroundColor).toBe("#000000");

  useDirectorStore.getState().updateScene({ backgroundColor: "#303640" });

  expect(localStorage.getItem("storyai-3d-director-desk-demo:node_director_b")).not.toBeNull();

  useDirectorStore.getState().openScopedScene("node_director_a");

  expect(useDirectorStore.getState().viewportAspectRatio).toBe("16:9");
  expect(useDirectorStore.getState().project.scene.backgroundColor).toBe("#151515");

  useDirectorStore.getState().openScopedScene("node_director_b");

  expect(useDirectorStore.getState().viewportAspectRatio).toBe("auto");
  expect(useDirectorStore.getState().project.scene.backgroundColor).toBe("#303640");
});

it("hydrates the initial state from the persisted director scene snapshot", () => {
  localStorage.setItem(
    "storyai-3d-director-desk-demo",
    JSON.stringify({
      viewMode: "camera",
      selectedObjectId: "char_default_a",
      selectedObjectIds: ["char_default_a"],
      directorInspectorMode: "auto",
      transformMode: "rotate",
      viewportAspectRatio: "9:16",
      viewportRuleOfThirdsEnabled: true,
      viewportRotateSensitivity: 0.9,
      viewportZoomSensitivity: 1.1,
      viewportPanelsCollapsed: true,
      project: {
        ...createDefaultDirectorProject(),
        scene: {
          ...createDefaultDirectorProject().scene,
          backgroundColor: "#303640",
        },
      },
    })
  );

  const hydratedState = createInitialDirectorState({
    includePersistedLocalAssets: true,
    includePersistedScene: true,
  });

  expect(hydratedState.viewMode).toBe("camera");
  expect(hydratedState.transformMode).toBe("rotate");
  expect(hydratedState.viewportAspectRatio).toBe("9:16");
  expect(hydratedState.viewportRuleOfThirdsEnabled).toBe(true);
  expect(hydratedState.viewportRotateSensitivity).toBe(0.9);
  expect(hydratedState.viewportZoomSensitivity).toBe(1.1);
  expect(hydratedState.viewportPanelsCollapsed).toBe(true);
  expect(hydratedState.selectedObjectId).toBe("char_default_a");
  expect(hydratedState.project.scene.backgroundColor).toBe("#303640");
});

it("adds an empty motion path when hydrating a legacy camera", () => {
  const legacyProject = createDefaultDirectorProject();
  delete legacyProject.cameras[0].motionPath;

  localStorage.setItem(
    "storyai-3d-director-desk-demo",
    JSON.stringify({
      ...createInitialDirectorState(),
      project: legacyProject,
    })
  );

  const hydratedState = createInitialDirectorState({ includePersistedScene: true });

  expect(hydratedState.project.cameras[0].motionPath).toEqual({
    duration: 6,
    loop: false,
    interpolation: "smooth",
    easing: "ease-in-out",
    speedMode: "soft",
    customEasing: [0, 0, 1, 1],
    keyframes: [],
  });
});

it("keeps motion playback state transient when saving the project snapshot", () => {
  useDirectorStore.setState(createInitialDirectorState());
  useDirectorStore.getState().setCameraMotionProgress(0.625);
  useDirectorStore.getState().setCameraMotionPlaying(true);
  useDirectorStore.getState().selectCameraMotionKeyframe("motion_key_preview");
  useDirectorStore.getState().saveLatestSnapshot();

  const persisted = JSON.parse(localStorage.getItem("storyai-3d-director-desk-demo") ?? "{}") as Record<
    string,
    unknown
  >;

  expect(persisted).not.toHaveProperty("cameraMotionProgress");
  expect(persisted).not.toHaveProperty("cameraMotionPlaying");
  expect(persisted).not.toHaveProperty("selectedCameraKeyframeId");
  expect((persisted.project as { cameras?: unknown[] } | undefined)?.cameras).toHaveLength(1);
});

it("keeps timeline edits synchronized with runtime playback", () => {
  useDirectorStore.getState().setCameraMotionProgress(0.375);

  expect(useDirectorStore.getState().cameraMotionProgress).toBe(0.375);
  expect(getRuntimePlaybackProgress()).toBe(0.375);
});

it("commits the latest runtime progress when playback pauses", () => {
  useDirectorStore.getState().setCameraMotionProgress(0.2);
  useDirectorStore.getState().setCameraMotionPlaying(true);
  setRuntimePlaybackProgress(0.64);

  useDirectorStore.getState().setCameraMotionPlaying(false);

  expect(useDirectorStore.getState().cameraMotionProgress).toBe(0.64);
  expect(getRuntimePlaybackProgress()).toBe(0.64);
});

it("migrates persisted procedural characters to the built-in UE4 mannequin rig", () => {
  const legacyProject = createDefaultDirectorProject();
  const legacyCharacter = legacyProject.objects.find((item) => item.kind === "character");

  if (!legacyCharacter) {
    throw new Error("Expected default character");
  }

  legacyCharacter.color = "#4F8EF7";
  legacyCharacter.transform.position = [1, 0, -2];
  legacyCharacter.characterRig = {
    rigType: "mannequin",
    posePresetId: "stand",
    controls: {
      "head.yaw": 12,
    },
  };

  localStorage.setItem(
    "storyai-3d-director-desk-demo",
    JSON.stringify({
      ...createInitialDirectorState(),
      project: legacyProject,
    })
  );

  const hydratedState = createInitialDirectorState({
    includePersistedScene: true,
  });
  const migratedCharacter = hydratedState.project.objects.find((item) => item.id === legacyCharacter.id);

  expect(migratedCharacter?.transform.position).toEqual([1, 0, -2]);
  expect(migratedCharacter?.color).toBe("#4F8EF7");
  expect(migratedCharacter?.characterRig).toEqual({
    rigType: "ue4-mannequin",
    posePresetId: "stand",
    controls: {
      "head.yaw": 12,
    },
  });
});

it("preserves persisted Mixamo characters and their selected action", () => {
  const project = createDefaultDirectorProject();
  const character = project.objects.find((item) => item.kind === "character");

  if (!character) throw new Error("Expected default character");

  character.assetRefId = "mixamo-character-remy";
  character.characterRig = {
    rigType: "mixamo",
    posePresetId: "stand",
    actionPresetId: "walk-cycle",
    controls: {},
  };
  project.assets.push({
    id: "mixamo-character-remy",
    kind: "character",
    sourceType: "model",
    fileName: "remy.fbx",
    name: "Remy",
    url: "/local-assets/mixamo/characters/remy.fbx",
    assetSource: "library",
  });

  localStorage.setItem(
    "storyai-3d-director-desk-demo",
    JSON.stringify({ ...createInitialDirectorState(), project })
  );

  const hydratedState = createInitialDirectorState({ includePersistedScene: true });
  const hydratedCharacter = hydratedState.project.objects.find((item) => item.id === character.id);

  expect(hydratedCharacter?.assetRefId).toBe("mixamo-character-remy");
  expect(hydratedCharacter?.characterRig).toEqual(character.characterRig);
});

it("adds the built-in UE4 mannequin rig to persisted characters that predate rig metadata", () => {
  const legacyProject = createDefaultDirectorProject();
  const legacyCharacter = legacyProject.objects.find((item) => item.kind === "character");

  if (!legacyCharacter) {
    throw new Error("Expected default character");
  }

  delete legacyCharacter.characterRig;

  localStorage.setItem(
    "storyai-3d-director-desk-demo",
    JSON.stringify({
      ...createInitialDirectorState(),
      project: legacyProject,
    })
  );

  const hydratedState = createInitialDirectorState({
    includePersistedScene: true,
  });
  const migratedCharacter = hydratedState.project.objects.find((item) => item.id === legacyCharacter.id);

  expect(migratedCharacter?.characterRig).toEqual({
    rigType: "ue4-mannequin",
    posePresetId: "stand",
    controls: {},
  });
});

it("copies and pastes the current selection as new scene objects", () => {
  useDirectorStore.getState().selectObject("char_default_a");

  useDirectorStore.getState().copySelectedObjects();
  useDirectorStore.getState().pasteClipboardObjects();

  const state = useDirectorStore.getState();
  const characters = state.project.objects.filter((item) => item.kind === "character");
  const pastedCharacter = characters.find((item) => item.id !== "char_default_a");

  expect(characters).toHaveLength(2);
  expect(pastedCharacter?.id).not.toBe("char_default_a");
  expect(pastedCharacter?.transform.position).toEqual([0.6, 0, 0.6]);
  expect(state.selectedObjectId).toBe(pastedCharacter?.id ?? null);
  expect(state.selectedObjectIds).toEqual(pastedCharacter ? [pastedCharacter.id] : []);
});

it("undoes the latest scene mutation", () => {
  useDirectorStore.getState().addPresetCharacter("female");

  expect(useDirectorStore.getState().project.objects.some((item) => item.name === "角色02")).toBe(true);

  useDirectorStore.getState().undo();

  expect(useDirectorStore.getState().project.objects.some((item) => item.name === "角色02")).toBe(false);
  expect(useDirectorStore.getState().project.objects.filter((item) => item.kind === "character")).toHaveLength(1);
});

it("groups repeated transform updates into one undo step while batching", () => {
  useDirectorStore.getState().beginUndoBatch();
  useDirectorStore.getState().updateObjectTransform("char_default_a", { position: [1, 0, 0] });
  useDirectorStore.getState().updateObjectTransform("char_default_a", { position: [2, 0, 0] });
  useDirectorStore.getState().updateObjectTransform("char_default_a", { position: [3, 0, 0] });
  useDirectorStore.getState().endUndoBatch();

  expect(useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a")?.transform.position).toEqual([
    3, 0, 0,
  ]);

  useDirectorStore.getState().undo();

  expect(useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a")?.transform.position).toEqual([
    0, 0, 0,
  ]);
});
