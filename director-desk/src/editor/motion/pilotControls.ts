export interface PilotMovementIntent {
  forward: number;
  strafe: number;
  vertical: number;
}

const PILOT_MOVEMENT_CODES = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "KeyE",
  "KeyQ",
]);

export function isPilotMovementCode(code: string) {
  return PILOT_MOVEMENT_CODES.has(code);
}

export function getPilotMovementIntent(pressedCodes: ReadonlySet<string>): PilotMovementIntent {
  return {
    forward: Number(pressedCodes.has("KeyW")) - Number(pressedCodes.has("KeyS")),
    strafe: Number(pressedCodes.has("KeyD")) - Number(pressedCodes.has("KeyA")),
    vertical: Number(pressedCodes.has("KeyE")) - Number(pressedCodes.has("KeyQ")),
  };
}

export function isEditablePilotEventTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName);
}
