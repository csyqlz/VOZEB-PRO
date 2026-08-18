import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef, type MutableRefObject } from "react";
import {
  Euler,
  MathUtils,
  PerspectiveCamera,
  Raycaster,
  Spherical,
  Vector2,
  Vector3,
  type Object3D,
} from "three";
import type { CameraMotionSnapshot } from "../schema/cameraMotion";
import {
  DEFAULT_VIEWPORT_ROTATE_SENSITIVITY,
  DEFAULT_VIEWPORT_ZOOM_SENSITIVITY,
  normalizeViewportSensitivity,
} from "../schema/viewportSensitivity";
import { useDirectorStore } from "../store/directorStore";
import { getPilotMovementIntent, isEditablePilotEventTarget, isPilotMovementCode } from "./pilotControls";
import { isPointerLockedTo, requestPointerLockSafely } from "./pointerLock";

const PILOT_MOVE_SPEED = 4;
const PILOT_ORBIT_SPEED = 1.15;
const PILOT_MOUSE_SENSITIVITY = 0.0022;
const PILOT_MIN_FOV = 10;
const PILOT_MAX_FOV = 120;
const PILOT_WHEEL_FOV_SENSITIVITY = 0.006;
const PILOT_WHEEL_MAX_FOV_STEP = 0.6;
const PILOT_MAX_FRAME_DELTA = 0.05;
const PILOT_RAYCAST_INTERVAL_MS = 80;

export function getPilotMouseSensitivity(rotateSensitivity = DEFAULT_VIEWPORT_ROTATE_SENSITIVITY) {
  const normalizedSensitivity = normalizeViewportSensitivity(
    rotateSensitivity,
    DEFAULT_VIEWPORT_ROTATE_SENSITIVITY
  );
  return PILOT_MOUSE_SENSITIVITY * (normalizedSensitivity / DEFAULT_VIEWPORT_ROTATE_SENSITIVITY);
}

export function getPilotFovAfterWheel(
  currentFov: number,
  deltaY: number,
  zoomSensitivity = DEFAULT_VIEWPORT_ZOOM_SENSITIVITY
) {
  const normalizedSensitivity = normalizeViewportSensitivity(
    zoomSensitivity,
    DEFAULT_VIEWPORT_ZOOM_SENSITIVITY
  );
  const sensitivityScale = normalizedSensitivity / DEFAULT_VIEWPORT_ZOOM_SENSITIVITY;
  const step = MathUtils.clamp(
    (Number.isFinite(deltaY) ? deltaY : 0) * PILOT_WHEEL_FOV_SENSITIVITY * sensitivityScale,
    -PILOT_WHEEL_MAX_FOV_STEP * sensitivityScale,
    PILOT_WHEEL_MAX_FOV_STEP * sensitivityScale
  );
  return MathUtils.clamp(currentFov + step, PILOT_MIN_FOV, PILOT_MAX_FOV);
}

function snapshotTuple(vector: Vector3): [number, number, number] {
  return [vector.x, vector.y, vector.z].map((value) => Number(value.toFixed(6))) as [number, number, number];
}

function findDirectorObjectRoot(object: Object3D | null) {
  let current = object;
  while (current) {
    if (typeof current.userData?.directorObjectId === "string") return current;
    current = current.parent;
  }
  return null;
}

function refreshDirectorObjectCache(
  scene: Object3D,
  objectById: Map<string, Object3D>,
  roots: Object3D[]
) {
  objectById.clear();
  roots.length = 0;
  scene.traverse((object) => {
    const objectId = object.userData?.directorObjectId;
    if (typeof objectId !== "string" || objectById.has(objectId)) return;
    objectById.set(objectId, object);
    roots.push(object);
  });
}

function getDirectorObjectTarget(object: Object3D, output: Vector3, worldOffset: Vector3) {
  object.getWorldPosition(output);
  const offset = object.userData?.directorFocusOffset;
  if (Array.isArray(offset) && offset.length === 3) {
    worldOffset.set(Number(offset[0]) || 0, Number(offset[1]) || 0, Number(offset[2]) || 0);
    object.localToWorld(worldOffset);
    output.copy(worldOffset);
  }
  return output;
}

export function CameraPilotController({
  active,
  onExit,
  onRecord,
  onToggleActionPlayback,
  snapshotRef,
}: {
  active: boolean;
  onExit: () => void;
  onRecord: (snapshot: CameraMotionSnapshot) => void;
  onToggleActionPlayback: () => void;
  snapshotRef: MutableRefObject<CameraMotionSnapshot>;
}) {
  const { camera, gl, scene } = useThree();
  const pressedCodesRef = useRef(new Set<string>());
  const orientationRef = useRef(new Euler(0, 0, 0, "YXZ"));
  const pendingLockedMouseRef = useRef({ x: 0, y: 0 });
  const focusDistanceRef = useRef(6);
  const raycasterRef = useRef(new Raycaster());
  const screenCenterRef = useRef(new Vector2(0, 0));
  const objectByIdRef = useRef(new Map<string, Object3D>());
  const trackableRootsRef = useRef<Object3D[]>([]);
  const lastRaycastAtRef = useRef(0);
  const lockedTargetObjectRef = useRef<Object3D | null>(null);
  const targetRef = useRef(new Vector3());
  const worldOffsetRef = useRef(new Vector3());
  const targetDeltaRef = useRef(new Vector3());
  const orbitOffsetRef = useRef(new Vector3());
  const sphericalOffsetRef = useRef(new Vector3());
  const forwardRef = useRef(new Vector3());
  const rightRef = useRef(new Vector3());
  const sphericalRef = useRef(new Spherical());
  const hoveredTargetId = useDirectorStore((state) => state.cameraPilotHoveredTargetId);
  const lockedTargetId = useDirectorStore((state) => state.cameraPilotLockedTargetId);
  const lockedPoint = useDirectorStore((state) => state.cameraPilotLockedPoint);
  const followTarget = useDirectorStore((state) => state.cameraPilotFollowTarget);
  const viewportRotateSensitivity = useDirectorStore((state) => state.viewportRotateSensitivity);
  const viewportZoomSensitivity = useDirectorStore((state) => state.viewportZoomSensitivity);
  const trackableObjectKey = useDirectorStore((state) =>
    state.project.objects
      .filter((object) => object.visible && object.kind !== "camera")
      .map((object) => object.id)
      .join("\u0000")
  );
  const setHoveredTarget = useDirectorStore((state) => state.setCameraPilotHoveredTarget);
  const setLockedTarget = useDirectorStore((state) => state.setCameraPilotLockedTarget);
  const setLockedPoint = useDirectorStore((state) => state.setCameraPilotLockedPoint);
  const hoveredTargetIdRef = useRef(hoveredTargetId);
  const lockedTargetIdRef = useRef(lockedTargetId);
  const lockedPointRef = useRef<[number, number, number] | null>(lockedPoint);
  const lastLockedTargetPositionRef = useRef<Vector3 | null>(null);
  const onExitRef = useRef(onExit);
  const onRecordRef = useRef(onRecord);
  const onToggleActionPlaybackRef = useRef(onToggleActionPlayback);
  const hadPointerLockRef = useRef(false);
  const pilotMouseSensitivity = getPilotMouseSensitivity(viewportRotateSensitivity);

  useEffect(() => {
    hoveredTargetIdRef.current = hoveredTargetId;
  }, [hoveredTargetId]);

  useEffect(() => {
    lockedTargetIdRef.current = lockedTargetId;
    lockedTargetObjectRef.current = lockedTargetId
      ? objectByIdRef.current.get(lockedTargetId) ?? null
      : null;
    lastLockedTargetPositionRef.current = null;
  }, [lockedTargetId]);

  useEffect(() => {
    lockedPointRef.current = lockedPoint ? [...lockedPoint] : null;
    lastLockedTargetPositionRef.current = null;
  }, [lockedPoint]);

  useEffect(() => {
    onExitRef.current = onExit;
    onRecordRef.current = onRecord;
    onToggleActionPlaybackRef.current = onToggleActionPlayback;
  }, [onExit, onRecord, onToggleActionPlayback]);

  useEffect(() => {
    if (!active) return;
    refreshDirectorObjectCache(scene, objectByIdRef.current, trackableRootsRef.current);
    const lockedId = lockedTargetIdRef.current;
    lockedTargetObjectRef.current = lockedId
      ? objectByIdRef.current.get(lockedId) ?? null
      : null;
  }, [active, scene, trackableObjectKey]);

  useEffect(() => {
    if (!active) {
      pressedCodesRef.current.clear();
      return;
    }

    const pilotCamera = camera as PerspectiveCamera;
    pilotCamera.position.set(...snapshotRef.current.position);
    pilotCamera.fov = snapshotRef.current.fov;
    pilotCamera.lookAt(...snapshotRef.current.target);
    pilotCamera.updateProjectionMatrix();
    pilotCamera.updateMatrixWorld();
    orientationRef.current.setFromQuaternion(pilotCamera.quaternion, "YXZ");
    focusDistanceRef.current = Math.max(
      0.5,
      new Vector3(...snapshotRef.current.position).distanceTo(new Vector3(...snapshotRef.current.target))
    );
    refreshDirectorObjectCache(scene, objectByIdRef.current, trackableRootsRef.current);

    const canvas = gl.domElement;
    const canUseCanvasEvents = typeof HTMLElement !== "undefined" && canvas instanceof HTMLElement;
    hadPointerLockRef.current = canUseCanvasEvents && isPointerLockedTo(canvas);

    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || isEditablePilotEventTarget(event.target)) return;

      if (isPilotMovementCode(event.code)) {
        event.preventDefault();
        pressedCodesRef.current.add(event.code);
        return;
      }

      if (event.code === "Space") {
        event.preventDefault();
        if (!event.repeat) onToggleActionPlaybackRef.current();
        return;
      }

      if (event.repeat) return;
      if (event.code === "KeyF") {
        event.preventDefault();
        const currentLocked = lockedTargetIdRef.current;
        const currentPoint = lockedPointRef.current;
        if (currentLocked || currentPoint) {
          lockedTargetIdRef.current = null;
          lockedPointRef.current = null;
          lockedTargetObjectRef.current = null;
          lastLockedTargetPositionRef.current = null;
          orientationRef.current.setFromQuaternion(pilotCamera.quaternion, "YXZ");
          setLockedTarget(null);
          setLockedPoint(null);
          return;
        }
        const nextLocked = hoveredTargetIdRef.current;
        if (!nextLocked) {
          const direction = forwardRef.current
            .set(0, 0, -1)
            .applyQuaternion(pilotCamera.quaternion)
            .normalize();
          const point = targetRef.current
            .copy(pilotCamera.position)
            .addScaledVector(direction, focusDistanceRef.current);
          const nextPoint = snapshotTuple(point);
          lockedPointRef.current = nextPoint;
          setLockedPoint(nextPoint);
          return;
        }
        lockedTargetIdRef.current = nextLocked;
        lockedTargetObjectRef.current = nextLocked
          ? objectByIdRef.current.get(nextLocked) ?? null
          : null;
        lastLockedTargetPositionRef.current = null;
        setLockedTarget(nextLocked);
        return;
      }

      if (event.code === "Enter") {
        event.preventDefault();
        onRecordRef.current(snapshotRef.current);
        return;
      }

      if (event.code === "Escape") {
        event.preventDefault();
        onExitRef.current();
      }
    }

    function handleKeyUp(event: KeyboardEvent) {
      pressedCodesRef.current.delete(event.code);
    }

    function handleMouseMove(event: MouseEvent) {
      if (!canUseCanvasEvents || !isPointerLockedTo(canvas)) return;
      if (lockedTargetIdRef.current || lockedPointRef.current) {
        pendingLockedMouseRef.current.x += event.movementX;
        pendingLockedMouseRef.current.y += event.movementY;
        return;
      }

      orientationRef.current.y -= event.movementX * pilotMouseSensitivity;
      orientationRef.current.x = MathUtils.clamp(
        orientationRef.current.x - event.movementY * pilotMouseSensitivity,
        -Math.PI / 2 + 0.025,
        Math.PI / 2 - 0.025
      );
    }

    function handleWheel(event: WheelEvent) {
      event.preventDefault();
      pilotCamera.fov = getPilotFovAfterWheel(pilotCamera.fov, event.deltaY, viewportZoomSensitivity);
      pilotCamera.updateProjectionMatrix();
    }

    function requestPointerLock() {
      if (!canUseCanvasEvents || isPointerLockedTo(canvas)) return;
      void requestPointerLockSafely(canvas);
    }

    function handlePointerLockChange() {
      if (!canUseCanvasEvents) return;
      if (isPointerLockedTo(canvas)) {
        hadPointerLockRef.current = true;
        return;
      }

      if (hadPointerLockRef.current) {
        hadPointerLockRef.current = false;
        onExitRef.current();
      }
    }

    function clearPressedCodes() {
      pressedCodesRef.current.clear();
    }

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    window.addEventListener("keyup", handleKeyUp, { capture: true });
    window.addEventListener("blur", clearPressedCodes);
    window.addEventListener("mousemove", handleMouseMove);
    if (typeof document !== "undefined") {
      document.addEventListener("pointerlockchange", handlePointerLockChange);
    }
    if (canUseCanvasEvents) {
      canvas.addEventListener("click", requestPointerLock);
      canvas.addEventListener("wheel", handleWheel, { passive: false });
    }

    return () => {
      pressedCodesRef.current.clear();
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
      window.removeEventListener("keyup", handleKeyUp, { capture: true });
      window.removeEventListener("blur", clearPressedCodes);
      window.removeEventListener("mousemove", handleMouseMove);
      if (typeof document !== "undefined") {
        document.removeEventListener("pointerlockchange", handlePointerLockChange);
      }
      if (canUseCanvasEvents) {
        canvas.removeEventListener("click", requestPointerLock);
        canvas.removeEventListener("wheel", handleWheel);
      }
    };
  }, [
    active,
    camera,
    gl.domElement,
    pilotMouseSensitivity,
    scene,
    setLockedPoint,
    setLockedTarget,
    snapshotRef,
    viewportZoomSensitivity,
  ]);

  useFrame((_state, delta) => {
    if (!active) return;
    const pilotCamera = camera as PerspectiveCamera;
    const intent = getPilotMovementIntent(pressedCodesRef.current);
    const lockedId = lockedTargetIdRef.current;
    const lockedSpacePoint = lockedPointRef.current;
    const target = targetRef.current;
    const frameDelta = Math.min(Math.max(delta, 0), PILOT_MAX_FRAME_DELTA);
    const now = typeof performance === "undefined" ? Date.now() : performance.now();

    let hasLockedFocus = false;
    if (lockedId) {
      const targetObject = lockedTargetObjectRef.current ?? objectByIdRef.current.get(lockedId) ?? null;
      if (!targetObject) {
        lockedTargetIdRef.current = null;
        lockedTargetObjectRef.current = null;
        setLockedTarget(null);
      } else {
        hasLockedFocus = true;
        lockedTargetObjectRef.current = targetObject;
        getDirectorObjectTarget(targetObject, target, worldOffsetRef.current);
        if (followTarget && lastLockedTargetPositionRef.current) {
          targetDeltaRef.current.copy(target).sub(lastLockedTargetPositionRef.current);
          pilotCamera.position.add(targetDeltaRef.current);
        }
        if (lastLockedTargetPositionRef.current) lastLockedTargetPositionRef.current.copy(target);
        else lastLockedTargetPositionRef.current = new Vector3().copy(target);

      }
    } else if (lockedSpacePoint) {
      target.set(...lockedSpacePoint);
      hasLockedFocus = true;
    }

    if (hasLockedFocus) {
      const offset = orbitOffsetRef.current.copy(pilotCamera.position).sub(target);
      if (offset.lengthSq() < 0.01) offset.set(0, 0, 1);
      const spherical = sphericalRef.current.setFromVector3(offset);
      spherical.theta -= intent.strafe * PILOT_ORBIT_SPEED * frameDelta;
      spherical.theta -= pendingLockedMouseRef.current.x * pilotMouseSensitivity;
      spherical.phi = MathUtils.clamp(
        spherical.phi + pendingLockedMouseRef.current.y * pilotMouseSensitivity,
        0.08,
        Math.PI - 0.08
      );
      spherical.radius = Math.max(0.35, spherical.radius - intent.forward * PILOT_MOVE_SPEED * frameDelta);
      pendingLockedMouseRef.current.x = 0;
      pendingLockedMouseRef.current.y = 0;

      sphericalOffsetRef.current.setFromSpherical(spherical);
      pilotCamera.position.copy(target).add(sphericalOffsetRef.current);
      pilotCamera.position.y += intent.vertical * PILOT_MOVE_SPEED * frameDelta;
      pilotCamera.lookAt(target);
    } else {
      lastLockedTargetPositionRef.current = null;
      pilotCamera.quaternion.setFromEuler(orientationRef.current);
      const forward = forwardRef.current.set(0, 0, -1).applyQuaternion(pilotCamera.quaternion).normalize();
      const right = rightRef.current.set(1, 0, 0).applyQuaternion(pilotCamera.quaternion).normalize();
      pilotCamera.position.addScaledVector(forward, intent.forward * PILOT_MOVE_SPEED * frameDelta);
      pilotCamera.position.addScaledVector(right, intent.strafe * PILOT_MOVE_SPEED * frameDelta);
      pilotCamera.position.y += intent.vertical * PILOT_MOVE_SPEED * frameDelta;
      target.copy(pilotCamera.position).addScaledVector(forward, focusDistanceRef.current);
    }

    pilotCamera.updateMatrixWorld();

    if (now - lastRaycastAtRef.current >= PILOT_RAYCAST_INTERVAL_MS) {
      lastRaycastAtRef.current = now;
      raycasterRef.current.setFromCamera(screenCenterRef.current, pilotCamera);
      const intersections = raycasterRef.current.intersectObjects(trackableRootsRef.current, true);
      let pointedRoot: Object3D | null = null;
      for (const intersection of intersections) {
        pointedRoot = findDirectorObjectRoot(intersection.object);
        if (pointedRoot) break;
      }
      const nextHoveredId = pointedRoot?.userData.directorObjectId ?? null;
      if (nextHoveredId !== hoveredTargetIdRef.current) {
        hoveredTargetIdRef.current = nextHoveredId;
        setHoveredTarget(nextHoveredId);
      }
    }

    const snapshot: CameraMotionSnapshot = {
      fov: Number(pilotCamera.fov.toFixed(3)),
      position: snapshotTuple(pilotCamera.position),
      target: snapshotTuple(target),
    };
    snapshotRef.current = snapshot;
  });

  return null;
}
