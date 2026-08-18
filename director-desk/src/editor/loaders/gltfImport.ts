export async function readGltfFile(file: File) {
  return {
    id: crypto.randomUUID(),
    fileName: file.name,
    name: file.name.replace(/\.(glb|gltf)$/i, ""),
    url: URL.createObjectURL(file),
  };
}
