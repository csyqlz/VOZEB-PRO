import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import { clearViewportCaptureHandler, setViewportCaptureHandler } from "../../io/captureBridge";
import { BODY_TYPE_OPTIONS } from "../../runtime/mannequin/bodyTypes";
import { createInitialDirectorState, useDirectorStore } from "../../store/directorStore";
import { getCameraRigPositionFromViewSnapshot, getCameraViewSnapshotFromShot } from "../../schema/cameraGeometry";
import { ViewportToolbar } from "../ViewportToolbar";

const mockReadLocalModelFile = vi.fn();
const mockInspectCharacterModelFile = vi.fn();

vi.mock("../../loaders/localModelImport", () => ({
  readLocalModelFile: (...args: unknown[]) => mockReadLocalModelFile(...args),
}));

vi.mock("../../loaders/characterAssetInspection", () => ({
  inspectCharacterModelFile: (...args: unknown[]) => mockInspectCharacterModelFile(...args),
}));

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
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
  });
  mockReadLocalModelFile.mockReset();
  mockInspectCharacterModelFile.mockReset();
});

afterEach(() => {
  clearViewportCaptureHandler();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("renders the viewport capsule as project icon-system buttons", () => {
  render(<ViewportToolbar />);

  const toolbar = screen.getByRole("group", { name: "3D视口快捷工具" });
  const expectedActions = [
    "移动",
    "旋转",
    "缩放",
    "显示人物路线",
    "添加角色",
    "导入本地模型",
    "模型库",
    "添加机位",
    "选择画幅比例",
    "当前视角截图",
    "四方位截图",
    "十二方位截图",
    "全屏",
  ];

  expectedActions.forEach((label) => {
    const button = within(toolbar).getByRole("button", { name: label });

    expect(button.querySelector("svg")).toBeInTheDocument();
    expect(button).toHaveClass("viewport-toolbar-button");
  });

  expect(toolbar).toHaveClass("viewport-toolbar");

  const toolbarButtonLabels = Array.from(toolbar.querySelectorAll("button[aria-label]")).map((button) =>
    button.getAttribute("aria-label")
  );
  expect(toolbarButtonLabels.indexOf("模型库")).toBe(toolbarButtonLabels.indexOf("导入本地模型") + 1);
});

it("keeps character routes visible by default and lets the viewport toolbar hide them", async () => {
  const user = userEvent.setup();
  render(<ViewportToolbar />);

  const toggle = screen.getByRole("button", { name: "显示人物路线" });
  expect(toggle).toHaveAttribute("aria-pressed", "true");

  await user.click(toggle);
  expect(useDirectorStore.getState().showCharacterRoutes).toBe(false);
  expect(toggle).toHaveAttribute("aria-pressed", "false");
});

it("renders custom hover labels instead of native title tooltips", () => {
  render(<ViewportToolbar />);

  const toolbar = screen.getByRole("group", { name: "3D视口快捷工具" });
  const button = within(toolbar).getByRole("button", { name: "导入本地模型" });
  const label = within(button).getByText("导入本地模型");

  expect(button).not.toHaveAttribute("title");
  expect(label).toHaveClass("viewport-toolbar-label");
});

it("uses the requested viewport toolbar SVG icons for camera and capture actions", () => {
  render(<ViewportToolbar />);

  expect(screen.getByRole("button", { name: "添加机位" }).querySelector("svg")).toHaveClass("lucide-video");
  expect(screen.getByRole("button", { name: "当前视角截图" }).querySelector("svg")).toHaveClass("lucide-camera");
  expect(screen.getByRole("button", { name: "四方位截图" }).querySelector("svg")).toHaveClass("lucide-grid2x2");
  expect(screen.getByRole("button", { name: "十二方位截图" }).querySelector("svg")).toHaveClass("lucide-grid3x3");
});

it("uses the fullscreen button to collapse the side panels instead of entering browser fullscreen", async () => {
  const user = userEvent.setup();
  render(<ViewportToolbar />);

  expect((useDirectorStore.getState() as { viewportPanelsCollapsed?: boolean }).viewportPanelsCollapsed ?? false).toBe(
    false
  );

  await user.click(screen.getByRole("button", { name: "全屏" }));

  expect((useDirectorStore.getState() as { viewportPanelsCollapsed?: boolean }).viewportPanelsCollapsed ?? false).toBe(
    true
  );
});

it("creates a new camera before storing viewport capsule screenshots from director view", async () => {
  const user = userEvent.setup();
  const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const snapshot = {
    fov: 64,
    position: [3, 2, 1] as [number, number, number],
    target: [0, 1, -2] as [number, number, number],
  };
  const handler = vi.fn(async () => [
    {
      label: "当前机位",
      dataUrl: "data:image/png;base64,current-camera",
      meta: {
        mode: "camera" as const,
        cameraId: "cam_2",
        fov: 64,
        position: [3, 2, 1] as [number, number, number],
        target: [0, 1, -2] as [number, number, number],
      },
    },
  ]);

  setViewportCaptureHandler(handler);
  render(<ViewportToolbar getViewportCameraSnapshot={() => snapshot} />);

  await user.click(screen.getByRole("button", { name: "当前视角截图" }));

  await waitFor(() => {
    expect(handler).toHaveBeenCalledWith({ preset: "current", source: "camera-panel", cameraId: "cam_2" });
  });

  const state = useDirectorStore.getState();
  const originalCamera = state.project.cameras[0];
  const newCamera = state.project.cameras[1];

  expect(anchorClick).not.toHaveBeenCalled();
  expect(state.viewMode).toBe("camera");
  expect(state.project.activeCameraId).toBe("cam_2");
  expect(state.selectedObjectId).toBe("cam_object_2");
  expect(originalCamera?.captures).toEqual([]);
  expect(newCamera?.fov).toBe(64);
  expect(newCamera?.transform.position).toEqual(getCameraRigPositionFromViewSnapshot(snapshot));
  expect(getCameraViewSnapshotFromShot(newCamera)).toEqual(snapshot);
  expect(newCamera?.captures).toEqual([
    {
      id: "cam_2-capture-01",
      index: 1,
      name: "机位02-截图01",
      dataUrl: "data:image/png;base64,current-camera",
    },
  ]);
  expect(newCamera?.lastCaptureUrl).toBe("data:image/png;base64,current-camera");
});

it("stores viewport capsule screenshots in the current camera while already in camera view", async () => {
  const user = userEvent.setup();
  const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const secondCameraSnapshot = {
    fov: 58,
    position: [1, 2, 6] as [number, number, number],
    target: [0, 1, 0] as [number, number, number],
  };
  const handler = vi.fn(async ({ preset }: { preset: "current" | "four" | "twelve" }) =>
    Array.from({ length: preset === "four" ? 4 : 1 }, (_, index) => ({
      label: `机位截图-${index + 1}`,
      dataUrl: `data:image/png;base64,camera-view-${index + 1}`,
      meta: {
        mode: "camera" as const,
        cameraId: "cam_2",
        fov: 58,
        position: [1, 2, 6] as [number, number, number],
        target: [0, 1, 0] as [number, number, number],
      },
    }))
  );

  useDirectorStore.getState().addCameraShot(secondCameraSnapshot);
  useDirectorStore.getState().setViewMode("camera");
  setViewportCaptureHandler(handler);
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "四方位截图" }));

  await waitFor(() => {
    expect(handler).toHaveBeenCalledWith({ preset: "four", source: "camera-panel", cameraId: "cam_2" });
  });

  const state = useDirectorStore.getState();
  const originalCamera = state.project.cameras[0];
  const activeCamera = state.project.cameras[1];

  expect(anchorClick).not.toHaveBeenCalled();
  expect(state.project.cameras).toHaveLength(2);
  expect(state.viewMode).toBe("camera");
  expect(state.project.activeCameraId).toBe("cam_2");
  expect(originalCamera?.captures).toEqual([]);
  expect(activeCamera?.captures).toHaveLength(4);
  expect(activeCamera?.captures?.map((item) => item.name)).toEqual([
    "机位02-截图01",
    "机位02-截图02",
    "机位02-截图03",
    "机位02-截图04",
  ]);
  expect(activeCamera?.lastCaptureUrl).toBe("data:image/png;base64,camera-view-4");
});

it("switches the active transform control mode from the viewport capsule", async () => {
  const user = userEvent.setup();
  render(<ViewportToolbar />);

  expect(screen.getByRole("button", { name: "移动" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "移动" })).toHaveClass("is-active");
  expect(screen.getByRole("button", { name: "旋转" })).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByRole("button", { name: "缩放" })).toHaveAttribute("aria-pressed", "false");

  await user.click(screen.getByRole("button", { name: "旋转" }));
  expect(useDirectorStore.getState().transformMode).toBe("rotate");
  expect(screen.getByRole("button", { name: "移动" })).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByRole("button", { name: "旋转" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "旋转" })).toHaveClass("is-active");

  await user.click(screen.getByRole("button", { name: "缩放" }));
  expect(useDirectorStore.getState().transformMode).toBe("scale");
  expect(screen.getByRole("button", { name: "旋转" })).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByRole("button", { name: "缩放" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "缩放" })).toHaveClass("is-active");

  await user.click(screen.getByRole("button", { name: "移动" }));
  expect(useDirectorStore.getState().transformMode).toBe("translate");
  expect(screen.getByRole("button", { name: "移动" })).toHaveAttribute("aria-pressed", "true");
});

it("keeps add role and add camera actions available from the viewport capsule", async () => {
  const user = userEvent.setup();
  const snapshot = { fov: 64, position: [3, 2, 1] as [number, number, number], target: [0, 1, -2] as [number, number, number] };

  render(<ViewportToolbar getViewportCameraSnapshot={() => snapshot} />);

  await user.click(screen.getByRole("button", { name: "添加角色" }));
  await user.click(screen.getByRole("menuitem", { name: "男性素体" }));
  await user.click(screen.getByRole("button", { name: "添加机位" }));

  const state = useDirectorStore.getState();
  const characterCount = state.project.objects.filter((item) => item.kind === "character").length;
  const cameraCount = state.project.cameras.length;

  expect(characterCount).toBe(2);
  expect(cameraCount).toBe(2);
  expect(state.selectedObjectId).toBe("cam_object_2");
  expect(state.project.cameras[1].fov).toBe(64);
  expect(state.project.cameras[1].transform.position).toEqual(getCameraRigPositionFromViewSnapshot(snapshot));
  expect(getCameraViewSnapshotFromShot(state.project.cameras[1]).position).toEqual(snapshot.position);
  expect(state.project.cameras[1].target).toEqual([0, 1, -2]);
});

it("does not show operation feedback text on the right side of the viewport capsule", async () => {
  const user = userEvent.setup();
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "旋转" }));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.queryByText("已切换到旋转工具")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "添加角色" }));
  await user.click(screen.getByRole("menuitem", { name: "男性素体" }));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.queryByText("已添加男性素体")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "选择画幅比例" }));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.queryByText("画幅比例入口已就绪")).not.toBeInTheDocument();
});

it("adds a selected procedural body type from the add-character menu", async () => {
  const user = userEvent.setup();
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "添加角色" }));

  BODY_TYPE_OPTIONS.forEach((option) => {
    expect(screen.getByRole("menuitem", { name: option.label })).toBeInTheDocument();
  });

  await user.click(screen.getByRole("menuitem", { name: "宽厚素体" }));

  const characters = useDirectorStore.getState().project.objects.filter((item) => item.kind === "character");
  const added = characters[characters.length - 1];

  expect(added?.bodyType).toBe("broad");
  expect(useDirectorStore.getState().selectedObjectId).toBe(added?.id);
});

it("adds geometry primitives from the add-character submenu", async () => {
  const user = userEvent.setup();
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "添加角色" }));

  const geometryMenuItem = screen.getByRole("menuitem", { name: "几何模型" });
  expect(geometryMenuItem.querySelector("svg")).toBeInTheDocument();

  await user.hover(geometryMenuItem);

  ["立方体", "球体", "圆柱体", "环状体", "圆锥", "棱锥"].forEach((label) => {
    expect(screen.getByRole("menuitem", { name: label })).toBeInTheDocument();
  });

  await user.click(screen.getByRole("menuitem", { name: "立方体" }));

  const prop = useDirectorStore.getState().project.objects.find((item) => item.kind === "prop");

  expect(prop?.name).toBe("立方体");
  expect(prop?.geometryType).toBe("box");
  expect(prop?.color).toBe("#d7e7ff");
  expect(useDirectorStore.getState().selectedObjectId).toBe(prop?.id);
});

it("opens a crowd panel from the add-character menu hover row and adds a 3x3 character array", async () => {
  const user = userEvent.setup();
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "添加角色" }));

  const crowdMenuItem = screen.getByRole("menuitem", { name: "群众 (3x3)" });
  expect(crowdMenuItem.querySelector(".lucide-users")).not.toBeInTheDocument();
  expect(crowdMenuItem.querySelector(".lucide-chevron-right")).toBeInTheDocument();

  fireEvent.click(crowdMenuItem);
  expect(screen.queryByRole("dialog", { name: "添加群众阵列" })).not.toBeInTheDocument();

  await user.hover(crowdMenuItem);

  const crowdDialog = screen.getByRole("dialog", { name: "添加群众阵列" });
  expect(crowdDialog).toBeInTheDocument();
  expect(within(crowdDialog).getByText("共9人")).toBeInTheDocument();
  expect(within(crowdDialog).getByLabelText("群众行数")).toHaveValue(3);
  expect(within(crowdDialog).getByLabelText("群众列数")).toHaveValue(3);
  expect(within(crowdDialog).getByLabelText("群众间距")).toHaveValue(1.2);
  expect(within(crowdDialog).getByRole("button", { name: "取消" })).toHaveClass("camera-capture-clear-all");
  expect(within(crowdDialog).getByRole("button", { name: "添加群众" })).toHaveClass("camera-capture-send-all");

  await user.click(screen.getByRole("button", { name: "添加群众" }));

  await waitFor(() => {
    expect(useDirectorStore.getState().project.objects.filter((item) => item.kind === "character")).toHaveLength(10);
  });

  const state = useDirectorStore.getState();
  const crowdCharacters = state.project.objects.filter((item) => item.kind === "character" && item.id !== "char_default_a");

  expect(crowdCharacters).toHaveLength(9);
  expect(screen.queryByRole("dialog", { name: "添加群众阵列" })).not.toBeInTheDocument();
  expect(state.selectedObjectIds).toHaveLength(9);
  expect(state.selectedObjectId).toBe(crowdCharacters[crowdCharacters.length - 1]?.id ?? null);
});

it("opens the model library panel from the viewport capsule", async () => {
  const user = userEvent.setup();
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "模型库" }));

  expect(screen.getByRole("dialog", { name: "模型库" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "便利生活" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tab", { name: "居家生活" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "户外出行" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "工具配件" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "我的模型" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "关闭模型库" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "添加模型 自动取款机" })).toBeInTheDocument();
  expect(screen.getByText("自动取款机")).toBeInTheDocument();
  expect(screen.queryByText("ATM")).not.toBeInTheDocument();
  expect(screen.queryByText("2 Liter")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "添加模型 自动取款机" }).querySelector("img")).toBeInTheDocument();
});

it("uses category thumbnail folders for outdoor and tools model library items", async () => {
  const user = userEvent.setup();
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "模型库" }));
  await user.click(screen.getByRole("tab", { name: "户外出行" }));

  expect(screen.getByRole("button", { name: "添加模型 背包" }).querySelector("img")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "添加模型 保温瓶" }).querySelector("img")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "添加模型 鹿头骨" }).querySelector("img")).toBeInTheDocument();

  await user.click(screen.getByRole("tab", { name: "工具配件" }));

  expect(screen.getByRole("button", { name: "添加模型 扳手" }).querySelector("img")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "添加模型 台钻" }).querySelector("img")).toBeInTheDocument();
});

it("renders floating viewport menus and model library outside the frosted toolbar shell", async () => {
  const user = userEvent.setup();
  render(<ViewportToolbar />);

  const toolbar = screen.getByRole("group", { name: "3D视口快捷工具" });

  await user.click(screen.getByRole("button", { name: "添加角色" }));
  const characterMenu = screen.getByRole("menu", { name: "选择角色体型" });
  expect(toolbar.contains(characterMenu)).toBe(false);

  await user.hover(screen.getByRole("menuitem", { name: "几何模型" }));
  const geometryMenu = screen.getByRole("menu", { name: "选择几何模型" });
  expect(toolbar.contains(geometryMenu)).toBe(false);

  await user.click(screen.getByRole("button", { name: "模型库" }));
  const modelLibrary = screen.getByRole("dialog", { name: "模型库" });
  expect(toolbar.contains(modelLibrary)).toBe(false);
});

it("closes the model library panel from its close button", async () => {
  const user = userEvent.setup();
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "模型库" }));
  await user.click(screen.getByRole("button", { name: "关闭模型库" }));

  expect(screen.queryByRole("dialog", { name: "模型库" })).not.toBeInTheDocument();
});

it("adds a selected model library item into the viewport scene", async () => {
  const user = userEvent.setup();
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "模型库" }));
  await user.click(screen.getByRole("button", { name: "添加模型 自动取款机" }));

  const state = useDirectorStore.getState();
  const asset = state.project.assets.find((item) => item.fileName === "ATM_low.fbx");
  const prop = state.project.objects.find((item) => item.name === "自动取款机");

  expect(asset?.sourceType).toBe("model");
  expect(asset?.kind).toBe("prop");
  expect(asset?.url).toContain("ATM_low");
  expect(prop?.kind).toBe("prop");
  expect(prop?.assetRefId).toBe(asset?.id);
  expect(state.selectedObjectId).toBe(prop?.id);
});

it("preserves validated rig metadata when adding a GUO character from the model library", async () => {
  const user = userEvent.setup();
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "模型库" }));
  await user.click(screen.getByRole("tab", { name: "人物" }));
  expect(screen.getByRole("button", { name: "添加模型 健壮男性" })).toHaveTextContent("可用动作");
  await user.click(screen.getByRole("button", { name: "添加模型 健壮男性" }));

  const state = useDirectorStore.getState();
  const asset = state.project.assets.find((item) => item.fileName === "0040_muscular-male.fbx");
  const role = state.project.objects.find((item) => item.assetRefId === asset?.id);
  expect(asset).toMatchObject({
    kind: "character",
    modelFormat: "fbx",
    characterRigProfile: "mixamo",
    characterImportReadiness: "ready",
    characterOrientationCorrection: [0, 0, 0],
  });
  expect(role?.characterRig?.rigType).toBe("mixamo");
});

it("marks non-humanoid GUO models as requiring mapping instead of pretending they are action-ready", async () => {
  const user = userEvent.setup();
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "模型库" }));
  await user.click(screen.getByRole("tab", { name: "人物" }));
  expect(screen.getByRole("button", { name: "添加模型 马" })).toHaveTextContent("需骨架映射");
  await user.click(screen.getByRole("button", { name: "添加模型 马" }));

  const asset = useDirectorStore.getState().project.assets.find((item) => item.fileName === "0033_horse.fbx");
  expect(asset).toMatchObject({
    characterRigProfile: "unknown",
    characterImportReadiness: "manual-mapping",
    characterOrientationCorrection: [0, 0, 0],
  });
});

it("shows a centered empty state with a local import action inside the my-models tab", async () => {
  const user = userEvent.setup();
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "模型库" }));
  await user.click(screen.getByRole("tab", { name: "我的模型" }));

  const emptyState = screen.getByRole("status", { name: "暂无任何模型" });
  expect(emptyState).toBeInTheDocument();
  expect(within(emptyState).getByRole("button", { name: "本地导入" })).toBeInTheDocument();
});

it("imports a local model into the my-models tab without adding it to the scene immediately", async () => {
  const user = userEvent.setup();
  mockReadLocalModelFile.mockResolvedValue({
    id: "local-model-1",
    fileName: "chair.obj",
    name: "本地椅子",
    url: "blob:local-chair",
  });
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "模型库" }));
  await user.click(screen.getByRole("tab", { name: "我的模型" }));
  await user.click(screen.getByRole("button", { name: "本地导入" }));

  const fileInput = screen.getByTestId("library-local-model-input") as HTMLInputElement | null;
  expect(fileInput).not.toBeNull();

  await user.upload(fileInput!, new File(["chair"], "chair.obj", { type: "model/obj" }));

  await waitFor(() => {
    expect(useDirectorStore.getState().project.assets.some((item) => item.fileName === "chair.obj")).toBe(true);
  });

  const state = useDirectorStore.getState();
  expect(state.project.assets.some((item) => item.fileName === "chair.obj")).toBe(true);
  expect(state.project.objects.some((item) => item.name === "本地椅子")).toBe(false);
  expect(screen.queryByRole("status", { name: "暂无任何模型" })).not.toBeInTheDocument();
  expect(screen.getByText("本地椅子")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "本地导入" })).toBeInTheDocument();
});

it("imports multiple local model files into the my-models tab at once", async () => {
  const user = userEvent.setup();
  mockReadLocalModelFile.mockImplementation(async (file: File) => ({
    id: `local-${file.name}`,
    fileName: file.name,
    name: file.name.replace(/\.(fbx|obj)$/i, ""),
    url: `data:model/plain;base64,${file.name}`,
  }));
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "模型库" }));
  await user.click(screen.getByRole("tab", { name: "我的模型" }));
  await user.click(screen.getByRole("button", { name: "本地导入" }));

  const fileInput = screen.getByTestId("library-local-model-input") as HTMLInputElement | null;
  expect(fileInput).not.toBeNull();
  expect(fileInput).toHaveAttribute("multiple");

  await user.upload(fileInput!, [
    new File(["chair"], "本地椅子.obj", { type: "model/obj" }),
    new File(["table"], "本地桌子.fbx", { type: "model/fbx" }),
  ]);

  await waitFor(() => {
    expect(useDirectorStore.getState().project.assets.filter((item) => item.assetSource === "local")).toHaveLength(2);
  });

  const state = useDirectorStore.getState();
  expect(state.project.objects.some((item) => item.name === "本地椅子")).toBe(false);
  expect(state.project.objects.some((item) => item.name === "本地桌子")).toBe(false);
  expect(screen.getByText("本地椅子")).toBeInTheDocument();
  expect(screen.getByText("本地桌子")).toBeInTheDocument();
  expect(mockReadLocalModelFile).toHaveBeenCalledTimes(2);
});

it("restores imported my-models assets after browser refresh initialization", async () => {
  const user = userEvent.setup();
  mockReadLocalModelFile.mockResolvedValue({
    id: "local-model-persisted",
    fileName: "chair.obj",
    name: "本地椅子",
    url: "data:model/plain;base64,cGERSISTED",
  });
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "模型库" }));
  await user.click(screen.getByRole("tab", { name: "我的模型" }));
  await user.click(screen.getByRole("button", { name: "本地导入" }));
  await user.upload(
    screen.getByTestId("library-local-model-input") as HTMLInputElement,
    new File(["chair"], "chair.obj", { type: "model/obj" })
  );

  await waitFor(() => {
    expect(useDirectorStore.getState().project.assets.some((item) => item.fileName === "chair.obj")).toBe(true);
  });

  await act(async () => {
    useDirectorStore.setState({
      ...useDirectorStore.getState(),
      ...createInitialDirectorState({ includePersistedLocalAssets: true }),
    });
  });

  await waitFor(() => {
    expect(screen.getByText("本地椅子")).toBeInTheDocument();
  });

  const restoredAsset = useDirectorStore.getState().project.assets.find((item) => item.fileName === "chair.obj");
  expect(restoredAsset?.assetSource).toBe("local");
  expect(restoredAsset?.url).toBe("data:model/plain;base64,cGERSISTED");
  expect(useDirectorStore.getState().project.objects.some((item) => item.name === "本地椅子")).toBe(false);
});

it("still imports a local model directly into the scene from the viewport capsule action", async () => {
  const user = userEvent.setup();
  mockReadLocalModelFile.mockResolvedValue({
    id: "local-model-2",
    fileName: "lamp.obj",
    name: "本地台灯",
    url: "blob:local-lamp",
  });
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "导入本地模型" }));

  const fileInput = screen.getByTestId("scene-local-model-input") as HTMLInputElement | null;
  expect(fileInput).not.toBeNull();

  await user.upload(fileInput!, new File(["lamp"], "lamp.obj", { type: "model/obj" }));

  await waitFor(() => {
    expect(useDirectorStore.getState().project.objects.some((item) => item.name === "本地台灯")).toBe(true);
  });

  const state = useDirectorStore.getState();
  expect(state.project.assets.some((item) => item.fileName === "lamp.obj")).toBe(true);
  expect(state.project.objects.some((item) => item.name === "本地台灯")).toBe(true);
});

it("inspects a rigged character before adding it as a character", async () => {
  const user = userEvent.setup();
  useDirectorStore.getState().setCameraMotionProgress(0.42);
  useDirectorStore.getState().setCameraMotionPlaying(false);
  mockInspectCharacterModelFile.mockResolvedValue({
    format: "fbx",
    readiness: "ready",
    rigProfile: "mixamo",
    skinnedMeshCount: 1,
    skeletonCount: 1,
    primaryBoneCount: 65,
    skeletonDepth: 8,
    animationNames: ["Idle"],
    animations: [{ name: "Idle", duration: 1.5, trackCount: 52 }],
    animationCount: 1,
    playableAnimationCount: 1,
    boneNames: [],
    boneMap: {
      head: "Head", chest: "Chest", waist: "Hips",
      leftUpperArm: "LeftArm", leftForearm: "LeftForeArm", leftHand: "LeftHand",
      rightUpperArm: "RightArm", rightForearm: "RightForeArm", rightHand: "RightHand",
      leftThigh: "LeftUpLeg", leftCalf: "LeftLeg", leftFoot: "LeftFoot",
      rightThigh: "RightUpLeg", rightCalf: "RightLeg", rightFoot: "RightFoot",
    },
    mappedBodyParts: [
      "center", "head", "chest", "waist", "leftUpperArm", "leftForearm", "leftHand", "rightUpperArm",
      "rightForearm", "rightHand", "leftThigh", "leftCalf", "leftFoot", "rightThigh", "rightCalf", "rightFoot",
    ],
    missingBodyParts: [],
    dimensions: [1, 1.8, 0.5],
    footOffsetY: 0,
    uprightAxis: "y",
    orientationCorrection: [0, 0, 0],
    recommendedScale: 1,
    warnings: [],
  });
  mockReadLocalModelFile.mockResolvedValue({
    id: "local-character",
    fileName: "actor.fbx",
    name: "演员",
    url: "director-asset://local/actor-key",
    storageKey: "actor-key",
    byteLength: 1024,
    modelFormat: "fbx",
  });
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "添加角色" }));
  await user.click(screen.getByRole("menuitem", { name: "导入绑骨人物" }));
  await user.upload(
    screen.getByTestId("character-local-model-input") as HTMLInputElement,
    new File(["rigged"], "actor.fbx", { type: "model/fbx" })
  );

  const dialog = await screen.findByRole("dialog", { name: "人物模型体检结果" });
  expect(within(dialog).getByText("可直接使用")).toBeInTheDocument();
  expect(within(dialog).getByText("16/16")).toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "作为人物加入" }));

  await waitFor(() => {
    expect(useDirectorStore.getState().project.objects.some((item) => item.name === "演员")).toBe(true);
  });
  const asset = useDirectorStore.getState().project.assets.find((item) => item.fileName === "actor.fbx");
  const actor = useDirectorStore.getState().project.objects.find((item) => item.assetRefId === asset?.id);
  expect(asset).toMatchObject({
    id: "local_asset_actor-key",
    kind: "character",
    storageKey: "actor-key",
    characterRigProfile: "mixamo",
    characterImportReadiness: "ready",
  });
  expect(actor?.kind).toBe("character");
  expect(actor?.characterRig?.rigType).toBe("mixamo");
  expect(actor?.characterRig?.actionPresetId).toBeNull();
  expect(useDirectorStore.getState().cameraMotionProgress).toBe(0);
  expect(useDirectorStore.getState().cameraMotionPlaying).toBe(true);
  expect(useDirectorStore.getState().characterActionPreview).toEqual({
    objectId: actor?.id,
    actionPresetId: "walk-cycle",
  });
  const previewStatus = screen.getByRole("status", { name: "人物动作自动自检" });
  expect(previewStatus).toHaveTextContent("正在预览：走路 1/4");
  expect(useDirectorStore.getState().project.animationAssets).toEqual([
    expect.objectContaining({
      id: "local_animation_actor-key",
      name: "演员 自带动作",
      rigProfile: "mixamo",
      sourceCharacterAssetId: "local_asset_actor-key",
      clips: [{ id: "clip_1", name: "Idle", duration: 1.5, trackCount: 52 }],
    }),
  ]);

  await user.click(within(previewStatus).getByRole("button", { name: "跳过" }));
  expect(useDirectorStore.getState().characterActionPreview).toBeNull();
  expect(useDirectorStore.getState().cameraMotionProgress).toBe(0.42);
  expect(useDirectorStore.getState().cameraMotionPlaying).toBe(false);
  expect(actor?.characterRig?.actionPresetId).toBeNull();
});

it("only allows an unrigged character file to be added as a static prop", async () => {
  const user = userEvent.setup();
  mockInspectCharacterModelFile.mockResolvedValue({
    format: "glb",
    readiness: "static-only",
    rigProfile: "unknown",
    skinnedMeshCount: 0,
    skeletonCount: 0,
    primaryBoneCount: 0,
    skeletonDepth: 0,
    animationNames: [],
    animations: [],
    animationCount: 0,
    playableAnimationCount: 0,
    boneNames: [],
    boneMap: {},
    mappedBodyParts: ["center"],
    missingBodyParts: ["head"],
    dimensions: [1, 1, 1],
    footOffsetY: 0,
    uprightAxis: "y",
    orientationCorrection: [0, 0, 0],
    recommendedScale: 1,
    warnings: ["没有检测到蒙皮骨架，只能作为静态模型使用"],
  });
  mockReadLocalModelFile.mockResolvedValue({
    id: "local-static-model",
    fileName: "statue.glb",
    name: "雕像",
    url: "director-asset://local/statue-key",
    storageKey: "statue-key",
    byteLength: 1024,
    modelFormat: "glb",
  });
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "添加角色" }));
  await user.click(screen.getByRole("menuitem", { name: "导入绑骨人物" }));
  await user.upload(
    screen.getByTestId("character-local-model-input") as HTMLInputElement,
    new File(["static"], "statue.glb", { type: "model/gltf-binary" })
  );

  const dialog = await screen.findByRole("dialog", { name: "人物模型体检结果" });
  expect(within(dialog).getByText("仅静态使用")).toBeInTheDocument();
  expect(within(dialog).queryByRole("button", { name: "作为人物加入" })).not.toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "作为静态道具加入" }));

  await waitFor(() => {
    const asset = useDirectorStore.getState().project.assets.find((item) => item.fileName === "statue.glb");
    expect(asset?.kind).toBe("prop");
    expect(useDirectorStore.getState().project.objects.find((item) => item.assetRefId === asset?.id)?.kind).toBe("prop");
  });
});

it("automatically previews all four humanoid checks and restores playback afterward", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const report = {
    format: "fbx" as const,
    readiness: "ready" as const,
    rigProfile: "mixamo" as const,
    skinnedMeshCount: 1,
    skeletonCount: 1,
    primaryBoneCount: 65,
    skeletonDepth: 8,
    animationNames: [],
    animations: [],
    animationCount: 0,
    playableAnimationCount: 0,
    boneNames: [],
    boneMap: {
      head: "Head", chest: "Chest", waist: "Hips",
      leftUpperArm: "LeftArm", leftForearm: "LeftForeArm", leftHand: "LeftHand",
      rightUpperArm: "RightArm", rightForearm: "RightForeArm", rightHand: "RightHand",
      leftThigh: "LeftUpLeg", leftCalf: "LeftLeg", leftFoot: "LeftFoot",
      rightThigh: "RightUpLeg", rightCalf: "RightLeg", rightFoot: "RightFoot",
    },
    mappedBodyParts: [
      "center", "head", "chest", "waist", "leftUpperArm", "leftForearm", "leftHand", "rightUpperArm",
      "rightForearm", "rightHand", "leftThigh", "leftCalf", "leftFoot", "rightThigh", "rightCalf", "rightFoot",
    ],
    missingBodyParts: [],
    dimensions: [1, 1.8, 0.5] as [number, number, number],
    footOffsetY: 0,
    uprightAxis: "y" as const,
    orientationCorrection: [0, 0, 0] as [number, number, number],
    recommendedScale: 1,
    warnings: [],
  };
  mockInspectCharacterModelFile.mockResolvedValue(report);
  mockReadLocalModelFile.mockResolvedValue({
    id: "preview-actor",
    fileName: "preview-actor.fbx",
    name: "预览演员",
    url: "director-asset://local/preview-actor",
    storageKey: "preview-actor",
    byteLength: 1024,
    modelFormat: "fbx",
  });
  useDirectorStore.getState().setCameraMotionProgress(0.36);
  useDirectorStore.getState().setCameraMotionPlaying(false);
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "添加角色" }));
  await user.click(screen.getByRole("menuitem", { name: "导入绑骨人物" }));
  await user.upload(
    screen.getByTestId("character-local-model-input") as HTMLInputElement,
    new File(["rigged"], "preview-actor.fbx", { type: "model/fbx" })
  );
  await user.click(within(await screen.findByRole("dialog", { name: "人物模型体检结果" }))
    .getByRole("button", { name: "作为人物加入" }));

  const expectStep = (label: string, actionPresetId: string) => {
    expect(screen.getByRole("status", { name: "人物动作自动自检" })).toHaveTextContent(label);
    expect(useDirectorStore.getState().characterActionPreview?.actionPresetId).toBe(actionPresetId);
  };
  expectStep("走路 1/4", "walk-cycle");
  await act(async () => vi.advanceTimersByTime(1_800));
  expectStep("跑步 2/4", "run-cycle");
  await act(async () => vi.advanceTimersByTime(1_800));
  expectStep("跳跃 3/4", "jump-cycle");
  await act(async () => vi.advanceTimersByTime(1_800));
  expectStep("挥手 4/4", "wave-cycle");
  await act(async () => vi.advanceTimersByTime(1_800));

  expect(screen.queryByRole("status", { name: "人物动作自动自检" })).not.toBeInTheDocument();
  expect(useDirectorStore.getState().characterActionPreview).toBeNull();
  expect(useDirectorStore.getState().cameraMotionProgress).toBe(0.36);
  expect(useDirectorStore.getState().cameraMotionPlaying).toBe(false);
  vi.useRealTimers();
});

it("lets users complete a manual bone map before importing a generic rig as a character", async () => {
  const user = userEvent.setup();
  const parts = [
    ["leftUpperArm", "左上臂"], ["leftForearm", "左前臂"], ["leftHand", "左手"],
    ["rightUpperArm", "右上臂"], ["rightForearm", "右前臂"], ["rightHand", "右手"],
    ["leftThigh", "左大腿"], ["leftCalf", "左小腿"], ["leftFoot", "左脚"],
    ["rightThigh", "右大腿"], ["rightCalf", "右小腿"], ["rightFoot", "右脚"],
    ["head", "头部"], ["chest", "胸口"], ["waist", "腰部"],
  ] as const;
  const boneNames = parts.map(([id]) => `Rig_${id}`);
  mockInspectCharacterModelFile.mockResolvedValue({
    format: "fbx",
    readiness: "manual-mapping",
    rigProfile: "generic-humanoid",
    skinnedMeshCount: 1,
    skeletonCount: 1,
    primaryBoneCount: 48,
    skeletonDepth: 7,
    animationNames: [],
    animations: [],
    animationCount: 0,
    playableAnimationCount: 0,
    boneNames,
    boneMap: {},
    mappedBodyParts: ["center"],
    missingBodyParts: ["head"],
    dimensions: [1, 1.8, 0.5],
    footOffsetY: 0,
    uprightAxis: "y",
    orientationCorrection: [0, 0, 0],
    recommendedScale: 1,
    warnings: ["身体部位识别不完整，跟拍和外部动作可能受限"],
  });
  mockReadLocalModelFile.mockResolvedValue({
    id: "local-generic-character",
    fileName: "generic.fbx",
    name: "通用演员",
    url: "director-asset://local/generic-key",
    storageKey: "generic-key",
    byteLength: 1024,
    modelFormat: "fbx",
  });
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "添加角色" }));
  await user.click(screen.getByRole("menuitem", { name: "导入绑骨人物" }));
  await user.upload(
    screen.getByTestId("character-local-model-input") as HTMLInputElement,
    new File(["rigged"], "generic.fbx", { type: "model/fbx" })
  );

  const dialog = await screen.findByRole("dialog", { name: "人物模型体检结果" });
  expect(within(dialog).getByText("补全骨架映射")).toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "补全映射后作为人物加入" })).toBeDisabled();

  for (const [id, label] of parts) {
    await user.selectOptions(within(dialog).getByLabelText(`映射 ${label}`), `Rig_${id}`);
  }

  await user.click(within(dialog).getByRole("button", { name: "作为人物加入" }));
  await waitFor(() => {
    const asset = useDirectorStore.getState().project.assets.find((item) => item.fileName === "generic.fbx");
    expect(asset).toMatchObject({
      kind: "character",
      characterImportReadiness: "ready",
      characterBoneMap: {
        head: "Rig_head",
        rightHand: "Rig_rightHand",
      },
    });
  });
});

it("shows a delete action on my-models cards and removes the asset plus its scene instances", async () => {
  const user = userEvent.setup();
  mockReadLocalModelFile.mockResolvedValue({
    id: "local-model-3",
    fileName: "chair.obj",
    name: "本地椅子",
    url: "blob:local-chair",
  });
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "模型库" }));
  await user.click(screen.getByRole("tab", { name: "我的模型" }));
  await user.click(screen.getByRole("button", { name: "本地导入" }));

  const fileInput = screen.getByTestId("library-local-model-input") as HTMLInputElement | null;
  expect(fileInput).not.toBeNull();

  await user.upload(fileInput!, new File(["chair"], "chair.obj", { type: "model/obj" }));

  await waitFor(() => {
    expect(screen.getByRole("button", { name: "添加模型 本地椅子" })).toBeInTheDocument();
  });

  await user.click(screen.getByRole("button", { name: "添加模型 本地椅子" }));

  await waitFor(() => {
    expect(useDirectorStore.getState().project.objects.some((item) => item.name === "本地椅子")).toBe(true);
  });

  await user.click(screen.getByRole("button", { name: "模型库" }));
  await user.click(screen.getByRole("tab", { name: "我的模型" }));
  await user.hover(screen.getByRole("button", { name: "添加模型 本地椅子" }));
  await user.click(screen.getByRole("button", { name: "删除模型 本地椅子" }));

  await waitFor(() => {
    expect(useDirectorStore.getState().project.assets.some((item) => item.fileName === "chair.obj")).toBe(false);
  });

  const state = useDirectorStore.getState();
  expect(state.project.assets.some((item) => item.fileName === "chair.obj")).toBe(false);
  expect(state.project.objects.some((item) => item.name === "本地椅子")).toBe(false);
  expect(screen.getByRole("status", { name: "暂无任何模型" })).toBeInTheDocument();
});

it("opens the geometry submenu only after hover every time the add-character menu is opened", async () => {
  const user = userEvent.setup();
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "添加角色" }));

  const geometryMenuItem = screen.getByRole("menuitem", { name: "几何模型" });
  fireEvent.click(geometryMenuItem);
  expect(screen.queryByRole("menu", { name: "选择几何模型" })).not.toBeInTheDocument();

  await user.hover(geometryMenuItem);
  expect(screen.getByRole("menu", { name: "选择几何模型" })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "添加角色" }));
  expect(screen.queryByRole("menu", { name: "选择角色体型" })).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "添加角色" }));
  expect(screen.getByRole("menu", { name: "选择角色体型" })).toBeInTheDocument();
  expect(screen.queryByRole("menu", { name: "选择几何模型" })).not.toBeInTheDocument();

  await user.hover(screen.getByRole("menuitem", { name: "几何模型" }));
  expect(screen.getByRole("menu", { name: "选择几何模型" })).toBeInTheDocument();
});

it("closes the geometry submenu when users hover another character menu item", async () => {
  const user = userEvent.setup();
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "添加角色" }));
  await user.hover(screen.getByRole("menuitem", { name: "几何模型" }));

  expect(screen.getByRole("menu", { name: "选择几何模型" })).toBeInTheDocument();

  await user.hover(screen.getByRole("menuitem", { name: "女性素体" }));

  expect(screen.queryByRole("menu", { name: "选择几何模型" })).not.toBeInTheDocument();
  expect(screen.getByRole("menu", { name: "选择角色体型" })).toBeInTheDocument();
});

it("closes open viewport toolbar menus when users click outside", async () => {
  const user = userEvent.setup();
  render(
    <>
      <button type="button">画布空白</button>
      <ViewportToolbar />
    </>
  );

  await user.click(screen.getByRole("button", { name: "添加角色" }));
  await user.hover(screen.getByRole("menuitem", { name: "几何模型" }));

  expect(screen.getByRole("menu", { name: "选择角色体型" })).toBeInTheDocument();
  expect(screen.getByRole("menu", { name: "选择几何模型" })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "画布空白" }));

  expect(screen.queryByRole("menu", { name: "选择角色体型" })).not.toBeInTheDocument();
  expect(screen.queryByRole("menu", { name: "选择几何模型" })).not.toBeInTheDocument();
});

it("opens the aspect ratio panel from the viewport capsule with the supported presets", async () => {
  const user = userEvent.setup();
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "选择画幅比例" }));

  const toolbar = screen.getByRole("group", { name: "3D视口快捷工具" });
  const dialog = screen.getByRole("dialog", { name: "比例" });

  expect(dialog).toBeInTheDocument();
  expect(toolbar.contains(dialog)).toBe(false);
  expect(screen.getByRole("button", { name: "自动" })).toHaveAttribute("aria-pressed", "true");
  ["1:1", "2:1", "3:4", "4:3", "16:9", "21:9", "9:16"].forEach((label) => {
    expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
  });
});

it("positions toolbar panels below the top toolbar instead of outside the viewport", async () => {
  const user = userEvent.setup();
  render(
    <div data-testid="viewport-frame">
      <ViewportToolbar />
    </div>
  );

  const frame = screen.getByTestId("viewport-frame");
  const toolbar = screen.getByRole("group", { name: "3D视口快捷工具" });
  const characterTrigger = screen.getByRole("button", { name: "添加角色" });
  const aspectTrigger = screen.getByRole("button", { name: "选择画幅比例" });

  vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({
    left: 100,
    top: 50,
    right: 1100,
    bottom: 650,
    width: 1000,
    height: 600,
    x: 100,
    y: 50,
    toJSON: () => ({}),
  });
  vi.spyOn(toolbar, "getBoundingClientRect").mockReturnValue({
    left: 300,
    top: 100,
    right: 800,
    bottom: 148,
    width: 500,
    height: 48,
    x: 300,
    y: 100,
    toJSON: () => ({}),
  });
  vi.spyOn(characterTrigger, "getBoundingClientRect").mockReturnValue({
    left: 400,
    top: 108,
    right: 432,
    bottom: 140,
    width: 32,
    height: 32,
    x: 400,
    y: 108,
    toJSON: () => ({}),
  });
  vi.spyOn(aspectTrigger, "getBoundingClientRect").mockReturnValue({
    left: 600,
    top: 108,
    right: 632,
    bottom: 140,
    width: 32,
    height: 32,
    x: 600,
    y: 108,
    toJSON: () => ({}),
  });

  await user.click(characterTrigger);
  await waitFor(() => {
    expect(screen.getByRole("menu", { name: "选择角色体型" })).toHaveStyle({
      top: "106px",
      bottom: "auto",
    });
  });

  await user.click(screen.getByRole("button", { name: "模型库" }));
  await waitFor(() => {
    expect(screen.getByRole("dialog", { name: "模型库" })).toHaveStyle({
      top: "108px",
      bottom: "auto",
      maxHeight: "484px",
    });
  });

  await user.click(aspectTrigger);
  await waitFor(() => {
    expect(screen.getByRole("dialog", { name: "比例" })).toHaveStyle({
      top: "106px",
      bottom: "auto",
    });
  });
});

it("updates the viewport aspect ratio from the ratio panel", async () => {
  const user = userEvent.setup();
  render(<ViewportToolbar />);

  await user.click(screen.getByRole("button", { name: "选择画幅比例" }));
  await user.click(screen.getByRole("button", { name: "9:16" }));

  expect(useDirectorStore.getState().viewportAspectRatio).toBe("9:16");
  expect(screen.queryByRole("dialog", { name: "比例" })).not.toBeInTheDocument();
});
