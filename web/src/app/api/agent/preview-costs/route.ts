import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBodyResult } from "@/lib/auth/request";
import { CREATIVE_RUN_MODEL_LIMIT, CreativeRuntimeInputError, normalizeCreativeGenerationPreferences } from "@/lib/creative-runtime-contract";
import { previewCreativeDirectCosts } from "@/lib/server/creative-cost-preview-service";

export async function POST(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    try {
        const parsed = await readJsonBodyResult<unknown>(request);
        if (!parsed.ok) return NextResponse.json({ code: parsed.status, data: null, msg: parsed.message }, { status: parsed.status });
        const body = parsed.data;
        const input = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
        const modelIds: unknown[] = Array.isArray(input.modelIds) ? input.modelIds : [];
        if (!modelIds.length || modelIds.length > CREATIVE_RUN_MODEL_LIMIT || modelIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 160) || new Set(modelIds).size !== modelIds.length)
            throw new CreativeRuntimeInputError("请选择有效的模型");
        const preview = await previewCreativeDirectCosts(modelIds as string[], normalizeCreativeGenerationPreferences(input.preferences), input.hasImageReferences === true);
        return NextResponse.json({ code: 0, data: { preview }, msg: "OK" }, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
        if (error instanceof CreativeRuntimeInputError) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        throw error;
    }
}
