import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { createInitialDirectorState, useDirectorStore } from "../editor/store/directorStore";
import { readDirectorDeskRecords, writeDirectorDeskRecords } from "../editor/workspaces/directorDeskRegistry";

vi.mock("../editor/canvas/DirectorCanvas", () => ({
  DirectorCanvas: () => <div data-testid="mock-director-canvas" />,
}));

import App from "../App";

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, "", "/?instanceId=desk_1");
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
  });
});

it("returns to a real home page that lists director desks 1 through 4", async () => {
  const user = userEvent.setup();
  const timestamp = "2026-07-11T12:00:00.000Z";
  writeDirectorDeskRecords([1, 2, 3, 4].map((number) => ({
    id: `desk_${number}`,
    name: `导演台 ${number} 号`,
    createdAt: timestamp,
    updatedAt: timestamp,
  })));
  window.history.replaceState({}, "", "/?instanceId=desk_4");

  render(<App />);
  await user.click(screen.getByRole("button", { name: "返回首页" }));

  expect(screen.getByRole("heading", { name: "选择一个导演台开始摆场景" })).toBeInTheDocument();
  for (const number of [1, 2, 3, 4]) {
    expect(screen.getByText(`导演台 ${number} 号`)).toBeInTheDocument();
  }
  expect(window.location.search).not.toContain("instanceId");
  expect(screen.getByRole("heading", { name: "四步完成第一条运镜" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "向下查看使用说明" })).toHaveAttribute("href", "#director-home-guide-title");
  expect(screen.getByText("掌镜快捷键")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "路线编辑、监看与导出升级" })).toBeInTheDocument();
  expect(screen.getByText("主成片 FOV 与监看小窗 FOV 已分开设置，导出使用主成片 FOV")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "共同完善 3D 导演台" })).toBeInTheDocument();
  expect(screen.getByText("AIGC 耀光")).toBeInTheDocument();
  expect(screen.getByText("抖音号：AIJPDM001")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "键盘、鼠标与触控板操作" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "普通导演视角" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "掌镜模式" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "通用编辑" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "macOS 触控板手势" })).toBeInTheDocument();
  expect(screen.getByText("⌘ / Ctrl + Z")).toBeInTheDocument();
  expect(screen.getByText("双指点按后拖动")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "主要界面按钮" })).toBeInTheDocument();
});

it("keeps the selected director desk in the URL so refresh opens the same desk", async () => {
  const user = userEvent.setup();
  const timestamp = "2026-07-11T12:00:00.000Z";
  writeDirectorDeskRecords([1, 2, 3, 4].map((number) => ({
    id: `desk_${number}`,
    name: `导演台 ${number} 号`,
    createdAt: timestamp,
    updatedAt: timestamp,
  })));

  render(<App />);
  await user.selectOptions(screen.getByRole("combobox", { name: "选择导演台" }), "desk_4");

  expect(window.location.search).toContain("instanceId=desk_4");
});

it("renders the director desk header and view mode switch", () => {
  const { container } = render(<App />);

  expect(screen.getByText("3D导演台")).toBeInTheDocument();
  expect(screen.getByLabelText("当前版本 v0.3.1")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "导演视角" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "第一视角" })).toBeInTheDocument();
  expect(container.querySelector(".top-bar-center .mode-toggle")).toBeInTheDocument();
  expect(screen.queryByLabelText("帮助")).not.toBeInTheDocument();
  expect(screen.getByLabelText("关闭")).toBeInTheDocument();
});

it("runs the benchmark as a temporary workspace without adding it to the director registry", () => {
  window.history.replaceState({}, "", "/?instanceId=benchmark_test&benchmark=standard");

  render(<App />);

  expect(screen.getByRole("option", { name: "历史压力性能基准（临时）" })).toBeInTheDocument();
  expect(readDirectorDeskRecords().some((record) => record.id === "benchmark_test")).toBe(false);
  expect(useDirectorStore.getState().project.objects.filter((object) => object.kind === "character")).toHaveLength(25);
  expect(useDirectorStore.getState().motionStudioOpen).toBe(true);
  expect(useDirectorStore.getState().cameraMotionPlaying).toBe(true);
});

it("notifies the host canvas when the director desk app is ready", () => {
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);

  render(<App />);

  expect(postMessage).toHaveBeenCalledWith(
    { type: "storyai:director-desk-ready" },
    window.location.origin
  );

  postMessage.mockRestore();
});

it("notifies the host canvas when the director desk close button is clicked", async () => {
  const user = userEvent.setup();
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);

  render(<App />);

  await user.click(screen.getByRole("button", { name: "关闭" }));

  expect(postMessage).toHaveBeenCalledWith(
    { type: "storyai:director-desk-close" },
    window.location.origin
  );

  postMessage.mockRestore();
});

it("uses a full-width director desk frame instead of floating card columns", () => {
  const { container } = render(<App />);
  const shell = container.querySelector(".director-shell.director-shell-fullbleed");

  expect(shell).toBeInTheDocument();
  expect(shell?.firstElementChild).toHaveClass("viewport-column");
  expect(screen.getByLabelText("场景")).toHaveClass("left-sidebar");
  expect(screen.getByLabelText("3D视口")).toHaveClass("viewport-column");
  expect(screen.getByLabelText("属性")).toHaveClass("right-sidebar");
});

it("collapses both side panels from the fullscreen toolbar action", async () => {
  const { container, rerender } = render(<App />);

  expect(container.querySelector(".director-shell-fullbleed.is-sidebars-collapsed")).not.toBeInTheDocument();

  act(() => {
    useDirectorStore.setState({
      ...useDirectorStore.getState(),
      viewportPanelsCollapsed: true,
    } as ReturnType<typeof useDirectorStore.getState>);
  });
  rerender(<App />);

  expect(container.querySelector(".director-shell-fullbleed.is-sidebars-collapsed")).toBeInTheDocument();
  expect(screen.getByLabelText("场景")).toHaveAttribute("aria-hidden", "true");
  expect(screen.getByLabelText("属性")).toHaveAttribute("aria-hidden", "true");
});

it("switches from director mode to camera mode", async () => {
  const user = userEvent.setup();
  render(<App />);

  const directorButton = screen.getByRole("button", { name: "导演视角" });
  const cameraButton = screen.getByRole("button", { name: "第一视角" });

  expect(directorButton).toHaveAttribute("aria-pressed", "true");
  expect(cameraButton).toHaveAttribute("aria-pressed", "false");

  await user.click(cameraButton);

  expect(directorButton).toHaveAttribute("aria-pressed", "false");
  expect(cameraButton).toHaveAttribute("aria-pressed", "true");
});

it("supports Cmd/Ctrl+C and Cmd/Ctrl+V to duplicate the selected object", async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.click(screen.getByRole("button", { name: "角色01" }));
  await user.keyboard("{Control>}c{/Control}");
  await user.keyboard("{Control>}v{/Control}");

  const state = useDirectorStore.getState();
  const characters = state.project.objects.filter((item) => item.kind === "character");

  expect(characters).toHaveLength(2);
  expect(characters[1]?.id).not.toBe("char_default_a");
  expect(state.selectedObjectId).toBe(characters[1]?.id ?? null);
});

it("supports Cmd/Ctrl+Z to undo the latest scene edit", async () => {
  const user = userEvent.setup();
  render(<App />);

  act(() => {
    useDirectorStore.getState().addPresetCharacter("female");
  });
  expect(useDirectorStore.getState().project.objects.some((item) => item.name === "角色02")).toBe(true);

  await user.keyboard("{Control>}z{/Control}");

  expect(useDirectorStore.getState().project.objects.some((item) => item.name === "角色02")).toBe(false);
});

it("ignores repeated Cmd/Ctrl+Z keydown events so holding the shortcut only undoes once", () => {
  render(<App />);
  act(() => {
    useDirectorStore.getState().addPresetCharacter("female");
    useDirectorStore.getState().addPresetCharacter("broad");
  });

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, repeat: false }));
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, repeat: true }));

  const characters = useDirectorStore.getState().project.objects.filter((item) => item.kind === "character");
  expect(characters).toHaveLength(2);
});
