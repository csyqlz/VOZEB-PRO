import { fileTypeFromBuffer } from "file-type";

import { CREATIVE_UPLOAD_MAX_BYTES } from "@/lib/creative-upload";
import { creativeAssetReferenceAliases, orderCreativeAssetsByIds } from "@/lib/creative-asset-references";
import type { CreativeAsset } from "@/lib/creative-runtime-contract";
import { getCreativeAssetsByIds, getCreativeConversationContext } from "@/lib/server/creative-runtime-store";
import { fetchInternalApi } from "@/lib/server/internal-origin";
import { limitMediaResponseBody, mediaResponseExceedsLimit } from "@/lib/server/media-response-limit";
import { signGenerationAssetInputUrl, signReferenceAssetInputUrl } from "@/lib/server/reference-asset-access";
import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";
import type { AgentRun } from "@/lib/server/agent-run-store";
import type { AiTextMessage } from "@/types/ai";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export async function textConversationMessages(run: AgentRun, origin: string): Promise<AiTextMessage[]> {
    const [context, loadedAssets] = await Promise.all([getCreativeConversationContext(run.conversationId, run.userId, run.id), getCreativeAssetsByIds(run.referencedAssetIds, run.userId)]);
    const assets = orderCreativeAssetsByIds(loadedAssets, run.referencedAssetIds);
    if (assets.length !== run.referencedAssetIds.length || assets.some((asset) => asset.conversationId !== run.conversationId || asset.status !== "ready" || (asset.type !== "image" && asset.type !== "text")))
        throw new Error("文本对话只支持当前会话中可用的图片或文本素材");
    const aliases = creativeAssetReferenceAliases(assets, run.referencedAssetIds);
    const content: Extract<AiTextMessage["content"], unknown[]> = [{ type: "text", text: run.prompt }];
    for (const asset of assets) {
        const label = aliases.get(asset.id) || asset.title;
        if (asset.type === "text") {
            content.push({ type: "text", text: `素材 @${label}：\n${asset.textContent || ""}` });
            continue;
        }
        content.push({ type: "text", text: `图片 @${label}（${asset.title}）：` });
        content.push({ type: "image_url", image_url: { url: await imageDataUrl(asset, origin, run.userId) } });
    }
    return [
        { role: "system", content: `你是文本对话助手。根据用户实际提供的图片回答截图解读、OCR 和图表问题；辨认不清时说明不确定，不编造图中文字或数据。${context.summary ? `\n对话摘要：${context.summary}` : ""}` },
        ...context.recentMessages.filter((message) => message.role === "user" || message.role === "assistant").map((message) => ({ role: message.role as "user" | "assistant", content: message.content })),
        { role: "user", content },
    ];
}

async function imageDataUrl(asset: CreativeAsset, origin: string, userId: string) {
    let response: Response;
    if (asset.serverUrl) {
        if (!/^\/api\/(?:reference-assets|generation-log-assets)\//.test(asset.serverUrl)) throw new Error("图片素材地址无效");
        const signed = asset.serverUrl.startsWith("/api/reference-assets/") ? signReferenceAssetInputUrl(asset.serverUrl, origin, userId) : signGenerationAssetInputUrl(asset.serverUrl, origin, userId);
        if (!new URL(signed, origin).searchParams.has("signature")) throw new Error("图片素材签名不可用");
        response = await fetchInternalApi(signed, { cache: "no-store", redirect: "manual" });
        if (response.status === 307) {
            const location = response.headers.get("location");
            if (!location) throw new Error("图片素材读取失败");
            response = await fetchSafeOutbound(location, { cache: "no-store" });
        }
    } else if (asset.remoteUrl) {
        response = await fetchSafeOutbound(asset.remoteUrl, { cache: "no-store" });
    } else {
        throw new Error("图片素材缺少可读取的文件");
    }
    if (!response.ok || !response.body) throw new Error("图片素材读取失败");
    if (mediaResponseExceedsLimit(response.headers, CREATIVE_UPLOAD_MAX_BYTES)) throw new Error("图片素材超过上传大小限制");
    const bounded = limitMediaResponseBody(response.body, CREATIVE_UPLOAD_MAX_BYTES);
    if (!bounded) throw new Error("图片素材读取失败");
    const bytes = Buffer.from(await new Response(bounded).arrayBuffer());
    const mimeType = (await fileTypeFromBuffer(bytes))?.mime;
    if (!mimeType || !IMAGE_TYPES.has(mimeType)) throw new Error("图片素材不是支持的图片格式");
    return `data:${mimeType};base64,${bytes.toString("base64")}`;
}
