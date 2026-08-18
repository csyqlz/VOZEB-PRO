import { readFileSync } from "node:fs";
import {
  AnimationMixer,
  Box3,
  Group,
  Vector3,
  type Object3D,
} from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { CHARACTER_ACTION_PRESETS } from "../../presets/characterActionPresets";
import {
  getNativeMixamoActionClip,
  prepareMixamoAnimationClip,
  ROBOT_EXPRESSIVE_ACTION_CLIPS,
  SOLDIER_NATIVE_ACTION_CLIPS,
} from "../MixamoCharacterModel";

declare const process: {
  cwd: () => string;
};

const ASSET_ROOT = `${process.cwd()}/public/local-assets/mixamo`;
const GUO_CHARACTER_ROOT = `${process.cwd()}/public/local-assets/guo-3d-assets/guo-skeleton-models/models`;
const SAMPLE_PROGRESS = [0, 0.2, 0.45, 0.7, 0.95];

const CHARACTER_FILES = [
  "camille.fbx",
];

const originalCreateImageBitmap = globalThis.createImageBitmap;

beforeAll(() => {
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    value: async () => ({ width: 1, height: 1, close() {} }) as ImageBitmap,
  });
});

afterAll(() => {
  if (originalCreateImageBitmap) {
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: originalCreateImageBitmap,
    });
  } else {
    Reflect.deleteProperty(globalThis, "createImageBitmap");
  }
});

function readArrayBuffer(path: string) {
  const binary = readFileSync(path, "binary");
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function loadCharacter(fileName: string) {
  const path = `${ASSET_ROOT}/characters/${fileName}`;
  if (fileName.endsWith(".fbx")) return new FBXLoader().parse(readArrayBuffer(path), "");

  return (await loadGlb(fileName)).scene;
}

function loadGlb(fileName: string) {
  const path = `${ASSET_ROOT}/characters/${fileName}`;
  return new Promise<GLTF>((resolve, reject) => {
    new GLTFLoader().parse(readArrayBuffer(path), "", resolve, reject);
  });
}

function loadAnimation(fileName: string) {
  return new FBXLoader().parse(readArrayBuffer(`${ASSET_ROOT}/animations/${fileName}`), "");
}

function findMixamoBone(scene: Object3D, suffix: string) {
  let match: Object3D | null = null;
  scene.traverse((object) => {
    if (!match && object.name.replace(/:/g, "").endsWith(suffix)) match = object;
  });
  return match as Object3D | null;
}

function createNormalizedCharacter(source: Object3D) {
  const scene = cloneSkeleton(source) as Object3D;
  scene.updateMatrixWorld(true);
  const sourceBounds = new Box3().setFromObject(scene);
  const sourceSize = sourceBounds.getSize(new Vector3());
  const scale = sourceSize.y > 0 ? 1.8 / sourceSize.y : 1;
  const root = new Group();
  root.scale.setScalar(scale);
  root.position.set(
    -(sourceBounds.min.x + sourceBounds.max.x) * 0.5 * scale,
    -sourceBounds.min.y * scale,
    -(sourceBounds.min.z + sourceBounds.max.z) * 0.5 * scale
  );
  root.add(scene);
  root.updateMatrixWorld(true);
  return { root, scene };
}

describe("installed Mixamo character and action compatibility", () => {
  const actionFiles = CHARACTER_ACTION_PRESETS.map((preset) => ({
    action: preset.label,
    fileName: preset.mixamoAnimationUrl?.split("/").pop() ?? "",
  })).filter((item) => item.fileName);

  it.each(CHARACTER_FILES)("keeps %s upright and finite through every installed action", async (characterFile) => {
    const sourceCharacter = await loadCharacter(characterFile);

    for (const { action, fileName } of actionFiles) {
      const { root, scene } = createNormalizedCharacter(sourceCharacter);
      const animationSource = loadAnimation(fileName);
      const sourceClip = animationSource.animations[0];
      expect(sourceClip, `${action} should contain an animation clip`).toBeTruthy();
      const clip = prepareMixamoAnimationClip(
        sourceClip,
        scene,
        animationSource,
        "local-rest"
      );

      for (const track of clip.tracks) {
        const nodeName = track.name.slice(0, track.name.lastIndexOf("."));
        expect(scene.getObjectByName(nodeName), `${characterFile} ${action} cannot bind ${track.name}`).toBeTruthy();
        expect(Array.from(track.values).every(Number.isFinite), `${characterFile} ${action} has invalid track values`).toBe(true);
      }

      const hips = findMixamoBone(scene, "mixamorigHips");
      const head = findMixamoBone(scene, "mixamorigHead");
      expect(hips, `${characterFile} is missing Mixamo hips`).toBeTruthy();
      expect(head, `${characterFile} is missing Mixamo head`).toBeTruthy();

      const mixer = new AnimationMixer(scene);
      mixer.clipAction(clip, scene).play();
      for (const progress of SAMPLE_PROGRESS) {
        mixer.setTime(clip.duration * progress);
        root.updateMatrixWorld(true);
        const bounds = new Box3().setFromObject(root);
        const size = bounds.getSize(new Vector3());
        const center = bounds.getCenter(new Vector3());
        const hipsPosition = hips!.getWorldPosition(new Vector3());
        const headPosition = head!.getWorldPosition(new Vector3());

        expect([bounds.min, bounds.max, size, center, hipsPosition, headPosition]
          .flatMap((vector) => vector.toArray())
          .every(Number.isFinite), `${characterFile} ${action} produced invalid geometry`).toBe(true);
        expect(size.y, `${characterFile} ${action} appears flattened or sideways`).toBeGreaterThan(0.65);
        expect(size.y, `${characterFile} ${action} exploded vertically`).toBeLessThan(3.5);
        expect(Math.max(size.x, size.z), `${characterFile} ${action} exploded horizontally`).toBeLessThan(4);
        expect(center.length(), `${characterFile} ${action} flew away from the scene origin`).toBeLessThan(5);
        expect(headPosition.y - hipsPosition.y, `${characterFile} ${action} is no longer upright`).toBeGreaterThan(0.2);
        expect(bounds.min.y, `${characterFile} ${action} sank too far below the floor`).toBeGreaterThan(-0.35);
      }

      mixer.stopAllAction();
      mixer.uncacheRoot(scene);
    }
  }, 30_000);
});

describe("mixamorig1 character compatibility", () => {
  it("binds a standard Mixamo walk animation to the alternate bone prefix without exploding", () => {
    const sourceCharacter = new FBXLoader().parse(
      readArrayBuffer(`${GUO_CHARACTER_ROOT}/0038_male-skeleton.fbx`),
      ""
    );
    const animationSource = loadAnimation("walk.fbx");
    const sourceClip = animationSource.animations[0];
    const { root, scene } = createNormalizedCharacter(sourceCharacter);
    const clip = prepareMixamoAnimationClip(sourceClip, scene, animationSource, "local-rest");

    expect(clip.tracks.length).toBeGreaterThan(40);
    for (const track of clip.tracks) {
      const nodeName = track.name.slice(0, track.name.lastIndexOf("."));
      expect(scene.getObjectByName(nodeName), `alternate rig cannot bind ${track.name}`).toBeTruthy();
      expect(Array.from(track.values).every(Number.isFinite)).toBe(true);
    }

    const mixer = new AnimationMixer(scene);
    mixer.clipAction(clip, scene).play();
    for (const progress of SAMPLE_PROGRESS) {
      mixer.setTime(clip.duration * progress);
      root.updateMatrixWorld(true);
      const bounds = new Box3().setFromObject(root);
      const size = bounds.getSize(new Vector3());
      expect(size.y).toBeGreaterThan(0.65);
      expect(size.y).toBeLessThan(3.5);
      expect(Math.max(size.x, size.z)).toBeLessThan(4);
      expect(bounds.min.y).toBeGreaterThan(-0.35);
    }
  }, 30_000);
});

describe("installed X Bot native action compatibility", () => {
  it("keeps every mapped native action visible, upright, and finite", async () => {
    const sourceCharacter = await loadGlb("xbot.glb");

    for (const preset of CHARACTER_ACTION_PRESETS) {
      const { root, scene } = createNormalizedCharacter(sourceCharacter.scene);
      const sourceClip = getNativeMixamoActionClip(preset.id, sourceCharacter.animations);
      expect(sourceClip, `${preset.label} should map to a native X Bot clip`).toBeTruthy();
      const clip = sourceClip!.clone();
      const hips = findMixamoBone(scene, "mixamorigHips");
      const head = findMixamoBone(scene, "mixamorigHead");
      const mixer = new AnimationMixer(scene);
      mixer.clipAction(clip, scene).play();

      for (const progress of SAMPLE_PROGRESS) {
        mixer.setTime(clip.duration * progress);
        root.updateMatrixWorld(true);
        const bounds = new Box3().setFromObject(root);
        const size = bounds.getSize(new Vector3());
        const hipsPosition = hips!.getWorldPosition(new Vector3());
        const headPosition = head!.getWorldPosition(new Vector3());

        expect([bounds.min, bounds.max, size, hipsPosition, headPosition]
          .flatMap((vector) => vector.toArray())
          .every(Number.isFinite), `X Bot ${preset.label} produced invalid geometry`).toBe(true);
        expect(size.y, `X Bot ${preset.label} disappeared or flattened`).toBeGreaterThan(0.65);
        expect(size.y, `X Bot ${preset.label} exploded vertically`).toBeLessThan(3.5);
        expect(Math.max(size.x, size.z), `X Bot ${preset.label} exploded horizontally`).toBeLessThan(4);
        expect(headPosition.y - hipsPosition.y, `X Bot ${preset.label} is no longer upright`).toBeGreaterThan(0.2);
        expect(bounds.min.y, `X Bot ${preset.label} sank too far below the floor`).toBeGreaterThan(-0.35);
      }

      mixer.stopAllAction();
      mixer.uncacheRoot(scene);
    }
  });
});

describe("installed Soldier native fallback compatibility", () => {
  it("keeps every mapped fallback action visible, upright, and finite", async () => {
    const sourceCharacter = await loadGlb("soldier.glb");

    for (const preset of CHARACTER_ACTION_PRESETS) {
      const { root, scene } = createNormalizedCharacter(sourceCharacter.scene);
      const sourceClip = getNativeMixamoActionClip(
        preset.id,
        sourceCharacter.animations,
        SOLDIER_NATIVE_ACTION_CLIPS
      );
      expect(sourceClip, `${preset.label} should map to a native Soldier clip`).toBeTruthy();
      const clip = sourceClip!.clone();
      const mixer = new AnimationMixer(scene);
      mixer.clipAction(clip, scene).play();

      for (const progress of SAMPLE_PROGRESS) {
        mixer.setTime(clip.duration * progress);
        root.updateMatrixWorld(true);
        const bounds = new Box3().setFromObject(root);
        const size = bounds.getSize(new Vector3());
        const center = bounds.getCenter(new Vector3());

        expect([bounds.min, bounds.max, size, center]
          .flatMap((vector) => vector.toArray())
          .every(Number.isFinite), `Soldier ${preset.label} produced invalid geometry`).toBe(true);
        expect(size.y, `Soldier ${preset.label} disappeared or flattened`).toBeGreaterThan(0.65);
        expect(size.y, `Soldier ${preset.label} exploded vertically`).toBeLessThan(3.5);
        expect(Math.max(size.x, size.z), `Soldier ${preset.label} exploded horizontally`).toBeLessThan(4);
        expect(center.length(), `Soldier ${preset.label} flew away from the scene origin`).toBeLessThan(5);
        expect(bounds.min.y, `Soldier ${preset.label} sank too far below the floor`).toBeGreaterThan(-0.35);
      }

      mixer.stopAllAction();
      mixer.uncacheRoot(scene);
    }
  });
});

describe("installed RobotExpressive action compatibility", () => {
  it("keeps every mapped native action visible, upright, and finite", async () => {
    const sourceCharacter = await loadGlb("robot-expressive.glb");

    for (const preset of CHARACTER_ACTION_PRESETS) {
      const { root, scene } = createNormalizedCharacter(sourceCharacter.scene);
      const sourceClip = getNativeMixamoActionClip(
        preset.id,
        sourceCharacter.animations,
        ROBOT_EXPRESSIVE_ACTION_CLIPS
      );
      expect(sourceClip, `${preset.label} should map to a native RobotExpressive clip`).toBeTruthy();
      const clip = sourceClip!.clone();
      const mixer = new AnimationMixer(scene);
      mixer.clipAction(clip, scene).play();

      for (const progress of SAMPLE_PROGRESS) {
        mixer.setTime(clip.duration * progress);
        root.updateMatrixWorld(true);
        const bounds = new Box3().setFromObject(root);
        const size = bounds.getSize(new Vector3());

        expect([bounds.min, bounds.max, size]
          .flatMap((vector) => vector.toArray())
          .every(Number.isFinite), `RobotExpressive ${preset.label} produced invalid geometry`).toBe(true);
        expect(size.y, `RobotExpressive ${preset.label} disappeared or flattened`).toBeGreaterThan(0.55);
        expect(size.y, `RobotExpressive ${preset.label} exploded vertically`).toBeLessThan(3.5);
        expect(Math.max(size.x, size.z), `RobotExpressive ${preset.label} exploded horizontally`).toBeLessThan(4);
        expect(bounds.min.y, `RobotExpressive ${preset.label} sank too far below the floor`).toBeGreaterThan(-0.4);
      }

      mixer.stopAllAction();
      mixer.uncacheRoot(scene);
    }
  });
});
