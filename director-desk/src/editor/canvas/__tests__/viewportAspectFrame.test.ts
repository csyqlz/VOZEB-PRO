import { describe, expect, it } from "vitest";
import { fitFrameWithinViewport } from "../viewportAspectFrame";

describe("fitFrameWithinViewport", () => {
  it("keeps framed aspect layouts inside the visible safe area between overlay side panels", () => {
    const frame = fitFrameWithinViewport(1000, 700, 16 / 9, 126, {
      left: 220,
      right: 300,
      top: 0,
      bottom: 0,
    });

    expect(frame.left).toBeGreaterThanOrEqual(260);
    expect(frame.left + frame.width).toBeLessThanOrEqual(660);
    expect(frame.top).toBeGreaterThanOrEqual(40);
    expect(frame.top + frame.height).toBeLessThanOrEqual(574);
  });
});
