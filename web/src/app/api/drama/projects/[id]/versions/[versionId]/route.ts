import { NextResponse } from "next/server";
import { requireVozebCmsCapability } from "@/app/api/vozeb-cms-capability";

import { getCurrentUser } from "@/lib/auth/session";
import { deleteDramaProjectVersionForUser, DramaProjectServiceError, restoreDramaProjectVersionForUser } from "@/lib/server/drama-project-service";

type Context = { params: Promise<{ id: string; versionId: string }> };

export async function POST(_: Request, context: Context) {
    return handle(
        context,
        async (userId, id, versionId) => {
            const project = await restoreDramaProjectVersionForUser(userId, id, versionId);
            return NextResponse.json({ code: 0, data: { project }, msg: "短剧版本已恢复" });
        },
        "drama.project.manage",
    );
}

export async function DELETE(_: Request, context: Context) {
    return handle(
        context,
        async (userId, id, versionId) => {
            const result = await deleteDramaProjectVersionForUser(userId, id, versionId);
            return NextResponse.json({ code: 0, data: result, msg: "短剧版本已删除" });
        },
        "drama.project.manage",
    );
}

async function handle(context: Context, action: (userId: string, id: string, versionId: string) => Promise<NextResponse>, capabilityId?: string) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    if (capabilityId) {
        const blocked = await requireVozebCmsCapability(capabilityId, user.id);
        if (blocked) return blocked;
    }
    try {
        const { id, versionId } = await context.params;
        return await action(user.id, id, versionId);
    } catch (error) {
        if (error instanceof DramaProjectServiceError) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        throw error;
    }
}
