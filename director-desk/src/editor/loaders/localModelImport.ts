import type { DirectorModelFormat } from "../schema/directorProject";
import { createStoredAssetUrl, localAssetBinaryStorage } from "./localAssetBinaryStorage";

const LOCAL_MODEL_EXTENSION_RE = /\.(fbx|obj|glb)$/i;

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }

      reject(new Error("模型文件读取失败"));
    });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("模型文件读取失败")));
    reader.readAsDataURL(file);
  });
}

export async function readLocalModelFile(file: File) {
  const format = file.name.match(LOCAL_MODEL_EXTENSION_RE)?.[1]?.toLowerCase() as DirectorModelFormat | undefined;
  if (!format) throw new Error("当前仅支持 FBX / OBJ / GLB 模型文件");

  if (localAssetBinaryStorage.isAvailable) {
    const stored = await localAssetBinaryStorage.save(file);
    return {
      id: stored.key,
      fileName: file.name,
      name: file.name.replace(LOCAL_MODEL_EXTENSION_RE, ""),
      url: createStoredAssetUrl(stored.key),
      storageKey: stored.key,
      byteLength: stored.byteLength,
      modelFormat: format,
    };
  }

  return {
    id: crypto.randomUUID(),
    fileName: file.name,
    name: file.name.replace(LOCAL_MODEL_EXTENSION_RE, ""),
    url: await readFileAsDataUrl(file),
    byteLength: file.size,
    modelFormat: format,
  };
}
