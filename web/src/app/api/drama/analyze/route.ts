import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBody } from "@/lib/auth/request";
import { getAuthSettings, isAuthInputError, refundUserPoints } from "@/lib/auth/store";
import { describeDramaAnalysisCandidate, describeDramaModelOutput, dramaContentTool, dramaVisualTool, hasUsableDramaToolArguments, normalizeDramaContentAnalysis, normalizeDramaVisualAnalysis } from "@/lib/server/drama-analysis";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { resolveLogicalModelCandidates } from "@/lib/server/logical-model-router";
import { checkRateLimit } from "@/lib/server/security";
import { toSafeGenerationErrorMessage } from "@/lib/server/generation-errors";
import { hasSystemAiCharge, readSystemAiBilling, systemAiBillingHeaders, systemAiIdempotencyKey, type SystemAiBilling } from "@/lib/server/system-ai-billing";
import { rankTextPlanningCandidates, requestStructuredText, type TextPlanningCandidate } from "@/lib/server/text-planning-runtime";
import { dramaAnalysisText, normalizeDramaVisualInput, type DramaAnalyzeBody } from "@/lib/server/drama-analysis-input";

export const runtime = "nodejs";

export async function POST(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: 401, data: null, msg: "请先登录" }, { status: 401 });
    if (!(await checkRateLimit(`drama-analyze:${user.id}`, { maxRequests: 10, windowMs: 60_000 })).allowed) return NextResponse.json({ code: 429, data: null, msg: "剧本解析过于频繁，请稍后重试" }, { status: 429 });
    let body: DramaAnalyzeBody;
    try {
        body = await readJsonBody(request, 8 * 1024 * 1024);
    } catch (error) {
        if (isAuthInputError(error)) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
        throw error;
    }
    const phase = body.phase === "visual" ? "visual" : "content";
    const script = dramaAnalysisText(body.script);
    if (phase === "content" && !script) return NextResponse.json({ code: 400, data: null, msg: "请先填写剧本" }, { status: 400 });

    const visualInput = phase === "visual" ? normalizeDramaVisualInput(body) : null;
    if (phase === "visual" && !visualInput?.shotIds.length) return NextResponse.json({ code: 400, data: null, msg: "请先完成内容审核" }, { status: 400 });

    const settings = await getAuthSettings();
    const model = settings.defaultModels.textModel;
    const candidates = resolveLogicalModelCandidates(settings, "text", model);
    if (!model || !candidates.length) return NextResponse.json({ code: 400, data: null, msg: "后台尚未配置可用的默认文本模型" }, { status: 400 });

    let refundedPointsRemaining: number | undefined;
    try {
        const tool = phase === "visual" ? dramaVisualTool : dramaContentTool;
        const input = phase === "visual" ? visualInput!.payload : { script, summary: dramaAnalysisText(body.summary) };
        const schemaInstruction = `即使渠道没有传递工具定义，也必须只返回符合以下 JSON Schema 的对象，不能返回输入对象，不能把 script 或 summary 作为顶层字段：${JSON.stringify(tool.parameters)}`;
        const messages = [
            {
                role: "system",
                content:
                    phase === "visual"
                        ? `你是影视视觉导演。输入内容已经由用户审核，必须严格保留每个 shotId、镜头数量、顺序、人物、场景、对白、旁白、原文和时长。为每个镜头补充图片提示词、视频提示词、起始/结束帧提示词、镜头运动和连续性数据；连续性必须明确景别、机位、构图、人物站位、视线、动作起止、屏幕运动方向和轴线规则。镜头之间要保持人物服装、道具、空间和视线关系连续。必须调用 design_drama_visuals。不要使用 Markdown。${schemaInstruction}`
                        : `你是影视剧本编辑。只提取剧本明确存在的内容事实和镜头边界，不生成 imagePrompt、videoPrompt、镜头运动或画面风格，不添加无依据的主要情节。必须逐句保留所有角色直接说出的原话和原文明示的旁白，utterances 按原文顺序列出每一句，禁止把多句台词压缩成“某人说明/表示/询问”的剧情摘要；说话人转换、明确动作反应或场景变化都应成为可审核的镜头边界，sourceText 必须保留对应连续原文。必须调用 analyze_drama_content。不要使用 Markdown。${schemaInstruction}`,
            },
            { role: "user", content: JSON.stringify(input) },
        ];
        let latestError: unknown;
        for (const candidate of rankTextPlanningCandidates(candidates.map((candidate) => ({ ...candidate, channelId: candidate.channel.id })))) {
            try {
                const call = await requestFunctionCall(
                    resolveInternalOrigin(new URL(request.url).origin),
                    request.headers.get("cookie") || "",
                    candidate,
                    model,
                    messages,
                    user.id,
                    tool,
                    systemAiIdempotencyKey("drama-analyze", user.id, phase, JSON.stringify(input), candidate.channel.id, candidate.upstreamModel),
                );
                try {
                    const parsed = JSON.parse(call.args);
                    const data = phase === "visual" ? normalizeDramaVisualAnalysis(parsed, visualInput!.shotIds) : normalizeDramaContentAnalysis(parsed, settings.generationDefaults.videoSeconds, script);
                    const resultCount = data.shots.length;
                    const expectedCount = phase === "visual" ? visualInput!.shotIds.length : 1;
                    if (!resultCount || (phase === "visual" && resultCount !== expectedCount)) {
                        console.error("[drama-analyze] normalized output invalid", JSON.stringify({ phase, channelId: candidate.channel.id, model: candidate.upstreamModel, resultCount, expectedCount, shape: describeDramaAnalysisCandidate(parsed) }));
                        throw new Error(phase === "visual" ? "模型没有为全部镜头生成视觉结构" : "模型没有生成有效内容结构");
                    }
                    const response = NextResponse.json({ code: 0, data, msg: phase === "visual" ? "视觉结构已生成" : "内容结构待审核" });
                    if (typeof call.pointsRemaining === "number") response.headers.set("x-vozeb-pro-points-remaining", String(call.pointsRemaining));
                    return response;
                } catch (error) {
                    if (hasSystemAiCharge(call)) refundedPointsRemaining = (await refund(user.id, model, call))?.pointsBalance;
                    throw error;
                }
            } catch (error) {
                latestError = error;
            }
        }
        throw latestError instanceof Error ? latestError : new Error("没有可用的文本模型渠道");
    } catch (error) {
        const response = NextResponse.json({ code: 502, data: null, msg: toSafeGenerationErrorMessage(error, "剧本分析失败") }, { status: 502 });
        if (typeof refundedPointsRemaining === "number") response.headers.set("x-vozeb-pro-points-remaining", String(refundedPointsRemaining));
        return response;
    }
}

async function requestFunctionCall(
    origin: string,
    cookie: string,
    candidate: TextPlanningCandidate,
    billingModel: string,
    messages: Array<{ role: string; content: string }>,
    userId: string,
    tool: { name: string; description: string; parameters: Record<string, unknown> },
    idempotencyKey: string,
) {
    const headers = { "Content-Type": "application/json", cookie, ...systemAiBillingHeaders(billingModel, idempotencyKey, candidate.upstreamModel) };
    const call = await requestStructuredText({
        origin,
        cookie,
        candidate,
        messages,
        tool,
        headers,
        onInvalidResponse: (responseHeaders) => refund(userId, billingModel, responseHeaders),
    });
    if (!hasUsableDramaToolArguments(call.arguments, tool.name)) {
        console.error("[drama-analyze] structured output invalid", JSON.stringify({ endpoint: call.protocol, channelId: candidate.channel.id, model: candidate.upstreamModel, argumentShape: describeArgumentsText(call.arguments) }));
        await refund(userId, billingModel, call.headers);
        throw new Error("模型没有返回结构化剧本结果");
    }
    return readCallResult(call.arguments, call.headers);
}

function readCallResult(args: string, headers: Headers) {
    const remaining = Number(headers.get("x-vozeb-pro-points-remaining"));
    return {
        args,
        pointsRemaining: Number.isFinite(remaining) ? remaining : undefined,
        ...readSystemAiBilling(headers),
    };
}

function describeArgumentsText(value: string) {
    if (!value) return { present: false };
    try {
        return { present: true, ...describeDramaAnalysisCandidate(JSON.parse(value)) };
    } catch {
        return { present: true, parseable: false };
    }
}

async function refund(userId: string, model: string, source: Headers | SystemAiBilling) {
    const billing = source instanceof Headers ? readSystemAiBilling(source) : source;
    return hasSystemAiCharge(billing) ? refundUserPoints(userId, model, billing.pointsCost, "text", 1, undefined, billing.pointsRecordId) : null;
}
