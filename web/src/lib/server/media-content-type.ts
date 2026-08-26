import { fileTypeFromBuffer } from "file-type";

export async function resolveMediaMimeType(bytes: Buffer, type: "image" | "video", declaredMime?: string | null) {
    const detectedMime = (await fileTypeFromBuffer(bytes))?.mime?.toLowerCase() || "";
    if (detectedMime.startsWith(`${type}/`)) return detectedMime;

    const normalizedDeclaredMime = declaredMime?.split(";", 1)[0]?.trim().toLowerCase() || "";
    if (!normalizedDeclaredMime) return type === "video" ? "video/mp4" : "image/png";
    return normalizedDeclaredMime.startsWith(`${type}/`) ? normalizedDeclaredMime : "";
}
