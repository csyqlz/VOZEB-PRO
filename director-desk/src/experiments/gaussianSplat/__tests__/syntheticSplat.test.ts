import { describe, expect, it } from "vitest";
import {
  ANTISPLAT_BYTES_PER_SPLAT,
  createSyntheticKsplatData,
  createSyntheticPlyData,
  createSyntheticSplatData,
} from "../syntheticSplat";

describe("synthetic gaussian splat fixture", () => {
  it("creates deterministic 32-byte .splat records", () => {
    const first = createSyntheticSplatData(20);
    const second = createSyntheticSplatData(20);
    expect(first).toHaveLength(20 * ANTISPLAT_BYTES_PER_SPLAT);
    expect(first).toEqual(second);
  });

  it("writes finite positions, positive scales, color and identity quaternion", () => {
    const bytes = createSyntheticSplatData(1);
    const view = new DataView(bytes.buffer);
    expect([0, 4, 8].map((offset) => view.getFloat32(offset, true)).every(Number.isFinite)).toBe(true);
    expect([12, 16, 20].map((offset) => view.getFloat32(offset, true)).every((value) => value > 0)).toBe(true);
    expect(bytes.slice(28, 32)).toEqual(new Uint8Array([255, 128, 128, 128]));
  });
});

it("creates a binary 3DGS PLY fixture with the declared point count", () => {
  const bytes = createSyntheticPlyData(3);
  const header = new TextDecoder().decode(bytes.subarray(0, 600));
  expect(header).toContain("format binary_little_endian 1.0");
  expect(header).toContain("element vertex 3");
  expect(header).toContain("property float rot_3");
  expect(header).toContain("end_header");
});

it("creates an uncompressed KSPLAT 0.1 fixture with one section", () => {
  const bytes = createSyntheticKsplatData(3);
  const view = new DataView(bytes.buffer);
  expect([bytes[0], bytes[1]]).toEqual([0, 1]);
  expect(view.getUint32(4, true)).toBe(1);
  expect(view.getUint32(16, true)).toBe(3);
  expect(bytes).toHaveLength(4_096 + 1_024 + 3 * 44);
  expect(view.getFloat32(4_096 + 1_024 + 24, true)).toBeCloseTo(0.9921875);
  expect(view.getFloat32(4_096 + 1_024 + 28, true)).toBe(0);
});
