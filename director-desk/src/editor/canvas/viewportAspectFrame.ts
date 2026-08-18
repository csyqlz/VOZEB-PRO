import { getViewportAspectRatioValue, type ViewportAspectRatio } from "../schema/viewportAspectRatio";

export const FRAME_SIDE_PADDING = 40;
export const FRAME_TOP_PADDING = 40;

export interface ViewportSafeAreaInsets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface ViewportFrameRect {
  width: number;
  height: number;
  left: number;
  top: number;
}

export function fitFrameWithinViewport(
  width: number,
  height: number,
  ratio: number,
  bottomPadding: number,
  safeAreaInsets: ViewportSafeAreaInsets = { left: 0, right: 0, top: 0, bottom: 0 }
): ViewportFrameRect {
  const safeLeft = FRAME_SIDE_PADDING + safeAreaInsets.left;
  const safeTop = FRAME_TOP_PADDING + safeAreaInsets.top;
  const safeRight = Math.max(width - FRAME_SIDE_PADDING - safeAreaInsets.right, safeLeft);
  const safeBottom = Math.max(
    height - Math.max(bottomPadding, FRAME_TOP_PADDING) - safeAreaInsets.bottom,
    safeTop
  );
  const safeWidth = Math.max(safeRight - safeLeft, 0);
  const safeHeight = Math.max(safeBottom - safeTop, 0);

  if (safeWidth === 0 || safeHeight === 0) {
    return {
      width: 0,
      height: 0,
      left: (safeLeft + safeRight) / 2,
      top: (safeTop + safeBottom) / 2,
    };
  }

  const safeRatio = safeWidth / safeHeight;
  const frameWidth = ratio >= safeRatio ? safeWidth : safeHeight * ratio;
  const frameHeight = ratio >= safeRatio ? safeWidth / ratio : safeHeight;

  return {
    width: frameWidth,
    height: frameHeight,
    left: safeLeft + (safeWidth - frameWidth) / 2,
    top: safeTop + (safeHeight - frameHeight) / 2,
  };
}

export function getViewportAspectFrameRect(
  ratio: ViewportAspectRatio,
  width: number,
  height: number,
  bottomPadding: number = FRAME_TOP_PADDING,
  safeAreaInsets: ViewportSafeAreaInsets = { left: 0, right: 0, top: 0, bottom: 0 }
) {
  const ratioValue = getViewportAspectRatioValue(ratio);
  if (!ratioValue) return null;

  return fitFrameWithinViewport(width, height, ratioValue, bottomPadding, safeAreaInsets);
}
