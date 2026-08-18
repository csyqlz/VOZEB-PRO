import { describe, expect, it } from "vitest";
import {
  CAMERA_PATH_TEMPLATES,
  createCameraPathTemplate,
  getCameraPathTemplatesByGroup,
} from "../cameraPathTemplates";

const snapshot = { position: [0, 2, 8] as [number, number, number], target: [0, 1, 0] as [number, number, number], fov: 50 };

describe("camera path templates", () => {
  it("provides all requested beginner camera moves", () => {
    expect(CAMERA_PATH_TEMPLATES.map((item) => item.label)).toEqual([
      "推镜", "拉镜", "左摇镜", "右摇镜", "俯仰抬镜", "俯拍压镜",
      "左移镜", "右移镜", "环绕摇臂升镜", "跟拍", "平行跟拍", "手持晃镜",
      "过肩绕正面", "近景半环绕", "环绕摇臂降镜", "低机位追拍", "俯视跟拍", "横移揭示",
    ]);
  });

  it("keeps community presets separate with complete contribution metadata", () => {
    expect(getCameraPathTemplatesByGroup("official").map((item) => item.label)).toEqual([
      "推镜", "拉镜", "左摇镜", "右摇镜", "俯仰抬镜", "俯拍压镜", "左移镜", "右移镜",
    ]);
    const community = getCameraPathTemplatesByGroup("community");
    expect(community.map((item) => item.label)).toEqual([
      "环绕摇臂升镜", "跟拍", "平行跟拍", "手持晃镜", "过肩绕正面",
      "近景半环绕", "环绕摇臂降镜", "低机位追拍", "俯视跟拍", "横移揭示",
    ]);
    for (const template of community) {
      expect(template.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(template.suitableFor).toBeTruthy();
      expect(template.contribution).toEqual(expect.objectContaining({
        contributorName: "AIGC 耀光",
        contact: "抖音号：AIJPDM001",
        sourceUrl: null,
        license: expect.any(String),
      }));
    }
  });

  it("keeps every preset id unique", () => {
    expect(new Set(CAMERA_PATH_TEMPLATES.map((item) => item.id)).size).toBe(CAMERA_PATH_TEMPLATES.length);
  });

  it("creates visible parallel motion even when tracking a fixed point", () => {
    const path = createCameraPathTemplate({
      cameraId: "cam",
      focusAt: () => [0, 1, 0],
      snapshot,
      templateId: "parallel-follow",
    });
    expect(new Set(path.keyframes.map((item) => item.position.join(","))).size).toBeGreaterThan(1);
  });

  it("generates an editable route that tracks the selected object per waypoint", () => {
    const path = createCameraPathTemplate({
      cameraId: "cam_1",
      focusAt: (progress) => [progress * 4, 1, 0],
      snapshot,
      targetObjectId: "char_1",
      templateId: "follow",
    });

    expect(path.keyframes).toHaveLength(3);
    expect(path.keyframes.map((item) => item.time)).toEqual([0, .5, 1]);
    expect(path.keyframes.every((item) => item.targetObjectId === "char_1" && item.targetMode === "object")).toBe(true);
    expect(path.keyframes[2].position[0]).toBeGreaterThan(path.keyframes[0].position[0]);
  });

  it("scales the spatial range of a generated push route", () => {
    const small = createCameraPathTemplate({ cameraId: "cam", focusAt: () => [0, 1, 0], snapshot, scale: .5, templateId: "push-in" });
    const large = createCameraPathTemplate({ cameraId: "cam", focusAt: () => [0, 1, 0], snapshot, scale: 2, templateId: "push-in" });
    const smallTravel = Math.abs(small.keyframes[0].position[2] - small.keyframes[2].position[2]);
    const largeTravel = Math.abs(large.keyframes[0].position[2] - large.keyframes[2].position[2]);

    expect(largeTravel).toBeGreaterThan(smallTravel * 3);
  });

  it("scales every community preset around its tracked subject", () => {
    for (const template of getCameraPathTemplatesByGroup("community")) {
      const small = createCameraPathTemplate({
        cameraId: "cam",
        focusAt: () => [0, 1, 0],
        snapshot,
        scale: 0.5,
        templateId: template.id,
      });
      const large = createCameraPathTemplate({
        cameraId: "cam",
        focusAt: () => [0, 1, 0],
        snapshot,
        scale: 2,
        templateId: template.id,
      });
      const smallMaximumDistance = Math.max(...small.keyframes.map((item) => Math.hypot(
        item.position[0],
        item.position[1] - 1,
        item.position[2],
      )));
      const largeMaximumDistance = Math.max(...large.keyframes.map((item) => Math.hypot(
        item.position[0],
        item.position[1] - 1,
        item.position[2],
      )));

      expect(largeMaximumDistance, template.label).toBeGreaterThan(smallMaximumDistance * 3.5);
    }
  });

  it("creates deterministic multi-point handheld motion", () => {
    const first = createCameraPathTemplate({ cameraId: "cam", focusAt: () => [0, 1, 0], snapshot, templateId: "handheld" });
    const second = createCameraPathTemplate({ cameraId: "cam", focusAt: () => [0, 1, 0], snapshot, templateId: "handheld" });

    expect(first).toEqual(second);
    expect(first.keyframes).toHaveLength(7);
    expect(new Set(first.keyframes.map((item) => item.position.join(","))).size).toBeGreaterThan(3);
  });
});
