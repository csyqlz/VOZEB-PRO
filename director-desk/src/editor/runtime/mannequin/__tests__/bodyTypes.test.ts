import {
  BODY_TYPE_OPTIONS,
  CHARACTER_BODY_PRESETS,
  DEFAULT_CHARACTER_BODY_TYPE,
  getBodyPreset,
  getGroundedLabelY,
  normalizeBodyType,
} from "../bodyTypes";

it("defines the approved LibTV-style procedural body types", () => {
  expect(BODY_TYPE_OPTIONS.map((item) => item.bodyType)).toEqual([
    "mannequin",
    "female",
    "broad",
    "muscular",
    "slim",
    "teen",
    "child",
    "chibi",
  ]);

  expect(BODY_TYPE_OPTIONS.map((item) => item.label)).toEqual([
    "男性素体",
    "女性素体",
    "宽厚素体",
    "健壮素体",
    "纤细素体",
    "少年素体",
    "儿童素体",
    "二头身",
  ]);
});

it("keeps every body preset complete and renderable", () => {
  CHARACTER_BODY_PRESETS.forEach((preset) => {
    expect(preset.bodyType).toBeTruthy();
    expect(preset.label).toBeTruthy();
    expect(preset.defaultScale).toHaveLength(3);
    expect(preset.labelAnchorY).toBeGreaterThan(0);
    expect(preset.proportions.hipY).toBeGreaterThan(0);
    expect(preset.proportions.headRadius).toBeGreaterThan(0);
    expect(preset.proportions.upperArmLength).toBeGreaterThan(0);
    expect(preset.proportions.calfLength).toBeGreaterThan(0);
    expect(preset.proportions.jointRadiusScale).toBeGreaterThan(0);
    expect(preset.proportions.torsoUpperScale).toHaveLength(3);
    expect(preset.proportions.torsoLowerScale).toHaveLength(3);
    expect(preset.proportions.eyeRadius).toBeGreaterThan(0);
    expect(preset.proportions.noseScale).toHaveLength(3);
    expect(preset.proportions.mouthScale).toHaveLength(3);
  });
});

it("normalizes missing or unknown body types to the default mannequin", () => {
  expect(DEFAULT_CHARACTER_BODY_TYPE).toBe("mannequin");
  expect(normalizeBodyType()).toBe("mannequin");
  expect(normalizeBodyType("unknown")).toBe("mannequin");
  expect(normalizeBodyType("female")).toBe("female");
});

it("expresses the expected visible size relationships", () => {
  const adult = getBodyPreset("mannequin");
  const teen = getBodyPreset("teen");
  const child = getBodyPreset("child");
  const chibi = getBodyPreset("chibi");

  expect(teen.labelAnchorY).toBeLessThan(adult.labelAnchorY);
  expect(child.labelAnchorY).toBeLessThan(teen.labelAnchorY);
  expect(chibi.proportions.headRadius).toBeGreaterThan(child.proportions.headRadius);
  expect(chibi.proportions.thighLength).toBeLessThan(child.proportions.thighLength);
  expect(getGroundedLabelY("chibi")).toBe(chibi.labelAnchorY);
});

it("matches the reference lineup silhouettes for the five core character types", () => {
  const man = getBodyPreset("mannequin").proportions;
  const woman = getBodyPreset("female").proportions;
  const teen = getBodyPreset("teen").proportions;
  const child = getBodyPreset("child").proportions;
  const chibi = getBodyPreset("chibi").proportions;

  expect(man.shoulderWidth).toBeGreaterThan(woman.shoulderWidth);
  expect(woman.pelvisScale[0]).toBeGreaterThan(man.pelvisScale[0]);
  expect(teen.shoulderWidth).toBeLessThan(woman.shoulderWidth);
  expect(child.headRadius / child.hipY).toBeGreaterThan(teen.headRadius / teen.hipY);
  expect(chibi.headRadius / chibi.hipY).toBeGreaterThan(0.82);
  expect(chibi.upperArmLength).toBeLessThan(child.upperArmLength);
});
