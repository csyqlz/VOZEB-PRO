import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import { clearViewportCaptureHandler, setViewportCaptureHandler } from "../../io/captureBridge";
import { createInitialDirectorState, useDirectorStore } from "../../store/directorStore";
import { CameraPanel } from "../CameraPanel";
import { getDirectorObjectFocusTarget } from "../../schema/cameraTarget";

function seedCameraCapture() {
  useDirectorStore.setState((state) => ({
    ...state,
    project: {
      ...state.project,
      cameras: state.project.cameras.map((camera) =>
        camera.id === "cam_1"
          ? {
              ...camera,
              lastCaptureUrl: "data:image/png;base64,camera-preview",
              captures: [
                {
                  id: "cam_1-capture-01",
                  index: 1,
                  name: "机位01-截图01",
                  dataUrl: "data:image/png;base64,camera-preview",
                },
              ],
            }
          : camera
      ),
    },
  }));
}

function seedGroupedCameraCaptures() {
  const baseState = useDirectorStore.getState();
  const firstCamera = baseState.project.cameras[0];
  expect(firstCamera).toBeTruthy();

  useDirectorStore.setState({
    ...baseState,
    project: {
      ...baseState.project,
      cameras: [
        {
          ...firstCamera!,
          captures: [
            {
              id: "cam_1-capture-01",
              index: 1,
              name: "机位01-截图01",
              dataUrl: "data:image/png;base64,camera-1-a",
            },
            {
              id: "cam_1-capture-02",
              index: 2,
              name: "机位01-截图02",
              dataUrl: "data:image/png;base64,camera-1-b",
            },
          ],
          lastCaptureUrl: "data:image/png;base64,camera-1-b",
        },
        {
          ...firstCamera!,
          id: "cam_2",
          name: "机位02",
          captures: [
            {
              id: "cam_2-capture-01",
              index: 1,
              name: "机位02-截图01",
              dataUrl: "data:image/png;base64,camera-2-a",
            },
          ],
          lastCaptureUrl: "data:image/png;base64,camera-2-a",
        },
      ],
    },
  });
}

beforeEach(() => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
    selectedObjectId: "cam_object_1",
    selectedCameraKeyframeId: null,
    cameraMotionProgress: 0,
    cameraMotionPlaying: false,
  });
});

afterEach(() => {
  clearViewportCaptureHandler();
  vi.restoreAllMocks();
});

it("renders the approved camera panel fields", () => {
  render(<CameraPanel />);

  expect(screen.getByText("摄像机")).toBeInTheDocument();
  expect(screen.getByLabelText("机位名称")).toBeInTheDocument();
  expect(screen.getByLabelText("切换机位")).toBeInTheDocument();
  expect(screen.getByLabelText("机位位置 X")).toBeInTheDocument();
  expect(screen.getByLabelText("注视目标模式")).toBeInTheDocument();
  expect(screen.getByLabelText("注视坐标 X")).toBeInTheDocument();
  expect(screen.getByLabelText("机位 FOV")).toBeInTheDocument();
});

it("uses the provided right inspector layout for camera properties", () => {
  const { container } = render(<CameraPanel />);

  expect(screen.getByLabelText("摄像机右侧属性面板")).toHaveClass("right-inspector");
  expect(container.querySelector(".right-inspector-tabs")).toBeInTheDocument();
  expect(container.querySelector(".right-inspector-content")).toBeInTheDocument();
  expect(screen.queryByLabelText("机位预览卡片")).not.toBeInTheDocument();
  expect(screen.queryByText("FOV 50°")).not.toBeInTheDocument();
  expect(container.querySelector("select.inspector-select-input")).not.toBeInTheDocument();
  expect(screen.getByLabelText("切换机位")).toHaveClass("inspector-dropdown-trigger");
  expect(screen.getByLabelText("注视目标模式")).toHaveClass("inspector-dropdown-trigger");

  const positionY = screen.getByLabelText("机位位置 Y").closest(".inspector-axis-input");
  const fovField = screen.getByLabelText("机位 FOV").closest(".inspector-range-row");

  expect(positionY).toBeInTheDocument();
  expect(within(positionY as HTMLElement).getByText("Y")).toHaveClass("inspector-axis-prefix");
  expect(fovField).toBeInTheDocument();
});

it("keeps camera panel tab labels in fixed slots while switching tabs", async () => {
  const user = userEvent.setup();
  const { container } = render(<CameraPanel />);
  const tabList = container.querySelector(".right-inspector-tabs");
  const propertyTab = screen.getByRole("button", { name: "属性" });
  const capturesTab = screen.getByRole("button", { name: "摄像机截图" });

  expect(tabList).toHaveClass("right-inspector-tabs");
  expect(propertyTab).toHaveClass("right-inspector-tab-button");
  expect(capturesTab).toHaveClass("right-inspector-tab-button");
  expect(propertyTab).toHaveAttribute("aria-pressed", "true");

  await user.click(capturesTab);

  expect(propertyTab).toHaveClass("right-inspector-tab-button");
  expect(capturesTab).toHaveClass("right-inspector-tab-button");
  expect(capturesTab).toHaveAttribute("aria-pressed", "true");
});

it("builds and previews a free camera motion path from the motion tab", async () => {
  const user = userEvent.setup();
  render(<CameraPanel />);

  await user.click(screen.getByRole("button", { name: "轨迹" }));

  expect(screen.getByRole("status")).toHaveTextContent("还没有摄影机轨迹");
  await user.click(screen.getByRole("button", { name: "将当前机位添加为轨迹点" }));

  const currentCamera = useDirectorStore.getState().project.cameras[0];
  act(() => {
    useDirectorStore.getState().updateCamera("cam_1", {
      transform: { ...currentCamera.transform, position: [4, 3, -2] },
      fov: 38,
    });
  });
  await user.click(screen.getByRole("button", { name: "将当前机位添加为轨迹点" }));

  const keyframeList = screen.getByRole("list", { name: "摄影机轨迹点" });
  expect(within(keyframeList).getAllByRole("listitem")).toHaveLength(2);
  expect(screen.getByLabelText("摄影机路径插值")).toHaveTextContent("平滑曲线");

  const playButton = screen.getByRole("button", { name: "播放轨迹预演" });
  expect(playButton).toBeEnabled();
  await user.click(playButton);

  expect(useDirectorStore.getState().viewMode).toBe("camera");
  expect(useDirectorStore.getState().cameraMotionPlaying).toBe(true);

  fireEvent.change(screen.getByLabelText("摄影机轨迹播放位置"), { target: { value: "0.4" } });

  expect(useDirectorStore.getState().cameraMotionPlaying).toBe(false);
  expect(useDirectorStore.getState().cameraMotionProgress).toBe(0.4);
});

it("activates the first existing motion point when opening the motion tab", async () => {
  const user = userEvent.setup();
  useDirectorStore.getState().addCameraMotionKeyframe("cam_1");
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    viewMode: "camera",
    selectedCameraKeyframeId: null,
    cameraMotionProgress: 0.75,
  });

  render(<CameraPanel />);
  await user.click(screen.getByRole("button", { name: "轨迹" }));

  expect(useDirectorStore.getState().viewMode).toBe("director");
  expect(useDirectorStore.getState().selectedCameraKeyframeId).toBe("cam_1_motion_key_1");
  expect(useDirectorStore.getState().cameraMotionProgress).toBe(0);
  expect(screen.getByRole("button", { name: "选择轨迹点 K1" })).toHaveAttribute("aria-pressed", "true");
});

it("uses computed automatic arrival times when selecting motion points", async () => {
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
            { id: "panel_uniform_1", time: 0, position: [0, 2, 8], target: [0, 1, 0], fov: 50 },
            { id: "panel_uniform_2", time: 0.5, position: [1, 2, 8], target: [0, 1, 0], fov: 50 },
            { id: "panel_uniform_3", time: 1, position: [10, 2, 8], target: [0, 1, 0], fov: 50 },
          ],
        },
      })),
    },
  });
  render(<CameraPanel />);

  await user.click(screen.getByRole("button", { name: "轨迹" }));
  await user.click(screen.getByRole("button", { name: "选择轨迹点 K2" }));

  expect(useDirectorStore.getState().cameraMotionProgress).toBeCloseTo(0.1, 4);
  expect(screen.getByRole("button", { name: "选择轨迹点 K2" })).toHaveTextContent("1.0s");
});

it("edits and removes the selected camera motion keyframe", async () => {
  const user = userEvent.setup();
  useDirectorStore.getState().addCameraMotionKeyframe("cam_1");
  render(<CameraPanel />);

  await user.click(screen.getByRole("button", { name: "轨迹" }));
  await user.clear(screen.getByLabelText("轨迹点位置 X"));
  await user.type(screen.getByLabelText("轨迹点位置 X"), "7.5");
  await user.clear(screen.getByLabelText("轨迹点 FOV"));
  await user.type(screen.getByLabelText("轨迹点 FOV"), "32");
  await user.tab();

  expect(useDirectorStore.getState().project.cameras[0].motionPath?.keyframes[0]).toMatchObject({
    position: [7.5, expect.any(Number), expect.any(Number)],
    fov: 32,
  });

  await user.click(screen.getByRole("button", { name: "删除当前轨迹点" }));

  expect(useDirectorStore.getState().project.cameras[0].motionPath?.keyframes).toEqual([]);
  expect(screen.getByRole("status")).toHaveTextContent("还没有摄影机轨迹");
});

it("updates the selected camera name and fov", async () => {
  const user = userEvent.setup();
  render(<CameraPanel />);

  await user.clear(screen.getByLabelText("机位名称"));
  await user.type(screen.getByLabelText("机位名称"), "近景机位");
  await user.clear(screen.getByLabelText("机位 FOV"));
  await user.type(screen.getByLabelText("机位 FOV"), "65");

  const camera = useDirectorStore.getState().project.cameras[0];
  expect(camera.name).toBe("近景机位");
  expect(camera.fov).toBe(65);
});

it("uses the custom dropdown menu to switch camera shots", async () => {
  const user = userEvent.setup();
  useDirectorStore.getState().addCameraShot();

  render(<CameraPanel />);

  await user.click(screen.getByLabelText("切换机位"));

  const menu = screen.getByRole("listbox", { name: "切换机位" });

  expect(menu).toHaveClass("inspector-dropdown-menu");

  await user.click(within(menu).getByRole("option", { name: "机位01" }));

  expect(useDirectorStore.getState().project.activeCameraId).toBe("cam_1");
  expect(screen.queryByRole("listbox", { name: "切换机位" })).not.toBeInTheDocument();
});

it("renders target mode as the custom dropdown menu", async () => {
  const user = userEvent.setup();

  render(<CameraPanel />);

  await user.click(screen.getByLabelText("注视目标模式"));

  const menu = screen.getByRole("listbox", { name: "注视目标模式" });
  const manualOption = within(menu).getByRole("option", { name: "手动坐标" });

  expect(menu).toHaveClass("inspector-dropdown-menu");
  expect(manualOption).toHaveClass("is-selected");
  expect(manualOption).toHaveAttribute("aria-selected", "true");
});

it("lists visible viewport models as camera focus targets and centers on the selected model", async () => {
  const user = userEvent.setup();
  useDirectorStore.getState().addPresetCharacter("female");
  useDirectorStore.getState().addGeometryPrimitive("box");

  render(<CameraPanel />);

  await user.click(screen.getByLabelText("注视目标模式"));

  const menu = screen.getByRole("listbox", { name: "注视目标模式" });
  const modelNames = within(menu).getAllByRole("option").map((option) => option.textContent);

  expect(modelNames).toEqual(["手动坐标", "角色01", "角色02", "立方体"]);
  expect(within(menu).queryByRole("option", { name: "机位01" })).not.toBeInTheDocument();

  await user.click(within(menu).getByRole("option", { name: "角色02" }));

  const state = useDirectorStore.getState();
  const focusedObject = state.project.objects.find((item) => item.name === "角色02");
  const camera = state.project.cameras.find((item) => item.id === state.project.activeCameraId);

  expect(focusedObject).toBeTruthy();
  expect(camera?.targetMode).toBe("object");
  expect(camera?.targetObjectId).toBe(focusedObject?.id);
  expect(camera?.target).toEqual(getDirectorObjectFocusTarget(focusedObject!));
  expect(screen.getByLabelText("注视目标模式")).toHaveTextContent("角色02");
  expect(screen.getByLabelText("注视坐标 X")).toHaveValue(-1.25);
  expect(screen.getByLabelText("注视坐标 Y")).toHaveValue(camera?.target[1]);
  expect(screen.getByLabelText("注视坐标 Z")).toHaveValue(0);
});

it("updates camera position and target coordinates across all axes", async () => {
  const user = userEvent.setup();
  render(<CameraPanel />);

  await user.clear(screen.getByLabelText("机位位置 Y"));
  await user.type(screen.getByLabelText("机位位置 Y"), "3.4");
  await user.clear(screen.getByLabelText("机位位置 Z"));
  await user.type(screen.getByLabelText("机位位置 Z"), "7.5");
  await user.clear(screen.getByLabelText("注视坐标 Y"));
  await user.type(screen.getByLabelText("注视坐标 Y"), "1.8");
  await user.clear(screen.getByLabelText("注视坐标 Z"));
  await user.type(screen.getByLabelText("注视坐标 Z"), "2");

  const camera = useDirectorStore.getState().project.cameras[0];
  expect(camera.transform.position).toEqual([0, 3.4, 7.5]);
  expect(camera.target).toEqual([0, 1.8, 2]);
});

it("captures the current camera preview from the properties tab and shows it in the screenshots overview", async () => {
  const user = userEvent.setup();
  setViewportCaptureHandler(async () => [
    {
      label: "当前机位",
      dataUrl: "data:image/png;base64,camera-preview",
      meta: {
        mode: "camera",
        cameraId: "cam_1",
        fov: 50,
        position: [0, 2.2, 9],
        target: [0, 1.2, 0],
      },
    },
  ]);

  render(<CameraPanel />);

  await user.click(screen.getByRole("button", { name: "当前机位截图" }));
  await user.click(screen.getByRole("button", { name: "摄像机截图" }));

  expect(useDirectorStore.getState().project.cameras[0]?.lastCaptureUrl).toBe("data:image/png;base64,camera-preview");
  expect(useDirectorStore.getState().project.cameras[0]?.captures).toEqual([
    {
      id: "cam_1-capture-01",
      index: 1,
      name: "机位01-截图01",
      dataUrl: "data:image/png;base64,camera-preview",
    },
  ]);
  expect(await screen.findByAltText("机位01-截图01 缩略图")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "机位01截图" })).toBeInTheDocument();
  expect(screen.getByText("机位01-截图01")).toBeInTheDocument();
});

it("keeps the camera capture section visible at the bottom of the properties tab", () => {
  render(<CameraPanel />);

  expect(screen.getByRole("heading", { name: "相机截图" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "当前机位截图" })).toHaveClass("camera-capture-current-button");
  expect(screen.getByTestId("camera-current-capture-icon")).toBeInTheDocument();
});

it("renders the thumbnail actions in a bottom bar and opens the project-style viewer toolbar", async () => {
  const user = userEvent.setup();
  seedCameraCapture();

  render(<CameraPanel />);

  expect(screen.getByRole("group", { name: "机位01-截图01 缩略图操作" })).toHaveClass("camera-capture-actions");

  await user.click(screen.getByLabelText("查看截图 机位01-截图01"));

  const viewer = screen.getByRole("dialog", { name: "相机截图查看器" });
  const toolbar = within(viewer).getByRole("toolbar", { name: "相机截图查看器工具栏" });

  expect(viewer).toBeInTheDocument();
  expect(screen.getByAltText("机位01-截图01 查看大图")).toBeInTheDocument();
  expect(within(toolbar).getByRole("button", { name: "放大图片" })).toBeInTheDocument();
  expect(within(toolbar).getByRole("button", { name: "缩小图片" })).toBeInTheDocument();
  expect(within(toolbar).getByRole("button", { name: "下载图片" })).toBeInTheDocument();
  expect(within(toolbar).getByRole("button", { name: "关闭相机截图查看器" })).toBeInTheDocument();
});

it("sends a single camera capture to the host canvas when the thumbnail action is clicked", async () => {
  const user = userEvent.setup();
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  seedCameraCapture();

  render(<CameraPanel />);

  await user.click(screen.getByRole("button", { name: "发送到画布 机位01-截图01" }));

  expect(postMessage).toHaveBeenCalledWith(
    {
      type: "storyai:director-desk-captures-sent",
      payload: {
        requestId: expect.stringMatching(/^capture-/),
        captures: [
          {
            dataUrl: "data:image/png;base64,camera-preview",
            fileName: "机位01-截图01.png",
          },
        ],
      },
    },
    window.location.origin
  );
});

it("shows all camera screenshots grouped by camera in the screenshots tab", async () => {
  const user = userEvent.setup();
  seedGroupedCameraCaptures();

  render(<CameraPanel />);

  await user.click(screen.getByRole("button", { name: "摄像机截图" }));

  const firstGroup = screen.getByRole("region", { name: "机位01截图" });
  const secondGroup = screen.getByRole("region", { name: "机位02截图" });

  expect(screen.queryByRole("heading", { name: "相机截图" })).not.toBeInTheDocument();
  expect(within(firstGroup).getByRole("heading", { name: "机位01截图" })).toBeInTheDocument();
  expect(within(firstGroup).getByText("机位01-截图01")).toBeInTheDocument();
  expect(within(firstGroup).getByText("机位01-截图02")).toBeInTheDocument();
  expect(within(secondGroup).getByRole("heading", { name: "机位02截图" })).toBeInTheDocument();
  expect(within(secondGroup).getByText("机位02-截图01")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "清空全部" })).toHaveClass("camera-capture-clear-all");
  expect(screen.getByRole("button", { name: "发送到画布" })).toHaveClass(
    "camera-capture-send-all",
    "viewport-toolbar-crowd-confirm"
  );
  expect(screen.getByRole("button", { name: "发送到画布" })).not.toHaveClass("is-hover-state");
  expect(screen.getByTestId("camera-capture-clear-icon")).toBeInTheDocument();
  expect(screen.getByTestId("camera-capture-send-icon")).toBeInTheDocument();

  const panel = screen.getByLabelText("摄像机右侧属性面板");
  const content = panel.querySelector(".right-inspector-content");
  const footer = panel.querySelector(".camera-capture-overview-footer");

  expect(footer).toBeInTheDocument();
  expect(content).toBeInTheDocument();
  expect(content).not.toContainElement(footer as HTMLElement);
});

it("sends all visible camera screenshots to the host canvas from the overview footer", async () => {
  const user = userEvent.setup();
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  seedGroupedCameraCaptures();

  render(<CameraPanel />);

  await user.click(screen.getByRole("button", { name: "摄像机截图" }));
  await user.click(screen.getByRole("button", { name: "发送到画布" }));

  expect(postMessage).toHaveBeenCalledWith(
    {
      type: "storyai:director-desk-captures-sent",
      payload: {
        requestId: expect.stringMatching(/^capture-/),
        captures: [
          {
            dataUrl: "data:image/png;base64,camera-1-a",
            fileName: "机位01-截图01.png",
          },
          {
            dataUrl: "data:image/png;base64,camera-1-b",
            fileName: "机位01-截图02.png",
          },
          {
            dataUrl: "data:image/png;base64,camera-2-a",
            fileName: "机位02-截图01.png",
          },
        ],
      },
    },
    window.location.origin
  );
});

it("clears every camera screenshot from the screenshots tab and shows the empty state", async () => {
  const user = userEvent.setup();
  seedGroupedCameraCaptures();

  render(<CameraPanel />);

  await user.click(screen.getByRole("button", { name: "摄像机截图" }));
  await user.click(screen.getByRole("button", { name: "清空全部" }));

  expect(screen.queryByText("机位01-截图01")).not.toBeInTheDocument();
  const emptyState = screen.getByRole("status", { name: "暂无摄像机截图" });
  expect(emptyState).toHaveClass("camera-capture-empty", "object-search-empty-state");
  expect(screen.getByTestId("camera-capture-empty-icon")).toHaveClass("object-search-empty-icon");
  expect(screen.getByTestId("camera-capture-empty-icon").querySelector(".lucide-images")).toBeInTheDocument();
  expect(screen.getByTestId("camera-capture-empty-icon").querySelector(".lucide-search")).not.toBeInTheDocument();
  expect(screen.getByText("暂无摄像机截图")).toBeInTheDocument();
  expect(useDirectorStore.getState().project.cameras.map((camera) => camera.captures ?? [])).toEqual([[], []]);
  expect(useDirectorStore.getState().project.cameras.map((camera) => camera.lastCaptureUrl ?? null)).toEqual([
    null,
    null,
  ]);
});

it("closes the capture viewer when clicking outside the image", async () => {
  const user = userEvent.setup();
  seedCameraCapture();

  const { container } = render(<CameraPanel />);

  await user.click(screen.getByLabelText("查看截图 机位01-截图01"));

  const previewImage = screen.getByAltText("机位01-截图01 查看大图");
  const viewerStage = container.querySelector(".camera-capture-viewer-stage");

  expect(viewerStage).toBeInTheDocument();

  await user.click(previewImage);
  expect(screen.getByRole("dialog", { name: "相机截图查看器" })).toBeInTheDocument();

  await user.click(viewerStage as HTMLElement);
  expect(screen.queryByRole("dialog", { name: "相机截图查看器" })).not.toBeInTheDocument();
});

it("zooms the capture preview through the viewer toolbar controls with the canvas image preview step", async () => {
  const user = userEvent.setup();
  seedCameraCapture();

  render(<CameraPanel />);

  await user.click(screen.getByLabelText("查看截图 机位01-截图01"));
  await user.click(screen.getByRole("button", { name: "放大图片" }));

  expect(screen.getByAltText("机位01-截图01 查看大图")).toHaveStyle({
    transform: "translate(0px, 0px) scale(1.25)",
  });
});

it("supports wheel zooming and dragging like the canvas image preview", async () => {
  const user = userEvent.setup();
  seedCameraCapture();

  render(<CameraPanel />);

  await user.click(screen.getByLabelText("查看截图 机位01-截图01"));

  const previewImage = screen.getByAltText("机位01-截图01 查看大图");

  fireEvent.wheel(previewImage, { deltaY: -100 });
  expect(previewImage).toHaveStyle({ transform: "translate(0px, 0px) scale(1.25)" });

  fireEvent.mouseDown(previewImage, { clientX: 100, clientY: 100 });
  fireEvent.mouseMove(window, { clientX: 124, clientY: 132 });
  fireEvent.mouseUp(window);

  expect(previewImage).toHaveStyle({ transform: "translate(24px, 32px) scale(1.25)" });
});

it("deletes a camera capture from the screenshot grid", async () => {
  const user = userEvent.setup();
  seedCameraCapture();

  render(<CameraPanel />);

  await user.click(screen.getByLabelText("删除截图 机位01-截图01"));

  expect(screen.queryByText("机位01-截图01")).not.toBeInTheDocument();
  expect(useDirectorStore.getState().project.cameras[0]?.captures).toEqual([]);
  expect(useDirectorStore.getState().project.cameras[0]?.lastCaptureUrl).toBeNull();
});
