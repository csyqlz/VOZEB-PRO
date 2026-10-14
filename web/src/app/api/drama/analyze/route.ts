import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { readJsonBody } from "@/lib/auth/request";
import { getAuthSettings, isAuthInputError, refundUserPoints } from "@/lib/auth/store";
import { describeDramaAnalysisCandidate, dramaContentTool, dramaVisualTool, hasCompleteDramaContentAnalysis, hasUsableDramaToolArguments, normalizeDramaContentAnalysis, normalizeDramaToolArguments } from "@/lib/server/drama-analysis";
import { mergeDramaContentAnalyses } from "@/lib/server/drama-analysis-merge";
import { splitDramaScriptAtBoundary } from "@/lib/server/drama-analysis-segmentation";
import { resolveInternalOrigin } from "@/lib/server/internal-origin";
import { resolveLogicalModelCandidates } from "@/lib/server/logical-model-router";
import { checkRateLimit } from "@/lib/server/security";
import { hasSystemAiCharge, readSystemAiBilling, systemAiBillingHeaders, systemAiIdempotencyKey, type SystemAiBilling } from "@/lib/server/system-ai-billing";
import { isStructuredTextFailure, rankTextPlanningCandidates, requestStructuredText, type TextPlanningCandidate } from "@/lib/server/text-planning-runtime";
import { dramaAnalysisText, normalizeDramaVisualInput, type DramaAnalyzeBody, type NormalizedDramaVisualInput } from "@/lib/server/drama-analysis-input";
import { dramaShotDurationInstruction, resolveDramaVideoDurationPolicy } from "@/lib/server/drama-shot-config";
import { analyzeDramaVisualBatches } from "@/lib/server/drama-visual-analysis-runtime";

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
    const requestId = dramaAnalysisText(body.requestId);
    if (!requestId || requestId.length > 200) return NextResponse.json({ code: 400, data: null, msg: "剧本分析请求标识无效" }, { status: 400 });
    const phase = body.phase === "visual" ? "visual" : "content";
    const script = dramaAnalysisText(body.script);
    if (phase === "content" && !script) return NextResponse.json({ code: 400, data: null, msg: "请先填写剧本" }, { status: 400 });

    const visualInput = phase === "visual" ? normalizeDramaVisualInput(body) : null;
    if (phase === "visual" && !visualInput?.shotIds.length) return NextResponse.json({ code: 400, data: null, msg: "请先完成内容审核" }, { status: 400 });

    const settings = await getAuthSettings();
    const model = settings.defaultModels.textModel;
    const candidates = resolveLogicalModelCandidates(settings, "text", model);
    if (!model || !candidates.length) return NextResponse.json({ code: 400, data: null, msg: "后台尚未配置可用的默认文本模型" }, { status: 400 });
    const requestedVideoModel = dramaAnalysisText(body.videoModel);
    const defaultVideoModel = settings.defaultModels.videoModel;
    const requestedVideoCandidates = phase === "content" && (requestedVideoModel || defaultVideoModel) ? resolveLogicalModelCandidates(settings, "video", requestedVideoModel || defaultVideoModel) : [];
    const videoCandidates = requestedVideoCandidates.length || !defaultVideoModel || requestedVideoModel === defaultVideoModel ? requestedVideoCandidates : resolveLogicalModelCandidates(settings, "video", defaultVideoModel);
    const durationPolicy = resolveDramaVideoDurationPolicy(videoCandidates, settings.generationDefaults.videoSeconds, settings.generationPointMultipliers?.videoSeconds);
    const durationInstruction = phase === "content" ? dramaShotDurationInstruction(durationPolicy) : "";

    let refundedPointsRemaining: number | undefined;
    try {
        const tool = phase === "visual" ? dramaVisualTool : dramaContentTool;
        const input = phase === "visual" ? visualInput!.payload : { script, summary: dramaAnalysisText(body.summary) };
        const schemaInstruction = `即使渠道没有传递工具定义，也必须只返回符合以下 JSON Schema 的对象，不能返回输入对象，不能把 script 或 summary 作为顶层字段：${JSON.stringify(tool.parameters)}`;
        const messagesFor = (batchInput: unknown) => [
            {
                role: "system",
                content:
                    phase === "visual"
                        ? `你是影视视觉导演。输入内容已经由用户审核，必须严格保留每个 shotId、镜头数量、顺序、人物、场景、对白、旁白、原文和时长。为每个镜头补充图片提示词、视频提示词、起始/结束帧提示词、镜头运动和连续性数据；连续性必须明确景别、机位、构图、人物站位、视线、动作起止、屏幕运动方向和轴线规则。镜头之间要保持人物服装、道具、空间和视线关系连续。必须调用 design_drama_visuals。不要使用 Markdown。${schemaInstruction}`
                        : `你是影视剧本编辑。只提取剧本明确存在的内容事实和镜头边界，不生成 imagePrompt、videoPrompt、镜头运动或画面风格，不添加无依据的主要情节。必须逐句保留所有角色直接说出的原话和原文明示的旁白，utterances 按原文顺序列出每一句；每条 dialogue 必须根据前后文填写明确说话人姓名或身份，禁止留空、填写“说话人/未知”或只写无法定位的代词；带引号的地名、招式名、物品名和章节名不是对白。禁止把多句台词压缩成“某人说明/表示/询问”的剧情摘要；说话人转换、明确动作反应或场景变化都应成为可审核的镜头边界，sourceText 必须保留对应连续原文。${durationInstruction}必须调用 analyze_drama_content。不要使用 Markdown。${schemaInstruction}`,
            },
            { role: "user", content: JSON.stringify(batchInput) },
        ];
        let latestError: unknown;
        for (const candidate of rankTextPlanningCandidates(candidates.map((candidate) => ({ ...candidate, channelId: candidate.channel.id })))) {
            try {
                if (phase === "visual") {
                    const result = await analyzeDramaVisualBatches({
                        input: visualInput!,
                        requestBatch: async (batch) => {
                            const call = await requestFunctionCall(
                                resolveInternalOrigin(new URL(request.url).origin),
                                request.headers.get("cookie") || "",
                                candidate,
                                model,
                                messagesFor(batch.payload),
                                user.id,
                                tool,
                                visualBatchIdempotencyKey(user.id, requestId, candidate, batch),
                                undefined,
                                false,
                                request.signal,
                            );
                            return { value: JSON.parse(call.args), call };
                        },
                        releaseCall: async (call) => {
                            if (hasSystemAiCharge(call)) refundedPointsRemaining = (await refund(user.id, model, call))?.pointsBalance;
                        },
                        shouldSplitError: isAdaptiveVisualBatchError,
                    });
                    if (result.data.shots.length !== visualInput!.shotIds.length) throw new Error("模型没有为全部镜头生成视觉结构");
                    const response = NextResponse.json({ code: 0, data: result.data, msg: "视觉结构已生成" });
                    const pointsRemaining = result.calls
                        .map((call) => call.pointsRemaining)
                        .filter((value): value is number => typeof value === "number")
                        .at(-1);
                    if (typeof pointsRemaining === "number") response.headers.set("x-vozeb-pro-points-remaining", String(pointsRemaining));
                    return response;
                }
                const result = await analyzeDramaContentCandidate({
                    origin: resolveInternalOrigin(new URL(request.url).origin),
                    cookie: request.headers.get("cookie") || "",
                    candidate,
                    model,
                    tool,
                    requestId,
                    script,
                    summary: dramaAnalysisText(body.summary),
                    userId: user.id,
                    durationPolicy,
                    messagesFor,
                    signal: request.signal,
                    onRefund: (pointsBalance) => {
                        if (typeof pointsBalance === "number") refundedPointsRemaining = pointsBalance;
                    },
                });
                const response = NextResponse.json({ code: 0, data: result.data, msg: "内容结构待审核" });
                const pointsRemaining = result.calls
                    .map((call) => call.pointsRemaining)
                    .filter((value): value is number => typeof value === "number")
                    .at(-1);
                if (typeof pointsRemaining === "number") response.headers.set("x-vozeb-pro-points-remaining", String(pointsRemaining));
                return response;
            } catch (error) {
                latestError = error;
                if (!shouldTryAnotherTextCandidate(error)) break;
            }
        }
        throw latestError instanceof Error ? latestError : new Error("没有可用的文本模型渠道");
    } catch (error) {
        const response = NextResponse.json({ code: 502, data: null, msg: error instanceof Error ? error.message : "剧本分析失败" }, { status: 502 });
        if (typeof refundedPointsRemaining === "number") response.headers.set("x-vozeb-pro-points-remaining", String(refundedPointsRemaining));
        return response;
    }
}

function visualBatchIdempotencyKey(userId: string, requestId: string, candidate: TextPlanningCandidate, batch: NormalizedDramaVisualInput) {
    return systemAiIdempotencyKey("drama-analyze", userId, "visual", requestId, batch.shotIds.join("\0"), candidate.channel.id, candidate.upstreamModel);
}

function isAdaptiveVisualBatchError(error: unknown) {
    const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
    const message = error instanceof Error ? error.message : "";
    return status === 413 || isStructuredTextFailure(error) || message === "模型没有返回所需的结构化结果" || message === "模型没有返回结构化剧本结果";
}

function shouldTryAnotherTextCandidate(error: unknown) {
    if (isStructuredTextFailure(error)) return false;
    const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
    return status >= 500 || status === 408 || status === 429;
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
    validateArguments = (argumentsText: string) => hasUsableDramaToolArguments(argumentsText, tool.name),
    allowRepair = true,
    signal?: AbortSignal,
) {
    const headers = { "Content-Type": "application/json", cookie, ...systemAiBillingHeaders(billingModel, `${idempotencyKey}:tool`, candidate.upstreamModel) };
    const fallbackHeaders = { "Content-Type": "application/json", cookie, ...systemAiBillingHeaders(billingModel, `${idempotencyKey}:json`, candidate.upstreamModel) };
    const normalizeArguments = (argumentsText: string) => normalizeDramaToolArguments(argumentsText, tool.name);
    const call = await requestStructuredText({
        origin,
        cookie,
        candidate,
        messages,
        tool,
        headers,
        fallbackHeaders,
        preferNativeTools: false,
        allowRepair,
        stream: true,
        streamFallback: true,
        signal,
        validateArguments: (argumentsText) => validateArguments(normalizeArguments(argumentsText)),
        onInvalidResponse: (responseHeaders) => refund(userId, billingModel, responseHeaders),
    });
    const normalizedArguments = normalizeArguments(call.arguments);
    if (!validateArguments(normalizedArguments)) {
        console.error("[drama-analyze] structured output invalid", JSON.stringify({ endpoint: call.protocol, channelId: candidate.channel.id, model: candidate.upstreamModel, argumentShape: describeArgumentsText(call.arguments) }));
        await refund(userId, billingModel, call.headers);
        throw new Error("模型没有返回结构化剧本结果");
    }
    return readCallResult(normalizedArguments, call.headers);
}

type DramaContentCall = Awaited<ReturnType<typeof requestFunctionCall>>;
type DramaTool = { name: string; description: string; parameters: Record<string, unknown> };

async function analyzeDramaContentCandidate(input: {
    origin: string;
    cookie: string;
    candidate: TextPlanningCandidate;
    model: string;
    tool: DramaTool;
    requestId: string;
    script: string;
    summary: string;
    userId: string;
    durationPolicy: ReturnType<typeof resolveDramaVideoDurationPolicy>;
    messagesFor: (batchInput: unknown) => Array<{ role: string; content: string }>;
    signal: AbortSignal;
    onRefund: (pointsBalance: unknown) => void;
}) {
    const calls: DramaContentCall[] = [];
    try {
        const data = await analyzeDramaScriptSegment(input, input.script, "full", calls);
        if (!hasCompleteDramaSourceCoverage(data, input.script)) throw new Error("模型分段合并后的剧本结构不完整");
        return { data, calls };
    } catch (error) {
        for (const call of calls) {
            if (!hasSystemAiCharge(call)) continue;
            const result = await refund(input.userId, input.model, call);
            input.onRefund(result && typeof result === "object" && "pointsBalance" in result ? result.pointsBalance : undefined);
        }
        throw error;
    }
}

async function analyzeDramaScriptSegment(input: Parameters<typeof analyzeDramaContentCandidate>[0], script: string, segmentKey: string, calls: DramaContentCall[]): Promise<ReturnType<typeof normalizeDramaContentAnalysis>> {
    try {
        const call = await requestFunctionCall(
            input.origin,
            input.cookie,
            input.candidate,
            input.model,
            input.messagesFor({ script, summary: input.summary }),
            input.userId,
            input.tool,
            systemAiIdempotencyKey("drama-analyze", input.userId, "content", input.requestId, segmentKey, script, input.candidate.channel.id, input.candidate.upstreamModel),
            (argumentsText) => hasUsableDramaToolArguments(argumentsText, input.tool.name),
            true,
            input.signal,
        );
        try {
            const parsed = JSON.parse(call.args);
            const data = normalizeDramaContentAnalysis(parsed, input.durationPolicy, script);
            if (!hasCompleteDramaContentAnalysis(data, script)) throw new Error("模型返回的剧本对白或原文不完整");
            calls.push(call);
            return data;
        } catch (error) {
            if (hasSystemAiCharge(call)) await refund(input.userId, input.model, call);
            throw error;
        }
    } catch (error) {
        const split = splitDramaScriptAtBoundary(script);
        if (!split || !isAdaptiveContentError(error)) throw error;
        const left = await analyzeDramaScriptSegment(input, split[0], `${segmentKey}.0`, calls);
        const right = await analyzeDramaScriptSegment(input, split[1], `${segmentKey}.1`, calls);
        return mergeDramaContentAnalyses([left, right]);
    }
}

function isAdaptiveContentError(error: unknown) {
    const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
    const message = error instanceof Error ? error.message : "";
    return status === 413 || isStructuredTextFailure(error) || message === "模型没有返回所需的结构化结果" || message === "模型没有返回结构化剧本结果" || message === "模型返回的剧本原文不完整" || message === "模型返回的剧本对白或原文不完整";
}

function hasCompleteDramaSourceCoverage(value: unknown, sourceScript: string) {
    const source = sourceScript.trim().replace(/\s/gu, "");
    const output = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const shots = "shots" in output && Array.isArray(output.shots) ? output.shots : [];
    const covered = shots
        .map((shot) => (shot && typeof shot === "object" && !Array.isArray(shot) && "sourceText" in shot && typeof shot.sourceText === "string" ? shot.sourceText : ""))
        .join("")
        .replace(/\s/gu, "");
    return Boolean(source && covered === source);
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
