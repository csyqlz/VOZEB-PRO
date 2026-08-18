import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach } from "vitest";
import { createInitialDirectorState, useDirectorStore } from "../../store/directorStore";
import { areAnimationProfilesCompatible, CharacterPanel } from "../CharacterPanel";
import { createImportedCharacterActionId } from "../../schema/importedCharacterAction";

beforeEach(() => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
    selectedObjectId: "char_default_a",
  });
});

it("allows a fully mapped external rig to use a recognizable external action profile", () => {
  expect(areAnimationProfilesCompatible("bip", "mixamo", true)).toBe(true);
  expect(areAnimationProfilesCompatible("generic-humanoid", "cc-base", true)).toBe(true);
  expect(areAnimationProfilesCompatible("generic-humanoid", "unknown", true)).toBe(false);
  expect(areAnimationProfilesCompatible("bip", "mixamo", false)).toBe(false);
});

it("renders the approved role property order", () => {
  render(<CharacterPanel />);

  expect(screen.getByLabelText("角色名称")).toBeInTheDocument();
  expect(screen.getByLabelText("角色位置 X")).toBeInTheDocument();
  expect(screen.getByLabelText("角色旋转 X")).toBeInTheDocument();
  expect(screen.getByLabelText("角色缩放 X")).toBeInTheDocument();
  expect(screen.getByLabelText("角色统一缩放")).toBeInTheDocument();
  expect(screen.getByLabelText("角色颜色")).toBeInTheDocument();
});

it("keeps character creation-only body type controls out of the role property panel", () => {
  render(<CharacterPanel />);

  const content = document.querySelector(".right-inspector-content");
  expect(content).toBeInTheDocument();

  const labels = Array.from(content?.querySelectorAll(".inspector-field-label, .inspector-section h3") ?? []).map((item) =>
    item.textContent?.trim()
  );

  expect(labels).toEqual(["名称", "位置", "旋转", "缩放", "统一缩放", "颜色"]);
  expect(screen.queryByText("体型")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "二头身" })).not.toBeInTheDocument();
});

it("keeps role axis labels exactly 10px above their coordinate rows", () => {
  render(<CharacterPanel />);

  ["位置", "旋转", "缩放"].forEach((label) => {
    const group = screen.getByRole("group", { name: label });

    expect(group).toHaveClass("inspector-axis-group");
    expect(group.tagName).toBe("DIV");
  });
});

it("uses the provided right inspector layout for role properties", () => {
  const { container } = render(<CharacterPanel />);

  expect(screen.getByLabelText("角色右侧属性面板")).toHaveClass("right-inspector", "character-inspector");
  expect(container.querySelector(".right-inspector-header")).toBeInTheDocument();
  expect(container.querySelector(".right-inspector-tabs")).toBeInTheDocument();
  expect(container.querySelector(".right-inspector-content")).toBeInTheDocument();

  const positionX = screen.getByLabelText("角色位置 X").closest(".inspector-axis-input");
  const colorRow = screen.getByLabelText("角色颜色 HEX").closest(".inspector-color-row");

  expect(positionX).toBeInTheDocument();
  expect(within(positionX as HTMLElement).getByText("X")).toHaveClass("inspector-axis-prefix");
  expect(colorRow).toBeInTheDocument();
  expect(screen.getByLabelText("角色颜色")).toHaveClass("inspector-color-swatch");
});

it("marks the pose adjustment section for the compact character inspector layout", async () => {
  const user = userEvent.setup();
  render(<CharacterPanel />);

  await user.click(screen.getByRole("button", { name: "姿势" }));

  expect(screen.getByText("姿势预设").closest(".inspector-section")).toHaveClass("pose-preset-section");
  expect(screen.getByText("姿势调节").closest(".inspector-section")).toHaveClass("pose-adjust-section");
});

it("adjusts axis values by dragging the gray XYZ prefix handles", () => {
  render(<CharacterPanel />);

  const dragHandle = screen.getByRole("button", { name: "角色位置 X 拖动调整" });

  fireEvent.mouseDown(dragHandle, { button: 0, clientX: 100 });
  fireEvent.mouseMove(window, { clientX: 120 });
  fireEvent.mouseUp(window);

  const role = useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a");
  expect(role?.transform.position[0]).toBe(2);
  expect(screen.getByLabelText("角色位置 X")).toHaveValue(2);
});

it("updates the selected role name and uniform scale", async () => {
  const user = userEvent.setup();
  render(<CharacterPanel />);

  await user.clear(screen.getByLabelText("角色名称"));
  await user.type(screen.getByLabelText("角色名称"), "主角");
  await user.clear(screen.getByLabelText("角色统一缩放"));
  await user.type(screen.getByLabelText("角色统一缩放"), "1.2");

  const role = useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a");
  expect(role?.name).toBe("主角");
  expect(role?.transform.scale).toEqual([1.2, 1.2, 1.2]);
});

it("updates role rotation, per-axis scale, and hex color fields", async () => {
  const user = userEvent.setup();
  render(<CharacterPanel />);

  await user.clear(screen.getByLabelText("角色旋转 Y"));
  await user.type(screen.getByLabelText("角色旋转 Y"), "15");
  await user.clear(screen.getByLabelText("角色缩放 Z"));
  await user.type(screen.getByLabelText("角色缩放 Z"), "1.4");
  await user.clear(screen.getByLabelText("角色颜色 HEX"));
  await user.type(screen.getByLabelText("角色颜色 HEX"), "#123456");

  const role = useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a");
  expect(role?.transform.rotation).toEqual([0, 15, 0]);
  expect(role?.transform.scale).toEqual([1, 1, 1.4]);
  expect(role?.color).toBe("#123456");
});

it("updates every member in a selected crowd group from the property panel", async () => {
  const user = userEvent.setup();
  useDirectorStore.getState().addCrowdCharacters({ rows: 2, columns: 2, spacing: 1.2 });
  useDirectorStore.getState().selectCrowd("crowd_1");

  render(<CharacterPanel />);

  await user.clear(screen.getByLabelText("角色颜色 HEX"));
  await user.type(screen.getByLabelText("角色颜色 HEX"), "#123456");

  const crowdMembers = useDirectorStore
    .getState()
    .project.objects.filter((item) => item.kind === "character" && item.crowdId === "crowd_1");

  expect(crowdMembers).toHaveLength(4);
  expect(new Set(crowdMembers.map((item) => item.color))).toEqual(new Set(["#123456"]));
});

it("applies pose presets to every member in a selected crowd group", async () => {
  const user = userEvent.setup();
  useDirectorStore.getState().addCrowdCharacters({ rows: 2, columns: 2, spacing: 1.2 });
  useDirectorStore.getState().selectCrowd("crowd_1");

  render(<CharacterPanel />);

  await user.click(screen.getByRole("button", { name: "姿势" }));
  await user.click(screen.getByRole("button", { name: "T型" }));

  const crowdMembers = useDirectorStore
    .getState()
    .project.objects.filter((item) => item.kind === "character" && item.crowdId === "crowd_1");

  expect(crowdMembers).toHaveLength(4);
  expect(new Set(crowdMembers.map((item) => item.characterRig?.posePresetId))).toEqual(new Set(["t-pose"]));
  expect(new Set(crowdMembers.map((item) => item.characterRig?.controls["leftShoulder.spread"]))).toEqual(new Set([-70]));
});

it("selects and starts a character action preset", async () => {
  const user = userEvent.setup();
  render(<CharacterPanel />);

  await user.click(screen.getByRole("button", { name: "动作" }));
  await user.click(screen.getByRole("button", { name: "播放动作 正常行走" }));

  const state = useDirectorStore.getState();
  const role = state.project.objects.find((item) => item.id === "char_default_a");
  expect(role?.characterRig?.actionPresetId).toBe("walk-cycle");
  expect(state.cameraMotionPlaying).toBe(true);
  expect(state.cameraMotionProgress).toBe(0);
});

it("blocks humanoid presets for a library character that still needs bone mapping", async () => {
  const user = userEvent.setup();
  const state = useDirectorStore.getState();
  useDirectorStore.setState({
    project: {
      ...state.project,
      assets: [{
        id: "asset_horse",
        kind: "character",
        sourceType: "model",
        fileName: "0033_horse.fbx",
        url: "/local-assets/guo-3d-assets/guo-skeleton-models/models/0033_horse.fbx",
        modelFormat: "fbx",
        characterRigProfile: "unknown",
        characterImportReadiness: "manual-mapping",
      }],
      objects: state.project.objects.map((item) => item.id === "char_default_a"
        ? { ...item, assetRefId: "asset_horse", characterRig: { rigType: "mixamo", posePresetId: "stand", controls: {} } }
        : item),
    },
  });
  render(<CharacterPanel />);

  await user.click(screen.getByRole("button", { name: "动作" }));

  expect(screen.getByRole("status")).toHaveTextContent("需要补全骨骼映射");
  expect(screen.queryByRole("button", { name: "播放动作 正常行走" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "播放动作 跑步" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "姿势" }));
  expect(screen.getByRole("status")).toHaveTextContent("尚未完成标准人形骨骼映射");
  expect(screen.queryByRole("button", { name: "T型" })).not.toBeInTheDocument();
});

it("plays and removes a compatible imported character action", async () => {
  const user = userEvent.setup();
  const state = useDirectorStore.getState();
  useDirectorStore.setState({
    project: {
      ...state.project,
      animationAssets: [{
        id: "local_animation_walk",
        name: "本地走路",
        fileName: "walk.fbx",
        url: "director-asset://local/walk",
        modelFormat: "fbx",
        storageKey: "walk",
        rigProfile: "bip",
        clips: [{ id: "clip_1", name: "Walk", duration: 1.25, trackCount: 48 }],
      }],
    },
  });
  render(<CharacterPanel />);

  await user.click(screen.getByRole("button", { name: "动作" }));
  const playButton = screen.getByRole("button", { name: "播放导入动作 本地走路 · Walk" });
  expect(playButton).toHaveTextContent("1.25 秒");
  await user.click(playButton);

  const actionId = createImportedCharacterActionId("local_animation_walk", "clip_1");
  expect(useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a")?.characterRig?.actionPresetId)
    .toBe(actionId);
  expect(useDirectorStore.getState().cameraMotionPlaying).toBe(true);

  await user.click(screen.getByRole("button", { name: "删除动作文件 本地走路" }));
  expect(useDirectorStore.getState().project.animationAssets).toEqual([]);
  expect(useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a")?.characterRig?.actionPresetId)
    .toBeNull();
});

it("lets a native-only character replay its own embedded actions without exposing unrelated actions", async () => {
  const user = userEvent.setup();
  const state = useDirectorStore.getState();
  useDirectorStore.setState({
    project: {
      ...state.project,
      assets: [{
        id: "asset_native_actor",
        kind: "character",
        sourceType: "model",
        fileName: "native-actor.glb",
        url: "director-asset://local/native-actor",
        modelFormat: "glb",
        characterRigProfile: "unknown",
        characterImportReadiness: "native-only",
      }],
      animationAssets: [{
        id: "local_animation_native_actor",
        name: "演员自带动作",
        fileName: "native-actor.glb",
        url: "director-asset://local/native-actor",
        modelFormat: "glb",
        rigProfile: "unknown",
        sourceCharacterAssetId: "asset_native_actor",
        clips: [{ id: "clip_1", name: "Native Walk", duration: 1.5, trackCount: 32 }],
      }, {
        id: "local_animation_other_actor",
        name: "其他未知动作",
        fileName: "other.glb",
        url: "director-asset://local/other",
        modelFormat: "glb",
        rigProfile: "unknown",
        sourceCharacterAssetId: "asset_other_actor",
        clips: [{ id: "clip_1", name: "Other Motion", duration: 1, trackCount: 20 }],
      }],
      objects: state.project.objects.map((item) => item.id === "char_default_a"
        ? {
            ...item,
            assetRefId: "asset_native_actor",
            characterRig: { rigType: "mixamo", posePresetId: "stand", actionPresetId: null, controls: {} },
          }
        : item),
    },
  });
  render(<CharacterPanel />);

  await user.click(screen.getByRole("button", { name: "动作" }));

  expect(screen.getByRole("status")).toHaveTextContent("只保证播放自带动作");
  expect(screen.getByRole("button", { name: "播放导入动作 演员自带动作 · Native Walk" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "播放导入动作 其他未知动作 · Other Motion" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "播放动作 正常行走" })).not.toBeInTheDocument();
});

it("recognizes embedded actions from older projects by matching the character file", async () => {
  const user = userEvent.setup();
  const state = useDirectorStore.getState();
  useDirectorStore.setState({
    project: {
      ...state.project,
      assets: [{
        id: "asset_legacy_native",
        kind: "character",
        sourceType: "model",
        fileName: "legacy.glb",
        url: "director-asset://local/legacy",
        characterRigProfile: "unknown",
        characterImportReadiness: "native-only",
      }],
      animationAssets: [{
        id: "legacy_animation",
        name: "旧版自带动作",
        fileName: "legacy.glb",
        url: "director-asset://local/legacy",
        modelFormat: "glb",
        rigProfile: "unknown",
        clips: [{ id: "clip_1", name: "Legacy Clip", duration: 2, trackCount: 24 }],
      }],
      objects: state.project.objects.map((item) => item.id === "char_default_a"
        ? { ...item, assetRefId: "asset_legacy_native" }
        : item),
    },
  });
  render(<CharacterPanel />);

  await user.click(screen.getByRole("button", { name: "动作" }));

  expect(screen.getByRole("button", { name: "播放导入动作 旧版自带动作 · Legacy Clip" })).toBeInTheDocument();
});

it("shows native action durations for RobotExpressive characters", async () => {
  const user = userEvent.setup();
  const state = useDirectorStore.getState();
  const role = state.project.objects.find((item) => item.id === "char_default_a")!;
  useDirectorStore.setState({
    project: {
      ...state.project,
      assets: [{
        id: "asset_robot",
        kind: "character",
        sourceType: "model",
        fileName: "robot-expressive.glb",
        url: "/local-assets/mixamo/characters/robot-expressive.glb",
      }],
      objects: state.project.objects.map((item) => item.id === role.id
        ? {
            ...item,
            assetRefId: "asset_robot",
            characterRig: { rigType: "mixamo", posePresetId: "stand", controls: {} },
          }
        : item),
    },
  });
  render(<CharacterPanel />);

  await user.click(screen.getByRole("button", { name: "动作" }));

  expect(screen.getByRole("button", { name: "播放动作 挥手打招呼" })).toHaveTextContent("1.83 秒");
  expect(screen.getByRole("button", { name: "播放动作 原地跳跃" })).toHaveTextContent("0.71 秒");
});

it("restarts action playback from zero when another action is chosen while already playing", async () => {
  const user = userEvent.setup();
  useDirectorStore.getState().setCameraMotionProgress(0.65);
  useDirectorStore.getState().setCameraMotionPlaying(true);
  const previousRevision = useDirectorStore.getState().cameraMotionPlaybackRevision;
  render(<CharacterPanel />);

  await user.click(screen.getByRole("button", { name: "动作" }));
  await user.click(screen.getByRole("button", { name: "播放动作 跑步" }));

  const state = useDirectorStore.getState();
  expect(state.cameraMotionProgress).toBe(0);
  expect(state.cameraMotionPlaying).toBe(true);
  expect(state.cameraMotionPlaybackRevision).toBe(previousRevision + 1);
});

it("adds and edits a route point from the character route tab", async () => {
  const user = userEvent.setup();
  render(<CharacterPanel />);

  await user.click(screen.getByRole("button", { name: "路线" }));
  await user.click(screen.getByRole("button", { name: "添加点" }));

  expect(screen.getByRole("button", { name: "选择路线点 1" })).toHaveAttribute("aria-pressed", "true");
  await user.selectOptions(screen.getByLabelText("路线点本段动作"), "run-cycle");
  await user.selectOptions(screen.getByLabelText("路线点朝向方式"), "path");

  const point = useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a")?.motionPath?.keyframes[0];
  expect(point?.actionPresetId).toBe("run-cycle");
  expect(point?.facingMode).toBe("path");
});

it("selects a route point without moving the scene preview until explicitly requested", async () => {
  const user = userEvent.setup();
  useDirectorStore.getState().addCharacterRoutePoint("char_default_a");
  useDirectorStore.getState().addCharacterRoutePoint("char_default_a");
  useDirectorStore.getState().setCameraMotionProgress(0.25);
  render(<CharacterPanel />);

  await user.click(screen.getByRole("button", { name: "路线" }));
  await user.click(screen.getByRole("button", { name: "选择路线点 2" }));
  expect(useDirectorStore.getState().cameraMotionProgress).toBe(0.25);

  await user.click(screen.getByRole("button", { name: "预览当前路线点" }));
  expect(useDirectorStore.getState().cameraMotionProgress).toBe(1);
});

it("switches the character route between smooth curve and straight line", async () => {
  const user = userEvent.setup();
  render(<CharacterPanel />);

  await user.click(screen.getByRole("button", { name: "路线" }));
  await user.click(screen.getByRole("button", { name: "折线" }));

  let role = useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a");
  expect(role?.motionPath?.interpolation).toBe("linear");
  expect(screen.getByRole("button", { name: "折线" })).toHaveAttribute("aria-pressed", "true");

  await user.click(screen.getByRole("button", { name: "平滑" }));
  role = useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a");
  expect(role?.motionPath?.interpolation).toBe("smooth");
});

it("uses the same speed and hold controls for a character route", async () => {
  const user = userEvent.setup();
  useDirectorStore.getState().addCharacterRoutePoint("char_default_a");
  useDirectorStore.getState().addCharacterRoutePoint("char_default_a");
  useDirectorStore.getState().addCharacterRoutePoint("char_default_a");
  render(<CharacterPanel />);

  await user.click(screen.getByRole("button", { name: "路线" }));
  await user.click(screen.getByRole("button", { name: "柔和" }));
  expect(useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a")?.motionPath?.speedMode).toBe("soft");

  await user.click(screen.getByRole("button", { name: "选择路线点 2" }));
  expect(screen.getByRole("spinbutton", { name: "路线点到达时间" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "停留" }));
  fireEvent.change(screen.getByRole("slider", { name: "路线点停留时长滑杆" }), { target: { value: "1.2" } });
  await user.selectOptions(screen.getByRole("combobox", { name: "路线点停留动作方式" }), "custom");
  await user.selectOptions(screen.getByRole("combobox", { name: "路线点指定停留动作" }), "wave-cycle");

  const route = useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a")?.motionPath;
  expect(route?.keyframes[1]).toMatchObject({
    pointBehavior: "hold",
    holdSeconds: 1.2,
    holdAction: "custom",
    holdActionPresetId: "wave-cycle",
  });
  await user.click(screen.getByRole("button", { name: "自定义" }));
  expect(screen.getByRole("spinbutton", { name: "路线点到达时间" })).toBeEnabled();
  const characterEasing = screen.getByRole("group", { name: "人物段内节奏" });
  await user.click(within(characterEasing).getByRole("button", { name: "两头柔和" }));
  expect(useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a")?.motionPath?.customEasing)
    .toEqual([0.42, 0, 0.58, 1]);
  expect(within(characterEasing).getByRole("button", { name: "两头柔和" })).toHaveAttribute("aria-pressed", "true");
});
