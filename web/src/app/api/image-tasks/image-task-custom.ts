import type { ImageTask } from "@/lib/server/image-task-store";
import { GenerationSubmissionSafeFailure, GenerationSubmissionUncertainError } from "@/lib/server/generation-submission-error";
import { buildProviderRequest, isProviderBusinessError, readProviderError, readProviderString, readProviderValue } from "@/lib/server/provider-task-config";
import { buildYumengImageRequest, resolveYumengImageResolution } from "@/lib/yumeng-model-center";

import { publicImageReferenceRequestUrl } from "./image-task-openai";
import { IMAGE_TASK_POLL_INTERVAL_MS, type ImageApiResponse, type ImageTaskResult } from "./image-task-types";
import {
    findImageResults,
    imagePointsIdempotencyKey,
    imageSubmissionFetch,
    imageSubmissionResponseError,
    imageReferenceToDataUrl,
    imageTaskPollAttempts,
    imageTaskPollUrls,
    isPendingImageStatus,
    parseChargedImageResponse,
    readFetchError,
    readImageTaskId,
    parseImageSubmissionJson,
    imageRequestAspectRatio,
    resolveRequestSize,
    taskFetch,
    taskHeaders,
    taskUrl,
    withSystemPrompt,
    withImageOutputInstructions,
    ImageUpstreamTerminalError,
} from "./image-task-support";

export async function runCustomImageTask(task: ImageTask, origin: string, publicOrigin: string, cookie: string, singleStep = false) {
    const config = task.config;
    const advanced = config.advancedConfig;
    if (!advanced?.createPath || !advanced.requestTemplate || !advanced.resultField) throw new GenerationSubmissionSafeFailure("自定义图片协议缺少创建路径、请求模板或结果字段");
    const size = resolveDeclarativeImageSize(config);
    const [width, height] = /^\d+x\d+$/.test(size) ? size.split("x").map(Number) : [undefined, undefined];
    const context = { ownerUserId: task.userId, taskId: task.id };
    const inlineReferences = advanced.protocol === "stable-diffusion" || /\bbase64\b|data:image|\binline\b/i.test(advanced.referenceRule || "");
    const images = (
        await Promise.all(
            task.references.map((reference, index) => (inlineReferences ? imageReferenceToDataUrl(reference, reference.name || `reference-${index + 1}.png`, origin, cookie) : publicImageReferenceRequestUrl(reference, origin, publicOrigin, context))),
        )
    ).filter(Boolean);
    const outputCount = config.outputMode === "layers" ? undefined : 1;
    const values = {
        model: config.model,
        prompt: withSystemPrompt(config, withImageOutputInstructions(config, task.prompt)),
        size,
        ratio: imageRequestAspectRatio(config.size || "auto"),
        aspect_ratio: imageRequestAspectRatio(config.size || "auto"),
        resolution: advanced.protocol === "yumeng" ? resolveYumengImageResolution(config.model, config.quality) : config.quality || "auto",
        width,
        height,
        quality: config.quality || "auto",
        background: config.outputBackground || "opaque",
        output_format: config.outputBackground === "transparent" ? "png" : "",
        n: outputCount,
        count: outputCount,
        num_images: outputCount,
        batch_size: outputCount,
        image: images[0] || "",
        images,
    };
    const payload =
        advanced.protocol === "yumeng"
            ? buildYumengImageRequest({ model: config.model, prompt: values.prompt, images, aspectRatio: values.aspect_ratio, resolution: values.resolution, size })
            : buildProviderRequest(advanced.requestTemplate, values, values);
    const url = taskUrl(config, task.kind === "edit" ? advanced.editPath || advanced.createPath : advanced.createPath, origin);
    const headers = taskHeaders(config, cookie, imagePointsIdempotencyKey(task));
    headers.set("content-type", "application/json");
    const response = await imageSubmissionFetch(config, url, { method: "POST", headers, body: JSON.stringify(payload), cache: "no-store" });
    if (!response.ok) throw imageSubmissionResponseError(response.status, await readFetchError(response, "自定义图片接口调用失败"));
    const data = await parseImageSubmissionJson<ImageApiResponse>(task, response);
    return parseChargedImageResponse(task, response, async () => {
        if (isProviderBusinessError(data)) throw new ImageUpstreamTerminalError(readProviderError(data) || "自定义图片接口返回失败");
        const mediaBaseUrl = response.headers.get("x-vozeb-pro-upstream-url") || url;
        const direct = configuredImageResult(data, mediaBaseUrl, task);
        if (direct) return direct;
        const taskId = readImageTaskId(data);
        if (!taskId || !advanced.queryPath) throw new GenerationSubmissionUncertainError("自定义图片接口没有返回图片或任务 ID，创建结果待确认");
        if (singleStep) return { dataUrl: "", pending: { id: taskId, mediaBaseUrl, pollBaseUrl: url } };
        return pollCustomImageTask(task, taskId, mediaBaseUrl, url, cookie);
    });
}

export function resolveDeclarativeImageSize(config: Pick<ImageTask["config"], "quality" | "size" | "advancedConfig">) {
    const size = resolveRequestSize(config.quality, config.size || "auto") || config.size || "";
    return !size || size.toLowerCase() === "auto" ? "" : size;
}

export async function pollCustomImageTask(task: ImageTask, taskId: string, mediaBaseUrl: string, pollBaseUrl: string, cookie: string, singleStep = false) {
    const config = task.config;
    let lastError = "";
    for (let attempt = 0; attempt < (singleStep ? 1 : imageTaskPollAttempts(config)); attempt += 1) {
        for (const url of imageTaskPollUrls(config, pollBaseUrl, taskId)) {
            const response = await taskFetch(config, url, { headers: taskHeaders(config, cookie), cache: "no-store" });
            if (!response.ok) {
                lastError = await readFetchError(response, "自定义图片任务查询失败");
                continue;
            }
            const data = (await response.json().catch(() => null)) as ImageApiResponse | null;
            if (!data || isProviderBusinessError(data)) throw new ImageUpstreamTerminalError(readProviderError(data) || "自定义图片任务查询失败");
            const result = configuredImageResult(data, response.headers.get("x-vozeb-pro-upstream-url") || mediaBaseUrl || url, task);
            if (result) return result;
            const status = readProviderString(data, config.advancedConfig?.statusField, STATUS_KEYS).toLowerCase();
            if (!isPendingImageStatus(status)) throw new ImageUpstreamTerminalError(readProviderError(data) || "自定义图片任务完成但没有返回图片");
            lastError = "";
            break;
        }
        if (lastError) throw new Error(lastError);
        if (!singleStep) await new Promise((resolve) => setTimeout(resolve, IMAGE_TASK_POLL_INTERVAL_MS));
    }
    if (singleStep) return { dataUrl: "", pending: { id: taskId, mediaBaseUrl, pollBaseUrl } };
    throw new Error("自定义图片任务生成超时");
}

function configuredImageResult(data: ImageApiResponse, baseUrl: string, task: ImageTask): ImageTaskResult | null {
    const configured = findImageResults(readProviderValue(data, task.config.advancedConfig?.resultField), baseUrl, task.config);
    const discovered = findImageResults(data, baseUrl, task.config);
    const images = discovered.length > configured.length ? discovered : configured;
    return images.length ? { ...images[0], results: images } : null;
}

const STATUS_KEYS = ["status", "state", "task_status", "taskStatus"];
