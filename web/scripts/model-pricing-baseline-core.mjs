import Decimal from "decimal.js";
import Fraction from "fraction.js";

function oneUsdExamplePoints(conversion, coefficient) {
    if (!conversion?.cnyPerUsd || !conversion?.pointsPerCny) return null;
    const points = new Fraction(conversion.cnyPerUsd).mul(conversion.pointsPerCny).mul(coefficient).round(2);
    return new Decimal(points.toString(2)).toFixed(2);
}

export function isAttentionReservation(reservation) {
    return reservation.status === "reserved" || (reservation.status === "settled" && (reservation.billingWarnings?.length > 0 || (reservation.unpaidAtSettlement != null && new Decimal(reservation.unpaidAtSettlement).gt(0))));
}

function contractOperation(contract) {
    if (contract.operation) return contract.operation;
    if (contract.scope === "global-standard-gemini-tts") return "generateContent";
    if (contract.scope === "global-standard-openai-chat-audio-uncached") return "chat/completions";
    return "generation";
}

function channelModelIdentityReview(version, binding, contract, operation, capability) {
    if (!version) return "no-published-price";
    if (!version.sku) return "missing-official-sku";
    if (binding.upstreamModel === version.sku) return "exact-sku";
    if (version.logicalModelId || (capability !== "text" && capability !== "image")) return "unsupported-alias";
    if (!contract) return "missing-current-contract";
    const identity = contract.identity;
    if (!identity) return "missing-reviewed-identity";
    if (!binding.id || identity.channelBindingId !== binding.id || identity.officialSku !== version.sku || identity.operation !== operation) return "identity-mismatch";
    const modelIdentity = capability === "text" ? identity.modelIdentity : contract.modelIdentity;
    if (typeof contract.reportedModel !== "string" || !contract.reportedModel.trim() || (modelIdentity !== "response-required" && modelIdentity !== "reviewed-request")) return "incomplete-identity";
    let source;
    try {
        source = new URL(identity.sourceUrl);
    } catch {
        return "incomplete-identity";
    }
    if (source.protocol !== "https:" || source.username || source.password || typeof identity.evidence !== "string" || !identity.evidence.trim()) return "incomplete-identity";
    return "recorded-unverified";
}

export function summarizePricingBaseline({
    pricing,
    models,
    channels = [],
    defaultModels = {},
    modelPointCosts = null,
    generationPointMultipliers = null,
    currentContracts = [],
    reservations,
    frozenReferenceCatalog,
    officialInventory,
    candidateStatuses,
}) {
    const sales = pricing.currentSales;
    const priceById = new Map(pricing.officialVersions.map((version) => [version.id, version]));
    const modelById = new Map(models.map((model) => [model.id, model]));
    const currentBindings = new Map((pricing.priceBindings || []).filter((binding) => binding.current).map((binding) => [JSON.stringify([binding.logicalModelId, binding.scope]), binding]));
    const references = [
        ...Object.entries(sales?.priceVersionIds || {}).map(([modelId, officialVersionId]) => ({ modelId, officialVersionId, kind: "legacy" })),
        ...(sales?.selectedPriceBindings || []).map((selection) => ({ modelId: selection.logicalModelId, ...selection, kind: "selected" })),
    ];
    const publishedBindings = references.map((reference) => {
        const { modelId, officialVersionId: versionId } = reference;
        const price = priceById.get(versionId);
        const model = modelById.get(modelId);
        const currentBinding = reference.kind === "selected" ? currentBindings.get(JSON.stringify([modelId, reference.scope])) : undefined;
        const currentBindingIssue =
            reference.kind !== "selected" || !pricing.priceBindings
                ? null
                : !currentBinding
                  ? "missing-current-binding"
                  : currentBinding.status !== "active"
                    ? "revoked"
                    : currentBinding.id !== reference.bindingId
                      ? "binding-id-changed"
                      : currentBinding.revision !== reference.bindingRevision
                        ? "revision-changed"
                        : currentBinding.officialVersionId !== versionId
                          ? "official-version-changed"
                          : null;
        const rules = sales.userPriceRules || [];
        const appliedRule =
            rules.find((rule) => rule.scope === "model" && rule.modelId === modelId) ||
            rules.find((rule) => rule.scope === "series" && rule.manufacturer === price?.manufacturer && rule.series === price?.series) ||
            rules.find((rule) => rule.scope === "manufacturer" && rule.manufacturer === price?.manufacturer) ||
            rules.find((rule) => rule.scope === "default");
        return {
            modelId,
            kind: reference.kind,
            ...(reference.kind === "selected"
                ? {
                      scope: reference.scope,
                      bindingId: reference.bindingId,
                      bindingRevision: reference.bindingRevision,
                      currentBindingMatchesPublished: pricing.priceBindings ? currentBindingIssue === null : null,
                      currentBindingIssue,
                      currentBindingId: currentBinding?.id || null,
                      currentBindingRevision: currentBinding?.revision || null,
                      currentBindingOfficialVersionId: currentBinding?.officialVersionId || null,
                  }
                : {}),
            officialVersionId: versionId,
            sourceVersionId: price?.linkedFromVersionId || null,
            officialSku: price?.sku || null,
            manufacturer: price?.manufacturer || null,
            series: price?.series || null,
            coefficient: appliedRule?.coefficient || "1",
            coefficientScope: appliedRule?.scope || "default",
            configuredBindings: model?.bindings?.filter((binding) => binding.enabled).map((binding) => ({ channelId: binding.channelId, upstreamModel: binding.upstreamModel })) || [],
        };
    });
    const activations = Object.entries(pricing.activations || {})
        .filter(([, activation]) => activation?.enabled)
        .map(([key, activation]) => ({
            modelId: activation.modelId || key,
            ...(activation.scope ? { scope: activation.scope } : {}),
            officialVersionId: activation.officialVersionId || null,
            salesVersionId: activation.salesVersionId || null,
            bindingKeys: Object.keys(activation.bindings || {}),
            shadowContractIds: Object.keys(activation.evidence?.shadowReceiptIds || {}),
            bindingEvidenceKnown: activation.bindings !== undefined,
        }));
    const channelById = new Map(channels.map((channel) => [channel.id, channel]));
    const contractByCall = new Map(currentContracts.filter((contract) => contract.current).map((contract) => [JSON.stringify([contract.officialVersionId, contract.channelId, contract.requestedModel, contractOperation(contract)]), contract]));
    const scopesByCapability = {
        text: ["text:generation:standard"],
        image: ["image:generations:standard", "image:edits:standard"],
        video: ["video:generation:standard"],
        audio: ["audio:generateContent:standard", "audio:chat/completions:standard"],
    };
    const routingReviewRows = models.flatMap((model) =>
        (model.bindings || []).flatMap((binding) => {
            const channel = channelById.get(binding.channelId);
            const bindingKey = `${binding.channelId}/${binding.upstreamModel}`;
            return (scopesByCapability[model.capability] || []).map((scope) => {
                const selected = publishedBindings.find((item) => item.modelId === model.id && item.scope === scope);
                const legacy = publishedBindings.find((item) => item.modelId === model.id && item.kind === "legacy");
                const activation = activations.find((item) => item.modelId === model.id && item.scope === scope) || activations.find((item) => item.modelId === model.id && !item.scope);
                const officialVersionId = selected?.officialVersionId || legacy?.officialVersionId || null;
                const version = priceById.get(officialVersionId);
                const operation = scope.split(":")[1];
                const contract = officialVersionId ? contractByCall.get(JSON.stringify([officialVersionId, binding.channelId, binding.upstreamModel, operation])) : null;
                const estimate = model.capability === "text" ? contract?.reservationEstimate : contract?.holdEstimate;
                const countContract = contract?.scope === "global-standard-dataeyes-flux-image";
                const requestBoundContract = model.capability === "video" || model.capability === "audio";
                const basis = requestBoundContract ? contract : countContract ? contract.imageLimit : estimate;
                const meteringItemsRecorded =
                    model.capability === "video"
                        ? contract?.scope === "global-standard-minimax-h3-generation"
                            ? Boolean(Object.keys(contract.resolutionItems || {}).length && contract.inputImageItem && contract.inputAudioItem)
                            : contract?.scope === "global-standard-minimax-hailuo-generation" && Boolean(Object.keys(contract.tierItems || {}).length)
                        : model.capability === "audio"
                          ? contract?.scope === "global-standard-gemini-tts"
                              ? Boolean(contract.inputTextItem && contract.outputAudioItem)
                              : contract?.scope === "global-standard-openai-chat-audio-uncached" && Object.keys(contract.itemKeys || {}).length === 4
                          : null;
                const basisComplete = Boolean(
                    basis?.evidence &&
                    (requestBoundContract
                        ? meteringItemsRecorded
                        : basis?.sourceUrl && (model.capability === "text" ? basis.method === "request-size-recent-output" && contract?.requestLimits : countContract ? basis.maxImages === 1 : basis?.meterQuantities)),
                );
                const reservationReview = scopesByCapability[model.capability]
                    ? {
                          contractId: contract?.id || null,
                          contractScope: contract?.scope || null,
                          strategy: requestBoundContract ? (contract ? "request-upper-bound" : null) : model.capability === "text" ? estimate?.method || null : countContract && basis ? "image-count-limit" : estimate ? "token-meter-quantities" : null,
                          sourceRecorded: requestBoundContract ? null : Boolean(basis?.sourceUrl),
                          evidenceRecorded: Boolean(basis?.evidence),
                          ...(model.capability === "text"
                              ? { requestLimitsRecorded: Boolean(contract?.requestLimits) }
                              : model.capability === "image"
                                ? { meterQuantitiesRecorded: Boolean(estimate?.meterQuantities), imageLimitRecorded: Boolean(contract?.imageLimit) }
                                : { meteringItemsRecorded: Boolean(meteringItemsRecorded) }),
                          status: !officialVersionId
                              ? "no-published-price"
                              : !contract
                                ? "missing-current-contract"
                                : !basis
                                  ? countContract
                                      ? "missing-image-limit"
                                      : "missing-reservation-estimate"
                                  : basisComplete
                                    ? "recorded-unverified"
                                    : "incomplete-reservation-basis",
                      }
                    : null;
                return {
                    modelId: model.id,
                    modelEnabled: model.enabled !== false,
                    capability: model.capability,
                    scope,
                    operationSupport: "requires-protocol-verification",
                    channelBindingId: binding.id || null,
                    bindingEnabled: binding.enabled === true,
                    acceptanceOnly: binding.acceptanceOnly === true,
                    priority: binding.priority ?? null,
                    channelId: binding.channelId,
                    upstreamModel: binding.upstreamModel,
                    channelFound: Boolean(channel),
                    channelEnabled: channel?.enabled === true,
                    channelProtocol: channel?.advancedConfig?.protocol || null,
                    apiFormat: channel?.apiFormat || null,
                    publishedReferenceKind: selected ? "selected" : legacy ? "legacy" : null,
                    publishedOfficialVersionId: selected?.officialVersionId || legacy?.officialVersionId || null,
                    publishedSelectionIssue: selected?.currentBindingIssue || null,
                    channelModelIdentityReview: channelModelIdentityReview(version, binding, contract, operation, model.capability),
                    activationScope: activation?.scope || null,
                    recordedBindingApproval: activation ? (activation.bindingEvidenceKnown ? activation.bindingKeys.includes(bindingKey) : null) : false,
                    reservationReview,
                    runtimeMeteredEligibility: "requires-runtime-admission-verification",
                };
            });
        }),
    );
    const legacyFallbackModels = models.length
        ? []
        : channels.flatMap((channel) =>
              (channel.models || []).map((model) => ({
                  channelId: channel.id,
                  channelEnabled: channel.enabled === true,
                  upstreamModel: model,
                  apiFormat: channel.apiFormat || null,
                  channelProtocol: channel.advancedConfig?.protocol || null,
                  configuredCapabilityHint:
                      channel.advancedConfig?.modelCapabilities?.[
                          String(model)
                              .trim()
                              .replace(/^models\//i, "")
                              .toLowerCase()
                      ] || null,
                  configuredDefaultKeys: Object.entries(defaultModels)
                      .filter(([, configured]) => configured === model)
                      .map(([key]) => key),
                  routeEligibility: "requires-runtime-verification",
              })),
          );
    const attentionReservations = reservations.map((reservation) => ({
        status: reservation.status || "reserved",
        modelId: reservation.modelId || null,
        usageKind: reservation.usageKind || null,
        channelId: reservation.channelId || reservation.frozen?.text?.call?.channelId || reservation.frozen?.image?.call?.channelId || reservation.frozen?.video?.call?.channelId || reservation.frozen?.audio?.call?.channelId || null,
        requestedModel:
            reservation.requestedModel || reservation.frozen?.text?.call?.requestedModel || reservation.frozen?.image?.call?.requestedModel || reservation.frozen?.video?.call?.requestedModel || reservation.frozen?.audio?.call?.requestedModel || null,
        operation: reservation.operation || reservation.frozen?.text?.call?.operation || reservation.frozen?.image?.call?.operation || reservation.frozen?.video?.call?.operation || reservation.frozen?.audio?.call?.operation || null,
        officialVersionId: reservation.frozen?.version?.id || null,
        salesVersionId: reservation.frozen?.policy?.id || null,
        contractId: reservation.frozen?.contractId || null,
        priceScope: reservation.frozen?.priceSelection?.scope || null,
        priceBindingId: reservation.frozen?.priceSelection?.bindingId || null,
        priceBindingRevision: reservation.frozen?.priceSelection?.bindingRevision || null,
        submissionPhase: reservation.submission?.phase || null,
        taskType: reservation.preparation?.taskType || null,
        taskLinkage: reservation.taskLinkage || "not-audited",
        count: Number(reservation.count || 1),
    }));
    const openReservations = attentionReservations.filter((reservation) => reservation.status === "reserved");
    const taskLinkageCounts = new Map();
    for (const reservation of attentionReservations) {
        const key = JSON.stringify([reservation.status, reservation.usageKind, reservation.taskLinkage]);
        taskLinkageCounts.set(key, (taskLinkageCounts.get(key) || 0) + reservation.count);
    }
    const frozenReferenceIssues = frozenReferenceCatalog
        ? attentionReservations.flatMap((reservation) => {
              const missing = [];
              if (!reservation.officialVersionId || !frozenReferenceCatalog.officialVersionIds.includes(reservation.officialVersionId)) missing.push("official-price-version");
              if (!reservation.salesVersionId || !frozenReferenceCatalog.salesVersionIds.includes(reservation.salesVersionId)) missing.push("sales-version");
              if (frozenReferenceCatalog.contractIds && (!reservation.contractId || !frozenReferenceCatalog.contractIds.includes(reservation.contractId))) missing.push("metering-contract");
              return missing.length
                  ? [
                        {
                            status: reservation.status,
                            modelId: reservation.modelId,
                            usageKind: reservation.usageKind,
                            officialVersionId: reservation.officialVersionId,
                            salesVersionId: reservation.salesVersionId,
                            contractId: reservation.contractId,
                            missing,
                            count: reservation.count,
                        },
                    ]
                  : [];
          })
        : null;
    return {
        currentSalesVersionId: sales?.id || null,
        fixedPointConfiguration: { modelPointCosts, generationPointMultipliers },
        officialInventory,
        candidateStatuses,
        publishedBindings,
        routingReviewRows,
        legacyFallbackModels,
        publishedSelectionIssues: publishedBindings.filter((binding) => binding.kind === "selected" && binding.currentBindingIssue),
        seriesRuleImpacts: (sales?.userPriceRules || [])
            .filter((rule) => rule.scope === "series")
            .map((rule) => {
                const fallback = sales.userPriceRules.find((item) => item.scope === "manufacturer" && item.manufacturer === rule.manufacturer) || sales.userPriceRules.find((item) => item.scope === "default");
                return {
                    manufacturer: rule.manufacturer,
                    series: rule.series,
                    coefficient: rule.coefficient,
                    effectivePublishedReferences: publishedBindings
                        .filter((binding) => binding.coefficientScope === "series" && binding.manufacturer === rule.manufacturer && binding.series === rule.series)
                        .map((binding) => ({
                            modelId: binding.modelId,
                            ...(binding.scope ? { scope: binding.scope } : {}),
                            officialVersionId: binding.officialVersionId,
                            withoutSeriesCoefficient: fallback?.coefficient || "1",
                            withoutSeriesScope: fallback?.scope || "default",
                            oneUsdPointsWithSeries: oneUsdExamplePoints(sales.conversion, binding.coefficient),
                            oneUsdPointsWithoutSeries: oneUsdExamplePoints(sales.conversion, fallback?.coefficient || "1"),
                        })),
                };
            }),
        missingPublishedPriceVersionIds: [...new Set(publishedBindings.filter((binding) => !priceById.has(binding.officialVersionId)).map((binding) => binding.officialVersionId))],
        activeUsageModels: activations,
        openReservations,
        reservationTaskLinkage: [...taskLinkageCounts].map(([key, count]) => {
            const [status, usageKind, linkage] = JSON.parse(key);
            return { status, usageKind, linkage, count };
        }),
        settledExceptions: attentionReservations.filter((reservation) => reservation.status === "settled"),
        frozenReferenceIssues,
        openReservationCount: openReservations.reduce((total, group) => total + group.count, 0),
    };
}
