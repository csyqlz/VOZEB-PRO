import { getCanvasProjectForUser } from "@/lib/server/canvas-project-service";
import { getCreativeConversation } from "@/lib/server/creative-runtime-store";
import { getDramaProjectForUser } from "@/lib/server/drama-project-service";
import { normalizeVozebCmsProjectRef, type VozebCmsProjectRef } from "@/lib/vozeb-cms/project-ref";

export class VozebCmsProjectRefError extends Error {
    constructor(
        message: string,
        readonly status = 400,
    ) {
        super(message);
    }
}

export async function resolveVozebCmsProjectRef(userId: string, value: unknown, required = true): Promise<VozebCmsProjectRef | undefined> {
    const ref = normalizeVozebCmsProjectRef(value, userId);
    if (!ref) {
        if (required) throw new VozebCmsProjectRefError("项目引用无效", 400);
        return undefined;
    }
    const exists = ref.type === "canvas" ? await getCanvasProjectForUser(userId, ref.id) : ref.type === "drama" ? await getDramaProjectForUser(userId, ref.id) : await getCreativeConversation(ref.id, userId);
    if (!exists) throw new VozebCmsProjectRefError("项目不存在或无权访问", 404);
    return ref;
}
