import { NextResponse } from "next/server";

import { readJsonBody } from "@/lib/auth/request";
import { getCurrentUser } from "@/lib/auth/session";
import { isAuthInputError } from "@/lib/auth/store";
import { CREATE_AGENT_PROMPT_MAX_LENGTH } from "@/lib/create-agent-prompt";
import type { CreativeGenerationMode } from "@/lib/creative-runtime-contract";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { optimizeCreativePrompt, PromptOptimizationError } from "@/lib/server/prompt-optimization-service";
import { checkGenerationRateLimit, rateLimitHeaders } from "@/lib/server/security";
import { requireVozebCmsCapability } from "@/app/api/vozeb-cms-capability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;

type PromptOptimizationBody = { requestId?: unknown; prompt?: unknown; mode?: unknown };
const modes = new Set(["agent", "image", "video", "audio"]);

export async function POST(request: Request) {
    const user = await getCurrentUser(request);
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    const blocked = await requireVozebCmsCapability("agent.run", user.id);
    if (blocked) return blocked;
    const rate = await checkGenerationRateLimit(user.id, request, "text");
    if (!rate.allowed) return NextResponse.json({ code: 429, data: null, msg: "优化请求过于频繁，请稍后重试" }, { status: 429, headers: rateLimitHeaders(rate) });

    let body: PromptOptimizationBody;
    try {
        body = await readJsonBody(request);
    } catch (error) {
        if (isAuthInputError(error)) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        throw error;
    }
    const requestId = text(body.requestId, 160);
    const prompt = text(body.prompt, CREATE_AGENT_PROMPT_MAX_LENGTH);
    const mode = modes.has(String(body.mode || "")) ? (body.mode as "agent" | CreativeGenerationMode) : "agent";
    if (!requestId || !prompt) return NextResponse.json({ code: 400, data: null, msg: "请先输入需要优化的提示词" }, { status: 400 });

    try {
        const optimizedPrompt = await optimizeCreativePrompt({
            origin: resolveInternalOrigin(new URL(request.url).origin),
            cookie: request.headers.get("cookie") || "",
            userId: user.id,
            requestId,
            prompt,
            mode,
        });
        return NextResponse.json({ code: 0, data: { prompt: optimizedPrompt }, msg: "OK" });
    } catch (error) {
        const status = error instanceof PromptOptimizationError ? error.status : 502;
        const message = error instanceof PromptOptimizationError ? error.message : "提示词优化失败，请稍后重试";
        return NextResponse.json({ code: status, data: null, msg: message }, { status });
    }
}

function text(value: unknown, maxLength: number) {
    return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}
