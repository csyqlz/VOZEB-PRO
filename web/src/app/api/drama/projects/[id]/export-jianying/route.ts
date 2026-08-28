import { NextResponse } from "next/server";
import { requireVozebCmsCapability } from "@/app/api/vozeb-cms-capability";

import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { exportDramaEpisodeAsJianying, DramaJianyingExportError } from "@/lib/server/drama-jianying-export";
import { getDramaProjectForUser, DramaProjectServiceError } from "@/lib/server/drama-project-service";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const blocked = await requireVozebCmsCapability("drama.project.manage", user.id);
    if (blocked) return blocked;
    try {
        const parsed = await readJsonBodyResult<{ episodeId?: string; draftPath?: string; version?: string }>(request);
        if (!parsed.ok) return NextResponse.json({ code: parsed.status, data: null, msg: parsed.message }, { status: parsed.status });
        const body = parsed.data;
        const project = await getDramaProjectForUser(user.id, (await context.params).id);
        const episode = project.episodes.find((item) => item.id === String(body.episodeId || ""));
        if (!episode) return NextResponse.json({ code: 404, data: null, msg: "短剧剧集不存在" }, { status: 404 });
        const result = await exportDramaEpisodeAsJianying({
            project,
            episode,
            draftPath: String(body.draftPath || ""),
            version: body.version === "5" ? "5" : "6",
            origin: resolveInternalOrigin(new URL(request.url).origin),
            cookie: request.headers.get("cookie") || "",
        });
        return new Response(result.data, {
            headers: {
                "Content-Type": "application/zip",
                "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
                "Content-Length": String(result.data.byteLength),
            },
        });
    } catch (error) {
        if (error instanceof DramaProjectServiceError || error instanceof DramaJianyingExportError) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        console.error("jianying draft export failed", error);
        return NextResponse.json({ code: 500, data: null, msg: "剪映草稿导出失败" }, { status: 500 });
    }
}
