import { isCompleteDirectorCharacterBoneMap } from "../semanticBody";

it("requires every main body part to map to a distinct bone", () => {
  const complete = {
    head: "head", chest: "chest", waist: "hips",
    leftUpperArm: "leftUpperArm", leftForearm: "leftForearm", leftHand: "leftHand",
    rightUpperArm: "rightUpperArm", rightForearm: "rightForearm", rightHand: "rightHand",
    leftThigh: "leftThigh", leftCalf: "leftCalf", leftFoot: "leftFoot",
    rightThigh: "rightThigh", rightCalf: "rightCalf", rightFoot: "rightFoot",
  };

  expect(isCompleteDirectorCharacterBoneMap(complete)).toBe(true);
  expect(isCompleteDirectorCharacterBoneMap({ ...complete, rightHand: "leftHand" })).toBe(false);
});
