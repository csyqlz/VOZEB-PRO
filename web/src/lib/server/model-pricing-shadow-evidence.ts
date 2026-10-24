import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import Decimal from "decimal.js";
import { modelPriceBindingScope, PricingInputError, type ModelPriceBinding } from "@/lib/model-pricing";
import { accumulateExactPoints } from "@/lib/model-pricing-precision";
import { listDataDirectory, readJsonDataFile } from "./data-adapter";
import { ensurePostgresSchema, getDatabaseProvider, postgresQuery } from "./database";
import { ModelPricingShadowRepository } from "./database/model-pricing-shadow-repository";
import { modelPricingEffectiveTerms } from "./model-pricing-effective-terms";
import type { ShadowCall } from "./model-pricing-shadow-store";
import type { ShadowPriceReceipt } from "./model-pricing-shadow-service";
import { getCurrentSalesVersion, getOfficialVersionsByIds } from "./model-pricing-store";
import { getShadowPointEvidence, getShadowTaskEvidence, hasShadowPriceReversal, mutateShadowTextCall } from "./model-pricing-shadow-store";
import { getUnpricedImageShadowCalls } from "./model-pricing-shadow-store";
import { revalueShadowImageCall } from "./model-pricing-shadow-image-call";
import { getImagePriceContractsByIds, listImagePriceContracts } from "./model-pricing-image-contract-store";
import { getModelPricingAdmission } from "./model-pricing-admission";
import { reinterpretDirectImageZeroMetadata } from "./model-pricing-image-usage";
import { getShadowBillingSource, hasRefundedShadowBillingSource } from "./model-pricing-shadow-refund";
import { getModelPriceReservation } from "./model-pricing-wallet-service";
import { getTextUsageRuleById } from "./model-pricing-text-usage-rule-store";
import { reinterpretOpenAiZeroTokenDetails } from "./model-pricing-token-usage";
import { prepareFlatTextShadowPrice } from "./model-pricing-shadow-service";
import { validateObservedRequestBound } from "./model-pricing-request-bound";
import type { ShadowTextCall } from "./model-pricing-shadow-call";
import { getImageTask } from "./image-task-store";
import { getAudioTask } from "./audio-task-store";
import { getVideoTask } from "./video-task-store";
import { resolvePublishedModelPrice, type PublishedPriceSelection } from "./model-pricing-published-price";

type PricedCall = { call: ShadowCall; receipt: ShadowPriceReceipt };

function sameImagePriceTerms(a: Awaited<ReturnType<typeof getImagePriceContractsByIds>>[number], b: typeof a) {
    const excluded = new Set(["id", "current", "reviewedAt", "reviewedBy", "evidence", "holdEstimate", "holdEstimates"]);
    const pricedFields = (contract: typeof a) => Object.fromEntries(Object.entries(contract).filter(([key]) => !excluded.has(key)));
    return isDeepStrictEqual(pricedFields(a), pricedFields(b));
}

export async function getDirectedPricingEvidence(userId: string, taskId: string, capability: "text" | "image" | "video" | "audio") {
    if (!taskId.trim()) throw new PricingInputError("缺少验收任务 ID");
    let evidence = await getShadowTaskEvidence(userId, taskId);
    const task = !evidence && capability === "image" ? await getImageTask(taskId) : null;
    if (!evidence && task?.userId === userId) {
        const pointRecordId = task.usageObservations?.at(-1)?.pointsRecordId;
        if (pointRecordId) evidence = await getShadowPointEvidence(userId, pointRecordId);
    }
    if (!evidence) {
        const storedTask = task || (capability === "audio" ? await getAudioTask(taskId) : capability === "video" ? await getVideoTask(taskId) : null);
        if (!storedTask || storedTask.userId !== userId) return null;
        const observation = storedTask.usageObservations?.at(-1)?.observation;
        if (!observation) return null;
        return {
            taskId,
            channelId: storedTask.config.channelId || "",
            requestedModel: storedTask.config.model,
            reportedModel: "reportedModel" in observation && typeof observation.reportedModel === "string" ? observation.reportedModel : undefined,
            protocol: observation.protocol,
            requestPath: undefined,
            operation: capability === "image" && "kind" in storedTask ? storedTask.kind : undefined,
            status: storedTask.status === "success" ? "observed" : storedTask.status,
            reasons: observation.invalid,
            usageFields: observation.usageFields || {},
            unmappedUsageFields: observation.unmappedUsageFields || [],
            zeroOnlyUsageFields: "zeroOnlyUsageFields" in observation ? observation.zeroOnlyUsageFields || [] : [],
            quotedPoints: undefined,
            contractId: undefined,
        };
    }
    const { call, receipt } = evidence;
    const rawObservation = call.result && "observation" in call.result ? call.result.observation : undefined;
    const observation = "revaluation" in call && call.revaluation && rawObservation?.protocol === "openai-images" ? reinterpretDirectImageZeroMetadata(rawObservation) : rawObservation;
    return {
        taskId,
        channelId: call.channelId,
        requestedModel: call.requestedModel,
        reportedModel: observation && "reportedModel" in observation && typeof observation.reportedModel === "string" ? observation.reportedModel : undefined,
        protocol: call.protocol,
        requestPath: call.requestPath,
        operation: "operation" in call ? call.operation : undefined,
        status: "revaluation" in call && call.revaluation ? "priced" : call.result?.status || "pending",
        reasons: "revaluation" in call && call.revaluation ? [] : call.result?.reasons || call.reasons,
        usageFields: observation?.usageFields || {},
        unmappedUsageFields: observation?.unmappedUsageFields || [],
        zeroOnlyUsageFields: observation && "zeroOnlyUsageFields" in observation ? observation.zeroOnlyUsageFields || [] : [],
        quotedPoints: receipt?.snapshot.quote.points,
        contractId: receipt?.snapshot.contractId,
        responseMeta: call.result && "responseMeta" in call.result ? call.result.responseMeta : undefined,
    };
}

export async function getModelPricingSampleUsage(modelId: string, officialVersionId: string, channelId?: string) {
    const policy = await getCurrentSalesVersion();
    const published = await resolvePublishedModelPrice(modelId, "text", "generation", policy);
    const version = published?.version.id === officialVersionId ? published.version : (await getOfficialVersionsByIds([officialVersionId])).find((item) => item.id === officialVersionId && item.logicalModelId === modelId);
    if (!version) throw new PricingInputError("该模型官方价版本不存在");
    const call = await latestObservedCall(modelId, channelId);
    const observation = call?.result && "observation" in call.result ? call.result.observation : undefined;
    if (!call || !observation?.quantities) return null;
    const keys = version.textPriceSchedule ? version.textPriceSchedule.meters.map((item) => item.meter) : version.items.map((item) => item.key);
    const itemMeters = call.frozen?.version.id === version.id && "itemMeters" in call.frozen.contract ? call.frozen.contract.itemMeters : undefined;
    const usage: Record<string, string> = {};
    for (const key of keys) {
        const meters = itemMeters?.[key] || [key];
        if (!meters.length || meters.some((meter) => !/^(0|[1-9]\d*)(\.\d+)?$/.test(observation.quantities[meter] || ""))) continue;
        usage[key] = meters.reduce((sum, meter) => sum.plus(observation.quantities[meter]), new Decimal(0)).toString();
    }
    if (version.textPriceSchedule && /^(0|[1-9]\d*)$/.test(observation.quantities.inputTotalTokens || "")) usage.inputTotalTokens = observation.quantities.inputTotalTokens;
    return Object.keys(usage).length
        ? { usage, observedAt: call.result?.completedAt || call.startedAt, channelId: call.channelId, complete: keys.every((key) => Object.hasOwn(usage, key)) && (!version.textPriceSchedule || Object.hasOwn(usage, "inputTotalTokens")) }
        : null;
}

async function latestObservedCall(modelId: string, channelId?: string): Promise<ShadowCall | undefined> {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        return new ModelPricingShadowRepository({ query: postgresQuery }).latestObservedCall(modelId, channelId);
    }
    let files: Awaited<ReturnType<typeof listDataDirectory>>;
    try {
        files = await listDataDirectory("model-pricing-shadow");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
    let latest: ShadowCall | undefined;
    for (const file of files.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))) {
        const account = await readJsonDataFile<{ calls: ShadowCall[] }>(`model-pricing-shadow/${file.name}`, { calls: [] });
        for (const call of account.calls) {
            const result = call.result;
            if (call.modelId !== modelId || (channelId && call.channelId !== channelId) || !result || !("observation" in result) || !result.observation?.quantities || (latest && latest.startedAt >= call.startedAt)) continue;
            latest = call;
        }
    }
    return latest;
}

async function latestPricedByContract(modelId: string, contractIds: string[], channelId?: string, textUsageRuleId?: string | null): Promise<PricedCall[]> {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        return new ModelPricingShadowRepository({ query: postgresQuery }).latestPricedByContract(modelId, contractIds, channelId, textUsageRuleId);
    }
    let files: Awaited<ReturnType<typeof listDataDirectory>>;
    try {
        files = await listDataDirectory("model-pricing-shadow");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }
    const latest = new Map<string, PricedCall>();
    for (const file of files.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))) {
        const account = await readJsonDataFile<{ calls: ShadowCall[]; receipts: ShadowPriceReceipt[] }>(`model-pricing-shadow/${file.name}`, { calls: [], receipts: [] });
        for (const call of account.calls) {
            const contractId = call.frozen?.contract.id;
            if (call.modelId !== modelId || (channelId && call.channelId !== channelId) || (call.result?.status !== "priced" && !("revaluation" in call && call.revaluation)) || !contractId || !contractIds.includes(contractId)) continue;
            const receipt = account.receipts.find((item) => item.requestId === call.requestId && item.kind === "charge");
            if (!receipt || (textUsageRuleId !== undefined && (receipt.snapshot.textUsageRuleId || null) !== textUsageRuleId) || (latest.get(contractId)?.call.startedAt || "") >= call.startedAt) continue;
            latest.set(contractId, { call, receipt });
        }
    }
    return [...latest.values()];
}

/** A priced shadow receipt proves the same contract and effective sale terms priced a real response. */
export async function getModelPricingShadowEvidence(modelId: string, officialVersionId: string, contractIds: string[], channelId?: string, textUsageRuleId?: string | null) {
    if (!officialVersionId) return { ready: false, missingCount: contractIds.length, receiptIds: {} as Record<string, string>, sample: null as null | { usage: Record<string, string>; observedAt: string; channelId: string; complete: boolean } };
    const policy = await getCurrentSalesVersion();
    const version = (await getOfficialVersionsByIds([officialVersionId])).find((item) => item.id === officialVersionId);
    if (!policy || !version) throw new PricingInputError("当前模型售价或官方价已变更");
    const selections: Array<PublishedPriceSelection | undefined> = [];
    if (version.logicalModelId === modelId && policy.priceVersionIds[modelId] === version.id) selections.push(undefined);
    if (!version.logicalModelId && version.capability) {
        for (const selection of policy.selectedPriceBindings || []) {
            if (selection.logicalModelId !== modelId || selection.officialVersionId !== version.id) continue;
            const operation = selection.scope.split(":")[1] as ModelPriceBinding["operation"];
            try {
                if (selection.scope !== modelPriceBindingScope(version.capability, operation, "standard")) continue;
            } catch (error) {
                if (!(error instanceof PricingInputError)) throw error;
                continue;
            }
            const current = await resolvePublishedModelPrice(modelId, version.capability, operation, policy);
            if (current?.version.id === version.id && isDeepStrictEqual(current.selection, selection)) selections.push(selection);
        }
    }
    if (!selections.length) throw new PricingInputError("当前模型售价或官方价已变更");
    const terms = modelPricingEffectiveTerms(version, policy, modelId);
    const calls = await latestPricedByContract(modelId, contractIds, channelId, textUsageRuleId);
    const matchesCurrentPrice = ({ call, receipt }: PricedCall) =>
        call.frozen?.version.id === officialVersionId &&
        call.frozen?.contract.id === receipt.snapshot.contractId &&
        (call.result?.receiptId === receipt.id || ("revaluation" in call && call.revaluation?.receiptId === receipt.id)) &&
        receipt.snapshot.quote.officialVersionId === officialVersionId &&
        receipt.snapshot.quote.modelId === modelId &&
        selections.some((selection) => isDeepStrictEqual(call.frozen && "priceSelection" in call.frozen ? call.frozen.priceSelection : undefined, selection)) &&
        (textUsageRuleId === undefined || (receipt.snapshot.textUsageRuleId || null) === textUsageRuleId) &&
        modelPricingEffectiveTerms(call.frozen.version, call.frozen.policy, modelId) === terms;
    const matched = calls.filter(matchesCurrentPrice);
    const receiptIds: Record<string, string> = Object.fromEntries(matched.map(({ call, receipt }) => [call.frozen!.contract.id, receipt.id]));
    const carriedFromContractIds: Record<string, string> = {};
    if (channelId && version.items.some((item) => item.key === "outputImageTokens") && contractIds.some((id) => !receiptIds[id])) {
        for (const current of await getImagePriceContractsByIds(contractIds.filter((id) => !receiptIds[id]))) {
            if (!current.current || current.officialVersionId !== officialVersionId || current.channelId !== channelId || current.scope !== "global-standard-direct-image-tokens") continue;
            const history = await listImagePriceContracts(officialVersionId, channelId, current.requestedModel, current.operation);
            const previous = history.filter((item) => !item.current && sameImagePriceTerms(item, current));
            const inherited = (
                await latestPricedByContract(
                    modelId,
                    previous.map((item) => item.id),
                    channelId,
                    textUsageRuleId,
                )
            )
                .filter(matchesCurrentPrice)
                .sort((a, b) => b.call.startedAt.localeCompare(a.call.startedAt))[0];
            if (!inherited) continue;
            receiptIds[current.id] = inherited.receipt.id;
            carriedFromContractIds[current.id] = inherited.call.frozen!.contract.id;
            matched.push(inherited);
        }
    }
    const sampleCall = matched.sort((a, b) => b.call.startedAt.localeCompare(a.call.startedAt))[0];
    const observed = sampleCall || (version.capability && version.capability !== "text") ? null : await getModelPricingSampleUsage(modelId, officialVersionId, channelId);
    return {
        ready: contractIds.length > 0 && contractIds.every((id) => Boolean(receiptIds[id])),
        missingCount: contractIds.filter((id) => !receiptIds[id]).length,
        receiptIds,
        carriedFromContractIds,
        sample: sampleCall
            ? {
                  usage: Object.fromEntries(sampleCall.receipt.snapshot.quote.lines.map((line) => [line.key, line.quantity])),
                  observedAt: sampleCall.call.result?.completedAt || sampleCall.call.startedAt,
                  channelId: sampleCall.call.channelId,
                  complete: true,
              }
            : observed,
    };
}

async function* textEvidenceCandidates(modelId: string, contractIds: string[], channelId: string): AsyncGenerator<ShadowTextCall> {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const repository = new ModelPricingShadowRepository({ query: postgresQuery });
        let cursor: { startedAt: string; requestId: string } | undefined;
        while (true) {
            const page = await repository.listTextEvidenceCandidates(modelId, contractIds, channelId, cursor);
            if (!page.length) return;
            for (const item of page) yield item;
            const last = page.at(-1)!;
            cursor = { startedAt: last.startedAt, requestId: last.requestId };
        }
    }
    const candidates: ShadowTextCall[] = [];
    let files: Awaited<ReturnType<typeof listDataDirectory>>;
    try {
        files = await listDataDirectory("model-pricing-shadow");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
    }
    for (const file of files.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))) {
        const account = await readJsonDataFile<{ calls: ShadowCall[] }>(`model-pricing-shadow/${file.name}`, { calls: [] });
        for (const candidate of account.calls) {
            if (
                !candidate.protocol ||
                !["openai-chat", "openai-responses", "anthropic-messages", "gemini-generate"].includes(candidate.protocol) ||
                candidate.modelId !== modelId ||
                candidate.channelId !== channelId ||
                candidate.requestId.startsWith("text-revaluation:") ||
                !candidate.frozen?.contract.id ||
                !contractIds.includes(candidate.frozen.contract.id) ||
                !candidate.result ||
                !["priced", "unpriced"].includes(candidate.result.status) ||
                !("observation" in candidate.result) ||
                !candidate.result.observation
            )
                continue;
            const call = candidate as ShadowTextCall;
            candidates.push(call);
        }
    }
    for (const call of candidates.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.requestId.localeCompare(a.requestId))) yield call;
}

/** Explicit admin action; re-quotes saved real usage without submitting another upstream request. */
export async function revalueSavedTextEvidence(modelId: string, bindingKey: string) {
    const admission = await getModelPricingAdmission(modelId);
    const binding = admission.bindings.find((item) => item.key === bindingKey);
    if (admission.capability !== "text" || !admission.officialVersionId || !admission.textUsageRuleId || !binding?.fingerprint || !binding.contractIds.length) throw new PricingInputError("请选择已有文本契约及已审核缓存规则的渠道绑定");
    const channelId = bindingKey.slice(0, bindingKey.indexOf("/"));
    const upstreamModel = bindingKey.slice(channelId.length + 1);
    const [policy, version, rules] = await Promise.all([getCurrentSalesVersion(), getOfficialVersionsByIds([admission.officialVersionId]).then((items) => items[0]), getTextUsageRuleById(admission.textUsageRuleId)]);
    if (!policy || !version || !rules || rules.modelId !== modelId || rules.officialVersionId !== version.id) throw new PricingInputError("当前官方价、售价或缓存规则不可用");
    const published = await resolvePublishedModelPrice(modelId, "text", "generation", policy);
    if (published?.version.id !== version.id && !version.logicalModelId) throw new PricingInputError("当前独立选价绑定已变化");
    const terms = modelPricingEffectiveTerms(version, policy, modelId);
    let revalued = 0;
    const remaining = new Set(binding.contractIds);
    for await (const original of textEvidenceCandidates(modelId, binding.contractIds, channelId)) {
        if (!original.frozen || !remaining.has(original.frozen.contract.id)) continue;
        if (
            !original.frozen ||
            !original.protocol ||
            !original.result?.observation ||
            (original.result.status === "priced" && original.frozen.rules?.id === rules.id) ||
            reinterpretOpenAiZeroTokenDetails(original.result.observation).invalid ||
            original.result.reasons.some((reason) => reason.includes("响应尚未完整") || reason.includes("未取得可解析")) ||
            !original.requestBound?.ready ||
            original.requestedModel !== upstreamModel ||
            original.frozen.version.id !== version.id ||
            !isDeepStrictEqual(original.frozen.priceSelection, published?.selection) ||
            modelPricingEffectiveTerms(original.frozen.version, original.frozen.policy, modelId) !== terms
        )
            continue;
        if (await hasShadowPriceReversal(original.userId, original.requestId)) continue;
        const source = await getShadowBillingSource({ requestId: original.requestId });
        const fixedSource = source?.type === "consume" && source.userId === original.userId && source.requestFingerprint === original.requestFingerprint && source.model === modelId && !(await hasRefundedShadowBillingSource(source));
        const walletSource = fixedSource ? null : await getModelPriceReservation({ userId: original.userId, requestId: original.requestId, requestFingerprint: original.requestFingerprint });
        if (!fixedSource && (walletSource?.status !== "settled" || walletSource.modelId !== modelId)) continue;
        const requestId = `text-revaluation:${createHash("sha256")
            .update(JSON.stringify([original.userId, original.requestId, rules.id]))
            .digest("hex")}`;
        const requestFingerprint = createHash("sha256")
            .update(JSON.stringify([original.requestFingerprint, rules.id]))
            .digest("hex");
        const occurredAt = new Date().toISOString();
        const observation = reinterpretOpenAiZeroTokenDetails(original.result.observation);
        const prepared = prepareFlatTextShadowPrice({
            userId: original.userId,
            requestId,
            requestFingerprint,
            contractId: original.frozen.contract.id,
            version,
            policy,
            contract: original.frozen.contract,
            rules,
            observation,
            call: {
                ...original.requestContext,
                modelId,
                ...(published?.selection ? { priceSelection: published.selection } : {}),
                channelId,
                requestedModel: upstreamModel,
                officialVersionId: version.id,
                salesVersionId: policy.id,
                region: original.requestContext.region || original.frozen.contract.region,
                serviceTier: original.requestContext.serviceTier || original.frozen.contract.serviceTier,
                responseComplete: true,
                occurredAt,
            },
        });
        if (!prepared.ready || prepared.warnings.length || validateObservedRequestBound(original.requestBound, original.frozen.contract, prepared.normalizedObservation).length) continue;
        await mutateShadowTextCall(original.userId, requestId, (saved, state) => {
            if (saved) return { call: saved };
            const quoted = prepared.build(state);
            const receipt = { ...quoted, changeExactPoints: "0", accrual: accumulateExactPoints(state.exactPoints, "0") };
            return {
                receipt,
                call: {
                    ...original,
                    requestId,
                    requestFingerprint,
                    taskId: undefined,
                    startedAt: occurredAt,
                    frozen: { version, policy, contract: original.frozen!.contract, rules, ...(published?.selection ? { priceSelection: published.selection } : {}) },
                    reasons: [],
                    result: { status: "priced", reasons: [], completedAt: occurredAt, observation, receiptId: receipt.id, requestBoundCheck: { valid: true, reasons: [] } },
                },
            };
        });
        remaining.delete(original.frozen.contract.id);
        revalued++;
        if (!remaining.size) break;
    }
    return { revalued, status: await getModelPricingShadowEvidence(modelId, version.id, binding.contractIds, channelId, rules.id) };
}

/** Explicit administrator action: price saved real usage with the original frozen terms and an append-only shadow receipt. */
export async function revalueSavedImageEvidence(modelId: string, bindingKey: string, imageOperation?: "generations" | "edits") {
    const admission = await getModelPricingAdmission(modelId, undefined, undefined, imageOperation);
    const binding = admission.bindings.find((item) => item.key === bindingKey);
    if (admission.capability !== "image" || !admission.officialVersionId || !binding?.fingerprint || !binding.contractIds.length) throw new PricingInputError("请选择已有图片计费契约的渠道绑定");
    const policy = await getCurrentSalesVersion();
    const version = (await getOfficialVersionsByIds([admission.officialVersionId]))[0];
    if (!policy || !version) throw new PricingInputError("当前官方价或用户售价不可用");
    const terms = modelPricingEffectiveTerms(version, policy, modelId);
    const channelId = bindingKey.slice(0, bindingKey.indexOf("/"));
    let revalued = 0;
    for (const call of await getUnpricedImageShadowCalls(modelId, binding.contractIds, channelId)) {
        if (call.frozen?.version.id !== version.id || call.requestedModel !== bindingKey.slice(channelId.length + 1) || modelPricingEffectiveTerms(call.frozen.version, call.frozen.policy, modelId) !== terms) continue;
        if (!call.requestId.startsWith("system-ai:")) continue;
        const source = await getShadowBillingSource({ requestId: call.requestId });
        if (source?.type !== "consume" || source.userId !== call.userId || source.model !== modelId || source.requestFingerprint !== call.requestFingerprint) continue;
        const saved = await revalueShadowImageCall(call);
        if (saved.revaluation) revalued++;
    }
    return { revalued, status: await getModelPricingShadowEvidence(modelId, version.id, binding.contractIds, channelId) };
}
