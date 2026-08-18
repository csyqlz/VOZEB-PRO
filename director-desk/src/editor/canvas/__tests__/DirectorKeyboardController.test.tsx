import { act, fireEvent, render } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { PerspectiveCamera, Vector3 } from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fiberMocks = vi.hoisted(() => ({
  useFrame: vi.fn(),
  useThree: vi.fn(),
}));

vi.mock("@react-three/fiber", () => fiberMocks);

import {
  DirectorKeyboardController,
  getDirectorMovementDirection,
  getDirectorMovementIntent,
  isDirectorMovementCode,
  isEditableDirectorEventTarget,
} from "../DirectorKeyboardController";

type FrameCallback = (state: unknown, delta: number) => void;

let camera: PerspectiveCamera;
let frameCallback: FrameCallback;
let controls: {
  target: Vector3;
  update: ReturnType<typeof vi.fn>;
};
let controlsRef: MutableRefObject<OrbitControlsImpl | null>;

beforeEach(() => {
  camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 2, 5);
  camera.lookAt(0, 2, 0);
  camera.updateMatrixWorld();

  controls = {
    target: new Vector3(0, 2, 0),
    update: vi.fn(),
  };
  controlsRef = {
    current: controls as unknown as OrbitControlsImpl,
  };

  fiberMocks.useThree.mockReturnValue({ camera });
  fiberMocks.useFrame.mockImplementation((callback: FrameCallback) => {
    frameCallback = callback;
  });
});

describe("director keyboard movement helpers", () => {
  it("maps WASD, Space and either Shift key to the expected intent", () => {
    expect(getDirectorMovementIntent(new Set(["KeyW", "KeyA", "Space"]))).toEqual({
      forward: 1,
      strafe: -1,
      vertical: 1,
    });
    expect(getDirectorMovementIntent(new Set(["KeyS", "KeyD", "ShiftRight"]))).toEqual({
      forward: -1,
      strafe: 1,
      vertical: -1,
    });
    expect(getDirectorMovementIntent(new Set(["ShiftLeft"])).vertical).toBe(-1);
  });

  it("does not treat Q/E as regular director movement keys", () => {
    expect(isDirectorMovementCode("KeyQ")).toBe(false);
    expect(isDirectorMovementCode("KeyE")).toBe(false);
    expect(isDirectorMovementCode("Space")).toBe(true);
    expect(isDirectorMovementCode("ShiftLeft")).toBe(true);
  });

  it("projects forward movement onto the ground and normalizes diagonals", () => {
    const cameraForward = new Vector3(2, -8, -2);
    const movement = getDirectorMovementDirection(
      { forward: 1, strafe: 1, vertical: 0 },
      cameraForward
    );

    expect(movement.y).toBe(0);
    expect(movement.length()).toBeCloseTo(1);
    expect(movement.x).toBeGreaterThan(0);
    expect(movement.z).toBeCloseTo(0, 6);
    expect(cameraForward).toEqual(new Vector3(2, -8, -2));
  });

  it("recognizes controls and nested contenteditable targets", () => {
    const input = document.createElement("input");
    const button = document.createElement("button");
    const buttonIcon = document.createElement("span");
    button.append(buttonIcon);
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const editableChild = document.createElement("span");
    editable.append(editableChild);

    expect(isEditableDirectorEventTarget(input)).toBe(true);
    expect(isEditableDirectorEventTarget(buttonIcon)).toBe(true);
    expect(isEditableDirectorEventTarget(editableChild)).toBe(true);
    expect(isEditableDirectorEventTarget(document.createElement("div"))).toBe(false);
  });
});

describe("DirectorKeyboardController", () => {
  it("moves the camera and OrbitControls target together each frame", () => {
    render(<DirectorKeyboardController active controlsRef={controlsRef} moveSpeed={10} />);
    const originalOffset = camera.position.clone().sub(controls.target);

    fireEvent.keyDown(window, { code: "KeyW" });
    act(() => frameCallback({}, 0.1));

    expect(camera.position.z).toBeCloseTo(4.5);
    expect(controls.target.z).toBeCloseTo(-0.5);
    expect(camera.position.clone().sub(controls.target)).toEqual(originalOffset);
    expect(controls.update).toHaveBeenCalledTimes(1);
  });

  it("stops on keyup and clears held keys when the window loses focus", () => {
    render(<DirectorKeyboardController active controlsRef={controlsRef} moveSpeed={10} />);

    fireEvent.keyDown(window, { code: "KeyD" });
    act(() => frameCallback({}, 0.1));
    const afterFirstMove = camera.position.clone();

    fireEvent.keyUp(window, { code: "KeyD" });
    act(() => frameCallback({}, 0.1));
    expect(camera.position).toEqual(afterFirstMove);

    fireEvent.keyDown(window, { code: "KeyW" });
    fireEvent(window, new Event("blur"));
    act(() => frameCallback({}, 0.1));
    expect(camera.position).toEqual(afterFirstMove);
  });

  it("ignores movement keys typed in editable UI and when inactive", () => {
    const input = document.createElement("input");
    document.body.append(input);
    const { rerender } = render(
      <DirectorKeyboardController active controlsRef={controlsRef} moveSpeed={10} />
    );

    fireEvent.keyDown(input, { code: "KeyW" });
    act(() => frameCallback({}, 0.1));
    expect(camera.position).toEqual(new Vector3(0, 2, 5));

    rerender(<DirectorKeyboardController active={false} controlsRef={controlsRef} moveSpeed={10} />);
    fireEvent.keyDown(window, { code: "KeyW" });
    act(() => frameCallback({}, 0.1));
    expect(camera.position).toEqual(new Vector3(0, 2, 5));

    input.remove();
  });

  it("uses Space to rise and Shift to descend", () => {
    render(<DirectorKeyboardController active controlsRef={controlsRef} moveSpeed={10} />);

    fireEvent.keyDown(window, { code: "Space" });
    act(() => frameCallback({}, 0.1));
    expect(camera.position.y).toBeCloseTo(2.5);
    expect(controls.target.y).toBeCloseTo(2.5);

    fireEvent.keyUp(window, { code: "Space" });
    fireEvent.keyDown(window, { code: "ShiftLeft" });
    act(() => frameCallback({}, 0.1));
    expect(camera.position.y).toBeCloseTo(2);
    expect(controls.target.y).toBeCloseTo(2);
  });

  it("caps long frame gaps so keyboard movement does not jump after a stall", () => {
    render(<DirectorKeyboardController active controlsRef={controlsRef} moveSpeed={10} />);

    fireEvent.keyDown(window, { code: "KeyW" });
    act(() => frameCallback({}, 0.8));

    expect(camera.position.z).toBeCloseTo(4.5);
    expect(controls.target.z).toBeCloseTo(-0.5);
  });

  it("keeps held WASD movement continuous across normal and slow frames", () => {
    render(<DirectorKeyboardController active controlsRef={controlsRef} moveSpeed={10} />);

    fireEvent.keyDown(window, { code: "KeyW", repeat: false });
    act(() => frameCallback({}, 1 / 60));
    const afterFirstFrame = camera.position.z;
    act(() => frameCallback({}, 1 / 30));
    const afterSecondFrame = camera.position.z;
    act(() => frameCallback({}, 0.2));
    const afterSlowFrame = camera.position.z;

    expect(afterFirstFrame).toBeLessThan(5);
    expect(afterSecondFrame).toBeLessThan(afterFirstFrame);
    expect(afterSlowFrame).toBeLessThan(afterSecondFrame);
    expect(afterSecondFrame - afterSlowFrame).toBeCloseTo(0.5);
    expect(controls.update).toHaveBeenCalledTimes(3);
  });
});
