import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exitPointerLockSafely,
  isPointerLockedTo,
  requestPointerLockSafely,
} from "../pointerLock";

const pointerLockElementDescriptor = Object.getOwnPropertyDescriptor(document, "pointerLockElement");
const exitPointerLockDescriptor = Object.getOwnPropertyDescriptor(document, "exitPointerLock");

function setPointerLockElement(element: Element | null) {
  Object.defineProperty(document, "pointerLockElement", {
    configurable: true,
    value: element,
  });
}

function setExitPointerLock(exitPointerLock: (() => void | Promise<void>) | undefined) {
  Object.defineProperty(document, "exitPointerLock", {
    configurable: true,
    value: exitPointerLock,
  });
}

afterEach(() => {
  if (pointerLockElementDescriptor) {
    Object.defineProperty(document, "pointerLockElement", pointerLockElementDescriptor);
  } else {
    Reflect.deleteProperty(document, "pointerLockElement");
  }

  if (exitPointerLockDescriptor) {
    Object.defineProperty(document, "exitPointerLock", exitPointerLockDescriptor);
  } else {
    Reflect.deleteProperty(document, "exitPointerLock");
  }
});

describe("requestPointerLockSafely", () => {
  it("returns true for legacy hosts whose request method returns void", async () => {
    const element = document.createElement("div");
    const request = vi.fn(function (this: HTMLElement) {
      expect(this).toBe(element);
    });
    Object.defineProperty(element, "requestPointerLock", { configurable: true, value: request });

    await expect(requestPointerLockSafely(element)).resolves.toBe(true);
    expect(request).toHaveBeenCalledOnce();
  });

  it("waits for promise-based hosts and returns true after acceptance", async () => {
    const element = document.createElement("div");
    Object.defineProperty(element, "requestPointerLock", {
      configurable: true,
      value: vi.fn().mockResolvedValue(undefined),
    });

    await expect(requestPointerLockSafely(element)).resolves.toBe(true);
  });

  it("returns false when Pointer Lock is unsupported", async () => {
    const element = document.createElement("div");
    Object.defineProperty(element, "requestPointerLock", { configurable: true, value: undefined });

    await expect(requestPointerLockSafely(element)).resolves.toBe(false);
  });

  it("swallows a synchronous host exception and returns false", async () => {
    const element = document.createElement("div");
    Object.defineProperty(element, "requestPointerLock", {
      configurable: true,
      value: vi.fn(() => {
        throw new DOMException("Pointer Lock blocked");
      }),
    });

    await expect(requestPointerLockSafely(element)).resolves.toBe(false);
  });

  it("swallows a rejected host promise and returns false", async () => {
    const element = document.createElement("div");
    Object.defineProperty(element, "requestPointerLock", {
      configurable: true,
      value: vi.fn().mockRejectedValue(new DOMException("Permission denied")),
    });

    await expect(requestPointerLockSafely(element)).resolves.toBe(false);
  });
});

describe("exitPointerLockSafely", () => {
  it("supports both void and promise-based exit methods", async () => {
    setExitPointerLock(vi.fn(() => undefined));
    await expect(exitPointerLockSafely()).resolves.toBe(true);

    setExitPointerLock(vi.fn().mockResolvedValue(undefined));
    await expect(exitPointerLockSafely()).resolves.toBe(true);
  });

  it("returns false when exit is unsupported, throws, or rejects", async () => {
    setExitPointerLock(undefined);
    await expect(exitPointerLockSafely()).resolves.toBe(false);

    setExitPointerLock(() => {
      throw new DOMException("Exit blocked");
    });
    await expect(exitPointerLockSafely()).resolves.toBe(false);

    setExitPointerLock(() => Promise.reject(new DOMException("Exit rejected")));
    await expect(exitPointerLockSafely()).resolves.toBe(false);
  });
});

describe("isPointerLockedTo", () => {
  it("only reports a lock owned by the specified element", () => {
    const element = document.createElement("div");
    const otherElement = document.createElement("div");

    setPointerLockElement(element);
    expect(isPointerLockedTo(element)).toBe(true);
    expect(isPointerLockedTo(otherElement)).toBe(false);

    setPointerLockElement(null);
    expect(isPointerLockedTo(element)).toBe(false);
  });
});
