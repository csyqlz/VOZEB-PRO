import { expect, it } from "vitest";
import { createImportedCharacterActionId, parseImportedCharacterActionId } from "../importedCharacterAction";

it("round-trips imported action asset and clip ids safely", () => {
  const id = createImportedCharacterActionId("animation:演员 1", "clip:走路/循环");
  expect(parseImportedCharacterActionId(id)).toEqual({
    animationAssetId: "animation:演员 1",
    clipId: "clip:走路/循环",
  });
});

it("ignores built-in action ids and malformed imported ids", () => {
  expect(parseImportedCharacterActionId("walk-cycle")).toBeNull();
  expect(parseImportedCharacterActionId("imported-action:missing-clip")).toBeNull();
});
