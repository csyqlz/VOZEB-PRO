import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach } from "vitest";
import {
  DEFAULT_VIEWPORT_ROTATE_SENSITIVITY,
  DEFAULT_VIEWPORT_ZOOM_SENSITIVITY,
} from "../../schema/viewportSensitivity";
import { createInitialDirectorState, useDirectorStore } from "../../store/directorStore";
import { ViewportSensitivitySettings } from "../ViewportSensitivitySettings";

beforeEach(() => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
  });
});

it("lets beginners adjust both viewport sensitivities and reset them", async () => {
  const user = userEvent.setup();
  render(<ViewportSensitivitySettings />);

  const trigger = screen.getByRole("button", { name: "视角手感" });
  expect(trigger).toHaveAttribute("aria-expanded", "false");

  await user.click(trigger);

  expect(screen.getByRole("dialog", { name: "视角灵敏度设置" })).toBeInTheDocument();
  expect(trigger).toHaveAttribute("aria-expanded", "true");

  fireEvent.change(screen.getByRole("slider", { name: "转动视角灵敏度" }), {
    target: { value: "80" },
  });
  fireEvent.change(screen.getByRole("slider", { name: "缩放视角灵敏度" }), {
    target: { value: "65" },
  });

  expect(useDirectorStore.getState().viewportRotateSensitivity).toBe(0.8);
  expect(useDirectorStore.getState().viewportZoomSensitivity).toBe(0.65);
  expect(screen.getByText("适中 · 80%")).toBeInTheDocument();
  expect(screen.getByText("适中 · 65%")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "恢复默认手感" }));

  expect(useDirectorStore.getState().viewportRotateSensitivity).toBe(DEFAULT_VIEWPORT_ROTATE_SENSITIVITY);
  expect(useDirectorStore.getState().viewportZoomSensitivity).toBe(DEFAULT_VIEWPORT_ZOOM_SENSITIVITY);
  expect(screen.getByRole("button", { name: "恢复默认手感" })).toBeDisabled();
});

it("closes the settings panel with Escape and returns focus to the trigger", async () => {
  const user = userEvent.setup();
  render(<ViewportSensitivitySettings />);

  const trigger = screen.getByRole("button", { name: "视角手感" });
  await user.click(trigger);
  await user.keyboard("{Escape}");

  expect(screen.queryByRole("dialog", { name: "视角灵敏度设置" })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});
