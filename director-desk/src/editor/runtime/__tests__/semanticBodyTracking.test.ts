import { Bone, Group, Mesh, Vector3 } from "three";
import { expect, it } from "vitest";
import {
  DIRECTOR_CHARACTER_BONE_MAP_USER_DATA_KEY,
  findSemanticBodyPartNode,
  getDirectorObjectSceneNodeName,
  getSceneSemanticBodyPartTarget,
  getSemanticBodyPartWorldPosition,
} from "../semanticBodyTracking";

it("maps Mixamo and UE4 bone names onto the shared semantic body", () => {
  const root = new Group();
  const mixamoHand = new Bone();
  mixamoHand.name = "mixamorig:RightHand";
  root.add(mixamoHand);
  const ueFoot = new Bone();
  ueFoot.name = "Bip001_L_Foot_059";
  root.add(ueFoot);
  const alternateMixamoCalf = new Bone();
  alternateMixamoCalf.name = "mixamorig1:RightLeg";
  root.add(alternateMixamoCalf);

  expect(findSemanticBodyPartNode(root, "rightHand")).toBe(mixamoHand);
  expect(findSemanticBodyPartNode(root, "leftFoot")).toBe(ueFoot);
  expect(findSemanticBodyPartNode(root, "rightCalf")).toBe(alternateMixamoCalf);
});

it("tracks a procedural mannequin limb marker after its parent rotates", () => {
  const root = new Group();
  root.position.set(2, 1, -3);
  const arm = new Group();
  arm.rotation.z = Math.PI / 2;
  const hand = new Mesh();
  hand.name = "humanoid-right-hand";
  hand.position.set(0, -1, 0);
  arm.add(hand);
  root.add(arm);
  root.updateMatrixWorld(true);

  const position = getSemanticBodyPartWorldPosition(root, "rightHand", new Vector3());
  expect(position?.x).toBeCloseTo(3, 5);
  expect(position?.y).toBeCloseTo(1, 5);
  expect(position?.z).toBeCloseTo(-3, 5);
});

it("resolves the animated body part inside one Canvas scene only", () => {
  const scene = new Group();
  const character = new Group();
  character.name = getDirectorObjectSceneNodeName("actor_1");
  character.position.set(4, 0, 2);
  const hand = new Bone();
  hand.name = "mixamorig:RightHand";
  hand.position.set(0.6, 1.3, 0.2);
  character.add(hand);
  scene.add(character);
  scene.updateMatrixWorld(true);

  expect(getSceneSemanticBodyPartTarget(scene, "actor_1", "rightHand")).toEqual([4.6, 1.3, 2.2]);
  expect(getSceneSemanticBodyPartTarget(scene, "actor_2", "rightHand")).toBeNull();
});

it("uses the saved manual bone map before falling back to name aliases", () => {
  const scene = new Group();
  const character = new Group();
  character.name = getDirectorObjectSceneNodeName("mapped_actor");
  character.userData[DIRECTOR_CHARACTER_BONE_MAP_USER_DATA_KEY] = { rightHand: "Custom_R_Grip" };
  const hand = new Bone();
  hand.name = "Custom_R_Grip";
  hand.position.set(0.2, 1.1, -0.3);
  character.add(hand);
  scene.add(character);
  scene.updateMatrixWorld(true);

  expect(getSceneSemanticBodyPartTarget(scene, "mapped_actor", "rightHand")).toEqual([0.2, 1.1, -0.3]);
});
