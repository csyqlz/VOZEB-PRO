import Decimal from "decimal.js";
import { PricingInputError } from "@/lib/model-pricing";
import type { VideoUsageObservation } from "./model-pricing-video-usage";

// Provider limits, not platform limits. Keep quantity bounds separate from sales allowances.
export const MINIMAX_VIDEO_REQUEST_SOURCE = "https://platform.minimax.io/docs/api-reference/video-generation-v2-create";
export const MINIMAX_VIDEO_PROFILES = {
    "MiniMax-H3": { resolutions: ["768P", "2K"], minDuration: 4 },
    "MiniMax-H3-Max": { resolutions: ["480P", "768P"], minDuration: 5 },
} as const;
export type MinimaxVideoModel = keyof typeof MINIMAX_VIDEO_PROFILES;
export type VideoRequestBound = {
    protocol: "minimax-video-v2";
    requestedModel: MinimaxVideoModel;
    resolution: string;
    requestedDuration: number;
    maximumQuantities: { inputSeconds: string; outputSeconds: string; inputImageCount: string; inputAudioSeconds: string };
    sourceUrl: string;
};
const object = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** Quantity evidence only: no price, free allowance, wallet mutation or request normalization. */
export function inspectMinimaxVideoRequestBound(payload: unknown, requestedModel: string, declaredProtocol: string): VideoRequestBound {
    const body = object(payload);
    if (declaredProtocol !== "minimax" || !Object.hasOwn(MINIMAX_VIDEO_PROFILES, requestedModel) || body.model !== requestedModel) throw new PricingInputError("视频请求型号或协议不在已核实 H3 V2 范围");
    const model = requestedModel as MinimaxVideoModel;
    const profile = MINIMAX_VIDEO_PROFILES[model];
    if (Object.keys(body).some((key) => !["model", "content", "resolution", "duration", "ratio", "extra", "callback_url"].includes(key))) throw new PricingInputError("请求包含尚无计量上界的额外字段");
    const resolution = body.resolution ?? (model === "MiniMax-H3-Max" ? "768P" : undefined);
    if (typeof resolution !== "string" || !(profile.resolutions as readonly string[]).includes(resolution)) throw new PricingInputError("视频分辨率尚无已核实上界");
    if (typeof body.duration !== "number" || !Number.isInteger(body.duration) || body.duration < profile.minDuration || body.duration > 15) throw new PricingInputError("视频时长不符合供应商公开范围");
    if (body.extra !== undefined && (model !== "MiniMax-H3-Max" || !body.extra || typeof body.extra !== "object" || Array.isArray(body.extra) || Object.keys(body.extra).some((key) => key !== "prompt_expansion_mode")))
        throw new PricingInputError("视频附加能力尚无计量上界");
    if (!Array.isArray(body.content) || !body.content.length) throw new PricingInputError("缺少可核对的视频输入素材");
    let texts = 0,
        images = 0,
        videos = 0,
        audios = 0,
        first = 0,
        last = 0,
        reference = false;
    for (const raw of body.content) {
        const item = object(raw);
        if (item.type === "text") {
            if (typeof item.text !== "string" || !item.text.trim()) throw new PricingInputError("视频需求不能为空");
            texts++;
        } else if (["image_url", "video_url", "audio_url"].includes(String(item.type))) {
            const type = item.type as string;
            if (typeof object(item[type]).url !== "string" || !String(object(item[type]).url).trim()) throw new PricingInputError("视频素材地址缺失");
            const role = item.role ?? (type === "image_url" ? "first_frame" : undefined);
            if (type === "image_url" && ["first_frame", "last_frame", "reference_image"].includes(String(role))) {
                images++;
                if (role === "first_frame") first++;
                else if (role === "last_frame") last++;
                else reference = true;
            } else if (type === "video_url" && role === "reference_video") {
                videos++;
                reference = true;
            } else if (type === "audio_url" && role === "reference_audio") {
                audios++;
                reference = true;
            } else throw new PricingInputError("视频素材类型与角色不符");
        } else throw new PricingInputError("视频输入包含未知计量类型");
    }
    if (texts !== 1 || first > 1 || last > 1 || images > 9 || videos > 3 || audios > 3 || (reference && first + last > 0)) throw new PricingInputError("视频素材组合不符合供应商公开范围");
    const ratios = ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
    if ((body.ratio !== undefined && !ratios.includes(String(body.ratio))) || (images + videos + audios === 0 && (body.ratio === undefined || body.ratio === "adaptive"))) throw new PricingInputError("视频比例不符合供应商公开范围");
    return {
        protocol: "minimax-video-v2",
        requestedModel: model,
        resolution,
        requestedDuration: body.duration,
        // Use the documented generation ceiling, not requested duration as an assumed exact billed duration.
        maximumQuantities: { inputSeconds: videos ? "15" : "0", outputSeconds: "15", inputImageCount: String(images), inputAudioSeconds: audios ? "15" : "0" },
        sourceUrl: MINIMAX_VIDEO_REQUEST_SOURCE,
    };
}

/** A mismatch requires pricing review; it must not turn a delivered video into a failed generation. */
export function validateObservedVideoRequestBound(bound: VideoRequestBound, observation: VideoUsageObservation): string[] {
    const reasons = [...observation.invalid];
    const profile = MINIMAX_VIDEO_PROFILES[bound.requestedModel];
    const maximum = bound.maximumQuantities;
    if (
        !profile ||
        !(profile.resolutions as readonly string[]).includes(bound.resolution) ||
        bound.sourceUrl !== MINIMAX_VIDEO_REQUEST_SOURCE ||
        !Number.isInteger(bound.requestedDuration) ||
        bound.requestedDuration < profile.minDuration ||
        bound.requestedDuration > 15 ||
        Object.keys(maximum).sort().join() !== "inputAudioSeconds,inputImageCount,inputSeconds,outputSeconds" ||
        maximum.outputSeconds !== "15" ||
        !["0", "15"].includes(maximum.inputSeconds) ||
        !["0", "15"].includes(maximum.inputAudioSeconds) ||
        !/^[0-9]$/.test(maximum.inputImageCount)
    )
        return ["保存的视频请求上界不符合公开契约"];
    if (observation.protocol !== bound.protocol || observation.reportedModel !== bound.requestedModel || observation.resolution !== bound.resolution || observation.taskType !== "generation" || observation.modality !== "video")
        reasons.push("视频响应与原请求的型号、分辨率或生成类型不一致");
    for (const [meter, maximum] of Object.entries(bound.maximumQuantities)) {
        const value = observation.quantities[meter];
        if (!value || !/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value) || (meter === "inputImageCount" && !/^\d+$/.test(value))) {
            reasons.push(`缺少 ${meter} 的有效上界核对用量`);
            continue;
        }
        // Decimal exponent notation can be returned by String(number) in the observation parser.
        const actual = Number(value);
        if (!Number.isFinite(actual) || actual < 0 || !Number.isSafeInteger(Math.ceil(actual)) || new Decimal(value).gt(maximum)) reasons.push(`${meter} 超出原请求的供应商公开上界`);
    }
    return reasons;
}
