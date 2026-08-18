import { Bone, Euler, Group, Quaternion } from "three";
import {
  applyUE4RestPoseAndRig,
  captureUE4RestPose,
} from "../ue4MannequinPoseApplication";
import { getUE4NeutralPoseBoneRotations, getUE4PoseBoneRotations } from "../ue4MannequinRig";

function expectQuaternionClose(actual: Quaternion, expected: Quaternion) {
  expect(actual.angleTo(expected)).toBeLessThan(0.000001);
}

function quaternionFromRotation(rotation: [number, number, number]) {
  return new Quaternion().setFromEuler(new Euler(rotation[0], rotation[1], rotation[2]));
}

it("restores a retopology bone's bind quaternion before applying body scales", () => {
  const scene = new Group();
  const spine = new Bone();
  spine.name = "Bip001_Spine1_05";
  spine.rotation.set(0.1, 0.2, 0.3);
  spine.scale.set(1.2, 1.1, 0.9);
  scene.add(spine);

  const restPose = captureUE4RestPose(scene);
  const neutral = getUE4NeutralPoseBoneRotations();
  const restQuaternion = spine.quaternion.clone();
  const expected = restQuaternion.clone();
  const neutralRotation = neutral.Bip001_Spine1_05;
  if (neutralRotation) {
    expected.multiply(quaternionFromRotation(neutralRotation));
  }

  spine.rotation.set(0, 0, 0);
  spine.scale.set(9, 9, 9);

  applyUE4RestPoseAndRig(scene, {
    bodyType: "mannequin",
    controls: {},
    restPose,
  });

  expectQuaternionClose(spine.quaternion, expected);
  expect(spine.scale.x).toBeCloseTo(1.2);
  expect(spine.scale.y).toBeCloseTo(1.1 * 1.02);
  expect(spine.scale.z).toBeCloseTo(0.9 * 1.02);
});

it("applies pose controls as offsets on top of the bind quaternion", () => {
  const scene = new Group();
  const head = new Bone();
  head.name = "Bip001_Head_055";
  head.rotation.set(0.2, -0.15, 0.08);
  scene.add(head);

  const restPose = captureUE4RestPose(scene);
  const neutral = getUE4NeutralPoseBoneRotations();
  const pose = getUE4PoseBoneRotations({ "head.yaw": 20 }, "mannequin");
  const expected = head.quaternion.clone();
  const neutralRotation = neutral.Bip001_Head_055;
  if (neutralRotation) {
    expected.multiply(quaternionFromRotation(neutralRotation));
  }
  expected.multiply(quaternionFromRotation(pose.Bip001_Head_055));

  applyUE4RestPoseAndRig(scene, {
    bodyType: "mannequin",
    controls: {
      "head.yaw": 20,
    },
    restPose,
  });

  expectQuaternionClose(head.quaternion, expected);
});

it("applies body vertical offset through the retopology pelvis local axis", () => {
  const scene = new Group();
  const pelvis = new Bone();
  pelvis.name = "Bip001_Pelvis_03";
  pelvis.position.set(1, 2, 3);
  scene.add(pelvis);

  const restPose = captureUE4RestPose(scene);

  applyUE4RestPoseAndRig(scene, {
    bodyType: "mannequin",
    controls: {
      "body.offsetY": -0.22,
    },
    restPose,
  });

  expect(pelvis.position.x).toBeCloseTo(1);
  expect(pelvis.position.y).toBeCloseTo(2);
  expect(pelvis.position.z).toBeCloseTo(3 - 0.22 / 0.0254);
});

it("applies the retopology neutral stance correction when no user pose controls are active", () => {
  const scene = new Group();
  const leftUpperArm = new Bone();
  const leftForearm = new Bone();
  leftUpperArm.name = "Bip001_L_UpperArm_08";
  leftForearm.name = "Bip001_L_Forearm_09";
  leftUpperArm.rotation.set(-0.24, 0.36, 0.12);
  leftForearm.rotation.set(0.1, -0.2, 0.3);
  scene.add(leftUpperArm);
  leftUpperArm.add(leftForearm);

  const restPose = captureUE4RestPose(scene);
  const neutral = getUE4NeutralPoseBoneRotations();
  const expectedUpperArm = leftUpperArm.quaternion
    .clone()
    .multiply(quaternionFromRotation(neutral.Bip001_L_UpperArm_08));
  const expectedForearm = leftForearm.quaternion
    .clone()
    .multiply(quaternionFromRotation(neutral.Bip001_L_Forearm_09));

  applyUE4RestPoseAndRig(scene, {
    bodyType: "mannequin",
    controls: {},
    restPose,
  });

  expectQuaternionClose(leftUpperArm.quaternion, expectedUpperArm);
  expectQuaternionClose(leftForearm.quaternion, expectedForearm);
});

it("does not accumulate pose offsets when controls are applied repeatedly", () => {
  const scene = new Group();
  const leftArm = new Bone();
  leftArm.name = "Bip001_L_UpperArm_08";
  leftArm.rotation.set(-0.4, 0.65, 0.18);
  scene.add(leftArm);

  const restPose = captureUE4RestPose(scene);
  const neutral = getUE4NeutralPoseBoneRotations();
  const firstPose = getUE4PoseBoneRotations(
    {
      "leftShoulder.pitch": 18,
      "leftShoulder.spread": -12,
    },
    "mannequin"
  );
  const secondPose = getUE4PoseBoneRotations(
    {
      "leftShoulder.pitch": -8,
      "leftShoulder.spread": 6,
    },
    "mannequin"
  );
  const expectedFirstPose = leftArm.quaternion
    .clone()
    .multiply(quaternionFromRotation(neutral.Bip001_L_UpperArm_08))
    .multiply(quaternionFromRotation(firstPose.Bip001_L_UpperArm_08));
  const expectedSecondPose = leftArm.quaternion
    .clone()
    .multiply(quaternionFromRotation(neutral.Bip001_L_UpperArm_08))
    .multiply(quaternionFromRotation(secondPose.Bip001_L_UpperArm_08));

  applyUE4RestPoseAndRig(scene, {
    bodyType: "mannequin",
    controls: {
      "leftShoulder.pitch": 18,
      "leftShoulder.spread": -12,
    },
    restPose,
  });
  applyUE4RestPoseAndRig(scene, {
    bodyType: "mannequin",
    controls: {
      "leftShoulder.pitch": -8,
      "leftShoulder.spread": 6,
    },
    restPose,
  });

  expectQuaternionClose(leftArm.quaternion, expectedSecondPose);
  expect(leftArm.quaternion.angleTo(expectedFirstPose)).toBeGreaterThan(0.1);
});
