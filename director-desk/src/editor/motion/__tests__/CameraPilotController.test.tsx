import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { PerspectiveCamera, Scene } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CameraMotionSnapshot } from "../../schema/cameraMotion";
import { useDirectorStore } from "../../store/directorStore";

const fiberMocks = vi.hoisted(() => ({
  useFrame: vi.fn(),
  useThree: vi.fn(),
}));

vi.mock("@react-three/fiber", () => fiberMocks);

import {
  CameraPilotController,
  getPilotFovAfterWheel,
  getPilotMouseSensitivity,
} from "../CameraPilotController";

type FrameCallback = (state: unknown, delta: number) => void;

const INITIAL_SNAPSHOT: CameraMotionSnapshot = {
  fov: 50,
  position: [0, 2, 5],
  target: [0, 2, 0],
};

let camera: PerspectiveCamera;
let scene: Scene;
let canvas: HTMLCanvasElement;
let frameCallback: FrameCallback;
let pointerLockOwner: Element | null;
let pointerLockDescriptor: PropertyDescriptor | undefined;
let requestPointerLock: ReturnType<typeof vi.fn>;
let snapshotRef: MutableRefObject<CameraMotionSnapshot>;

function renderController(overrides: {
  active?: boolean;
  onExit?: () => void;
  onRecord?: (snapshot: CameraMotionSnapshot) => void;
  onToggleActionPlayback?: () => void;
} = {}) {
  const callbacks = {
    onExit: overrides.onExit ?? vi.fn(),
    onRecord: overrides.onRecord ?? vi.fn(),
    onToggleActionPlayback: overrides.onToggleActionPlayback ?? vi.fn(),
  };

  const result = render(
    <CameraPilotController
      active={overrides.active ?? true}
      onExit={callbacks.onExit}
      onRecord={callbacks.onRecord}
      onToggleActionPlayback={callbacks.onToggleActionPlayback}
      snapshotRef={snapshotRef}
    />
  );

  return { ...result, ...callbacks };
}

function dispatchMouseMove(movementX: number, movementY: number) {
  const event = new MouseEvent("mousemove");
  Object.defineProperties(event, {
    movementX: { configurable: true, value: movementX },
    movementY: { configurable: true, value: movementY },
  });
  window.dispatchEvent(event);
}

beforeEach(() => {
  pointerLockOwner = null;
  pointerLockDescriptor = Object.getOwnPropertyDescriptor(document, "pointerLockElement");
  Object.defineProperty(document, "pointerLockElement", {
    configurable: true,
    get: () => pointerLockOwner,
  });

  canvas = document.createElement("canvas");
  requestPointerLock = vi.fn(() => undefined);
  Object.defineProperty(canvas, "requestPointerLock", {
    configurable: true,
    value: requestPointerLock,
  });
  document.body.append(canvas);

  camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(...INITIAL_SNAPSHOT.position);
  camera.lookAt(...INITIAL_SNAPSHOT.target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();

  snapshotRef = {
    current: {
      ...INITIAL_SNAPSHOT,
      position: [...INITIAL_SNAPSHOT.position],
      target: [...INITIAL_SNAPSHOT.target],
    },
  };

  scene = new Scene();
  fiberMocks.useThree.mockReturnValue({
    camera,
    gl: { domElement: canvas },
    scene,
  });
  fiberMocks.useFrame.mockImplementation((callback: FrameCallback) => {
    frameCallback = callback;
  });

  useDirectorStore.setState({
    cameraPilotHoveredTargetId: null,
    cameraPilotLockedTargetId: null,
    cameraPilotLockedPoint: null,
    cameraPilotFollowTarget: false,
  });
});

afterEach(() => {
  cleanup();
  canvas.remove();
  fiberMocks.useFrame.mockReset();
  fiberMocks.useThree.mockReset();
  vi.clearAllMocks();

  if (pointerLockDescriptor) {
    Object.defineProperty(document, "pointerLockElement", pointerLockDescriptor);
  } else {
    Reflect.deleteProperty(document, "pointerLockElement");
  }
});

describe("CameraPilotController", () => {
  it("toggles action playback once for Space and ignores key-repeat events", () => {
    const onToggleActionPlayback = vi.fn();
    renderController({ onToggleActionPlayback });

    fireEvent.keyDown(window, { code: "Space", repeat: false });
    fireEvent.keyDown(window, { code: "Space", repeat: true });

    expect(onToggleActionPlayback).toHaveBeenCalledTimes(1);
  });

  it("records the current camera snapshot when Enter is pressed", () => {
    const onRecord = vi.fn();
    renderController({ onRecord });

    fireEvent.keyDown(window, { code: "Enter" });

    expect(onRecord).toHaveBeenCalledTimes(1);
    expect(onRecord).toHaveBeenCalledWith(snapshotRef.current);
  });

  it("locks the current empty-space focus with F and unlocks it with F again", () => {
    renderController();

    fireEvent.keyDown(window, { code: "KeyF", repeat: false });
    expect(useDirectorStore.getState().cameraPilotLockedTargetId).toBeNull();
    expect(useDirectorStore.getState().cameraPilotLockedPoint).toEqual([0, 2, 0]);

    act(() => frameCallback({}, 1 / 60));
    expect(snapshotRef.current.target).toEqual([0, 2, 0]);

    fireEvent.keyUp(window, { code: "KeyF" });
    fireEvent.keyDown(window, { code: "KeyF", repeat: false });
    expect(useDirectorStore.getState().cameraPilotLockedPoint).toBeNull();
  });

  it("ignores mouse movement without Pointer Lock and rotates only after the canvas owns it", () => {
    renderController();

    dispatchMouseMove(120, -30);
    act(() => frameCallback({}, 1 / 60));
    const unlockedSnapshot = structuredClone(snapshotRef.current);

    expect(unlockedSnapshot).toEqual(INITIAL_SNAPSHOT);

    pointerLockOwner = canvas;
    fireEvent(document, new Event("pointerlockchange"));
    dispatchMouseMove(120, -30);
    act(() => frameCallback({}, 1 / 60));

    expect(snapshotRef.current.position).toEqual(unlockedSnapshot.position);
    expect(snapshotRef.current.target).not.toEqual(unlockedSnapshot.target);
  });

  it("exits when an already-acquired Pointer Lock is lost", () => {
    pointerLockOwner = canvas;
    const onExit = vi.fn();
    renderController({ onExit });

    pointerLockOwner = null;
    fireEvent(document, new Event("pointerlockchange"));
    fireEvent(document, new Event("pointerlockchange"));

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("retries Pointer Lock when the canvas is clicked while unlocked", () => {
    renderController();

    fireEvent.click(canvas);

    expect(requestPointerLock).toHaveBeenCalledTimes(1);
    expect(requestPointerLock).toHaveBeenCalledWith();
  });

  it("zooms gently for small wheel deltas and caps unusually large deltas", () => {
    renderController();

    const initialFov = camera.fov;
    fireEvent.wheel(canvas, { deltaY: 1 });
    const smallDeltaChange = camera.fov - initialFov;

    expect(smallDeltaChange).toBeGreaterThan(0);
    expect(smallDeltaChange).toBeLessThanOrEqual(0.1);

    const beforeLargeDelta = camera.fov;
    fireEvent.wheel(canvas, { deltaY: 10_000 });
    const largeDeltaChange = camera.fov - beforeLargeDelta;

    expect(largeDeltaChange).toBeGreaterThan(0);
    expect(largeDeltaChange).toBeLessThanOrEqual(1);
  });

  it("scales pilot turning and zooming with the shared viewport sensitivity", () => {
    expect(getPilotMouseSensitivity(0.15)).toBeLessThan(getPilotMouseSensitivity(0.9));

    const slowFov = getPilotFovAfterWheel(50, 100, 0.15);
    const fastFov = getPilotFovAfterWheel(50, 100, 0.9);

    expect(slowFov).toBeGreaterThan(50);
    expect(fastFov - 50).toBeGreaterThan(slowFov - 50);
  });

  it("uses the selected turning sensitivity while orbiting a locked space point", () => {
    useDirectorStore.setState({ viewportRotateSensitivity: 0.1 });
    renderController();
    pointerLockOwner = canvas;
    fireEvent(document, new Event("pointerlockchange"));
    fireEvent.keyDown(window, { code: "KeyF", repeat: false });

    dispatchMouseMove(100, 0);
    act(() => frameCallback({}, 1 / 60));
    const slowHorizontalMove = Math.abs(camera.position.x);

    camera.position.set(...INITIAL_SNAPSHOT.position);
    camera.lookAt(...INITIAL_SNAPSHOT.target);
    camera.updateMatrixWorld();
    act(() => useDirectorStore.setState({ viewportRotateSensitivity: 1.5 }));
    dispatchMouseMove(100, 0);
    act(() => frameCallback({}, 1 / 60));
    const fastHorizontalMove = Math.abs(camera.position.x);

    expect(slowHorizontalMove).toBeGreaterThan(0);
    expect(fastHorizontalMove).toBeGreaterThan(slowHorizontalMove * 5);
  });

  it("caps long frame gaps so WASD movement does not jump after a stall", () => {
    renderController();

    fireEvent.keyDown(window, { code: "KeyW" });
    act(() => frameCallback({}, 0.8));

    expect(snapshotRef.current.position[2]).toBeCloseTo(4.8);
  });

  it("does not traverse the whole scene again on every piloting frame", () => {
    const traverse = vi.spyOn(scene, "traverse");
    renderController();
    const callsAfterMount = traverse.mock.calls.length;

    for (let index = 0; index < 12; index += 1) {
      act(() => frameCallback({}, 1 / 60));
    }

    expect(callsAfterMount).toBeGreaterThan(0);
    expect(traverse).toHaveBeenCalledTimes(callsAfterMount);
  });
});
