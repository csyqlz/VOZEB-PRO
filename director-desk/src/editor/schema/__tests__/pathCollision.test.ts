import { describe, expect, it } from "vitest";
import { createInitialDirectorState } from "../../store/directorStore";
import type { DirectorObject } from "../directorProject";
import { constrainCameraPosition, constrainObjectMotionTransform } from "../pathCollision";

function createFixture() {
  const project = createInitialDirectorState().project;
  const character = project.objects.find((object) => object.kind === "character")!;
  const obstacle: DirectorObject = {
    ...character,
    id: "collision_box",
    name: "碰撞箱",
    kind: "prop",
    geometryType: "box",
    motionPath: undefined,
    transform: {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [2, 2, 2],
    },
  };
  return { character, obstacle, scene: project.scene };
}

describe("path collision", () => {
  it("preserves authored positions while collision is disabled", () => {
    const { character, obstacle, scene } = createFixture();
    const transform = { ...character.transform, position: [0, 5, 0] as [number, number, number] };

    expect(constrainObjectMotionTransform(character, transform, scene, [character, obstacle])).toBe(transform);
    expect(constrainCameraPosition([0, -2, 0], scene, [obstacle])).toEqual([0, -2, 0]);
  });

  it("grounds characters and pushes their route outside scene obstacles", () => {
    const { character, obstacle, scene } = createFixture();
    const collisionScene = { ...scene, groundHeight: 1.5, pathCollisionEnabled: true };
    const transform = { ...character.transform, position: [0, 8, 0] as [number, number, number] };

    const result = constrainObjectMotionTransform(character, transform, collisionScene, [character, obstacle]);

    expect(result.position[1]).toBe(1.5);
    expect(Math.abs(result.position[0]) > 1.1 || Math.abs(result.position[2]) > 1.1).toBe(true);
  });

  it("keeps the camera above ground and outside obstacles", () => {
    const { obstacle, scene } = createFixture();
    const collisionScene = { ...scene, groundHeight: 0, pathCollisionEnabled: true };

    const belowGround = constrainCameraPosition([5, -3, 5], collisionScene, [obstacle]);
    const insideObstacle = constrainCameraPosition([0, 0.5, 0], collisionScene, [obstacle]);

    expect(belowGround[1]).toBeGreaterThanOrEqual(0.18);
    expect(insideObstacle[1]).toBeGreaterThanOrEqual(0.18);
    expect(Math.abs(insideObstacle[0]) > 1.1 || Math.abs(insideObstacle[2]) > 1.1 || insideObstacle[1] > 2).toBe(true);
  });
});
