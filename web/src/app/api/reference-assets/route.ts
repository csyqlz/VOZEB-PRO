import { NextResponse } from "next/server";
import { fileTypeFromBuffer } from "file-type";

import { getCurrentUser } from "@/lib/auth/session";
import { CREATIVE_UPLOAD_MAX_BYTES, isCreativeUploadMimeType } from "@/lib/creative-upload";
import { writePersistentMediaDataUrl, writeReferenceMediaDataUrl } from "@/lib/server/reference-asset-store";
import { readJsonBodyResult } from "@/lib/auth/request";
import { createSignedReferenceAssetUrl } from "@/lib/server/reference-asset-access";
import { resolvePublicRequestOrigin } from "@/lib/server/public-request-origin";
import { readRequestBodyBytes, RequestBodyTooLargeError } from "@/lib/server/request-body-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_MULTIPART_BYTES = CREATIVE_UPLOAD_MAX_BYTES + 64 * 1024;

type UploadInput = { dataUrl: string; type: "image" | "video" | "audio"; persistent: boolean; originalName?: string };

export async function POST(request: Request) {
    const currentUser = await getCurrentUser(request);
    if (!currentUser) return NextResponse.json({ error: "请先登录" }, { status: 401 });

    try {
        const input = await readUploadInput(request);
        const context = {
            ownerUserId: currentUser.id,
            source: "user-upload",
            originalName: input.originalName,
            maxBytes: CREATIVE_UPLOAD_MAX_BYTES,
        };
        const asset = input.persistent ? await writePersistentMediaDataUrl(input.dataUrl, input.type, context) : await writeReferenceMediaDataUrl(input.dataUrl, input.type, context);
        const origin = resolvePublicRequestOrigin(request);
        const browserUrl = `/api/reference-assets/${asset.token
            .split("/")
            .map((part) => encodeURIComponent(part))
            .join("/")}`;
        return NextResponse.json({
            url: browserUrl,
            upstreamUrl: asset.url || createSignedReferenceAssetUrl(asset.token, origin, currentUser.id) || undefined,
            token: asset.token,
            key: asset.token,
            storage: asset.storage,
            bytes: asset.bytes,
            mimeType: asset.mimeType,
        });
    } catch (error) {
        const status = error instanceof RequestBodyTooLargeError ? error.status : error instanceof UploadInputError ? error.status : 400;
        return NextResponse.json({ error: error instanceof Error ? error.message : "参考图临时保存失败" }, { status });
    }
}

async function readUploadInput(request: Request): Promise<UploadInput> {
    const contentType = request.headers.get("content-type") || "";
    if (contentType.toLowerCase().includes("multipart/form-data")) {
        let form: FormData;
        try {
            const bytes = await readRequestBodyBytes(request, MAX_MULTIPART_BYTES);
            form = await new Request(request.url, { method: "POST", headers: { "content-type": contentType }, body: bytes }).formData();
        } catch (error) {
            if (error instanceof RequestBodyTooLargeError) throw new RequestBodyTooLargeError("单个文件不能超过 20MB");
            throw new UploadInputError("上传内容格式不正确");
        }
        const file = form.get("file");
        if (!(file instanceof File) || !file.size) throw new UploadInputError("缺少参考素材");
        if (file.size > CREATIVE_UPLOAD_MAX_BYTES) throw new RequestBodyTooLargeError("单个文件不能超过 20MB");
        const type = mediaType(form.get("type"));
        const bytes = Buffer.from(await file.arrayBuffer());
        const mimeType = await resolveMultipartMimeType(bytes, type, file.type);
        const dataUrl = `data:${mimeType};base64,${bytes.toString("base64")}`;
        return { dataUrl, type, persistent: String(form.get("persistent") || "") === "true", originalName: file.name || undefined };
    }

    const result = await readJsonBodyResult<{ dataUrl?: unknown; type?: unknown; persistent?: unknown; originalName?: unknown }>(request, 28 * 1024 * 1024);
    if (!result.ok) throw result.status === 413 ? new RequestBodyTooLargeError(result.message) : new UploadInputError(result.message, result.status);
    const dataUrl = typeof result.data.dataUrl === "string" ? result.data.dataUrl : "";
    if (!dataUrl) throw new UploadInputError("缺少参考素材");
    return {
        dataUrl,
        type: mediaType(result.data.type),
        persistent: result.data.persistent === true,
        originalName: typeof result.data.originalName === "string" ? result.data.originalName : undefined,
    };
}

async function resolveMultipartMimeType(bytes: Buffer, type: UploadInput["type"], declaredMime: string) {
    const detectedMime = (await fileTypeFromBuffer(bytes))?.mime?.toLowerCase() || "";
    if (detectedMime) {
        if (!isCreativeUploadMimeType(detectedMime) || !detectedMime.startsWith(`${type}/`)) throw new UploadInputError("参考素材格式不正确");
        return detectedMime;
    }
    const normalizedDeclaredMime = declaredMime.split(";", 1)[0]?.trim().toLowerCase() || "";
    if (!isCreativeUploadMimeType(normalizedDeclaredMime) || !normalizedDeclaredMime.startsWith(`${type}/`)) throw new UploadInputError("参考素材格式不正确");
    return normalizedDeclaredMime;
}

function mediaType(value: FormDataEntryValue | unknown): UploadInput["type"] {
    return value === "video" || value === "audio" ? value : "image";
}

class UploadInputError extends Error {
    constructor(
        message: string,
        readonly status = 400,
    ) {
        super(message);
    }
}
