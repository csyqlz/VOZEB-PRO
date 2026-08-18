import { render } from "@testing-library/react";
import { BODY_TYPE_OPTIONS } from "../mannequin/bodyTypes";
import { PrimitiveMannequin } from "../PrimitiveMannequin";

it("renders a segmented humanoid mannequin with r3f-safe scene node names", () => {
  const { container } = render(<PrimitiveMannequin />);

  expect(container.querySelectorAll("[data-testid]")).toHaveLength(0);

  [
    "humanoid-head",
    "humanoid-neck",
    "humanoid-chest",
    "humanoid-abdomen",
    "humanoid-pelvis",
    "humanoid-left-hand",
    "humanoid-right-hand",
    "humanoid-left-foot",
    "humanoid-right-foot",
  ].forEach((partId) => {
    expect(container.querySelector(`mesh[name="${partId}"]`)).toBeInTheDocument();
  });

  expect(container.querySelectorAll('mesh[name="humanoid-joint"]')).toHaveLength(12);
});

it("renders every approved procedural body type safely", () => {
  BODY_TYPE_OPTIONS.forEach((option) => {
    const { container, unmount } = render(<PrimitiveMannequin bodyType={option.bodyType} />);

    expect(container.querySelectorAll("[data-testid]")).toHaveLength(0);
    expect(container.querySelector(`group[name="procedural-${option.bodyType}"]`)).toBeInTheDocument();
    expect(container.querySelector('mesh[name="humanoid-head"]')).toBeInTheDocument();

    unmount();
  });
});

it("applies existing rig controls to compact body types without unsafe attributes", () => {
  const { container } = render(
    <PrimitiveMannequin
      bodyType="chibi"
      rigState={{
        rigType: "mannequin",
        posePresetId: "wave",
        controls: {
          "head.yaw": 18,
          "rightElbow.bend": 60,
          "rightShoulder.pitch": 54,
        },
      }}
    />
  );

  expect(container.querySelectorAll("[data-testid]")).toHaveLength(0);
  expect(container.querySelector('group[name="procedural-chibi"]')).toBeInTheDocument();
  expect(container.querySelector('mesh[name="humanoid-right-hand"]')).toBeInTheDocument();
});

it("renders reference-style facial and mannequin seam details", () => {
  const { container } = render(<PrimitiveMannequin bodyType="female" />);

  [
    "humanoid-left-eye",
    "humanoid-right-eye",
    "humanoid-nose",
    "humanoid-mouth",
    "humanoid-chest-seam",
    "humanoid-waist-seam",
    "humanoid-left-thumb",
    "humanoid-right-thumb",
    "humanoid-left-toe-cap",
    "humanoid-right-toe-cap",
  ].forEach((partId) => {
    expect(container.querySelector(`mesh[name="${partId}"]`)).toBeInTheDocument();
  });
});
