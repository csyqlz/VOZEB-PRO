import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import { createInitialDirectorState, useDirectorStore } from "../../store/directorStore";
import { MotionStudio } from "../MotionStudio";

beforeEach(() => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
    motionStudioOpen: true,
    cameraPilotMode: "idle",
  });
});

it("presents a beginner-friendly shooting workflow with the final key bindings", () => {
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  expect(screen.getByRole("region", { name: "运镜工作台" })).toBeInTheDocument();
  expect(screen.getByText(/无需摆放机位/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "播放导演视角预演" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "播放第一视角运镜预演" })).toBeInTheDocument();
  expect(screen.getByText("空格")).toBeInTheDocument();
  expect(screen.getByText("E")).toBeInTheDocument();
  expect(screen.getByText("上升")).toBeInTheDocument();
  expect(screen.getByText("Q")).toBeInTheDocument();
  expect(screen.getByText("下降")).toBeInTheDocument();
  expect(screen.getByText("播放 / 暂停人物")).toBeInTheDocument();
  expect(screen.queryByText("Shift")).not.toBeInTheDocument();
  expect(screen.queryByText("自由录制")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("录制轨迹还原程度")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "锁定后只保持看向主体" })).toHaveAttribute("aria-pressed", "true");
});

it("plays the completed move from the camera first-person view", async () => {
  const user = userEvent.setup();
  useDirectorStore.getState().recordCameraMotionSnapshot("cam_1", {
    position: [0, 2, 8],
    target: [0, 1, 0],
    fov: 50,
  });
  useDirectorStore.getState().recordCameraMotionSnapshot("cam_1", {
    position: [3, 2, 4],
    target: [0, 1, 0],
    fov: 42,
  });
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  await user.click(screen.getByRole("button", { name: "播放第一视角运镜预演" }));

  expect(useDirectorStore.getState().viewMode).toBe("camera");
  expect(useDirectorStore.getState().cameraMotionPlaying).toBe(true);
});

it("automatically creates a hidden motion camera when the scene has no placed camera", async () => {
  const state = useDirectorStore.getState();
  useDirectorStore.setState({
    ...state,
    project: {
      ...state.project,
      cameras: [],
      activeCameraId: null,
      objects: state.project.objects.filter((item) => item.kind !== "camera"),
    },
  });

  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [5, 3, 2], target: [0, 1, 0], fov: 46 })} />);

  await waitFor(() => expect(screen.getByRole("region", { name: "运镜工作台" })).toBeInTheDocument());
  const nextState = useDirectorStore.getState();
  expect(nextState.project.cameras).toHaveLength(1);
  expect(nextState.project.cameras[0]).toMatchObject({
    name: "自动运镜镜头",
    isVirtual: true,
    fov: 46,
    target: [0, 1, 0],
  });
  expect(nextState.project.objects.some((item) => item.kind === "camera")).toBe(false);
  expect(nextState.project.activeCameraId).toBe(nextState.project.cameras[0].id);
});

it("starts pilot mode and records the current view as a numbered waypoint", async () => {
  const user = userEvent.setup();
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [3, 2, 7], target: [0, 1, 0], fov: 44 })} />);

  await user.click(screen.getByRole("button", { name: "开始掌镜" }));
  expect(useDirectorStore.getState().cameraPilotMode).toBe("pilot");

  useDirectorStore.getState().stopCameraPilot();
  await user.click(screen.getByRole("button", { name: "添加当前视角为轨迹点" }));

  expect(screen.getByRole("button", { name: "选择轨迹点 1" })).toBeInTheDocument();
  expect(useDirectorStore.getState().project.cameras[0].motionPath?.keyframes[0]).toMatchObject({
    position: [3, 2, 7],
    target: [0, 1, 0],
    fov: 44,
  });
});

it("hands pilot startup to the viewport so pointer lock can be requested in the click gesture", async () => {
  const user = userEvent.setup();
  const onStartPilot = vi.fn();
  render(
    <MotionStudio
      getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })}
      onStartPilot={onStartPilot}
    />
  );

  await user.click(screen.getByRole("button", { name: "开始掌镜" }));

  expect(onStartPilot).toHaveBeenCalledWith(null);
});

it("keeps character controls in the dedicated bottom transport instead of duplicating them", () => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    selectedObjectId: "char_default_a",
    selectedObjectIds: ["char_default_a"],
    cameraMotionProgress: 0.4,
  });
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  expect(screen.queryByRole("slider", { name: "全局动作时间轴" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /记录角色01在当前时间的位置/ })).not.toBeInTheDocument();
});

it("keeps reached and approaching waypoint states visible while route preview is paused", () => {
  const state = useDirectorStore.getState();
  useDirectorStore.setState({
    ...state,
    viewMode: "director",
    cameraMotionPlaying: false,
    cameraMotionProgress: 0.5,
    project: {
      ...state.project,
      cameras: state.project.cameras.map((camera) => ({
        ...camera,
        motionPath: {
          duration: 6,
          loop: false,
          interpolation: "smooth",
          easing: "ease-in-out",
          keyframes: [
            { id: "paused_point_1", time: 0, position: [0, 2, 8], target: [0, 1, 0], fov: 50 },
            { id: "paused_point_2", time: 0.5, position: [3, 2, 5], target: [0, 1, 0], fov: 46 },
            { id: "paused_point_3", time: 1, position: [5, 2, 2], target: [0, 1, 0], fov: 42 },
          ],
        },
      })),
    },
  });

  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  expect(screen.getByRole("button", { name: "选择轨迹点 1" })).toHaveClass("is-reached");
  expect(screen.getByRole("button", { name: "选择轨迹点 2" })).toHaveClass("is-reached");
  expect(screen.getByRole("button", { name: "选择轨迹点 3" })).toHaveClass("is-approaching");
});

it("inserts a new waypoint from the plus button between two route points", async () => {
  const user = userEvent.setup();
  useDirectorStore.getState().recordCameraMotionSnapshot("cam_1", {
    position: [0, 2, 8], target: [0, 1, 0], fov: 50,
  });
  useDirectorStore.getState().recordCameraMotionSnapshot("cam_1", {
    position: [6, 2, 2], target: [0, 1, 0], fov: 40,
  });
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  await user.click(screen.getByRole("button", { name: "在轨迹点 1 和 2 之间插入轨迹点" }));

  expect(screen.getByRole("button", { name: "选择轨迹点 3" })).toBeInTheDocument();
  expect(useDirectorStore.getState().project.cameras[0].motionPath?.keyframes).toHaveLength(3);
  expect(useDirectorStore.getState().cameraMotionProgress).toBe(0.5);
});

it("supports visible arbitrary multi-selection for moving points 1, 3, and 6 together", async () => {
  const user = userEvent.setup();
  for (let index = 0; index < 6; index += 1) {
    useDirectorStore.getState().recordCameraMotionSnapshot("cam_1", {
      position: [index, 2, 8 - index], target: [0, 1, 0], fov: 50,
    });
  }
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  await user.click(screen.getByRole("button", { name: "批量选择并移动轨迹点" }));
  await user.click(screen.getByRole("button", { name: "清空轨迹点选择" }));
  await user.click(screen.getByRole("button", { name: "批量选择轨迹点 1" }));
  await user.click(screen.getByRole("button", { name: "批量选择轨迹点 3" }));
  await user.click(screen.getByRole("button", { name: "批量选择轨迹点 6" }));

  const keyframes = useDirectorStore.getState().project.cameras[0].motionPath?.keyframes ?? [];
  expect(useDirectorStore.getState().selectedCameraKeyframeIds).toEqual([
    keyframes[0].id,
    keyframes[2].id,
    keyframes[5].id,
  ]);
  expect(screen.getByText("已选 3 个点")).toBeInTheDocument();
});

it("lets every waypoint choose its own moving tracking target", async () => {
  const user = userEvent.setup();
  useDirectorStore.getState().recordCameraMotionSnapshot("cam_1", {
    position: [0, 2, 8], target: [0, 1, 0], fov: 50,
  });
  useDirectorStore.getState().recordCameraMotionSnapshot("cam_1", {
    position: [3, 2, 4], target: [0, 1, 0], fov: 44,
  });
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  await user.click(screen.getByRole("button", { name: "选择轨迹点 1" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "轨迹点跟踪主体" }), "char_default_a");

  let keyframes = useDirectorStore.getState().project.cameras[0].motionPath?.keyframes ?? [];
  expect(keyframes[0]).toMatchObject({
    targetMode: "object",
    targetObjectId: "char_default_a",
    targetBodyPart: "chest",
    targetFollowMode: "immediate",
  });
  expect(keyframes[1]).toMatchObject({ targetMode: "manual" });
  expect(screen.getByText("这个点会实时看向所选主体")).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "轨迹点跟踪身体部位" })).toHaveValue("chest");

  await user.selectOptions(screen.getByRole("combobox", { name: "轨迹点跟踪身体部位" }), "rightHand");
  await user.click(within(screen.getByRole("group", { name: "轨迹点跟随响应速度" })).getByRole("button", { name: "柔和" }));
  await user.click(within(screen.getByRole("group", { name: "镜头跟踪抖动" })).getByRole("button", { name: "开启防抖" }));
  keyframes = useDirectorStore.getState().project.cameras[0].motionPath?.keyframes ?? [];
  expect(keyframes[0]).toMatchObject({
    targetBodyPart: "rightHand",
    targetFollowMode: "smooth",
    targetStabilizationEnabled: true,
  });

  await user.click(screen.getByRole("button", { name: "选择轨迹点 2" }));
  expect(screen.getByRole("combobox", { name: "轨迹点跟踪主体" })).toHaveValue("");
  await user.selectOptions(screen.getByRole("combobox", { name: "轨迹点跟踪主体" }), "char_default_a");

  keyframes = useDirectorStore.getState().project.cameras[0].motionPath?.keyframes ?? [];
  expect(keyframes[1]).toMatchObject({ targetMode: "object", targetObjectId: "char_default_a" });
});

it("applies a motion parameter preset without replacing route points", async () => {
  const user = userEvent.setup();
  useDirectorStore.getState().recordCameraMotionSnapshot("cam_1", {
    position: [0, 2, 8], target: [0, 1, 0], fov: 50,
  });
  useDirectorStore.getState().recordCameraMotionSnapshot("cam_1", {
    position: [4, 2, 4], target: [0, 1, 0], fov: 42,
  });
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  await user.selectOptions(screen.getByRole("combobox", { name: "运镜参数预设" }), "fast-follow");

  const path = useDirectorStore.getState().project.cameras[0].motionPath;
  expect(path).toMatchObject({ duration: 3, interpolation: "smooth", easing: "linear" });
  expect(path?.keyframes).toHaveLength(2);
});

it("generates an editable camera route that follows the selected character", async () => {
  const user = userEvent.setup();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    selectedObjectId: "char_default_a",
    selectedObjectIds: ["char_default_a"],
  });
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  expect(screen.getByRole("combobox", { name: "镜头预设跟踪主体" })).toHaveValue("char_default_a");
  await user.click(screen.getByRole("button", { name: "套用推镜镜头预设" }));

  const path = useDirectorStore.getState().project.cameras[0].motionPath;
  expect(path?.keyframes).toHaveLength(3);
  expect(path?.keyframes.every((keyframe) => (
    keyframe.targetMode === "object" && keyframe.targetObjectId === "char_default_a"
  ))).toBe(true);
  expect(useDirectorStore.getState().selectedCameraKeyframeId).toBe(path?.keyframes[0].id);
  expect(useDirectorStore.getState().cameraMotionProgress).toBe(0);
});

it("opens community presets separately and shows their contribution metadata", async () => {
  const user = userEvent.setup();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    selectedObjectId: "char_default_a",
    selectedObjectIds: ["char_default_a"],
  });
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  expect(screen.getByRole("button", { name: "基础预设" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByRole("button", { name: "套用跟拍镜头预设" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "群友预设" }));
  expect(screen.getByRole("button", { name: "群友预设" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByRole("button", { name: "套用推镜镜头预设" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "套用跟拍镜头预设" }));

  const metadata = screen.getByRole("generic", { name: "群友预设资料" });
  expect(metadata).toHaveTextContent("跟拍 · v1.0.0");
  expect(metadata).toHaveTextContent("贡献者：AIGC 耀光");
  expect(metadata).toHaveTextContent("联系：抖音号：AIJPDM001");
  expect(metadata).toHaveTextContent("适合：走路、跑步、运动主体");
  const path = useDirectorStore.getState().project.cameras[0].motionPath;
  expect(path?.keyframes.every((point) => point.targetObjectId === "char_default_a")).toBe(true);
});

it("scales the generated camera route without changing the tracked subject", async () => {
  const user = userEvent.setup();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    selectedObjectId: "char_default_a",
    selectedObjectIds: ["char_default_a"],
  });
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  await user.click(screen.getByRole("button", { name: "套用左移镜镜头预设" }));
  const smallPath = useDirectorStore.getState().project.cameras[0].motionPath!;
  const smallTravel = Math.abs(smallPath.keyframes[2].position[0] - smallPath.keyframes[0].position[0]);

  const range = screen.getByRole("slider", { name: "镜头预设轨迹范围" });
  fireEvent.change(range, { target: { value: "3" } });
  const largePath = useDirectorStore.getState().project.cameras[0].motionPath!;
  const largeTravel = Math.abs(largePath.keyframes[2].position[0] - largePath.keyframes[0].position[0]);

  expect(largeTravel).toBeGreaterThan(smallTravel * 2);
  expect(largePath.keyframes.every((keyframe) => keyframe.targetObjectId === "char_default_a")).toBe(true);
  expect(screen.getByRole("button", { name: "套用左移镜镜头预设" })).toHaveAttribute("aria-pressed", "true");
});

it("updates a community preset route immediately while its range slider moves", async () => {
  const user = userEvent.setup();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    selectedObjectId: "char_default_a",
    selectedObjectIds: ["char_default_a"],
  });
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  await user.click(screen.getByRole("button", { name: "群友预设" }));
  await user.click(screen.getByRole("button", { name: "套用平行跟拍镜头预设" }));
  const smallPath = useDirectorStore.getState().project.cameras[0].motionPath!;
  const smallDistance = Math.hypot(...smallPath.keyframes[0].position);

  fireEvent.change(screen.getByRole("slider", { name: "镜头预设轨迹范围" }), { target: { value: "2.5" } });
  const largePath = useDirectorStore.getState().project.cameras[0].motionPath!;
  const largeDistance = Math.hypot(...largePath.keyframes[0].position);

  expect(largeDistance).toBeGreaterThan(smallDistance * 2);
  expect(screen.getByText("250%")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "套用平行跟拍镜头预设" })).toHaveAttribute("aria-pressed", "true");
});

it("enables stabilization for the complete route while keeping per-waypoint overrides", async () => {
  const user = userEvent.setup();
  for (const position of [[0, 2, 8], [2, 2, 6], [5, 2, 3]] as [number, number, number][]) {
    useDirectorStore.getState().recordCameraMotionSnapshot("cam_1", { position, target: [0, 1, 0], fov: 50 });
  }
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  const routeStabilization = screen.getByRole("group", { name: "整条镜头路线防抖" });
  await user.click(within(routeStabilization).getByRole("button", { name: "全部开启" }));
  let keyframes = useDirectorStore.getState().project.cameras[0].motionPath?.keyframes ?? [];
  expect(keyframes.every((keyframe) => keyframe.targetStabilizationEnabled)).toBe(true);
  expect(screen.getByText("已开启 3 / 3 个点，仍可在下方单独修改")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "选择轨迹点 2" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "轨迹点跟踪主体" }), "char_default_a");
  await user.click(within(screen.getByRole("group", { name: "镜头跟踪抖动" })).getByRole("button", { name: "保留抖动" }));
  keyframes = useDirectorStore.getState().project.cameras[0].motionPath?.keyframes ?? [];
  expect(keyframes.map((keyframe) => keyframe.targetStabilizationEnabled)).toEqual([true, false, true]);
  expect(screen.getByText("已开启 2 / 3 个点，仍可在下方单独修改")).toBeInTheDocument();
});

it("lets users retime an individual middle waypoint to control segment speed", async () => {
  const user = userEvent.setup();
  for (const position of [[0, 2, 8], [2, 2, 6], [5, 2, 3]] as [number, number, number][]) {
    useDirectorStore.getState().recordCameraMotionSnapshot("cam_1", { position, target: [0, 1, 0], fov: 50 });
  }
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  await user.click(screen.getByRole("button", { name: "自定义" }));
  await user.click(screen.getByRole("button", { name: "选择轨迹点 2" }));
  const arrival = screen.getByRole("spinbutton", { name: "当前轨迹点到达时间" });
  await user.clear(arrival);
  await user.type(arrival, "4");
  await user.tab();

  expect(useDirectorStore.getState().project.cameras[0].motionPath?.keyframes[1].time).toBeCloseTo(4 / 6);
});

it("offers uniform soft and custom timing plus an explicit waypoint hold", async () => {
  const user = userEvent.setup();
  for (const position of [[0, 2, 8], [2, 2, 6], [5, 2, 3]] as [number, number, number][]) {
    useDirectorStore.getState().recordCameraMotionSnapshot("cam_1", { position, target: [0, 1, 0], fov: 50 });
  }
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  await user.click(screen.getByRole("button", { name: "匀速" }));
  expect(useDirectorStore.getState().project.cameras[0].motionPath?.speedMode).toBe("uniform");
  await user.click(screen.getByRole("button", { name: "柔和" }));
  expect(useDirectorStore.getState().project.cameras[0].motionPath?.speedMode).toBe("soft");

  await user.click(screen.getByRole("button", { name: "选择轨迹点 2" }));
  expect(screen.getByRole("spinbutton", { name: "当前轨迹点到达时间" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "停留" }));
  const hold = screen.getByRole("slider", { name: "轨迹点停留时长" });
  fireEvent.change(hold, { target: { value: "1.4" } });

  const point = useDirectorStore.getState().project.cameras[0].motionPath?.keyframes[1];
  expect(point).toMatchObject({ pointBehavior: "hold", holdSeconds: 1.4 });
  await user.click(screen.getByRole("button", { name: "自定义" }));
  expect(screen.getByRole("spinbutton", { name: "当前轨迹点到达时间" })).toBeEnabled();
  const cameraEasing = screen.getByRole("group", { name: "镜头段内节奏" });
  await user.click(within(cameraEasing).getByRole("button", { name: "慢起" }));
  expect(useDirectorStore.getState().project.cameras[0].motionPath?.customEasing).toEqual([0.42, 0, 1, 1]);
  expect(within(cameraEasing).getByRole("button", { name: "慢起" })).toHaveAttribute("aria-pressed", "true");
});

it("seeks to the computed arrival when selecting a waypoint in automatic timing modes", async () => {
  const user = userEvent.setup();
  const state = useDirectorStore.getState();
  useDirectorStore.setState({
    ...state,
    project: {
      ...state.project,
      cameras: state.project.cameras.map((camera) => ({
        ...camera,
        motionPath: {
          duration: 10,
          loop: false,
          interpolation: "linear",
          easing: "linear",
          speedMode: "uniform",
          keyframes: [
            { id: "uniform_1", time: 0, position: [0, 2, 8], target: [0, 1, 0], fov: 50 },
            { id: "uniform_2", time: 0.5, position: [1, 2, 8], target: [0, 1, 0], fov: 50 },
            { id: "uniform_3", time: 1, position: [10, 2, 8], target: [0, 1, 0], fov: 50 },
          ],
        },
      })),
    },
  });
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  await user.click(screen.getByRole("button", { name: "选择轨迹点 2" }));

  expect(useDirectorStore.getState().cameraMotionProgress).toBeCloseTo(0.1, 4);
  expect(screen.getByRole("button", { name: "选择轨迹点 2" })).toHaveTextContent("1.0s");
});

it("shows a reference video export entry", async () => {
  const user = userEvent.setup();
  render(<MotionStudio getViewportCameraSnapshot={() => ({ position: [0, 2, 8], target: [0, 1, 0], fov: 50 })} />);

  await user.click(screen.getByRole("button", { name: "导出运镜" }));
  expect(screen.getByRole("region", { name: "导出运镜设置" })).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "参考视频画质" })).toHaveValue("720p");
  expect(screen.getByRole("combobox", { name: "参考视频帧率" })).toHaveValue("30");
  expect(screen.getByRole("button", { name: "导出 MP4" })).toBeInTheDocument();
});
