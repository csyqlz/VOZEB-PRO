import { MANNEQUIN_POSE_PRESETS } from "../mannequinPosePresets";

it("exports the approved 20 pose presets", () => {
  expect(MANNEQUIN_POSE_PRESETS.map((item) => item.label)).toEqual([
    "站立",
    "T型",
    "行走",
    "跑步",
    "坐姿",
    "蹲下",
    "单膝跪",
    "双膝跪",
    "叉腰",
    "倚靠",
    "鞠躬",
    "思考",
    "格斗",
    "踢球",
    "投掷",
    "推进",
    "招手",
    "伸手",
    "抱臂",
    "看手机",
  ]);
});

it("calibrates the T-pose for the retopology mannequin side plane", () => {
  const tPose = MANNEQUIN_POSE_PRESETS.find((item) => item.id === "t-pose");

  expect(tPose?.controls).toEqual({
    "leftShoulder.spread": -70,
    "rightShoulder.spread": 70,
    "leftShoulder.pitch": 15,
    "rightShoulder.pitch": 15,
    "leftElbow.bend": 10,
    "rightElbow.bend": 10,
  });
});

it("calibrates crouch as a seated squat with forward torso and hands near the knees", () => {
  const crouch = MANNEQUIN_POSE_PRESETS.find((item) => item.id === "crouch");

  expect(crouch?.controls).toMatchObject({
    "body.offsetY": -0.43,
    "body.pitch": -26,
    "torso.pitch": -24,
    "head.pitch": 22,
    "leftHip.pitch": 92,
    "rightHip.pitch": 92,
    "leftKnee.bend": 112,
    "rightKnee.bend": 112,
    "leftShoulder.pitch": 52,
    "rightShoulder.pitch": 50,
    "leftShoulder.spread": -10,
    "rightShoulder.spread": 10,
    "leftElbow.bend": 80,
    "rightElbow.bend": 76,
  });
});

it("calibrates one-knee kneel with a visibly curved left arm resting by the front knee", () => {
  const kneel = MANNEQUIN_POSE_PRESETS.find((item) => item.id === "kneel-one");

  expect(kneel?.controls).toMatchObject({
    "body.offsetY": -0.42,
    "body.pitch": -16,
    "torso.pitch": -10,
    "head.pitch": 12,
    "leftHip.pitch": 68,
    "leftKnee.bend": 86,
    "leftFoot.pitch": 20,
    "rightHip.pitch": -15,
    "rightKnee.bend": 80,
    "rightFoot.pitch": 60,
    "leftShoulder.pitch": 5,
    "leftShoulder.spread": 10,
    "leftShoulder.twist": -10,
    "leftElbow.bend": 30,
    "rightShoulder.pitch": -18,
    "rightShoulder.spread": 10,
    "rightElbow.bend": 18,
  });
});

it("calibrates two-knee kneel as an upright kneeling pose with folded calves and relaxed arms", () => {
  const kneel = MANNEQUIN_POSE_PRESETS.find((item) => item.id === "kneel-two");

  expect(kneel?.controls).toMatchObject({
    "body.offsetY": -0.4,
    "body.pitch": 2,
    "torso.pitch": 8,
    "head.pitch": -2,
    "leftShoulder.pitch": -10,
    "rightShoulder.pitch": -10,
    "leftShoulder.spread": -5,
    "rightShoulder.spread": 5,
    "leftElbow.bend": 8,
    "rightElbow.bend": 8,
    "leftHip.pitch": -8,
    "rightHip.pitch": -8,
    "leftKnee.bend": 126,
    "rightKnee.bend": 126,
    "leftFoot.pitch": -20,
    "rightFoot.pitch": -20,
  });
});

it("calibrates hands-on-hips with elbows outside and palms resting along the waist", () => {
  const pose = MANNEQUIN_POSE_PRESETS.find((item) => item.id === "hands-on-hips");

  expect(pose?.controls).toMatchObject({
    "leftShoulder.pitch": -36,
    "rightShoulder.pitch": -36,
    "leftShoulder.spread": 0,
    "rightShoulder.spread": 0,
    "leftShoulder.twist": 80,
    "rightShoulder.twist": -80,
    "leftElbow.bend": 86,
    "rightElbow.bend": 86,
    "leftHand.roll": -35,
    "rightHand.roll": 35,
  });
});

it("calibrates bow as a straight-legged forward bend with relaxed arms beside the thighs", () => {
  const pose = MANNEQUIN_POSE_PRESETS.find((item) => item.id === "bow");

  expect(pose?.controls).toMatchObject({
    "body.pitch": -46,
    "torso.pitch": -10,
    "head.pitch": 20,
    "leftHip.pitch": 49,
    "rightHip.pitch": 49,
    "leftShoulder.pitch": 5,
    "rightShoulder.pitch": 5,
    "leftShoulder.spread": 10,
    "rightShoulder.spread": -10,
    "leftElbow.bend": 12,
    "rightElbow.bend": 12,
  });
  expect(pose?.controls["leftKnee.bend"] ?? 0).toBe(0);
  expect(pose?.controls["rightKnee.bend"] ?? 0).toBe(0);
});

it("calibrates think with the right hand at the chin and the support arm folded across the torso", () => {
  const pose = MANNEQUIN_POSE_PRESETS.find((item) => item.id === "think");

  expect(pose?.controls).toMatchObject({
    "rightShoulder.pitch": 8,
    "rightShoulder.spread": 0,
    "rightShoulder.twist": -40,
    "rightElbow.bend": 90,
    "rightHand.roll": -40,
    "rightHand.pitch": 15,
    "rightHand.twist": -10,
    "leftShoulder.pitch": 8,
    "leftShoulder.spread": 0,
    "leftShoulder.twist": 40,
    "leftElbow.bend": 90,
  });
  expect(pose?.controls["head.yaw"] ?? 0).toBe(0);
  expect(pose?.controls["head.roll"] ?? 0).toBe(0);
});

it("calibrates fight as a wide guarded stance with both hands raised near the chest", () => {
  const pose = MANNEQUIN_POSE_PRESETS.find((item) => item.id === "fight");

  expect(pose?.controls).toMatchObject({
    "body.yaw": -10,
    "body.pitch": 5,
    "torso.yaw": 8,
    "head.yaw": 8,
    "leftShoulder.pitch": 48,
    "leftShoulder.spread": -16,
    "leftShoulder.twist": 22,
    "rightShoulder.pitch": 30,
    "rightShoulder.spread": 0,
    "rightShoulder.twist": -22,
    "leftElbow.bend": 86,
    "rightElbow.bend": 84,
    "leftHip.spread": -18,
    "rightHip.spread": 22,
    "leftHip.pitch": 4,
    "rightHip.pitch": -6,
    "leftKnee.bend": 12,
    "rightKnee.bend": 18,
  });
});

it("calibrates throw as a dynamic wind-up with the throwing hand beside the head", () => {
  const pose = MANNEQUIN_POSE_PRESETS.find((item) => item.id === "throw");

  expect(pose?.controls).toMatchObject({
    "body.offsetY": -0.12,
    "body.pitch": 5,
    "body.yaw": 14,
    "torso.yaw": -10,
    "head.yaw": 8,
    "rightShoulder.pitch": 76,
    "rightShoulder.spread": -14,
    "rightShoulder.twist": 28,
    "rightElbow.bend": 86,
    "rightHand.roll": 18,
    "rightHand.pitch": -12,
    "leftShoulder.pitch": 34,
    "leftShoulder.spread": 10,
    "leftShoulder.twist": 8,
    "leftElbow.bend": 54,
    "leftHand.pitch": -10,
    "leftHip.spread": -12,
    "rightHip.spread": 18,
    "leftHip.pitch": 24,
    "rightHip.pitch": -10,
    "leftKnee.bend": 30,
    "rightKnee.bend": 14,
    "leftFoot.pitch": -8,
    "rightFoot.roll": 6,
  });
});

it("calibrates push as a low forward drive with both arms extended", () => {
  const pose = MANNEQUIN_POSE_PRESETS.find((item) => item.id === "push");

  expect(pose?.controls).toMatchObject({
    "body.offsetY": -0.16,
    "body.pitch": 5,
    "body.yaw": 38,
    "torso.pitch": -4,
    "head.pitch": 6,
    "leftShoulder.pitch": 92,
    "rightShoulder.pitch": 92,
    "leftShoulder.spread": -11,
    "rightShoulder.spread": 11,
    "leftShoulder.twist": 6,
    "rightShoulder.twist": -6,
    "leftElbow.bend": 6,
    "rightElbow.bend": 6,
    "leftHand.pitch": -14,
    "rightHand.pitch": -14,
    "leftHip.spread": -12,
    "rightHip.spread": 14,
    "leftHip.pitch": 38,
    "rightHip.pitch": -20,
    "leftKnee.bend": 42,
    "rightKnee.bend": 20,
    "leftFoot.pitch": -6,
    "rightFoot.roll": 8,
  });
});

it("calibrates wave with the right hand raised beside the head and the left arm relaxed", () => {
  const pose = MANNEQUIN_POSE_PRESETS.find((item) => item.id === "wave");

  expect(pose?.controls).toMatchObject({
    "rightShoulder.pitch": 60,
    "rightShoulder.spread": 0,
    "rightShoulder.twist": 30,
    "rightElbow.bend": 90,
    "rightHand.roll": -20,
    "rightHand.pitch": 12,
    "rightHand.twist": 10,
    "leftShoulder.pitch": -10,
    "leftShoulder.spread": 8,
    "leftElbow.bend": 18,
    "leftHand.pitch": -8,
  });
});

it("calibrates cross-arms as a closed chest-level arm fold", () => {
  const pose = MANNEQUIN_POSE_PRESETS.find((item) => item.id === "cross-arms");

  expect(pose?.controls).toMatchObject({
    "leftShoulder.pitch": 50,
    "leftShoulder.spread": -55,
    "leftShoulder.twist": 75,
    "leftElbow.bend": 50,
    "leftHand.roll": 0,
    "leftHand.pitch": -10,
    "rightShoulder.pitch": 90,
    "rightShoulder.spread": 55,
    "rightShoulder.twist": -45,
    "rightElbow.bend": 50,
    "rightHand.roll": 18,
    "rightHand.pitch": -10,
  });
});

it("calibrates phone as a right-hand phone viewing pose with the left arm relaxed", () => {
  const pose = MANNEQUIN_POSE_PRESETS.find((item) => item.id === "phone");

  expect(pose?.controls).toMatchObject({
    "head.pitch": 18,
    "rightShoulder.pitch": 20,
    "rightShoulder.spread": -4,
    "rightShoulder.twist": -30,
    "rightElbow.bend": 82,
    "rightHand.roll": -30,
    "rightHand.pitch": 14,
    "rightHand.twist": 60,
    "leftShoulder.pitch": -10,
    "leftShoulder.spread": 8,
    "leftElbow.bend": 16,
    "leftHand.pitch": -8,
  });
});
