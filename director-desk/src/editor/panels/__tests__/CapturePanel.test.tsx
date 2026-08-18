import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearViewportCaptureHandler, setViewportCaptureHandler } from "../../io/captureBridge";
import { createInitialDirectorState, useDirectorStore } from "../../store/directorStore";
import { CapturePanel } from "../CapturePanel";

beforeEach(() => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

afterEach(() => {
  clearViewportCaptureHandler();
  vi.restoreAllMocks();
});

it("runs four-angle capture from the left screenshot panel", async () => {
  const user = userEvent.setup();
  const handler = vi.fn(async () => [
    {
      label: "四方位-1",
      dataUrl: "data:image/png;base64,a",
      meta: {
        mode: "director" as const,
        cameraId: null,
        fov: 50,
        position: [0, 2.2, 9] as [number, number, number],
        target: [0, 1.2, 0] as [number, number, number],
      },
    },
  ]);

  setViewportCaptureHandler(handler);
  render(<CapturePanel />);

  await user.click(screen.getByRole("button", { name: "四方位截图" }));

  expect(handler).toHaveBeenCalledWith({
    preset: "four",
    source: "capture-panel",
  });
  expect(await screen.findByText("已导出 1 张截图")).toBeInTheDocument();
});
