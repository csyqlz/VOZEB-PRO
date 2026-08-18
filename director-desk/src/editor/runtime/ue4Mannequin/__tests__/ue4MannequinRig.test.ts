import {
  UE4_MANNEQUIN_BONE_MAP,
  UE4_MANNEQUIN_MODEL_URL,
  getUE4GroundedLabelY,
  getUE4BodyBoneScales,
  getUE4ModelScale,
  getUE4NeutralPoseBoneRotations,
  getUE4PoseBoneRotations,
  resolveDirectorAssetUrl,
} from "../ue4MannequinRig";

it("points to the built-in rigged GLB asset", () => {
  expect(UE4_MANNEQUIN_MODEL_URL).toBe(resolveDirectorAssetUrl(import.meta.env.BASE_URL, "models/ue-mannequin-retopology.glb"));
});

it("resolves the built-in rigged GLB below the embedded director desk base path", () => {
  expect(resolveDirectorAssetUrl("/director-desk/", "models/ue-mannequin-retopology.glb")).toBe(
    "/director-desk/models/ue-mannequin-retopology.glb"
  );
  expect(resolveDirectorAssetUrl("./", "models/ue-mannequin-retopology.glb")).toBe(
    "./models/ue-mannequin-retopology.glb"
  );
});

it("defines the core retopology mannequin bones used by body shapes and pose presets", () => {
  expect(UE4_MANNEQUIN_BONE_MAP).toMatchObject({
    body: "Bip001_Pelvis_03",
    torso: "Bip001_Spine1_05",
    head: "Bip001_Head_055",
    leftShoulder: "Bip001_L_UpperArm_08",
    rightShoulder: "Bip001_R_UpperArm_032",
    leftElbow: "Bip001_L_Forearm_09",
    rightElbow: "Bip001_R_Forearm_033",
    leftHand: "Bip001_L_Hand_010",
    rightHand: "Bip001_R_Hand_034",
    leftHip: "Bip001_L_Thigh_057",
    rightHip: "Bip001_R_Thigh_061",
    leftKnee: "Bip001_L_Calf_058",
    rightKnee: "Bip001_R_Calf_062",
    leftFoot: "Bip001_L_Foot_059",
    rightFoot: "Bip001_R_Foot_063",
  });
});

it("derives visible body silhouettes from one rigged mannequin", () => {
  const adult = getUE4BodyBoneScales("mannequin");
  const female = getUE4BodyBoneScales("female");
  const child = getUE4BodyBoneScales("child");
  const chibi = getUE4BodyBoneScales("chibi");

  expect(adult.Bip001_Spine1_05[1]).toBeGreaterThan(female.Bip001_Spine1_05[1]);
  expect(female.Bip001_Pelvis_03[1]).toBeGreaterThan(adult.Bip001_Pelvis_03[1]);
  expect(child.Bip001_Head_055[0]).toBeGreaterThan(adult.Bip001_Head_055[0]);
  expect(chibi.Bip001_Head_055[0]).toBeGreaterThan(child.Bip001_Head_055[0]);
  expect(getUE4ModelScale("chibi")[1]).toBeLessThan(getUE4ModelScale("mannequin")[1]);
});

it("counter-scales chibi hands so the shortened forearms still leave visible palms", () => {
  const chibi = getUE4BodyBoneScales("chibi");

  expect(chibi.Bip001_L_Hand_010).toEqual(chibi.Bip001_R_Hand_034);
  expect(chibi.Bip001_L_Hand_010[0]).toBeGreaterThan(1.2);
  expect(chibi.Bip001_L_Forearm_09[0] * chibi.Bip001_L_Hand_010[0]).toBeGreaterThanOrEqual(0.88);
  expect(chibi.Bip001_L_Forearm_09[1] * chibi.Bip001_L_Hand_010[1]).toBeGreaterThanOrEqual(0.9);
  expect(chibi.Bip001_L_Forearm_09[2] * chibi.Bip001_L_Hand_010[2]).toBeGreaterThanOrEqual(0.9);
});

it("keeps chibi shoulder anchors outside the rounded torso so hands are not hidden", () => {
  const chibi = getUE4BodyBoneScales("chibi");

  expect(chibi.Bip001_L_Clavicle_07).toEqual(chibi.Bip001_R_Clavicle_031);
  expect(chibi.Bip001_L_Clavicle_07[0]).toBeGreaterThanOrEqual(chibi.Bip001_Pelvis_03[1]);
});

it("keeps the retopology mannequin adult arms at the authored natural length", () => {
  const adult = getUE4BodyBoneScales("mannequin");
  const broad = getUE4BodyBoneScales("broad");
  const muscular = getUE4BodyBoneScales("muscular");

  expect(adult.Bip001_L_UpperArm_08[0]).toBeCloseTo(1);
  expect(adult.Bip001_R_UpperArm_032[0]).toBeCloseTo(1);
  expect(adult.Bip001_L_Forearm_09[0]).toBeCloseTo(1);
  expect(adult.Bip001_R_Forearm_033[0]).toBeCloseTo(1);
  expect(broad.Bip001_L_UpperArm_08[0]).toBeCloseTo(1);
  expect(muscular.Bip001_L_UpperArm_08[0]).toBeCloseTo(1);
});

it("keeps role labels above the retopology GLB body", () => {
  expect(getUE4GroundedLabelY("mannequin")).toBeGreaterThan(1.8);
  expect(getUE4GroundedLabelY("mannequin")).toBeLessThan(2.3);
  expect(getUE4GroundedLabelY("teen")).toBeLessThan(getUE4GroundedLabelY("mannequin"));
  expect(getUE4GroundedLabelY("chibi")).toBeLessThan(getUE4GroundedLabelY("child"));
});

it("maps existing director pose controls to retopology Bip001 bone rotations", () => {
  const rotations = getUE4PoseBoneRotations(
    {
      "body.pitch": -30,
      "torso.pitch": -18,
      "head.pitch": 18,
      "head.yaw": 20,
      "rightShoulder.pitch": 56,
      "leftShoulder.spread": -30,
      "rightShoulder.spread": 30,
      "rightElbow.bend": 80,
      "leftHip.pitch": -18,
      "rightHip.pitch": 24,
      "leftHip.spread": -12,
      "rightHip.spread": 12,
      "rightKnee.bend": 42,
    },
    "mannequin"
  );

  expect(rotations.Bip001_Head_055[0]).toBeGreaterThan(0);
  expect(rotations.Bip001_Head_055[2]).toBeGreaterThan(0);
  expect(rotations.Bip001_Pelvis_03[2]).toBeGreaterThan(0);
  expect(rotations.Bip001_Spine1_05[2]).toBeGreaterThan(0);
  expect(rotations.Bip001_R_UpperArm_032[2]).toBeLessThan(0);
  expect(rotations.Bip001_L_UpperArm_08[1]).toBeLessThan(0);
  expect(rotations.Bip001_R_UpperArm_032[1]).toBeGreaterThan(0);
  expect(rotations.Bip001_R_Forearm_033[0]).toBeCloseTo(0);
  expect(rotations.Bip001_R_Forearm_033[2]).toBeLessThan(0);
  expect(rotations.Bip001_L_Thigh_057[2]).toBeLessThan(0);
  expect(rotations.Bip001_R_Thigh_061[2]).toBeGreaterThan(0);
  expect(rotations.Bip001_L_Thigh_057[1]).toBeGreaterThan(0);
  expect(rotations.Bip001_R_Thigh_061[1]).toBeLessThan(0);
  expect(rotations.Bip001_R_Calf_062[0]).toBeCloseTo(0);
  expect(rotations.Bip001_R_Calf_062[2]).toBeLessThan(0);
});

it("maps foot pitch controls for grounded kneel and lunge poses", () => {
  const rotations = getUE4PoseBoneRotations(
    {
      "leftFoot.pitch": 58,
      "rightFoot.pitch": 45,
    },
    "mannequin"
  );

  expect(rotations.Bip001_L_Foot_059[2]).toBeCloseTo((58 * Math.PI) / 180);
  expect(rotations.Bip001_R_Foot_063[2]).toBeCloseTo((45 * Math.PI) / 180);
});

it("maps hand roll controls so pose presets can orient palms without changing the arm IK target", () => {
  const rotations = getUE4PoseBoneRotations(
    {
      "leftHand.roll": -35,
      "rightHand.roll": 35,
    },
    "mannequin"
  );

  expect(rotations.Bip001_L_Hand_010[1]).toBeCloseTo((-35 * Math.PI) / 180);
  expect(rotations.Bip001_R_Hand_034[1]).toBeCloseTo((35 * Math.PI) / 180);
});

it("maps T-pose arm spread so both retopology arms open outward", () => {
  const rotations = getUE4PoseBoneRotations(
    {
      "leftShoulder.spread": -90,
      "rightShoulder.spread": 90,
    },
    "mannequin"
  );

  expect(rotations.Bip001_L_UpperArm_08[1]).toBeLessThan(0);
  expect(rotations.Bip001_R_UpperArm_032[1]).toBeGreaterThan(0);
});

it("calibrates the retopology neutral stance so both hands hang beside the thighs", () => {
  const rotations = getUE4NeutralPoseBoneRotations();

  expect(rotations.Bip001_L_UpperArm_08).toEqual([0, (25 * Math.PI) / 180, 0]);
  expect(rotations.Bip001_R_UpperArm_032).toEqual([0, (-25 * Math.PI) / 180, 0]);
  expect(rotations.Bip001_L_Forearm_09).toEqual([0, 0, (25 * Math.PI) / 180]);
  expect(rotations.Bip001_R_Forearm_033).toEqual([0, 0, (25 * Math.PI) / 180]);
});
