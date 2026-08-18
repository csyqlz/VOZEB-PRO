import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ViewportAspectOverlay } from "../ViewportAspectOverlay";

describe("ViewportAspectOverlay", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(700);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["1:1", 620, 620],
    ["2:1", 920, 460],
    ["3:4", 465, 620],
    ["4:3", 826.666667, 620],
    ["16:9", 920, 517.5],
    ["21:9", 920, 394.285714],
    ["9:16", 348.75, 620],
  ] as const)("fits %s inside a 40px safe area with the correct frame ratio", (ratio, expectedWidth, expectedHeight) => {
    render(<ViewportAspectOverlay ratio={ratio} />);

    const frame = screen.getByLabelText("视口画幅框");
    const width = Number.parseFloat((frame as HTMLElement).style.width);
    const height = Number.parseFloat((frame as HTMLElement).style.height);

    expect(width).toBeCloseTo(expectedWidth, 2);
    expect(height).toBeCloseTo(expectedHeight, 2);
    expect(width / height).toBeCloseTo(expectedWidth / expectedHeight, 4);
  });

  it("renders one full-bleed frosted mask with a frame cutout", () => {
    const { container } = render(<ViewportAspectOverlay ratio="16:9" />);

    const masks = container.querySelectorAll(".viewport-aspect-mask");
    expect(masks).toHaveLength(1);

    const mask = masks[0] as HTMLElement;
    expect(mask.style.getPropertyValue("--viewport-aspect-frame-left")).toBe("40px");
    expect(mask.style.getPropertyValue("--viewport-aspect-frame-top")).toBe("91.25px");
    expect(mask.style.getPropertyValue("--viewport-aspect-frame-width")).toBe("920px");
    expect(mask.style.getPropertyValue("--viewport-aspect-frame-height")).toBe("517.5px");
  });

  it("remeasures after mount when the first viewport read is still zero", () => {
    vi.useFakeTimers();

    let width = 0;
    let height = 0;
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => height);

    render(<ViewportAspectOverlay ratio="16:9" />);

    width = 681;
    height = 785;

    act(() => {
      vi.advanceTimersByTime(60);
    });

    const frame = screen.getByLabelText("视口画幅框");
    expect(Number.parseFloat((frame as HTMLElement).style.width)).toBeCloseTo(601, 2);
    expect(Number.parseFloat((frame as HTMLElement).style.height)).toBeCloseTo(338.0625, 2);

    vi.useRealTimers();
  });

  it("measures the frame when users switch from auto to a concrete aspect ratio", () => {
    const { rerender } = render(<ViewportAspectOverlay ratio="auto" />);

    expect(screen.queryByLabelText("视口画幅框")).not.toBeInTheDocument();

    rerender(<ViewportAspectOverlay ratio="16:9" />);

    const frame = screen.getByLabelText("视口画幅框");
    expect(Number.parseFloat((frame as HTMLElement).style.width)).toBeCloseTo(920, 2);
    expect(Number.parseFloat((frame as HTMLElement).style.height)).toBeCloseTo(517.5, 2);
  });

  it("reserves extra bottom space so the framed viewport clears the capsule toolbar", () => {
    render(<ViewportAspectOverlay ratio="16:9" bottomPadding={126} />);

    const frame = screen.getByLabelText("视口画幅框");
    const frameLeft = Number.parseFloat((frame as HTMLElement).style.left);
    const frameTop = Number.parseFloat((frame as HTMLElement).style.top);
    const frameHeight = Number.parseFloat((frame as HTMLElement).style.height);
    const frameBottomGap = 700 - (frameTop + frameHeight);

    expect(frameLeft).toBeCloseTo(40, 2);
    expect(frameTop).toBeGreaterThanOrEqual(40);
    expect(frameBottomGap).toBeGreaterThanOrEqual(126);
  });

  it("repositions the framed viewport inside the visible safe area when overlay side panels are open", () => {
    render(
      <ViewportAspectOverlay
        ratio="16:9"
        safeAreaInsets={{ left: 220, right: 300, top: 0, bottom: 0 }}
      />
    );

    const frame = screen.getByLabelText("视口画幅框");
    const frameLeft = Number.parseFloat((frame as HTMLElement).style.left);
    const frameWidth = Number.parseFloat((frame as HTMLElement).style.width);

    expect(frameLeft).toBeGreaterThanOrEqual(260);
    expect(frameLeft + frameWidth).toBeLessThanOrEqual(660);
  });

  it("shows the guide toggle button only when a concrete aspect ratio is active", () => {
    const { rerender } = render(<ViewportAspectOverlay ratio="auto" showRuleOfThirds={false} onToggleRuleOfThirds={() => undefined} />);

    expect(screen.queryByRole("button", { name: "开启九宫格辅助线" })).not.toBeInTheDocument();

    rerender(<ViewportAspectOverlay ratio="16:9" showRuleOfThirds={false} onToggleRuleOfThirds={() => undefined} />);

    expect(screen.getByRole("button", { name: "开启九宫格辅助线" })).toBeInTheDocument();
  });

  it("renders the rule-of-thirds guides when enabled", () => {
    const { container } = render(<ViewportAspectOverlay ratio="16:9" showRuleOfThirds onToggleRuleOfThirds={() => undefined} />);

    expect(screen.getByRole("button", { name: "关闭九宫格辅助线" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("九宫格辅助线")).toBeInTheDocument();
    expect(container.querySelectorAll(".viewport-rule-of-thirds-line.is-vertical")).toHaveLength(2);
    expect(container.querySelectorAll(".viewport-rule-of-thirds-line.is-horizontal")).toHaveLength(2);
  });
});
