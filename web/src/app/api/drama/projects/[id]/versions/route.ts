import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { DRAMA_PROJECT_MAX_BYTES } from "@/lib/drama-project-contract";
import { createDramaProjectVersionForUser, DramaProjectServiceError, listDramaProjectVersionsForUser } from "@/lib/server/drama-project-service";

type Context = { params: Promise<{ id: string }> };

export async function GET(_: Request, context: Context) {
    return handle(context, (userId, id) => listDramaProjectVersionsForUser(userId, id).then((versions) => NextResponse.json({ code: 0, data: { versions }, msg: "OK" })));
}

export async function POST(request: Request, context: Context) {
    const parsed = await readJsonBodyResult<unknown>(request, DRAMA_PROJECT_MAX_BYTES);
    if (!parsed.ok) return NextResponse.json({ code: parsed.status, data: null, msg: parsed.message }, { status: parsed.status });
    const body = parsed.data;
    return handle(context, (userId, id) => createDramaProjectVersionForUser(userId, id, body).then((version) => NextResponse.json({ code: 0, data: { version }, msg: "短剧版本已保存" })));
}

async function handle(context: Context, action: (userId: string, id: string) => Promise<NextResponse>) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    try {
        return await action(user.id, (await context.params).id);
    } catch (error) {
        if (error instanceof DramaProjectServiceError) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        throw error;
    }
}
