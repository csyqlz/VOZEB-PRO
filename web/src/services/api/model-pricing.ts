import type {
    BusinessExchangeRate,
    ModelPriceLifecycleMark,
    ModelPriceBinding,
    OfficialPriceInput,
    OfficialPriceCatalogEntry,
    OfficialPriceObservation,
    OfficialPriceObservationLink,
    OfficialPriceSource,
    OfficialPriceVersion,
    PriceCandidate,
    SalesPolicy,
    SalesVersion,
    UnpricedModel,
    UnpricedModelStatus,
} from "@/lib/model-pricing";
import type { FlatTextPriceContract, FlatTextPriceContractInput, FlatTextMeter } from "@/lib/server/model-pricing-token-contract";
import type { TokenUsageProtocol } from "@/lib/server/model-pricing-token-usage";

export type UnpricedModelFilter = { manufacturer?: string; series?: string; capability?: string; name?: string; status?: UnpricedModelStatus };
export type ModelWorkbenchFilter = { enabled?: "active" | "disabled" | "all"; manufacturer?: string; capability?: string; name?: string; status?: "no-candidate" | "pending-review" | "sales-unpublished" | "published" | "channel-pending" };
export type ModelWorkbenchRow = {
    id: string;
    name: string;
    manufacturer: string;
    series: string;
    capability: string;
    enabled: boolean;
    status: Exclude<NonNullable<ModelWorkbenchFilter["status"]>, "channel-pending">;
    approvedPrice: boolean;
    publishedPrice: boolean;
    publishedScopes: string[];
    bindingCount: number;
    billingMode: "disabled" | "fixed" | "metered" | "paused" | "review-needed";
    billingBindingSlots: number;
    qualifiedBindings: number;
    activeBindings: number;
    pendingBindings: number | null;
    blocker: string | null;
};
export type ModelPricingAdmission = Awaited<ReturnType<typeof import("@/lib/server/model-pricing-admission").getModelPricingAdmission>>;
export type ModelPricingActivationStatus = Awaited<ReturnType<typeof import("@/lib/server/model-pricing-activation-service").getModelPricingActivationStatus>>;
export type ModelPricingSampleUsage = Awaited<ReturnType<typeof import("@/lib/server/model-pricing-shadow-evidence").getModelPricingSampleUsage>>;
export async function getModelPricingSampleUsage(modelId: string, officialVersionId: string): Promise<ModelPricingSampleUsage> {
    const response = await fetch(`/api/admin/model-pricing?action=sample&modelId=${encodeURIComponent(modelId)}&officialVersionId=${encodeURIComponent(officialVersionId)}`, { credentials: "same-origin" });
    const result = (await response.json()) as { code: number; data: ModelPricingSampleUsage; msg: string };
    if (!response.ok || result.code !== 0) throw new Error(result.msg || "样例用量读取失败");
    return result.data;
}
export async function getModelPricingActivationStatus(modelId: string, imageOperation?: "generations" | "edits", audioOperation?: "generateContent" | "chat/completions"): Promise<ModelPricingActivationStatus> {
    const response = await fetch(
        `/api/admin/model-pricing?action=activation&modelId=${encodeURIComponent(modelId)}${imageOperation ? `&imageOperation=${imageOperation}` : ""}${audioOperation ? `&audioOperation=${encodeURIComponent(audioOperation)}` : ""}`,
        { credentials: "same-origin" },
    );
    const result = (await response.json()) as { code: number; data: ModelPricingActivationStatus; msg: string };
    if (!response.ok || result.code !== 0) throw new Error(result.msg || "模型计费状态读取失败");
    return result.data;
}
export async function setModelPricingActivation(input: {
    modelId: string;
    enabled: boolean;
    expectedRevision: string | null;
    bindingKey?: string;
    imageOperation?: "generations" | "edits";
    audioOperation?: "generateContent" | "chat/completions";
}): Promise<ModelPricingActivationStatus> {
    const response = await fetch("/api/admin/model-pricing", { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "activation", ...input }) });
    const result = (await response.json()) as { code: number; data: ModelPricingActivationStatus; msg: string };
    if (!response.ok || result.code !== 0) throw new Error(result.msg || "模型计费状态保存失败");
    return result.data;
}
export async function revalueSavedImageEvidence(modelId: string, bindingKey: string, imageOperation?: "generations" | "edits") {
    const response = await fetch("/api/admin/model-pricing", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "revalue-image-evidence", modelId, bindingKey, imageOperation }),
    });
    const result = (await response.json()) as { code: number; data: { revalued: number }; msg: string };
    if (!response.ok || result.code !== 0) throw new Error(result.msg || "历史图片用量复核失败");
    return result.data;
}
export async function revalueSavedTextEvidence(modelId: string, bindingKey: string) {
    const response = await fetch("/api/admin/model-pricing/text-evidence", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ modelId, bindingKey }) });
    const result = (await response.json()) as { code: number; data: { revalued: number }; msg: string };
    if (!response.ok || result.code !== 0) throw new Error(result.msg || "已有文本调用复核失败");
    return result.data;
}
export type DirectedPricingCapability = "text" | "image" | "video" | "audio";
export type DirectedPricingOperation = "generation" | "edit";
const directedTaskPaths: Record<DirectedPricingCapability, string> = { text: "text-tasks", image: "image-tasks", video: "video-generation-tasks", audio: "audio-tasks" };

export async function createDirectedPricingTask(input: { capability: DirectedPricingCapability; modelId: string; bindingKey: string; operation: DirectedPricingOperation; prompt: string; referenceDataUrl?: string }) {
    const body =
        input.capability === "text"
            ? { config: { model: input.modelId }, messages: [{ role: "user", content: input.prompt }] }
            : input.capability === "image"
              ? { config: { model: input.modelId }, kind: input.operation, prompt: input.prompt, references: input.operation === "edit" && input.referenceDataUrl ? [{ dataUrl: input.referenceDataUrl }] : [] }
              : { config: { model: input.modelId }, prompt: input.prompt };
    const response = await fetch(`/api/${directedTaskPaths[input.capability]}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-vozeb-pro-pricing-test-binding": input.bindingKey, "x-vozeb-pro-client-request-id": `pricing-test:${crypto.randomUUID()}` },
        body: JSON.stringify(body),
    });
    const result = (await response.json()) as { task?: { id: string; status: string; error?: string }; error?: string };
    if (!response.ok || !result.task) throw new Error(result.error || "定向验收任务创建失败");
    return result.task;
}

export async function getDirectedPricingTask(capability: DirectedPricingCapability, taskId: string) {
    const path = capability === "video" ? "video-tasks" : directedTaskPaths[capability];
    const response = await fetch(`/api/${path}/${encodeURIComponent(taskId)}`, { credentials: "same-origin", cache: "no-store" });
    const result = (await response.json()) as { task?: { id: string; status: string; error?: string; executionPhase?: string; result?: { dataUrl: string; serverUrl?: string; results?: Array<{ dataUrl: string; serverUrl?: string }> } }; error?: string };
    if (!response.ok || !result.task) throw new Error(result.error || "定向验收任务读取失败");
    return result.task;
}
export type DirectedPricingEvidence = Awaited<ReturnType<typeof import("@/lib/server/model-pricing-shadow-evidence").getDirectedPricingEvidence>>;
export async function getDirectedPricingEvidence(capability: DirectedPricingCapability, taskId: string): Promise<DirectedPricingEvidence> {
    const response = await fetch(`/api/admin/model-pricing?action=directed-evidence&capability=${capability}&taskId=${encodeURIComponent(taskId)}`, { credentials: "same-origin", cache: "no-store" });
    const result = (await response.json()) as { code: number; data: DirectedPricingEvidence; msg: string };
    if (!response.ok || result.code !== 0) throw new Error(result.msg || "定向验收证据读取失败");
    return result.data;
}
export async function getModelPricingAdmission(modelId: string): Promise<ModelPricingAdmission> {
    const response = await fetch(`/api/admin/model-pricing?action=admission&modelId=${encodeURIComponent(modelId)}`, { credentials: "same-origin" });
    const result = (await response.json()) as { code: number; data: ModelPricingAdmission; msg: string };
    if (!response.ok || result.code !== 0) throw new Error(result.msg || "模型计费准入核对失败");
    return result.data;
}
export type PriceReviewResult = import("@/lib/server/model-pricing-ai-review").PriceReviewResult;
export type PriceReviewProgress = import("@/lib/server/model-pricing-ai-review").PriceReviewProgress;
export type OfficialPriceObservationPage = { observations: OfficialPriceObservation[]; links: OfficialPriceObservationLink[]; total: number; page: number; pageSize: number };
export type FlatTextContractRecord = FlatTextPriceContract & { id: string; current: boolean };
export type FlatTextContractOptions = {
    version: OfficialPriceVersion;
    bindings: Array<{ channelId: string; channelName: string; channelBindingId?: string; requestedModel: string; suggestedProtocol?: TokenUsageProtocol }>;
    protocolMeters: Record<TokenUsageProtocol, FlatTextMeter[]>;
    inclusiveInputMeters: FlatTextMeter[];
};
export type FlatTextContractHistory = { version: OfficialPriceVersion; contracts: FlatTextContractRecord[] };

async function tokenContractRequest<T>(method: "GET" | "POST", body?: unknown, query?: URLSearchParams): Promise<T> {
    const response = await fetch(`/api/admin/model-pricing/token-contracts${query ? `?${query}` : ""}`, {
        method,
        credentials: "same-origin",
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = (await response.json()) as { code: number; data: T; msg: string };
    if (!response.ok || result.code !== 0) throw new Error(result.msg || "纯文本计费契约操作失败");
    return result.data;
}
export const getFlatTextContractOptions = (officialVersionId: string, logicalModelId?: string) => tokenContractRequest<FlatTextContractOptions>("GET", undefined, new URLSearchParams({ officialVersionId, ...(logicalModelId ? { logicalModelId } : {}) }));
export const getFlatTextContractHistory = (officialVersionId: string, channelId: string, requestedModel: string) => tokenContractRequest<FlatTextContractHistory>("GET", undefined, new URLSearchParams({ officialVersionId, channelId, requestedModel }));
export const reviewFlatTextContract = (officialVersionId: string, contract: FlatTextPriceContractInput, expectedCurrentId: string | null, logicalModelId?: string) =>
    tokenContractRequest<FlatTextContractRecord>("POST", { officialVersionId, contract, expectedCurrentId, ...(logicalModelId ? { logicalModelId } : {}) });

export type TextUsageRuleOptions = { officialVersionId: string; rules: import("@/lib/model-pricing").TextUsageRule[] };
async function textUsageRuleRequest<T>(method: "GET" | "POST", modelId: string, body?: unknown): Promise<T> {
    const response = await fetch(`/api/admin/model-pricing/text-usage-rules${method === "GET" ? `?modelId=${encodeURIComponent(modelId)}` : ""}`, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        headers: method === "POST" ? { "content-type": "application/json" } : undefined,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = (await response.json()) as { code: number; data: T; msg: string };
    if (!response.ok || result.code !== 0) throw new Error(result.msg || "文本用量规则请求失败");
    return result.data;
}
export const getTextUsageRuleOptions = (modelId: string) => textUsageRuleRequest<TextUsageRuleOptions>("GET", modelId);
export const reviewTextUsageRule = (input: { modelId: string; officialVersionId: string; cacheReadMissingAsZero: boolean; cacheWriteMissingAsZero: boolean; evidence: string; expectedCurrentId: string | null }) =>
    textUsageRuleRequest<import("@/lib/model-pricing").TextUsageRule>("POST", input.modelId, input);
export type TextPricingExceptions = Awaited<ReturnType<typeof import("@/lib/server/model-pricing-text-exceptions").listTextPricingExceptions>>;
export async function getTextPricingExceptions(modelId = "", offset = 0, filters: { channelId?: string; status?: "pending-review" | "settled-warning" } = {}): Promise<TextPricingExceptions> {
    const query = new URLSearchParams({ modelId, offset: String(offset) });
    if (filters.channelId) query.set("channelId", filters.channelId);
    if (filters.status) query.set("status", filters.status);
    const response = await fetch(`/api/admin/model-pricing/text-exceptions?${query}`, { credentials: "same-origin", cache: "no-store" });
    const result = (await response.json()) as { code: number; data: TextPricingExceptions; msg: string };
    if (!response.ok || result.code !== 0) throw new Error(result.msg || "文本计费异常读取失败");
    return result.data;
}

export type ImageContractRecord = import("@/lib/server/model-pricing-image-contract").ImagePriceContract & { id: string; current: boolean };
export type ImageContractOptions = {
    version: OfficialPriceVersion;
    bindings: Array<{ channelBindingId: string; channelId: string; channelName: string; requestedModel: string; selectedOperations: string[]; imageCountOperations: string[] }>;
    meters: import("@/lib/server/model-pricing-image-contract").ImageTokenMeter[];
};
export type ImageContractHistory = { version: OfficialPriceVersion; contracts: ImageContractRecord[] };
async function imageContractRequest<T>(method: "GET" | "POST", body?: unknown, query?: URLSearchParams): Promise<T> {
    const response = await fetch(`/api/admin/model-pricing/image-contracts${query ? `?${query}` : ""}`, {
        method,
        credentials: "same-origin",
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = (await response.json()) as { code: number; data: T; msg: string };
    if (!response.ok || result.code !== 0) throw new Error(result.msg || "图片计费契约操作失败");
    return result.data;
}
export const getImageContractOptions = (officialVersionId: string, logicalModelId?: string) => imageContractRequest<ImageContractOptions>("GET", undefined, new URLSearchParams({ officialVersionId, ...(logicalModelId ? { logicalModelId } : {}) }));
export const getImageContractHistory = (officialVersionId: string, channelId: string, requestedModel: string, operation: string) =>
    imageContractRequest<ImageContractHistory>("GET", undefined, new URLSearchParams({ officialVersionId, channelId, requestedModel, operation }));
export const reviewImageContract = (officialVersionId: string, contract: import("@/lib/server/model-pricing-image-contract").ImagePriceContractInput, expectedCurrentId: string | null, logicalModelId?: string) =>
    imageContractRequest<ImageContractRecord>("POST", { officialVersionId, contract, expectedCurrentId, ...(logicalModelId ? { logicalModelId } : {}) });

export type VideoContractRecord = import("@/lib/server/model-pricing-video-contract-store").ReviewedVideoPriceContract & { id: string; current: boolean };
export type VideoContractOptions = Awaited<ReturnType<typeof import("@/lib/server/model-pricing-video-contract-service").getVideoPriceContractOptions>>;
export type VideoContractHistory = { version: OfficialPriceVersion; contracts: VideoContractRecord[] };
async function videoContractRequest<T>(method: "GET" | "POST", body?: unknown, query?: URLSearchParams): Promise<T> {
    const response = await fetch(`/api/admin/model-pricing/video-contracts${query ? `?${query}` : ""}`, {
        method,
        credentials: "same-origin",
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = (await response.json()) as { code: number; data: T; msg: string };
    if (!response.ok || result.code !== 0) throw new Error(result.msg || "视频计费契约操作失败");
    return result.data;
}
export const getVideoContractOptions = (officialVersionId: string, logicalModelId?: string) => videoContractRequest<VideoContractOptions>("GET", undefined, new URLSearchParams({ officialVersionId, ...(logicalModelId ? { logicalModelId } : {}) }));
export const getVideoContractHistory = (officialVersionId: string, channelId: string, requestedModel: string) => videoContractRequest<VideoContractHistory>("GET", undefined, new URLSearchParams({ officialVersionId, channelId, requestedModel }));
export const reviewVideoContract = (officialVersionId: string, contract: import("@/lib/server/model-pricing-video-contract-store").ReviewedVideoPriceContractInput, expectedCurrentId: string | null, logicalModelId?: string) =>
    videoContractRequest<VideoContractRecord>("POST", { officialVersionId, contract, expectedCurrentId, ...(logicalModelId ? { logicalModelId } : {}) });

export type AudioContractRecord = import("@/lib/server/model-pricing-audio-contract-store").StoredAudioPriceContract;
export type AudioContractOptions = Awaited<ReturnType<typeof import("@/lib/server/model-pricing-audio-contract-service").getAudioPriceContractOptions>>;
export type AudioContractHistory = { version: OfficialPriceVersion; contracts: AudioContractRecord[] };
async function audioContractRequest<T>(method: "GET" | "POST", body?: unknown, query?: URLSearchParams): Promise<T> {
    const response = await fetch(`/api/admin/model-pricing/audio-contracts${query ? `?${query}` : ""}`, {
        method,
        credentials: "same-origin",
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = (await response.json()) as { code: number; data: T; msg: string };
    if (!response.ok || result.code !== 0) throw new Error(result.msg || "音频计费契约操作失败");
    return result.data;
}
export const getAudioContractOptions = (officialVersionId: string, logicalModelId?: string) => audioContractRequest<AudioContractOptions>("GET", undefined, new URLSearchParams({ officialVersionId, ...(logicalModelId ? { logicalModelId } : {}) }));
export const getAudioContractHistory = (officialVersionId: string, channelId: string, requestedModel: string) => audioContractRequest<AudioContractHistory>("GET", undefined, new URLSearchParams({ officialVersionId, channelId, requestedModel }));
export const reviewAudioContract = (officialVersionId: string, contract: import("@/lib/server/model-pricing-audio-contract-store").ReviewedAudioPriceContractInput, expectedCurrentId: string | null, logicalModelId?: string) =>
    audioContractRequest<AudioContractRecord>("POST", { officialVersionId, contract, expectedCurrentId, ...(logicalModelId ? { logicalModelId } : {}) });

async function observationRequest<T>(method: "GET" | "POST" | "PATCH" | "DELETE", body?: unknown, query?: URLSearchParams): Promise<T> {
    const response = await fetch(`/api/admin/model-pricing/observations${query ? `?${query}` : ""}`, {
        method,
        credentials: "same-origin",
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = (await response.json()) as { code: number; data: T; msg: string };
    if (!response.ok || result.code !== 0) throw new Error(result.msg || "官网发现操作失败");
    return result.data;
}
export const getOfficialPriceObservations = (page = 1, manufacturer = "", status: "open" | "pending" | "confirmed" | "rejected" | "all" = "all") =>
    observationRequest<OfficialPriceObservationPage>("GET", undefined, new URLSearchParams({ page: String(page), manufacturer, status }));
export const saveOfficialPriceObservation = (result: PriceReviewResult, finding: PriceReviewResult["findings"][number], newOnly = false, variants: PriceReviewResult["findings"] = [finding]) =>
    observationRequest<OfficialPriceObservation>("POST", {
        newOnly,
        manufacturer: result.manufacturer,
        officialModelId: finding.officialModelId,
        sourceUrl: result.sourceUrl,
        sourceDigest: result.sourceDigest,
        sourceMode: result.sourceMode,
        observedAt: result.observedAt,
        evidence: [...new Set(variants.map((item) => item.evidence))].join("\n"),
        sourceRowIds: [...new Set(variants.flatMap((item) => item.sourceRowIds))],
        conditions: finding.observedConditions,
        items: finding.observedItems,
        extractionIssue: finding.extractionIssue,
        suggestedSeries: finding.suggestedSeries,
        suggestedVersion: finding.suggestedVersion,
        suggestedTier: finding.suggestedTier,
        suggestedProcessingTier: finding.suggestedProcessingTier,
        suggestedEffectiveFrom: finding.suggestedEffectiveFrom,
        suggestedEffectiveTo: finding.suggestedEffectiveTo,
        headerEvidence: finding.headerEvidence,
        ...(variants.length > 1
            ? {
                  priceVariants: variants
                      .filter((item) => item.observedItems.length)
                      .map((item) => ({
                          evidence: item.evidence,
                          conditions: item.observedConditions,
                          items: item.observedItems,
                          suggestedSeries: item.suggestedSeries,
                          suggestedVersion: item.suggestedVersion,
                          suggestedTier: item.suggestedTier,
                          suggestedProcessingTier: item.suggestedProcessingTier,
                          suggestedEffectiveFrom: item.suggestedEffectiveFrom,
                          suggestedEffectiveTo: item.suggestedEffectiveTo,
                          headerEvidence: item.headerEvidence,
                      })),
              }
            : {}),
    });
export const amendOfficialPriceObservation = (id: string, input: { variantIndex: number; items: OfficialPriceInput["items"]; itemEvidence: string[]; conditions: string; reason: string; expectedRevision: number }) =>
    observationRequest<NonNullable<OfficialPriceObservation["amendments"]>[number]>("PATCH", { action: "amend", id, ...input });
export const reviewOfficialPriceObservation = (id: string, status: "confirmed" | "rejected", note = "", expectedRevision = 0) => observationRequest<OfficialPriceObservation>("PATCH", { action: "review", id, status, note, expectedRevision });
export const deleteOfficialPriceObservation = (id: string) => observationRequest<{ id: string; deleted: true }>("DELETE", { id });
export const invalidateOfficialPriceObservation = (id: string, reason: string) => observationRequest<OfficialPriceObservation>("PATCH", { action: "invalidate", id, reason });
export const bindOfficialPriceObservation = (id: string, logicalModelId: string | null) => observationRequest<OfficialPriceObservationLink | null>("PATCH", { action: "bind", id, logicalModelId });

export type ModelPricingOverview = {
    candidates: PriceCandidate[];
    officialVersions: OfficialPriceVersion[];
    approvedVersions: OfficialPriceVersion[];
    approvedTotal: number;
    boundVersions: OfficialPriceVersion[];
    salesVersions: SalesVersion[];
    candidateTotal: number;
    candidateAllTotal: number;
    manufacturers: string[];
    candidateModelIds: string[];
    unpricedModels: UnpricedModel[];
    unpricedTotal: number;
    unpricedPage: number;
    workbenchModels: ModelWorkbenchRow[];
    workbenchTodo: { pendingOfficialModels: number; unpublishedSalesModels: number; pendingBindings: number; reviewNeededBindings: number };
    workbenchTotal: number;
    workbenchPage: number;
    workbenchManufacturers: string[];
    officialSources: OfficialPriceSource[];
    lifecycleMarks: ModelPriceLifecycleMark[];
    officialTotal: number;
    candidatePage: number;
    officialPage: number;
    pageSize: number;
    selectedModelId: string;
    currentSalesVersionId: string | null;
    exchangeRate?: BusinessExchangeRate;
    models: Array<{ id: string; name: string; capability: string; manufacturer?: string; series?: string; enabled: boolean }>;
    plans: Array<{ id: string; name: string }>;
};

async function request<T>(method: "GET" | "POST" | "PATCH", body?: unknown, query?: URLSearchParams): Promise<T> {
    const response = await fetch(`/api/admin/model-pricing${query ? `?${query}` : ""}`, {
        method,
        credentials: "same-origin",
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = (await response.json()) as { code: number; data: T; msg: string };
    if (!response.ok || result.code !== 0) throw new Error(result.msg || "模型售价请求失败");
    return result.data;
}

export const getModelPricing = (
    modelId?: string,
    candidatePage = 1,
    officialPage = 1,
    candidateFilter: { modelId?: string; manufacturer?: string; status?: PriceCandidate["status"] } = {},
    unpricedPage = 1,
    unpricedFilter: UnpricedModelFilter = {},
    workbenchPage = 1,
    workbenchFilter: ModelWorkbenchFilter = {},
) =>
    request<ModelPricingOverview>(
        "GET",
        undefined,
        new URLSearchParams({
            ...(modelId ? { modelId } : {}),
            candidatePage: String(candidatePage),
            officialPage: String(officialPage),
            ...(candidateFilter.modelId ? { candidateModelId: candidateFilter.modelId } : {}),
            ...(candidateFilter.manufacturer ? { manufacturer: candidateFilter.manufacturer } : {}),
            ...(candidateFilter.status ? { candidateStatus: candidateFilter.status } : {}),
            unpricedPage: String(unpricedPage),
            ...(unpricedFilter.manufacturer ? { unpricedManufacturer: unpricedFilter.manufacturer } : {}),
            ...(unpricedFilter.series ? { unpricedSeries: unpricedFilter.series } : {}),
            ...(unpricedFilter.capability ? { unpricedCapability: unpricedFilter.capability } : {}),
            ...(unpricedFilter.name ? { unpricedName: unpricedFilter.name } : {}),
            ...(unpricedFilter.status ? { unpricedStatus: unpricedFilter.status } : {}),
            workbenchPage: String(workbenchPage),
            ...(workbenchFilter.enabled ? { workbenchEnabled: workbenchFilter.enabled } : {}),
            ...(workbenchFilter.manufacturer ? { workbenchManufacturer: workbenchFilter.manufacturer } : {}),
            ...(workbenchFilter.capability ? { workbenchCapability: workbenchFilter.capability } : {}),
            ...(workbenchFilter.name ? { workbenchName: workbenchFilter.name } : {}),
            ...(workbenchFilter.status ? { workbenchStatus: workbenchFilter.status } : {}),
        }),
    );
export const getOfficialPriceSources = () => request<OfficialPriceSource[]>("GET", undefined, new URLSearchParams({ action: "official-sources" }));
export const submitOfficialPrice = (price: OfficialPriceInput) => request<PriceCandidate>("POST", { action: "candidate", price });
export const editOfficialPrice = (candidateId: string, price: OfficialPriceInput, expectedRevision: string | null) => request<PriceCandidate>("PATCH", { action: "candidate-edit", candidateId, price, expectedRevision });
export const deleteOfficialPrice = (candidateId: string, expectedRevision: string | null) => request<{ candidateId: string; deleted: true }>("PATCH", { action: "candidate-delete", candidateId, expectedRevision });
export const getOfficialPriceReviewLinks = (manufacturer: string) => request<Array<{ url: string; label: string }>>("GET", undefined, new URLSearchParams({ action: "review-links", manufacturer }));
export async function reviewOfficialPrices(
    input: { manufacturer: string; sourceUrl: string; sourceText?: string; retirementText?: string; targetOfficialModelId?: string; discoveryOnly?: boolean; requestId: string },
    onProgress?: (progress: PriceReviewProgress) => void,
    onPartial?: (result: PriceReviewResult) => void,
) {
    const response = await fetch("/api/admin/model-pricing/ai-review", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify(input) });
    if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
        let result: { code: number; data: PriceReviewResult; msg: string };
        try {
            result = (await response.json()) as typeof result;
        } catch {
            throw new Error(response.status === 504 ? "官网核价连接在网关等待超时，请重试并查看当前阶段" : `官网核价请求失败（HTTP ${response.status}）`);
        }
        if (!response.ok || result.code !== 0) throw new Error(result.msg || "官网价目核对失败");
        return result.data;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result: PriceReviewResult | undefined;
    const readEvent = (frame: string) => {
        const lines = frame.split(/\r?\n/);
        const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
        const data = lines
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n");
        if (!event || !data) return;
        let payload: unknown;
        try {
            payload = JSON.parse(data);
        } catch {
            throw new Error("官网核价进度响应格式错误");
        }
        if (event === "progress") onProgress?.(payload as PriceReviewProgress);
        if (event === "partial") onPartial?.(payload as PriceReviewResult);
        if (event === "result") result = payload as PriceReviewResult;
        if (event === "error") throw new Error((payload as { message?: string }).message || "官网价目核对失败");
    };
    try {
        while (true) {
            const { done, value } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            let match: RegExpExecArray | null;
            while ((match = /\r?\n\r?\n/.exec(buffer))) {
                readEvent(buffer.slice(0, match.index));
                buffer = buffer.slice(match.index + match[0].length);
            }
            if (done) break;
        }
    } finally {
        reader.releaseLock();
    }
    if (!result) throw new Error("官网核价连接中断，未收到核对结果");
    return result;
}
export async function setByteDanceSeedRetired(input: { action: "mark" | "unmark"; logicalModelId: string; officialModelId?: string; evidence?: string; evidenceMode?: "website" | "admin-excerpt"; deactivationDate?: string; observedAt?: string }) {
    const response = await fetch("/api/admin/model-pricing/ai-review", { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    const result = (await response.json()) as { code: number; data: ModelPriceLifecycleMark | null; msg: string };
    if (!response.ok || result.code !== 0) throw new Error(result.msg || "停用标记失败");
    return result.data;
}
export const getOfficialPriceReferences = (manufacturer: string, series?: string, officialVersion?: string) =>
    request<{ series: string[]; versions: string[]; approved: OfficialPriceVersion[]; pending: PriceCandidate[] }>(
        "GET",
        undefined,
        new URLSearchParams({ action: "references", manufacturer, ...(series ? { series } : {}), ...(officialVersion ? { officialVersion } : {}) }),
    );
export const getOfficialPriceStructureReferences = (modelId: string, manufacturer?: string, capability?: string) =>
    request<OfficialPriceVersion[]>("GET", undefined, new URLSearchParams({ action: "structure-references", ...(modelId ? { modelId } : {}), ...(manufacturer ? { manufacturer } : {}), ...(capability ? { capability } : {}) }));
export async function getOfficialPriceCatalog(manufacturer: string): Promise<OfficialPriceCatalogEntry[]> {
    const response = await fetch(`/api/admin/model-pricing/catalog?manufacturer=${encodeURIComponent(manufacturer)}`, { credentials: "same-origin", cache: "no-store" });
    const result = (await response.json()) as { code: number; data: OfficialPriceCatalogEntry[]; msg: string };
    if (!response.ok || result.code !== 0) throw new Error(result.msg || "官方型号目录加载失败");
    return result.data;
}
export async function getOfficialPriceCatalogImpact(entry: OfficialPriceCatalogEntry): Promise<{ pending: number; approved: number; called: boolean; childVersions: number }> {
    const response = await fetch(`/api/admin/model-pricing/catalog?manufacturer=${encodeURIComponent(entry.manufacturer)}&impactId=${encodeURIComponent(entry.id)}`, { credentials: "same-origin", cache: "no-store" });
    const result = (await response.json()) as { code: number; data: { pending: number; approved: number; called: boolean; childVersions: number }; msg: string };
    if (!response.ok || result.code !== 0) throw new Error(result.msg || "目录引用状态加载失败");
    return result.data;
}
export async function createOfficialPriceCatalog(input: { manufacturer: string; kind: "series" | "version"; parentId?: string; name: string; capability?: string; sku?: string; sourceUrl: string; evidence: string }): Promise<OfficialPriceCatalogEntry> {
    const response = await fetch("/api/admin/model-pricing/catalog", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    const result = (await response.json()) as { code: number; data: OfficialPriceCatalogEntry; msg: string };
    if (!response.ok || result.code !== 0) throw new Error(result.msg || "官方型号目录保存失败");
    return result.data;
}
export async function editOfficialPriceCatalog(input: {
    id: string;
    expected: OfficialPriceCatalogEntry;
    manufacturer: string;
    kind: "series" | "version";
    parentId?: string;
    name: string;
    capability?: string;
    sku?: string;
    sourceUrl: string;
    evidence: string;
}): Promise<OfficialPriceCatalogEntry> {
    const response = await fetch("/api/admin/model-pricing/catalog", { method: "PATCH", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    const result = (await response.json()) as { code: number; data: OfficialPriceCatalogEntry; msg: string };
    if (!response.ok || result.code !== 0) throw new Error(result.msg || "官方型号目录修改失败");
    return result.data;
}
export async function deleteOfficialPriceCatalog(entry: OfficialPriceCatalogEntry): Promise<void> {
    const response = await fetch("/api/admin/model-pricing/catalog", {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: entry.id, manufacturer: entry.manufacturer, expected: entry }),
    });
    const result = (await response.json()) as { code: number; msg: string };
    if (!response.ok || result.code !== 0) throw new Error(result.msg || "官方型号目录删除失败");
}
export const reviewOfficialPrice = (candidateId: string, approved: boolean, note: string) => request<{ candidateId: string; approved: boolean; versionId: string | null }>("PATCH", { action: "review", candidateId, approved, note });
export const linkReviewedOfficialPrice = (versionId: string, logicalModelId: string) => request<OfficialPriceVersion>("PATCH", { action: "price-link", versionId, logicalModelId });
export type IndependentOfficialPriceOptions = Awaited<ReturnType<typeof import("@/lib/server/model-pricing-service").getIndependentOfficialPriceOptions>>;
export async function getIndependentOfficialPriceOptions(modelId: string, page = 1, sku = ""): Promise<IndependentOfficialPriceOptions> {
    const query = new URLSearchParams({ action: "selection-options", modelId, page: String(page), sku });
    const response = await fetch(`/api/admin/model-pricing?${query}`, { credentials: "same-origin", cache: "no-store" });
    const result = (await response.json()) as { code: number; data: IndependentOfficialPriceOptions; msg: string };
    if (!response.ok || result.code !== 0) throw new Error(result.msg || "独立官网价读取失败");
    return result.data;
}
export type ModelPriceSelection = ModelPriceBinding & { version: OfficialPriceVersion | null };
export async function getCurrentModelPriceSelection(modelId: string, scope: string): Promise<ModelPriceSelection | null> {
    const query = new URLSearchParams({ action: "selection-binding", modelId, scope });
    const response = await fetch(`/api/admin/model-pricing?${query}`, { credentials: "same-origin", cache: "no-store" });
    const result = (await response.json()) as { code: number; data: ModelPriceSelection | null; msg: string };
    if (!response.ok || result.code !== 0) throw new Error(result.msg || "当前选价绑定读取失败");
    return result.data;
}
export const bindIndependentOfficialPrice = (versionId: string, logicalModelId: string, operation: ModelPriceBinding["operation"], evidence: string, expectedRevision: string | null) =>
    request<ModelPriceBinding>("PATCH", { action: "selection-bind", versionId, logicalModelId, operation, evidence, expectedRevision });
export const revokeIndependentOfficialPrice = (logicalModelId: string, scope: string, evidence: string, expectedRevision: string | null) =>
    request<ModelPriceBinding>("PATCH", { action: "selection-revoke", logicalModelId, scope, evidence, expectedRevision });
export const saveModelExchangeRate = (exchangeRate: BusinessExchangeRate, expectedObservedAt: string | null) => request<BusinessExchangeRate>("PATCH", { action: "exchange-rate", exchangeRate, expectedObservedAt });
export const saveOfficialPriceSourceLink = (manufacturer: string, url: string, expectedUpdatedAt: string | null, create = false) => request<OfficialPriceSource>("PATCH", { action: "official-source", manufacturer, url, expectedUpdatedAt, create });
export const previewModelSales = (policy: SalesPolicy, modelId: string, usage: Record<string, string | number>, scope?: string) =>
    request<{
        policy: SalesPolicy;
        officialPrice: OfficialPriceVersion;
        selectedBinding?: NonNullable<SalesPolicy["selectedPriceBindings"]>[number];
        selectedGroupId?: string | null;
        deepSeekTier?: "peak" | "offPeak";
        pricingAt?: string;
        quote: ReturnType<typeof import("@/lib/model-pricing").quoteSalesPrice>;
        oldQuote: ReturnType<typeof import("@/lib/model-pricing").quoteSalesPrice> | null;
        pointsDifference: string | null;
        currentSalesVersionId: string | null;
        previewToken: string;
    }>("POST", { action: "preview", policy, modelId, usage, scope });
export const publishModelSales = (policy: SalesPolicy, currentSalesVersionId: string | null, previewToken: string) => request<SalesVersion>("PATCH", { action: "publish", policy, currentSalesVersionId, previewToken });
export const unbindModelSalesPrice = (modelId: string, currentSalesVersionId: string | null, scope?: string) => request<SalesVersion>("PATCH", { action: "unbind", modelId, currentSalesVersionId, scope });
