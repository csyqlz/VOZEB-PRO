type MaybeAsyncVoid = void | PromiseLike<void>;

type PointerLockRequest = (this: HTMLElement) => MaybeAsyncVoid;
type PointerLockExit = (this: Document) => MaybeAsyncVoid;

/**
 * Requests Pointer Lock without leaking browser or embedded-host failures.
 * `true` means that the host accepted the invocation; callers can listen for
 * `pointerlockchange` or use `isPointerLockedTo` when they need confirmed state.
 */
export async function requestPointerLockSafely(element: HTMLElement): Promise<boolean> {
  const request = element.requestPointerLock as unknown as PointerLockRequest | undefined;
  if (typeof request !== "function") return false;

  try {
    await request.call(element);
    return true;
  } catch {
    return false;
  }
}

/** Safely releases Pointer Lock, including hosts that return a Promise. */
export async function exitPointerLockSafely(): Promise<boolean> {
  if (typeof document === "undefined") return false;

  const exit = document.exitPointerLock as unknown as PointerLockExit | undefined;
  if (typeof exit !== "function") return false;

  try {
    await exit.call(document);
    return true;
  } catch {
    return false;
  }
}

/** Returns whether the specified element currently owns Pointer Lock. */
export function isPointerLockedTo(element: HTMLElement): boolean {
  return typeof document !== "undefined" && document.pointerLockElement === element;
}
