import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { DRAMA_PROJECT_MAX_BYTES } from "@/lib/drama-project-contract";
import { applyDramaVisualResultForUser, DramaProjectServiceError } from "@/lib/server/drama-project-service";

type Context = { params: Promise<{ id: string; episodeId: string }> };

export async function POST(request: Request, context: Context) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const parsed = await readJsonBodyResult<unknown>(request, DRAMA_PROJECT_MAX_BYTES);
    if (!parsed.ok) return NextResponse.json({ code: parsed.status, data: null, msg: parsed.message }, { status: parsed.status });
    const { id, episodeId } = await context.params;
    try {
        const result = await applyDramaVisualResultForUser(user.id, id, episodeId, parsed.data);
        const episode = result.project.episodes.find((item) => item.id === episodeId)!;
        return NextResponse.json({ code: 0, data: { episode, projectUpdatedAt: result.project.updatedAt, version: result.version }, msg: "视觉方案已保存" });
    } catch (error) {
        if (error instanceof DramaProjectServiceError) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        throw error;
    }
}
