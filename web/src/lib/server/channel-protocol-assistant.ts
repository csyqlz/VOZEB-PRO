import { getAuthSettings, refundUserPoints } from "@/lib/auth/store";
import { parseDeterministicProtocolDraft, protocolDraftFromUnknown, redactProtocolSecrets, type ChannelProtocolDraft } from "@/lib/channel-protocol-draft";
import { fetchInternalApi, resolveInternalOrigin } from "@/lib/server/internal-origin";
import { resolveLogicalModelCandidates } from "@/lib/server/logical-model-router";
import { TEXT_MODEL_REQUEST_TIMEOUT_MS } from "@/lib/server/model-request-policy";
import { strictJsonObjectText } from "@/lib/server/structured-model-output";
import { hasSystemAiCharge, readSystemAiBilling, systemAiBillingHeaders, systemAiIdempotencyKey } from "@/lib/server/system-ai-billing";
import { safeProtocolDocumentationUrl } from "@/lib/channel-protocol-security";
import { extractProtocolHtmlDocument, ProtocolDocumentFetchError, readProtocolDocumentSource } from "@/lib/server/protocol-document-source";

const MAX_PROTOCOL_SOURCE_CHARACTERS = 120_000;

export type ChannelProtocolDraftBundle = {
    drafts: ChannelProtocolDraft[];
    warnings: string[];
    sourcePages: number;
};

export async function createChannelProtocolDraft(input: { requestUrl: string; cookie: string; userId: string; documentationUrl?: string; documentationText?: string; examples?: string; useTextModel?: boolean }): Promise<ChannelProtocolDraftBundle> {
    const documentationUrl = cleanUrl(input.documentationUrl);
    let documentSource = { groups: [] as Array<{ text: string; sourceUrls: string[] }>, warnings: [] as string[], sourcePages: 0 };
    try {
        if (documentationUrl) documentSource = await readProtocolDocumentSource(documentationUrl);
    } catch (error) {
        if (error instanceof ProtocolDocumentFetchError) throw new ProtocolDraftError(error.message, error.status);
        throw error;
    }
    const supplemental = [input.documentationText || "", input.examples || ""].filter(Boolean).join("\n\n");
    const groups = documentSource.groups.length ? documentSource.groups : [{ text: "", sourceUrls: documentationUrl ? [documentationUrl] : [] }];
    const drafts: ChannelProtocolDraft[] = [];
    for (const group of groups) {
        const source = redactProtocolSecrets([group.text, supplemental].filter(Boolean).join("\n\n")).slice(0, MAX_PROTOCOL_SOURCE_CHARACTERS);
        if (!source.trim()) continue;
        const deterministic = parseDeterministicProtocolDraft({ text: source, documentationUrl: group.sourceUrls[0] || documentationUrl });
        const assisted = input.useTextModel === false ? null : await assistProtocolDraftWithTextModel(input, source, deterministic).catch(() => null);
        const draft = assisted || deterministic;
        if (draft) drafts.push({ ...draft, ...(group.sourceUrls[0] || documentationUrl ? { documentationUrl: group.sourceUrls[0] || documentationUrl } : {}) });
    }
    if (!drafts.length) {
        const message = input.useTextModel === false ? "文档中没有识别到完整的模型目录或能力接口，请补充请求与响应示例" : "没有识别到完整协议，请补充模型目录、创建、查询和成功响应示例";
        throw new ProtocolDraftError(message, 422);
    }
    const uniqueDrafts = deduplicateDrafts(drafts);
    const warnings = [...documentSource.warnings];
    if (uniqueDrafts.length > 1) warnings.unshift(`识别到 ${uniqueDrafts.length} 套独立上游协议，请分别复核并应用，不能共用一个 Base URL。`);
    return { drafts: uniqueDrafts, warnings, sourcePages: documentSource.sourcePages };
}

export class ProtocolDraftError extends Error {
    constructor(
        message: string,
        readonly status = 502,
    ) {
        super(message);
    }
}

async function assistProtocolDraftWithTextModel(input: { requestUrl: string; cookie: string; userId: string }, source: string, fallback: ChannelProtocolDraft | null) {
    const settings = await getAuthSettings();
    const logicalModel = settings.defaultModels.textModel;
    const candidates = resolveLogicalModelCandidates(settings, "text", logicalModel);
    if (!logicalModel || !candidates.length) return null;
    const origin = resolveInternalOrigin(new URL(input.requestUrl).origin);
    const prompt = protocolAssistantPrompt(source, fallback);
    for (const candidate of candidates) {
        const headers = {
            "Content-Type": "application/json",
            cookie: input.cookie,
            ...systemAiBillingHeaders(logicalModel, systemAiIdempotencyKey("protocol-draft", input.userId, candidate.channel.id, candidate.upstreamModel, source.slice(0, 4_000)), candidate.upstreamModel),
        };
        const response = await fetchInternalApi(`${origin}/api/ai/system/${encodeURIComponent(candidate.channel.id)}/chat/completions`, {
            method: "POST",
            headers,
            cache: "no-store",
            signal: AbortSignal.timeout(TEXT_MODEL_REQUEST_TIMEOUT_MS),
            body: JSON.stringify({
                model: candidate.upstreamModel,
                messages: [
                    { role: "system", content: "你是 API 协议分析器。只输出一个符合要求的 JSON 对象，不输出 Markdown、解释或代码。不得生成脚本。" },
                    { role: "user", content: prompt },
                ],
                response_format: { type: "json_object" },
            }),
        }).catch(() => null);
        if (!response?.ok) continue;
        const payload = (await response.json().catch(() => null)) as { choices?: Array<{ message?: { content?: string } }> } | null;
        const text = payload?.choices?.[0]?.message?.content || "";
        const json = strictJsonObjectText(text);
        let draft: ChannelProtocolDraft | null = null;
        if (json) {
            try {
                draft = protocolDraftFromUnknown(JSON.parse(json), fallback);
            } catch {
                draft = null;
            }
        }
        if (draft) return draft;
        const billing = readSystemAiBilling(response.headers);
        if (hasSystemAiCharge(billing)) await refundUserPoints(input.userId, logicalModel, billing.pointsCost, "text", 1, undefined, billing.pointsRecordId);
    }
    return null;
}

export function htmlDocumentText(source: string) {
    return extractProtocolHtmlDocument(source).text.replace(/\s+/g, " ").trim();
}

function deduplicateDrafts(drafts: ChannelProtocolDraft[]) {
    const unique = new Map<string, ChannelProtocolDraft>();
    for (const draft of drafts) {
        const key = JSON.stringify([draft.baseUrl, draft.operations.map((operation) => [operation.capability, operation.config.createPath, operation.config.queryPath])]);
        if (!unique.has(key)) unique.set(key, draft);
    }
    return Array.from(unique.values());
}

function protocolAssistantPrompt(source: string, fallback?: ChannelProtocolDraft | null) {
    return `从下面文档分析整套声明式 API 协议包，不要只分析一个模型或一条接口。\n要求：\n1. 根对象只允许 baseUrl、apiFormat、authMode、authHeader、authPrefix、modelCatalogPaths、operations、summary。\n2. modelCatalogPaths 收集文档中所有模型目录相对路径，包含分页入口；不能写完整 URL。operations 必须覆盖文档明确提供的全部 text/image/video/audio 能力。\n3. 每个 operation 只允许 capability、apiFormat、models、config。models 收集该能力在文档中明确列出的全部模型；文档未静态列出模型但提供模型目录时允许为空。\n4. config 只允许 capability、createPath、editPath、imageToVideoPath、queryPath、cancelPath、cancelMethod、requestTemplate、resultField、statusField、durationRange、referenceRule、supportsReferenceImage、supportsReferenceVideo、supportsReferenceAudio。cancelMethod 只能是 POST 或 DELETE。\n5. 所有路径必须是以 / 开头的相对 API 路径，不能是完整 URL；任务 ID 使用 :task_id。图片独立编辑端点写 editPath，视频独立图生视频端点写 imageToVideoPath。\n6. requestTemplate 必须是 JSON 对象字符串，动态值只能使用 {{model}}、{{prompt}}、{{input}}、{{text}}、{{messages}}、{{size}}、{{width}}、{{height}}、{{quality}}、{{n}}、{{count}}、{{num_images}}、{{batch_size}}、{{ratio}}、{{aspect_ratio}}、{{resolution}}、{{duration}}、{{seconds}}、{{image}}、{{images}}、{{video}}、{{videos}}、{{audio}}、{{audios}}、{{references}}、{{content}}、{{first_frame}}、{{first_frame_url}}、{{last_frame}}、{{last_frame_url}}、{{generate_audio}}、{{voice}}、{{format}}、{{response_format}}、{{speed}}。\n7. apiFormat 只能是 openai/gemini；authMode 只能是 none/bearer/x-api-key/custom-header；capability 只能是 text/image/video/audio。\n8. 必须提取创建、查询、取消、状态和结果字段，文档没有证据的字段留空，不得猜测。不得输出代码、脚本、Cookie、Authorization 或 API Key。\n${fallback ? `本地确定性解析结果，可校正并补全：${JSON.stringify(fallback)}\n` : ""}\n文档：\n${source}`;
}

function cleanUrl(value?: string) {
    if (!value?.trim()) return "";
    const url = safeProtocolDocumentationUrl(value);
    if (!url) throw new ProtocolDraftError("文档链接格式不正确，且不能包含账号、密码或 Key/Token 查询参数", 400);
    return url;
}
