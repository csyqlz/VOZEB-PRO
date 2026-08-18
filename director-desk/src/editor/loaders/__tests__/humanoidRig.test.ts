import { detectHumanoidRig } from "../humanoidRig";

it("recognizes a Mixamo-style humanoid skeleton", () => {
  expect(
    detectHumanoidRig(["Hips", "Spine", "Head", "LeftArm", "RightArm", "LeftUpLeg", "RightUpLeg"])
  ).toBe("mixamo");
});
