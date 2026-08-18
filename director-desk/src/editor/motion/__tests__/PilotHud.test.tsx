import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { PilotHud } from "../PilotHud";

it("shows Q/E lift controls, action playback shortcut, and an accessible crosshair", () => {
  render(
    <PilotHud
      lockedTargetName={null}
      mode="pilot"
      onExit={() => undefined}
      onRecord={() => undefined}
      pointedTargetName="角色01"
    />
  );

  expect(screen.getByLabelText("掌镜准星，当前对准角色01")).toBeInTheDocument();
  expect(screen.getByLabelText("掌镜快捷键")).toHaveTextContent("E 上升");
  expect(screen.getByLabelText("掌镜快捷键")).toHaveTextContent("Q 下降");
  expect(screen.getByLabelText("掌镜快捷键")).toHaveTextContent("空格 播放/暂停");
  expect(screen.getByLabelText("掌镜快捷键")).not.toHaveTextContent("Shift");
  expect(screen.queryByRole("button", { name: "播放人物" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("掌镜快捷键")).toHaveTextContent("F 锁定主体");
  expect(screen.getByRole("button", { name: "记录当前轨迹点" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "退出掌镜模式" })).toBeInTheDocument();
});

it("makes empty space visibly lockable with F", () => {
  render(
    <PilotHud
      lockedTargetName={null}
      mode="pilot"
      onExit={() => undefined}
      onRecord={() => undefined}
      pointedTargetName={null}
    />
  );

  expect(screen.getByLabelText("掌镜准星，按 F 锁定当前空间点")).toBeInTheDocument();
  expect(screen.getByText("空白空间 · 按 F 锁定")).toBeInTheDocument();
  expect(screen.getByLabelText("掌镜快捷键")).toHaveTextContent("F 锁定主体 / 空间点");
});

it("keeps only exit and waypoint recording actions in the HUD", () => {
  const onExit = vi.fn();
  const onRecord = vi.fn();

  render(
    <PilotHud
      lockedTargetName={null}
      mode="pilot"
      onExit={onExit}
      onRecord={onRecord}
      pointedTargetName={null}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "退出掌镜模式" }));
  fireEvent.click(screen.getByRole("button", { name: "记录当前轨迹点" }));
  expect(onExit).toHaveBeenCalledOnce();
  expect(onRecord).toHaveBeenCalledOnce();
});
