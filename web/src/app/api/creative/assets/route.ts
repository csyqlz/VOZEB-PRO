import { NextResponse } from "next/server";

import { requireVozebCmsCapability } from "@/app/api/vozeb-cms-capability";
import { getCurrentUser } from "@/lib/auth/session";
import { CREATIVE_UPLOAD_MAX_BYTES } from "@/lib/creative-upload";
import { CreativeRuntimeServiceError, uploadAssetForUser } from "@/lib/server/creative-runtime-service";
import { readRequestBodyBytes, RequestBodyTooLargeError } from "@/lib/server/request-body-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_UPLOAD_REQUEST_BYTES = CREATIVE_UPLOAD_MAX_BYTES + 64 * 1024;

export async function POST(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const blocked = await requireVozebCmsCapability("asset.manage", user.id);
    if (blocked) return blocked;
    try {
        const contentType = request.headers.get("content-type") || "";
        if (!contentType.toLowerCase().includes("multipart/form-data")) throw new CreativeRuntimeServiceError("上传内容格式不正确", 400);
        let form: FormData;
        try {
            const bytes = await readRequestBodyBytes(request, MAX_UPLOAD_REQUEST_BYTES);
            form = await new Request(request.url, { method: "POST", headers: { "content-type": contentType }, body: bytes }).formData();
        } catch (error) {
            if (error instanceof RequestBodyTooLargeError) throw error;
            throw new CreativeRuntimeServiceError("上传内容格式不正确", 400);
        }
        const conversationId = String(form.get("conversationId") || "").trim();
        const file = form.get("file");
        if (!conversationId) throw new CreativeRuntimeServiceError("创作会话不能为空", 400);
        if (!(file instanceof File)) throw new CreativeRuntimeServiceError("请选择上传文件", 400);
        const asset = await uploadAssetForUser(user.id, conversationId, file);
        return NextResponse.json({ code: 0, data: { asset }, msg: "素材已上传" });
    } catch (error) {
        if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ code: error.status, data: null, msg: "单个素材不能超过 20MB" }, { status: error.status });
        if (error instanceof CreativeRuntimeServiceError) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        throw error;
    }
}
