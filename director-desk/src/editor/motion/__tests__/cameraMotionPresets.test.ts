import { expect, it } from "vitest";
import { CAMERA_MOTION_PRESETS, getCameraMotionPresetPatch } from "../cameraMotionPresets";

it("provides beginner-friendly camera parameter presets", () => {
  expect(CAMERA_MOTION_PRESETS.map((preset) => preset.label)).toEqual([
    "电影慢推",
    "平稳跟拍节奏",
    "快速追拍",
    "产品环绕",
    "平稳横移",
    "氛围长镜头",
  ]);
  expect(getCameraMotionPresetPatch("fast-follow")).toEqual({
    duration: 3,
    interpolation: "smooth",
    easing: "linear",
  });
});
