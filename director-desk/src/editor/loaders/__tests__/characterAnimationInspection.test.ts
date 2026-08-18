import { readFileSync } from "node:fs";
import { AnimationClip, QuaternionKeyframeTrack } from "three";
import { describe, expect, it } from "vitest";
import {
  inspectCharacterAnimationFile,
  inspectCharacterAnimations,
  type CharacterAnimationRigProfile,
} from "../characterAnimationInspection";

declare const process: { cwd: () => string };

function makeFile(path: string, name: string) {
  const binary = readFileSync(path, "binary");
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new File([buffer], name, { type: "application/octet-stream" });
}

function makeClip(name: string, duration: number, nodeNames: string[]) {
  return new AnimationClip(
    name,
    duration,
    nodeNames.map((nodeName) => new QuaternionKeyframeTrack(
      `${nodeName}.quaternion`,
      [0, duration],
      [0, 0, 0, 1, 0, 0, 0, 1]
    ))
  );
}

describe("character animation inspection", () => {
  it.each<[CharacterAnimationRigProfile, string[]]>([
    ["mixamo", ["mixamorig:Hips", "mixamorig:Spine", "mixamorig:LeftArm"]],
    ["mixamorig1", ["mixamorig1:Hips", "mixamorig1:Spine", "mixamorig1:RightArm"]],
    ["bip", ["Bip001 Pelvis", "Bip001 Spine", "Bip001 L UpperArm"]],
    ["cc-base", ["CC_Base_Hip", "CC_Base_Spine01", "CC_Base_L_Upperarm"]],
    ["generic", ["Hips", "Spine", "Head", "LeftArm", "RightArm", "LeftLeg", "RightLeg"]],
    ["unknown", ["Cube", "CameraTarget", "ControlNode"]],
  ])("infers the %s profile from track node names", (expectedProfile, nodeNames) => {
    const report = inspectCharacterAnimations([makeClip("Take", 1, nodeNames)], "fbx");

    expect(report.rigProfile).toBe(expectedProfile);
    expect(report.clips).toEqual([{ name: "Take", duration: 1, trackCount: nodeNames.length }]);
  });

  it("ignores binding-frame clips at or below 0.05 seconds", () => {
    const report = inspectCharacterAnimations([
      makeClip("Bind pose", 0.05, ["mixamorig:Hips"]),
    ], "glb");

    expect(report.hasValidMotion).toBe(false);
    expect(report.warnings).toContain("仅检测到时长不超过 0.05 秒的绑定帧，没有有效动作");

    const movingReport = inspectCharacterAnimations([
      makeClip("Bind pose", 0.05, ["mixamorig:Hips"]),
      makeClip("Move", 0.0500001, ["mixamorig:Hips"]),
    ], "glb");
    expect(movingReport.hasValidMotion).toBe(true);
  });

  it("warns when no clips or recognizable track nodes exist", () => {
    const report = inspectCharacterAnimations([], "fbx");

    expect(report.clipCount).toBe(0);
    expect(report.rigProfile).toBe("unknown");
    expect(report.hasValidMotion).toBe(false);
    expect(report.warnings).toContain("未检测到动画 clip");
    expect(report.warnings).toContain("无法从动画轨道节点名识别骨架 profile");
  });

  it("inspects the real installed Mixamo walk FBX", async () => {
    const path = `${process.cwd()}/public/local-assets/mixamo/animations/walk.fbx`;
    const report = await inspectCharacterAnimationFile(makeFile(path, "walk.fbx"));

    expect(report.format).toBe("fbx");
    expect(report.rigProfile).toBe("mixamo");
    expect(report.hasValidMotion).toBe(true);
    expect(report.clipCount).toBe(1);
    expect(report.clips[0]).toMatchObject({ name: "mixamo.com", trackCount: 53 });
    expect(report.clips[0].duration).toBeCloseTo(1.033333, 5);
  });

  it("reports every clip from a real GLB with built-in animations", async () => {
    const path = `${process.cwd()}/public/local-assets/mixamo/characters/robot-expressive.glb`;
    const report = await inspectCharacterAnimationFile(makeFile(path, "robot-expressive.glb"));

    expect(report.format).toBe("glb");
    expect(report.rigProfile).toBe("generic");
    expect(report.hasValidMotion).toBe(true);
    expect(report.clipCount).toBe(14);
    expect(report.clips.map((clip) => clip.name)).toEqual([
      "Dance", "Death", "Idle", "Jump", "No", "Punch", "Running",
      "Sitting", "Standing", "ThumbsUp", "Walking", "WalkJump", "Wave", "Yes",
    ]);
    expect(report.clips.find((clip) => clip.name === "Wave")).toEqual({
      name: "Wave",
      duration: 1.833333,
      trackCount: 20,
    });
  });

  it("rejects unsupported animation file formats", async () => {
    const file = new File(["animation"], "take.bvh", { type: "application/octet-stream" });
    await expect(inspectCharacterAnimationFile(file)).rejects.toThrow("角色动画目前仅支持 FBX / GLB 文件");
  });
});
