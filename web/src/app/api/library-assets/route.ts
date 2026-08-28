import { NextResponse } from "next/server";
import { requireVozebCmsCapability } from "@/app/api/vozeb-cms-capability";

import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { createLibraryAssetForUser, LibraryAssetServiceError, listLibraryAssetPageForUser } from "@/lib/server/library-asset-service";

export async function GET(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const params = new URL(request.url).searchParams;
    const page = await listLibraryAssetPageForUser(user.id, {
        page: params.get("page"),
        pageSize: params.get("pageSize"),
        kind: params.get("kind"),
        keyword: params.get("keyword"),
    });
    return NextResponse.json({ code: 0, data: { assets: page.items, total: page.total, page: page.page, pageSize: page.pageSize }, msg: "OK" });
}

export async function POST(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const blocked = await requireVozebCmsCapability("asset.manage", user.id);
    if (blocked) return blocked;
    try {
        const parsed = await readJsonBodyResult<unknown>(request);
        if (!parsed.ok) return NextResponse.json({ code: parsed.status, data: null, msg: parsed.message }, { status: parsed.status });
        const asset = await createLibraryAssetForUser(user.id, parsed.data);
        return NextResponse.json({ code: 0, data: { asset }, msg: "素材已保存" });
    } catch (error) {
        return serviceError(error);
    }
}

function serviceError(error: unknown) {
    if (error instanceof LibraryAssetServiceError) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
    throw error;
}
