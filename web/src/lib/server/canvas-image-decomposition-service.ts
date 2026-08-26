import sharp from "sharp";

import { getAuthSettings, refundUserPoints } from "@/lib/auth/store";
import { normalizeCanvasImageDecomposition, canvasImageDecompositionInstruction, canvasImageDecompositionTool, type CanvasImageDecomposition } from "@/lib/canvas-image-decomposition";
import { CREATIVE_UPLOAD_MAX_BYTES } from "@/lib/creative-upload";
import { toSafeGenerationErrorMessage } from "@/lib/server/generation-errors";
import { fetchInternalApi } from "@/lib/server/internal-origin";
import { resolveLogicalModelCandidates, type ResolvedLogicalModel } from "@/lib/server/logical-model-router";
import { resolveModelRequestTimeoutMs } from "@/lib/server/model-request-policy";
import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";
import { strictJsonObjectText } from "@/lib/server/structured-model-output";
import { hasSystemAiCharge, readSystemAiBilling, systemAiBillingHeaders, systemAiIdempotencyKey } from "@/lib/server/system-ai-billing";
import { rankTextPlanningCandidates } from "@/lib/server/text-planning-runtime";
import { resolveTextProtocol } from "@/lib/server/text-protocol-resolver";

type SourceImage = { dataUrl: string; mimeType: string; width: number; height: number };
type VisionCall = { arguments: string; headers: Headers };

export class CanvasImageDecompositionError extends Error {
    constructor(
        message: string,
        readonly status = 502,
    ) {
        super(message);
        this.name = "CanvasImageDecompositionError";
    }
}

export async function decomposeCanvasImage(input: { origin: string; cookie: string; userId: string; requestId: string; source: string }): Promise<CanvasImageDecomposition> {
    const [settings, source] = await Promise.all([getAuthSettings(), readSourceImage(input.source, input.origin, input.cookie)]);
    const model = settings.defaultModels.textModel;
    const candidates = resolveLogicalModelCandidates(settings, "text", model);
    if (!model || !candidates.length) throw new CanvasImageDecompositionError("后台尚未配置可用的默认文本模型", 503);

    let latestError: unknown;
    for (const candidate of rankTextPlanningCandidates(candidates)) {
        const idempotencyKey = systemAiIdempotencyKey("canvas-image-decomposition", input.userId, input.requestId, candidate.channelId, candidate.upstreamModel);
        try {
            const call = await requestDecomposition(candidate, source, input.origin, input.cookie, input.userId, model, idempotencyKey);
            const result = parseDecomposition(call.arguments, source.width, source.height);
            if (result) return result;
            await refundInvalidResponse(input.userId, model, call.headers);
            latestError = new CanvasImageDecompositionError("默认文本模型没有返回可靠的图片分层策略");
        } catch (error) {
            latestError = error;
        }
    }
    if (latestError instanceof CanvasImageDecompositionError) throw latestError;
    throw new CanvasImageDecompositionError(toSafeGenerationErrorMessage(latestError, "图片分层识别失败，请稍后重试"));
}

async function requestDecomposition(candidate: ResolvedLogicalModel, source: SourceImage, origin: string, cookie: string, userId: string, billingModel: string, idempotencyKey: string): Promise<VisionCall> {
    const protocol = resolveTextProtocol({ model: candidate.upstreamModel, apiFormat: candidate.channel.apiFormat, advancedConfig: candidate.channel.advancedConfig, throughSystemProxy: true });
    if (protocol.kind === "custom" || protocol.kind === "claude") throw new CanvasImageDecompositionError("当前默认文本模型协议不支持图片理解，请在后台配置支持视觉输入的文本模型", 503);
    const instruction = canvasImageDecompositionInstruction(source.width, source.height);
    const prompt = `请分析这张 ${source.width}x${source.height} 图片，先判断电商或普通主体策略，再按要求完成分层。JSON Schema：${JSON.stringify(canvasImageDecompositionTool.parameters)}`;
    const body = visionRequestBody(protocol.kind, candidate.upstreamModel, instruction, prompt, source);
    const headers = {
        "Content-Type": "application/json",
        cookie,
        "Idempotency-Key": idempotencyKey,
        "X-Client-Request-Id": idempotencyKey,
        ...systemAiBillingHeaders(billingModel, idempotencyKey, candidate.upstreamModel),
    };
    const response = await fetchInternalApi(`${origin}/api/ai/system/${encodeURIComponent(candidate.channelId)}${normalizePath(protocol.path)}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(resolveModelRequestTimeoutMs(candidate, "text")),
    });
    if (!response.ok) {
        const message = toSafeGenerationErrorMessage(await response.text().catch(() => ""), `图片理解模型调用失败（HTTP ${response.status}）`);
        throw new CanvasImageDecompositionError(message, response.status);
    }
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!payload) {
        await refundInvalidResponse(userId, billingModel, response.headers);
        throw new CanvasImageDecompositionError("图片理解模型返回了无效 JSON");
    }
    const argumentsText = readVisionArguments(protocol.kind, payload);
    if (!argumentsText) {
        await refundInvalidResponse(userId, billingModel, response.headers);
        throw new CanvasImageDecompositionError("图片理解模型没有返回分层结构");
    }
    return { arguments: argumentsText, headers: response.headers };
}

function visionRequestBody(kind: "chat" | "responses" | "gemini", model: string, instruction: string, prompt: string, source: SourceImage) {
    if (kind === "responses") {
        return {
            model,
            input: [
                { role: "system", content: instruction },
                {
                    role: "user",
                    content: [
                        { type: "input_text", text: prompt },
                        { type: "input_image", image_url: source.dataUrl },
                    ],
                },
            ],
            tools: [{ type: "function", ...canvasImageDecompositionTool }],
            tool_choice: { type: "function", name: canvasImageDecompositionTool.name },
        };
    }
    if (kind === "gemini") {
        return {
            contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: source.mimeType, data: source.dataUrl.split(",", 2)[1] } }] }],
            systemInstruction: { parts: [{ text: instruction }] },
            tools: [{ functionDeclarations: [canvasImageDecompositionTool] }],
            toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [canvasImageDecompositionTool.name] } },
        };
    }
    return {
        model,
        messages: [
            { role: "system", content: instruction },
            {
                role: "user",
                content: [
                    { type: "text", text: prompt },
                    { type: "image_url", image_url: { url: source.dataUrl } },
                ],
            },
        ],
        tools: [{ type: "function", function: canvasImageDecompositionTool }],
        tool_choice: { type: "function", function: { name: canvasImageDecompositionTool.name } },
    };
}

function readVisionArguments(kind: "chat" | "responses" | "gemini", payload: Record<string, unknown>) {
    if (kind === "responses") {
        const output = records(payload.output);
        const call = output.find((item) => item.type === "function_call" && item.name === canvasImageDecompositionTool.name);
        return (
            jsonText(call?.arguments) ||
            strictJsonObjectText(
                typeof payload.output_text === "string"
                    ? payload.output_text
                    : output
                          .flatMap((item) => records(item.content))
                          .map((item) => (typeof item.text === "string" ? item.text : ""))
                          .join(""),
            )
        );
    }
    if (kind === "gemini") {
        const parts = records(record(records(payload.candidates)[0]?.content)?.parts);
        const call = parts.map((part) => record(part.functionCall)).find((item) => item?.name === canvasImageDecompositionTool.name);
        return jsonText(call?.args) || strictJsonObjectText(parts.map((part) => (typeof part.text === "string" ? part.text : "")).join(""));
    }
    const message = record(records(payload.choices)[0]?.message);
    const call = records(message?.tool_calls)
        .map((item) => record(item.function))
        .find((item) => item?.name === canvasImageDecompositionTool.name);
    return jsonText(call?.arguments) || strictJsonObjectText(typeof message?.content === "string" ? message.content : "");
}

async function readSourceImage(value: string, origin: string, cookie: string): Promise<SourceImage> {
    const source = value.trim();
    let bytes: Buffer;
    let mimeType = "";
    const dataMatch = source.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/i);
    if (dataMatch) {
        mimeType = dataMatch[1].toLowerCase();
        bytes = Buffer.from(dataMatch[2], "base64");
    } else {
        const response = source.startsWith("/api/") ? await fetchInternalApi(`${origin}${source}`, { headers: { cookie }, cache: "no-store" }) : /^https:\/\//i.test(source) ? await fetchSafeOutbound(source, { cache: "no-store" }) : null;
        if (!response?.ok) throw new CanvasImageDecompositionError("无法读取需要分层的源图片", 400);
        const contentLength = Number(response.headers.get("content-length") || 0);
        if (contentLength > CREATIVE_UPLOAD_MAX_BYTES) throw new CanvasImageDecompositionError("源图片过大，请压缩后重试", 413);
        mimeType = response.headers.get("content-type")?.split(";")[0].toLowerCase() || "";
        bytes = Buffer.from(await response.arrayBuffer());
    }
    if (!mimeType.startsWith("image/") || !bytes.length) throw new CanvasImageDecompositionError("源图片格式无效", 400);
    if (bytes.length > CREATIVE_UPLOAD_MAX_BYTES) throw new CanvasImageDecompositionError("源图片过大，请压缩后重试", 413);
    const metadata = await sharp(bytes)
        .metadata()
        .catch(() => null);
    if (!metadata?.width || !metadata.height) throw new CanvasImageDecompositionError("无法读取源图片尺寸", 400);
    return { dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}`, mimeType, width: metadata.width, height: metadata.height };
}

function parseDecomposition(value: string, width: number, height: number) {
    try {
        return normalizeCanvasImageDecomposition(JSON.parse(value), width, height);
    } catch {
        return null;
    }
}

async function refundInvalidResponse(userId: string, model: string, headers: Headers) {
    if (!userId) return;
    const billing = readSystemAiBilling(headers);
    if (hasSystemAiCharge(billing)) await refundUserPoints(userId, model, billing.pointsCost, "text", 1, undefined, billing.pointsRecordId);
}

function records(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function jsonText(value: unknown) {
    if (typeof value === "string") return value.trim();
    try {
        return value && typeof value === "object" ? JSON.stringify(value) : "";
    } catch {
        return "";
    }
}

function normalizePath(value: string) {
    return `/${value.trim().replace(/^\/+/, "")}`;
}
