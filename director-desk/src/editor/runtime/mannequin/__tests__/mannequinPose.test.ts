import { degreesToRadians, getBodyTypePoseLimit, getRotationFromControls } from "../mannequinPose";

it("converts degrees to radians", () => {
  expect(degreesToRadians(180)).toBeCloseTo(Math.PI);
  expect(degreesToRadians(90)).toBeCloseTo(Math.PI / 2);
});

it("returns r3f rotation tuples from control values", () => {
  expect(
    getRotationFromControls(
      {
        "head.pitch": 10,
        "head.yaw": 20,
        "head.roll": -30,
      },
      "head"
    )
  ).toEqual([degreesToRadians(10), degreesToRadians(20), degreesToRadians(-30)]);
});

it("uses stricter pose limits for child and chibi body types", () => {
  expect(getBodyTypePoseLimit("mannequin")).toBe(90);
  expect(getBodyTypePoseLimit("child")).toBe(72);
  expect(getBodyTypePoseLimit("chibi")).toBe(58);
});

it("clamps rotations for compact body types", () => {
  expect(getRotationFromControls({ "body.pitch": 90 }, "body", "chibi")[0]).toBeCloseTo(degreesToRadians(58));
  expect(getRotationFromControls({ "body.pitch": -90 }, "body", "child")[0]).toBeCloseTo(degreesToRadians(-72));
});
