import type { DirectorCameraMotionPath } from "../schema/directorProject";

export type CameraMotionPreset = {
  id: string;
  label: string;
  description: string;
  patch: Pick<DirectorCameraMotionPath, "duration" | "interpolation" | "easing">;
};

export const CAMERA_MOTION_PRESETS: CameraMotionPreset[] = [
  {
    id: "cinematic-push",
    label: "电影慢推",
    description: "8 秒，柔和起停，适合情绪和人物特写",
    patch: { duration: 8, interpolation: "smooth", easing: "ease-in-out" },
  },
  {
    id: "character-follow",
    label: "平稳跟拍节奏",
    description: "6 秒，平滑稳定，适合边走边拍",
    patch: { duration: 6, interpolation: "smooth", easing: "ease-in-out" },
  },
  {
    id: "fast-follow",
    label: "快速追拍",
    description: "3 秒，匀速响应，适合动作镜头",
    patch: { duration: 3, interpolation: "smooth", easing: "linear" },
  },
  {
    id: "product-orbit",
    label: "产品环绕",
    description: "10 秒，匀速平滑，适合环绕展示",
    patch: { duration: 10, interpolation: "smooth", easing: "linear" },
  },
  {
    id: "steady-slide",
    label: "平稳横移",
    description: "5 秒，直线柔和，适合横向展示空间",
    patch: { duration: 5, interpolation: "linear", easing: "ease-in-out" },
  },
  {
    id: "ambient-long-take",
    label: "氛围长镜头",
    description: "15 秒，慢速平滑，适合环境建立镜头",
    patch: { duration: 15, interpolation: "smooth", easing: "ease-in-out" },
  },
];

export function getCameraMotionPresetPatch(id: string) {
  return CAMERA_MOTION_PRESETS.find((preset) => preset.id === id)?.patch ?? null;
}

export function findMatchingCameraMotionPreset(path: DirectorCameraMotionPath) {
  return CAMERA_MOTION_PRESETS.find((preset) =>
    preset.patch.duration === path.duration &&
    preset.patch.interpolation === path.interpolation &&
    preset.patch.easing === path.easing
  ) ?? null;
}
