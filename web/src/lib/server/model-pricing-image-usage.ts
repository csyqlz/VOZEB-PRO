import { randomUUID } from "node:crypto";
import { mutateStoredGenerationTask } from "./generation-task-store";
import { GENERATION_TASK_RETENTION_MS } from "./generation-task-retention";
import type { ImageTask } from "./image-task-store";
import { inspectUsageFields } from "./model-pricing-usage-fields";

export type ImageUsageObservation = {
    protocol: "openai-images";
    quantities: Record<string, string>;
    missing: string[];
    invalid: string[];
    hasResults: boolean;
    reportedModel?: string;
    quality?: string;
    size?: string;
    requestMismatches?: Array<{ field: "quality" | "size"; requested: string; reported: string; source: string }>;
    usageFields?: Record<string, string>;
    unmappedUsageFields?: string[];
    zeroOnlyUsageFields?: string[];
    meterSources?: Record<string, { paths: string[]; kind: "upstream-response" | "approved-derivation"; formula?: string }>;
};
export type ImageUsageReceipt = {
    id: string;
    attemptNo: number;
    channelId?: string;
    requestedModel: string;
    logicalModel: string;
    operation: "generations" | "edits";
    observedAt: string;
    pointsRecordId?: string;
    observation: ImageUsageObservation;
    usageEvidence?: Record<string, unknown>;
};
const object = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** Preserve provider usage field presence and numeric values without storing media or free-form text. */
function usageEvidence(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return Object.fromEntries(
        Object.entries(value).flatMap<[string, unknown]>(([key, entry]) => {
            if (!/^[a-z][a-z0-9_]*$/i.test(key)) return [];
            if (typeof entry === "number" && Number.isFinite(entry)) return [[key, entry]];
            if (typeof entry === "string" && /^\d+$/.test(entry) && Number.isSafeInteger(Number(entry))) return [[key, entry]];
            if (entry && typeof entry === "object" && !Array.isArray(entry)) return [[key, usageEvidence(entry)]];
            return [[key, null]];
        }),
    );
}

/** Facts only: no guessed cache counts, model identity, output split, or image-price estimates. */
export function inspectOpenAiImageUsage(payload: unknown): ImageUsageObservation {
    const body = object(payload);
    const usage = object(body.usage);
    const zeroOnlyUsageFields = [
        ["input_tokens_details.cached_tokens", object(usage.input_tokens_details).cached_tokens],
        ["output_tokens_details.reasoning_tokens", object(usage.output_tokens_details).reasoning_tokens],
    ]
        .filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] === 0)
        .map(([path]) => path);
    const inventory = inspectUsageFields(usage, [
        "input_tokens",
        "output_tokens",
        "total_tokens",
        "input_tokens_details.text_tokens",
        "input_tokens_details.image_tokens",
        "output_tokens_details.text_tokens",
        "output_tokens_details.image_tokens",
        ...zeroOnlyUsageFields,
    ]);
    const observation: ImageUsageObservation = {
        protocol: "openai-images",
        quantities: {},
        missing: [],
        invalid: [],
        usageFields: inventory.fields,
        unmappedUsageFields: inventory.unmapped,
        zeroOnlyUsageFields,
        meterSources: {},
        hasResults:
            Array.isArray(body.data) &&
            body.data.length > 0 &&
            body.data.every((value) => {
                const item = object(value);
                return (typeof item.b64_json === "string" && item.b64_json.length > 0) || (typeof item.url === "string" && item.url.length > 0);
            }),
    };
    for (const [field, target] of [
        ["model", "reportedModel"],
        ["quality", "quality"],
        ["size", "size"],
    ] as const)
        if (typeof body[field] === "string") observation[target] = body[field];
    const results = Array.isArray(body.data) ? body.data.map(object) : [];
    const resultModels = results.map((item) => item.model).filter((model): model is string => typeof model === "string" && Boolean(model.trim()));
    if (resultModels.some((model) => model !== resultModels[0] || (observation.reportedModel && model !== observation.reportedModel))) observation.invalid.push("图片结果项报告的型号不一致");
    else if (!observation.reportedModel && resultModels.length === results.length && resultModels.length) observation.reportedModel = resultModels[0];
    if (body.error) observation.invalid.push("上游响应包含错误");
    if (inventory.unmapped.length) observation.invalid.push(`未解释的图片用量字段：${inventory.unmapped.join("、")}`);
    const read = (source: Record<string, unknown>, field: string, target: string, path = field) => {
        const value = source[field];
        if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
            observation.quantities[target] = String(value);
            observation.meterSources![target] = { paths: [`usage.${path}`], kind: "upstream-response" };
        } else {
            observation.missing.push(path);
            if (value !== undefined && value !== null) observation.invalid.push(`${path} 不是有效的非负整数`);
        }
    };
    read(usage, "input_tokens", "inputTotalTokens");
    read(usage, "output_tokens", "outputTotalTokens");
    read(usage, "total_tokens", "totalTokens");
    for (const direction of ["input", "output"] as const) {
        const details = object(usage[`${direction}_tokens_details`]);
        read(details, "text_tokens", `${direction}TextTokens`, `${direction}_tokens_details.text_tokens`);
        read(details, "image_tokens", `${direction}ImageTokens`, `${direction}_tokens_details.image_tokens`);
    }
    const sumMatches = (total: string, parts: string[]) => {
        const quantities = observation.quantities;
        if (quantities[total] !== undefined && parts.every((key) => quantities[key] !== undefined) && parts.reduce((sum, key) => sum + BigInt(quantities[key]), BigInt(0)) !== BigInt(quantities[total]))
            observation.invalid.push(`${total} 与分项合计不一致`);
    };
    sumMatches("inputTotalTokens", ["inputTextTokens", "inputImageTokens"]);
    sumMatches("outputTotalTokens", ["outputTextTokens", "outputImageTokens"]);
    sumMatches("totalTokens", ["inputTotalTokens", "outputTotalTokens"]);
    return observation;
}

/** Keep safe request/response parameter discrepancies with the receipt; token usage remains authoritative. */
export function recordImageRequestMismatches(observation: ImageUsageObservation, payload: unknown, request: unknown): ImageUsageObservation {
    const body = object(payload);
    const requested = object(request);
    const mismatches: NonNullable<ImageUsageObservation["requestMismatches"]> = [];
    const check = (field: "quality" | "size", reported: unknown, source: string) => {
        if (typeof requested[field] !== "string" || typeof reported !== "string" || reported === requested[field]) return;
        const safe = (value: string) => ((field === "size" ? /^(?:[1-9]\d*x[1-9]\d*|auto|2K)$/.test(value) : /^[a-z][a-z0-9_-]{0,31}$/i.test(value)) ? value : "unrecognized");
        mismatches.push({ field, requested: safe(requested[field]), reported: safe(reported), source });
    };
    check("quality", body.quality, "response.quality");
    check("size", body.size, "response.size");
    if (Array.isArray(body.data))
        body.data.forEach((value, index) => {
            const item = object(value);
            check("size", item.size, `data[${index}].size`);
            if (Number.isSafeInteger(item.width) && Number.isSafeInteger(item.height) && Number(item.width) > 0 && Number(item.height) > 0) check("size", `${item.width}x${item.height}`, `data[${index}].dimensions`);
        });
    return mismatches.length ? { ...observation, requestMismatches: mismatches } : observation;
}

/** Reinterpret saved numeric facts after recognizing zero-only direct Images metadata; never rewrite the original observation. */
export function reinterpretDirectImageZeroMetadata(observation: ImageUsageObservation): ImageUsageObservation {
    const zeroOnlyUsageFields = ["input_tokens_details.cached_tokens", "output_tokens_details.reasoning_tokens"].filter((path) => observation.usageFields?.[path] === "0");
    const unmappedUsageFields = (observation.unmappedUsageFields || []).filter((path) => !zeroOnlyUsageFields.includes(path));
    const oldUnknown = observation.unmappedUsageFields?.length ? `未解释的图片用量字段：${observation.unmappedUsageFields.join("、")}` : null;
    return {
        ...observation,
        zeroOnlyUsageFields,
        unmappedUsageFields,
        invalid: [...observation.invalid.filter((reason) => reason !== oldUnknown), ...(unmappedUsageFields.length ? [`未解释的图片用量字段：${unmappedUsageFields.join("、")}`] : [])],
    };
}

/** Count only a complete synchronous URL result; no synthetic token quantities. */
export function inspectOpenAiImageCount(payload: unknown): ImageUsageObservation {
    const body = object(payload);
    const inventory = inspectUsageFields(body.usage, []);
    const observation: ImageUsageObservation = {
        protocol: "openai-images",
        quantities: {},
        missing: [],
        invalid: inventory.unmapped.length ? [`未解释的图片用量字段：${inventory.unmapped.join("、")}`] : [],
        hasResults: false,
        usageFields: inventory.fields,
        unmappedUsageFields: inventory.unmapped,
        meterSources: {},
    };
    if (typeof body.model === "string") observation.reportedModel = body.model;
    if (body.error) observation.invalid.push("上游响应包含错误");
    if (!Array.isArray(body.data) || !body.data.length) observation.missing.push("data");
    else if (
        body.data.every((item) => {
            try {
                const url = new URL(String(object(item).url));
                return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
            } catch {
                return false;
            }
        })
    ) {
        observation.hasResults = true;
        observation.quantities.images = String(body.data.length);
        observation.meterSources!.images = { paths: ["data.length"], kind: "approved-derivation", formula: "count complete image results" };
    } else observation.invalid.push("图片结果未完整返回有效 URL");
    return observation;
}

/** A diagnostic write must never turn a received media result into a paid retry. */
export async function observeImageTaskUsage(task: ImageTask, response: Response, payload: unknown, requestUrl?: string) {
    if (!requestUrl || !response.ok) return;
    try {
        const match = new URL(requestUrl, "http://internal").pathname.match(/\/images\/(generations|edits)$/i);
        if (!match) return;
        const capturedUsage = usageEvidence(object(payload).usage);
        const receipt: ImageUsageReceipt = {
            id: randomUUID(),
            attemptNo: task.attemptNo || 1,
            channelId: task.config.channelId,
            requestedModel: task.config.model,
            logicalModel: task.config.logicalModel || task.config.model,
            operation: match[1].toLowerCase() as ImageUsageReceipt["operation"],
            observedAt: new Date().toISOString(),
            ...(response.headers.get("x-vozeb-pro-points-record-id") ? { pointsRecordId: response.headers.get("x-vozeb-pro-points-record-id")! } : {}),
            observation: inspectOpenAiImageUsage(payload),
            ...(capturedUsage ? { usageEvidence: capturedUsage } : {}),
        };
        await mutateStoredGenerationTask<ImageTask>("image", task.id, GENERATION_TASK_RETENTION_MS, (current) => {
            if (current.userId !== task.userId) throw new Error("图片任务用量身份不匹配");
            return { ...current, usageObservations: [...(current.usageObservations || []), receipt] };
        });
    } catch (error) {
        console.error("Image usage observation unavailable", { taskId: task.id, errorType: error instanceof Error ? error.name : "unknown" });
    }
}
