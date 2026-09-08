import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBody } from "@/lib/auth/request";
import { getAuthSettings, isAuthInputError, refundUserPoints } from "@/lib/auth/store";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { resolveLogicalModelCandidates } from "@/lib/server/logical-model-router";
import { checkRateLimit } from "@/lib/server/security";
import { toSafeGenerationErrorMessage } from "@/lib/server/generation-errors";
import { hasSystemAiCharge, readSystemAiBilling, systemAiBillingHeaders, systemAiIdempotencyKey } from "@/lib/server/system-ai-billing";
import { isStructuredTextFailure, rankTextPlanningCandidates, requestStructuredText, type TextPlanningCandidate } from "@/lib/server/text-planning-runtime";

export const runtime = "nodejs";

const adaptTool = {
    name: "adapt_novel_chapter",
    description: "把一个小说章节的正文改编成可拍摄的短剧剧本体，并输出供下一章衔接的剧情摘要",
    parameters: {
        type: "object",
        properties: {
            script: { type: "string", description: "改编后的剧本体正文" },
            summary: { type: "string", description: "本章剧情摘要（2-3 句），供下一章改编保持连贯" },
        },
        required: ["script", "summary"],
    },
} as const;

type NovelAdaptBody = {
    requestId?: string;
    textModel?: string;
    chapterTitle?: string;
    chapterText?: string;
    previousSummary?: string;
    style?: string;
};

const MAX_CHAPTER_CHARACTERS = 20_000;

export async function POST(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    if (!(await checkRateLimit(`drama-novel:${user.id}`, { maxRequests: 20, windowMs: 60_000 })).allowed) return NextResponse.json({ code: 429, data: null, msg: "小说改编请求过于频繁，请稍后重试" }, { status: 429 });
    let body: NovelAdaptBody;
    try {
        body = await readJsonBody(request, 2 * 1024 * 1024);
    } catch (error) {
        if (isAuthInputError(error)) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        throw error;
    }
    const requestId = text(body.requestId);
    if (!requestId || requestId.length > 200) return NextResponse.json({ code: 400, data: null, msg: "小说改编请求标识无效" }, { status: 400 });
    const chapterTitle = text(body.chapterTitle);
    const chapterText = text(body.chapterText);
    if (chapterText.length < 50) return NextResponse.json({ code: 400, data: null, msg: "章节正文过短，无法改编" }, { status: 400 });
    if (chapterText.length > MAX_CHAPTER_CHARACTERS) return NextResponse.json({ code: 400, data: null, msg: `章节正文超过 ${MAX_CHAPTER_CHARACTERS} 字，请先拆分章节` }, { status: 400 });
    const previousSummary = text(body.previousSummary).slice(0, 2_000);
    const style = text(body.style).slice(0, 2_000);

    const settings = await getAuthSettings();
    const requestedModel = text(body.textModel);
    if (!requestedModel) return NextResponse.json({ code: 400, data: null, msg: "请选择小说改编使用的文本模型" }, { status: 400 });
    if (requestedModel !== settings.defaultModels.textModel && !resolveLogicalModelCandidates(settings, "text", requestedModel).length) {
        return NextResponse.json({ code: 400, data: null, msg: `文本模型 ${requestedModel} 不可用，请重新选择` }, { status: 400 });
    }
    const candidates = resolveLogicalModelCandidates(settings, "text", requestedModel);
    if (!candidates.length) return NextResponse.json({ code: 400, data: null, msg: "所选文本模型当前不可用" }, { status: 400 });

    const systemPrompt = [
        "你是短剧改编编剧。把用户给到的小说章节正文改编成可拍摄的短剧剧本体，规则：",
        "1. 剧本按场景划分为多个「第X场：场景名」，每场开头用一行说明地点与时间。",
        "2. 动作与画面描写用「画面：」开头，只写镜头能拍到的内容，不写心理描写和文学修辞。",
        "3. 角色对白逐句保留小说原话，格式为「角色名：台词」；禁止把多句对白压缩成转述或说明。",
        "4. 必要的衔接叙述转为「旁白：」，每场最多一句。",
        "5. 完整覆盖本章全部主要情节与冲突，按原文顺序推进，不删减事件、不添加原文没有的人物或转折。",
        previousSummary ? "6. 结合「前情提要」保持人物、道具和情节连续。" : "6. 从本章出发完整改编。",
        `必须调用 ${adaptTool.name}，script 字段是改编后的剧本体，summary 字段用 2-3 句话概括本章主要事件、出场人物与结尾悬念。不要使用 Markdown、代码围栏或额外文字。`,
    ].join("\n");
    const messages = [
        { role: "system", content: systemPrompt },
        {
            role: "user",
            content: JSON.stringify({
                章节标题: chapterTitle || "（未命名章节）",
                ...(previousSummary ? { 前情提要: previousSummary } : {}),
                ...(style ? { 整体风格: style } : {}),
                章节正文: chapterText,
            }),
        },
    ];

    let latestError: unknown;
    try {
        for (const candidate of rankTextPlanningCandidates(candidates.map((item) => ({ ...item, channelId: item.channel.id })))) {
            try {
                const idempotencyKey = systemAiIdempotencyKey("drama-novel", user.id, "adapt", requestId, chapterTitle, candidate.channel.id, candidate.upstreamModel);
                const headers = { "Content-Type": "application/json", cookie: request.headers.get("cookie") || "", ...systemAiBillingHeaders(requestedModel, `${idempotencyKey}:tool`, candidate.upstreamModel) };
                const fallbackHeaders = { "Content-Type": "application/json", cookie: request.headers.get("cookie") || "", ...systemAiBillingHeaders(requestedModel, `${idempotencyKey}:json`, candidate.upstreamModel) };
                const call = await requestStructuredText({
                    origin: resolveInternalOrigin(new URL(request.url).origin),
                    cookie: request.headers.get("cookie") || "",
                    candidate,
                    messages,
                    tool: adaptTool,
                    headers,
                    fallbackHeaders,
                    preferNativeTools: false,
                    allowRepair: true,
                    stream: true,
                    streamFallback: true,
                    signal: request.signal,
                    overallDeadlineMs: 180_000,
                    validateArguments: (argumentsText) => usableAdaptation(argumentsText),
                    onInvalidResponse: async (responseHeaders) => {
                        await refund(user.id, requestedModel, responseHeaders);
                    },
                });
                const parsed = parseAdaptation(call.arguments);
                if (!parsed) throw new Error("模型没有返回可用的改编结果");
                const response = NextResponse.json({ code: 0, data: parsed, msg: "章节改编完成" });
                const remaining = Number(call.headers.get("x-vozeb-pro-points-remaining"));
                if (Number.isFinite(remaining)) response.headers.set("x-vozeb-pro-points-remaining", String(remaining));
                return response;
            } catch (error) {
                latestError = error;
                if (!shouldTryAnotherCandidate(error)) break;
                console.warn("[drama-novel] switching candidate", JSON.stringify({ requestId, failedChannel: candidate.channelId, failedModel: candidate.upstreamModel, reason: error instanceof Error ? error.message : String(error) }));
            }
        }
        throw latestError instanceof Error ? latestError : new Error("没有可用的文本模型渠道");
    } catch (error) {
        console.error(
            "[drama-novel] request failed",
            JSON.stringify({ requestId, chapterTitle, chapterCharacters: chapterText.length, errorName: error instanceof Error ? error.name : typeof error, message: error instanceof Error ? error.message : String(error) }),
        );
        return NextResponse.json({ code: 502, data: null, msg: toSafeGenerationErrorMessage(error, "小说改编失败") }, { status: 502 });
    }
}

function shouldTryAnotherCandidate(error: unknown) {
    if (isStructuredTextFailure(error)) return error.failureCode === "invalid-response-json";
    const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
    return status >= 500 || status === 408 || status === 429;
}

function usableAdaptation(argumentsText: string) {
    const parsed = parseAdaptation(argumentsText);
    return Boolean(parsed && parsed.script.length >= 100 && parsed.summary.length >= 10);
}

function parseAdaptation(argumentsText: string): { script: string; summary: string } | null {
    try {
        const parsed = JSON.parse(argumentsText) as { script?: unknown; summary?: unknown };
        const script = typeof parsed.script === "string" ? parsed.script.trim() : "";
        const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
        if (!script || !summary) return null;
        return { script, summary: summary.slice(0, 600) };
    } catch {
        return null;
    }
}

function refund(userId: string, model: string, headers: Headers) {
    const billing = readSystemAiBilling(headers);
    return hasSystemAiCharge(billing) ? refundUserPoints(userId, model, billing.pointsCost, "text", 1, undefined, billing.pointsRecordId) : null;
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}
