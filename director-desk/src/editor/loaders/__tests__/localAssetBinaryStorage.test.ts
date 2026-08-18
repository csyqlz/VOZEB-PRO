import { describe, expect, it, vi } from "vitest";
import {
  createLocalAssetBinaryStorage,
  createStoredAssetUrl,
  getStoredAssetKey,
  type LocalAssetBinaryBackend,
  type LocalAssetBinaryRecord,
} from "../localAssetBinaryStorage";

function createMemoryBackend() {
  const records = new Map<string, LocalAssetBinaryRecord>();
  const backend: LocalAssetBinaryBackend = {
    put: vi.fn(async (record) => { records.set(record.key, record); }),
    get: vi.fn(async (key) => records.get(key) ?? null),
    delete: vi.fn(async (key) => { records.delete(key); }),
  };
  return { backend, records };
}

describe("local asset binary storage", () => {
  it("stores model bytes outside the project JSON and restores them by stable key", async () => {
    const { backend } = createMemoryBackend();
    const storage = createLocalAssetBinaryStorage(backend);
    const file = new File(["model-bytes"], "actor.glb", { type: "model/gltf-binary" });

    const saved = await storage.save(file, "actor-key");
    const restored = await storage.read("actor-key");

    expect(saved).toMatchObject({ key: "actor-key", fileName: "actor.glb", byteLength: 11 });
    expect(restored?.blob).toBe(file);
    expect(createStoredAssetUrl(saved.key)).toBe("director-asset://local/actor-key");
    expect(getStoredAssetKey(createStoredAssetUrl(saved.key))).toBe("actor-key");
  });

  it("removes one stored binary without touching other assets", async () => {
    const { backend, records } = createMemoryBackend();
    const storage = createLocalAssetBinaryStorage(backend);
    await storage.save(new File(["a"], "a.fbx"), "a");
    await storage.save(new File(["b"], "b.fbx"), "b");

    await storage.remove("a");
    expect(records.has("a")).toBe(false);
    expect(records.has("b")).toBe(true);
  });

  it("reports unavailable storage clearly instead of silently losing a file", async () => {
    const storage = createLocalAssetBinaryStorage(null);
    expect(storage.isAvailable).toBe(false);
    await expect(storage.save(new File(["x"], "x.fbx"))).rejects.toThrow("当前浏览器不支持大型本地模型存储");
  });
});
