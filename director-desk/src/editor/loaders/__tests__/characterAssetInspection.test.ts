import { readFileSync } from "node:fs";
import {
  AnimationClip,
  Bone,
  BoxGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
} from "three";
import { describe, expect, it } from "vitest";
import {
  inspectCharacterAsset,
  inspectCharacterModelFile,
} from "../characterAssetInspection";

declare const process: { cwd: () => string };

function makeFile(path: string, name: string) {
  const binary = readFileSync(path, "binary");
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new File([buffer], name, { type: "application/octet-stream" });
}

function createMixamoCharacter() {
  const root = new Group();
  const names = [
    "Hips", "Spine2", "Head",
    "LeftArm", "LeftForeArm", "LeftHand",
    "RightArm", "RightForeArm", "RightHand",
    "LeftUpLeg", "LeftLeg", "LeftFoot",
    "RightUpLeg", "RightLeg", "RightFoot",
  ];
  const bones = names.map((name) => {
    const bone = new Bone();
    bone.name = `mixamorig:${name}`;
    return bone;
  });
  bones[0].add(...bones.slice(1));
  bones[2].position.y = 1.7;
  bones[11].position.y = 0;
  bones[14].position.y = 0;
  const geometry = new BoxGeometry(0.6, 1.8, 0.3);
  const vertexCount = geometry.getAttribute("position").count;
  const skinIndices = new Uint16Array(vertexCount * 4);
  const skinWeights = new Float32Array(vertexCount * 4);
  for (let index = 0; index < vertexCount; index += 1) skinWeights[index * 4] = 1;
  geometry.setAttribute("skinIndex", new Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute("skinWeight", new Float32BufferAttribute(skinWeights, 4));
  const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial());
  mesh.position.y = 0.9;
  mesh.add(bones[0]);
  mesh.bind(new Skeleton(bones));
  root.add(mesh);
  return root;
}

describe("character asset inspection", () => {
  it("recognizes a complete Mixamo skeleton as directly usable", () => {
    const report = inspectCharacterAsset(createMixamoCharacter(), [new AnimationClip("Idle", 1, [])], "fbx");

    expect(report.rigProfile).toBe("mixamo");
    expect(report.readiness).toBe("ready");
    expect(report.skinnedMeshCount).toBe(1);
    expect(report.primaryBoneCount).toBe(15);
    expect(report.mappedBodyParts).toHaveLength(16);
    expect(report.missingBodyParts).toEqual([]);
    expect(report.animationNames).toEqual(["Idle"]);
    expect(report.playableAnimationCount).toBe(0);
    expect(report.uprightAxis).toBe("y");
    expect(report.recommendedScale).toBeCloseTo(1, 4);
  });

  it("does not pretend an unrigged mesh can play character actions", () => {
    const scene = new Group();
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    scene.add(mesh);

    const report = inspectCharacterAsset(scene);
    expect(report.readiness).toBe("static-only");
    expect(report.skeletonCount).toBe(0);
    expect(report.warnings).toContain("没有检测到蒙皮骨架，只能作为静态模型使用");
  });

  it("produces an automatic correction for a character whose head-to-waist axis is horizontal", () => {
    const character = createMixamoCharacter();
    const head = character.getObjectByName("mixamorig:Head")!;
    head.position.set(1.7, 0, 0);

    const report = inspectCharacterAsset(character);
    expect(report.uprightAxis).toBe("x");
    expect(report.orientationCorrection).toEqual([0, 0, Number((Math.PI / 2).toFixed(6))]);
    expect(report.warnings).toContain("模型当前沿 X 轴站立，导入后需要自动转正");
  });

  it("rejects formats that cannot be imported as characters", async () => {
    const file = new File(["o cube"], "cube.obj", { type: "model/obj" });
    await expect(inspectCharacterModelFile(file)).rejects.toThrow("人物模型目前仅支持 FBX / GLB 文件");
  });

  it("inspects a real installed Mixamo FBX", async () => {
    const path = `${process.cwd()}/public/local-assets/mixamo/characters/camille.fbx`;
    const report = await inspectCharacterModelFile(makeFile(path, "camille.fbx"));

    expect(report.rigProfile).toBe("mixamo");
    expect(report.readiness).toBe("ready");
    expect(report.primaryBoneCount).toBeGreaterThan(20);
    expect(report.mappedBodyParts).toHaveLength(16);
    expect(report.uprightAxis).toBe("y");
    expect(report.dimensions.every(Number.isFinite)).toBe(true);
  });

  it("inspects a real installed GLB with native actions", async () => {
    const path = `${process.cwd()}/public/local-assets/mixamo/characters/robot-expressive.glb`;
    const report = await inspectCharacterModelFile(makeFile(path, "robot-expressive.glb"));

    expect(report.format).toBe("glb");
    expect(report.skinnedMeshCount).toBeGreaterThan(0);
    expect(report.animationCount).toBeGreaterThan(0);
    expect(report.playableAnimationCount).toBeGreaterThan(0);
    expect(["ready", "native-only"]).toContain(report.readiness);
    expect(report.animationNames).toContain("Wave");
  });

});
