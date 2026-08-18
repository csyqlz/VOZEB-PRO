import { AnimationClip, AnimationMixer, Bone, Euler, Group, Quaternion, QuaternionKeyframeTrack, VectorKeyframeTrack } from "three";
import {
  applyMixamoAnimationSample,
  applyCharacterRestPose,
  captureCharacterRestPose,
  getCanonicalHumanoidBoneName,
  getFallbackMixamoAnimationUrl,
  getNativeMixamoActionClip,
  prepareMixamoAnimationClip,
  ROBOT_EXPRESSIVE_ACTION_CLIPS,
  SOLDIER_NATIVE_ACTION_CLIPS,
} from "../MixamoCharacterModel";

it("keeps an absolute animation pose when the same runtime time is sampled on later frames", () => {
  const scene = new Group();
  const hand = new Bone();
  hand.name = "mixamorigRightHand";
  scene.add(hand);
  const restPose = captureCharacterRestPose(scene);
  const clip = new AnimationClip("wave", 1, [
    new VectorKeyframeTrack("mixamorigRightHand.position", [0, 1], [0, 0, 0, 1, 0, 0]),
  ]);
  const mixer = new AnimationMixer(scene);
  mixer.clipAction(clip, scene).play();

  const firstClipTime = applyMixamoAnimationSample({
    animationTimeSeconds: 0.5,
    clipDuration: clip.duration,
    lastClipTime: null,
    mixer,
    restPose,
    scene,
  });
  const firstPosition = hand.position.x;
  const repeatedClipTime = applyMixamoAnimationSample({
    animationTimeSeconds: 0.5,
    clipDuration: clip.duration,
    lastClipTime: firstClipTime,
    mixer,
    restPose,
    scene,
  });

  expect(firstPosition).toBeCloseTo(0.5);
  expect(repeatedClipTime).toBe(firstClipTime);
  expect(hand.position.x).toBeCloseTo(firstPosition);
});

it("treats mixamorig1 bones as the same humanoid joints as standard Mixamo bones", () => {
  expect(getCanonicalHumanoidBoneName("mixamorig1:Hips")).toBe("mixamorigHips");
  expect(getCanonicalHumanoidBoneName("mixamorig:LeftForeArm")).toBe("mixamorigLeftForeArm");
});

function expectTupleClose(actual: number[], expected: number[], precision = 5) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => {
    expect(value).toBeCloseTo(expected[index], precision);
  });
}

it("maps every director action to a native X Bot clip", () => {
  const clips = [
    new AnimationClip("agree", 1.83, []),
    new AnimationClip("idle", 2, []),
    new AnimationClip("run", 0.7, []),
    new AnimationClip("sneak_pose", 0.07, []),
    new AnimationClip("walk", 0.96, []),
  ];

  expect(getNativeMixamoActionClip("walk-cycle", clips)?.name).toBe("walk");
  expect(getNativeMixamoActionClip("run-cycle", clips)?.name).toBe("run");
  expect(getNativeMixamoActionClip("crouch-cycle", clips)?.name).toBe("sneak_pose");
  expect(getNativeMixamoActionClip("side-step-left", clips)?.name).toBe("walk");
  expect(getNativeMixamoActionClip("jump-cycle", clips)?.name).toBe("idle");
  expect(getNativeMixamoActionClip("wave-cycle", clips)?.name).toBe("agree");
});

it("maps every director action to a native RobotExpressive clip", () => {
  const clips = ["Walking", "Running", "Sitting", "Jump", "Wave"]
    .map((name) => new AnimationClip(name, 1, []));

  expect(getNativeMixamoActionClip("walk-cycle", clips, ROBOT_EXPRESSIVE_ACTION_CLIPS)?.name).toBe("Walking");
  expect(getNativeMixamoActionClip("run-cycle", clips, ROBOT_EXPRESSIVE_ACTION_CLIPS)?.name).toBe("Running");
  expect(getNativeMixamoActionClip("crouch-cycle", clips, ROBOT_EXPRESSIVE_ACTION_CLIPS)?.name).toBe("Sitting");
  expect(getNativeMixamoActionClip("side-step-left", clips, ROBOT_EXPRESSIVE_ACTION_CLIPS)?.name).toBe("Walking");
  expect(getNativeMixamoActionClip("jump-cycle", clips, ROBOT_EXPRESSIVE_ACTION_CLIPS)?.name).toBe("Jump");
  expect(getNativeMixamoActionClip("wave-cycle", clips, ROBOT_EXPRESSIVE_ACTION_CLIPS)?.name).toBe("Wave");
});

it("maps every legacy Soldier action to a stable native clip", () => {
  const clips = ["Idle", "Run", "Walk"].map((name) => new AnimationClip(name, 1, []));

  for (const actionId of [
    "walk-cycle",
    "run-cycle",
    "crouch-cycle",
    "side-step-left",
    "jump-cycle",
    "wave-cycle",
  ]) {
    expect(getNativeMixamoActionClip(actionId, clips, SOLDIER_NATIVE_ACTION_CLIPS)).toBeTruthy();
  }
});

it("falls back to the external humanoid action for a GLB without a matching native clip", () => {
  expect(getFallbackMixamoAnimationUrl("walk-cycle", null)).toContain("walk.fbx");
  expect(getFallbackMixamoAnimationUrl("walk-cycle", new AnimationClip("walk", 1, []))).toBeNull();
  expect(getFallbackMixamoAnimationUrl("walk-cycle", null, false)).toBeNull();
});

it("retargets a Mixamo animation track to a manually mapped target bone", () => {
  const sourceScene = new Group();
  const sourceHand = new Bone();
  sourceHand.name = "mixamorig:LeftHand";
  sourceScene.add(sourceHand);

  const targetScene = new Group();
  const targetHand = new Bone();
  targetHand.name = "Rig_Left_Palm_Custom";
  targetScene.add(targetHand);
  const clip = new AnimationClip("wave", 1, [
    new QuaternionKeyframeTrack("mixamorig:LeftHand.quaternion", [0, 1], [0, 0, 0, 1, 0.2, 0, 0, 0.98]),
  ]);

  const prepared = prepareMixamoAnimationClip(
    clip,
    targetScene,
    sourceScene,
    "local-rest",
    captureCharacterRestPose(targetScene),
    captureCharacterRestPose(sourceScene),
    { leftHand: "Rig_Left_Palm_Custom" }
  );

  expect(prepared.tracks[0].name).toBe("Rig_Left_Palm_Custom.quaternion");
});

it("retargets Mixamo hips height and removes horizontal root motion", () => {
  const scene = new Group();
  const hips = new Bone();
  hips.name = "mixamorigHips";
  hips.position.set(1, 105, 2);
  scene.add(hips);
  const sourceTrack = new VectorKeyframeTrack(
    "mixamorigHips.position",
    [0, 1],
    [0, 90, 0, 15, 112, 30]
  );
  const sourceClip = new AnimationClip("walk", 1, [sourceTrack]);

  const prepared = prepareMixamoAnimationClip(sourceClip, scene);
  const values = Array.from(prepared.tracks[0].values);

  expect(values).toEqual([1, 105, 2, 1, 127, 2]);
  expect(Array.from(sourceClip.tracks[0].values)).toEqual([0, 90, 0, 15, 112, 30]);
});

it("maps vertical hips motion through a rotated and scaled target parent", () => {
  const sourceScene = new Group();
  const sourceHips = new Bone();
  sourceHips.name = "mixamorigHips";
  sourceHips.position.set(0, 100, 0);
  sourceScene.add(sourceHips);

  const targetScene = new Group();
  const targetParent = new Group();
  targetParent.rotation.x = -Math.PI / 2;
  targetParent.scale.setScalar(0.01);
  const targetHips = new Bone();
  targetHips.name = "mixamorigHips";
  targetHips.position.set(0, 0, 100);
  targetParent.add(targetHips);
  targetScene.add(targetParent);
  sourceScene.updateMatrixWorld(true);
  targetScene.updateMatrixWorld(true);

  const clip = new AnimationClip("jump", 1, [
    new VectorKeyframeTrack("mixamorigHips.position", [0, 1], [0, 100, 0, 10, 120, 8]),
  ]);
  const prepared = prepareMixamoAnimationClip(clip, targetScene, sourceScene, "local-rest");

  expect(Array.from(prepared.tracks[0].values)).toEqual([
    expect.closeTo(0, 6), expect.closeTo(0, 6), expect.closeTo(100, 6),
    expect.closeTo(0, 6), expect.closeTo(0, 6), expect.closeTo(120, 6),
  ]);
});

it("accepts the colon form of Mixamo hips names", () => {
  const scene = new Group();
  const hips = new Bone();
  hips.name = "mixamorigHips";
  hips.position.set(0, 100, 0);
  scene.add(hips);
  const clip = new AnimationClip("jump", 1, [
    new VectorKeyframeTrack("mixamorig:Hips.position", [0, 1], [0, 80, 0, 4, 100, 8]),
  ]);

  expect(Array.from(prepareMixamoAnimationClip(clip, scene).tracks[0].values))
    .toEqual([0, 100, 0, 0, 120, 0]);
});

it("retargets animation track names to models that keep Mixamo colons", () => {
  const scene = new Group();
  const hips = new Bone();
  hips.name = "mixamorig:Hips";
  hips.position.set(0, 96, 0);
  scene.add(hips);
  const clip = new AnimationClip("walk", 1, [
    new VectorKeyframeTrack("mixamorigHips.position", [0, 1], [0, 80, 0, 3, 90, 7]),
  ]);

  const prepared = prepareMixamoAnimationClip(clip, scene);

  expect(prepared.tracks[0].name).toBe("mixamorig:Hips.position");
  expect(Array.from(prepared.tracks[0].values)).toEqual([0, 96, 0, 0, 106, 0]);
});

it("applies animation deltas on top of each model's own bone rest rotation", () => {
  const sourceScene = new Group();
  const sourceArm = new Bone();
  sourceArm.name = "mixamorigLeftArm";
  sourceScene.add(sourceArm);

  const targetScene = new Group();
  const targetArm = new Bone();
  targetArm.name = "mixamorig:LeftArm";
  targetArm.quaternion.setFromEuler(new Euler(0, 0, Math.PI / 2));
  targetScene.add(targetArm);

  const animatedRotation = new Quaternion().setFromEuler(new Euler(Math.PI / 4, 0, 0));
  const clip = new AnimationClip("wave", 1, [
    new QuaternionKeyframeTrack(
      "mixamorigLeftArm.quaternion",
      [0, 1],
      [0, 0, 0, 1, ...animatedRotation.toArray()]
    ),
  ]);

  const prepared = prepareMixamoAnimationClip(clip, targetScene, sourceScene, "local-rest");
  const values = Array.from(prepared.tracks[0].values);
  const expectedStart = targetArm.quaternion.toArray();
  const expectedEnd = targetArm.quaternion.clone().multiply(animatedRotation).toArray();

  expect(prepared.tracks[0].name).toBe("mixamorig:LeftArm.quaternion");
  expect(values.slice(0, 4)).toEqual(expect.arrayContaining(expectedStart.map((value) => expect.closeTo(value, 5))));
  expect(values.slice(4, 8)).toEqual(expect.arrayContaining(expectedEnd.map((value) => expect.closeTo(value, 5))));
});

it("restores the complete immutable character rest transform after animation sampling", () => {
  const scene = new Group();
  const hips = new Bone();
  hips.name = "mixamorigHips";
  hips.position.set(1, 2, 3);
  hips.quaternion.setFromEuler(new Euler(0.1, 0.2, 0.3));
  hips.scale.set(1.1, 0.9, 1.2);
  scene.add(hips);
  const restPose = captureCharacterRestPose(scene);
  const expectedPosition = hips.position.toArray();
  const expectedQuaternion = hips.quaternion.toArray();
  const expectedScale = hips.scale.toArray();

  hips.position.set(9, 8, 7);
  hips.quaternion.setFromEuler(new Euler(1, 1, 1));
  hips.scale.set(2, 3, 4);
  applyCharacterRestPose(scene, restPose);

  expectTupleClose(hips.position.toArray(), expectedPosition);
  expectTupleClose(hips.quaternion.toArray(), expectedQuaternion);
  expectTupleClose(hips.scale.toArray(), expectedScale);
});

it("prepares the same action from the stored rest pose after another canvas has posed the rig", () => {
  const sourceScene = new Group();
  const sourceArm = new Bone();
  sourceArm.name = "mixamorigLeftArm";
  sourceScene.add(sourceArm);
  const sourceRestPose = captureCharacterRestPose(sourceScene);

  const targetScene = new Group();
  const targetArm = new Bone();
  targetArm.name = "mixamorig:LeftArm";
  targetArm.quaternion.setFromEuler(new Euler(0, 0, Math.PI / 2));
  targetScene.add(targetArm);
  const targetRestPose = captureCharacterRestPose(targetScene);
  const expectedStart = targetArm.quaternion.toArray();

  const animatedRotation = new Quaternion().setFromEuler(new Euler(Math.PI / 4, 0, 0));
  const clip = new AnimationClip("wave", 1, [
    new QuaternionKeyframeTrack(
      "mixamorigLeftArm.quaternion",
      [0, 1],
      [0, 0, 0, 1, ...animatedRotation.toArray()]
    ),
  ]);

  targetArm.quaternion.setFromEuler(new Euler(0.8, -0.4, 0.2));
  sourceArm.quaternion.setFromEuler(new Euler(-0.5, 0.7, 0.3));

  const prepared = prepareMixamoAnimationClip(
    clip,
    targetScene,
    sourceScene,
    "local-rest",
    targetRestPose,
    sourceRestPose
  );
  const values = Array.from(prepared.tracks[0].values);
  const expectedEnd = new Quaternion().fromArray(expectedStart).multiply(animatedRotation).toArray();

  expectTupleClose(values.slice(0, 4), expectedStart);
  expectTupleClose(values.slice(4, 8), expectedEnd);
});
