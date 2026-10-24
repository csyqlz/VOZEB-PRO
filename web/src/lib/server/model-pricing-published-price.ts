import type { AuthSettings } from "@/lib/auth/store";
import { getFreshAuthSettings } from "@/lib/auth/store";
import { assertRegularPaidPriceItems, modelPriceBindingScope, officialItemsForTextPriceGroup, PricingInputError, validateTextPriceSchedule, type ModelPriceBinding, type OfficialPriceVersion, type SalesVersion } from "@/lib/model-pricing";
import { getCurrentModelPriceBinding } from "./model-price-binding-store";
import { getOfficialVersionsByIds } from "./model-pricing-store";

export type PublishedPriceSelection = NonNullable<SalesVersion["selectedPriceBindings"]>[number];

function hasExecutableUsdPrice(version: OfficialPriceVersion) {
    try {
        if (version.textPriceSchedule && version.items.length) return false;
        const groups = version.textPriceSchedule ? validateTextPriceSchedule(version.textPriceSchedule).groups.filter((group) => group.selector.processingMode === "standard") : [];
        const items = groups.length ? groups.flatMap(officialItemsForTextPriceGroup) : version.items;
        if (!items.length || items.some((item) => item.currency !== "USD")) return false;
        assertRegularPaidPriceItems(version.capability === "video" && ["MiniMax-H3", "MiniMax-H3-Max"].includes(version.sku) ? items.filter((item) => item.key !== "inputAudioSeconds") : items);
        return true;
    } catch (error) {
        if (error instanceof PricingInputError) return false;
        throw error;
    }
}

export function publishedPriceMatches(modelId: string, version: OfficialPriceVersion, policy: SalesVersion, selection?: PublishedPriceSelection) {
    if (!selection) return version.logicalModelId === modelId && policy.priceVersionIds[modelId] === version.id;
    return (
        !version.logicalModelId &&
        !policy.priceVersionIds[modelId] &&
        selection.logicalModelId === modelId &&
        selection.officialVersionId === version.id &&
        policy.selectedPriceBindings?.some(
            (item) =>
                item.logicalModelId === selection.logicalModelId && item.scope === selection.scope && item.bindingId === selection.bindingId && item.bindingRevision === selection.bindingRevision && item.officialVersionId === selection.officialVersionId,
        ) === true
    );
}

export function publishedSelectionMatchesModel(
    modelId: string,
    capability: ModelPriceBinding["capability"],
    operation: ModelPriceBinding["operation"],
    version: OfficialPriceVersion,
    selection: PublishedPriceSelection,
    binding: ModelPriceBinding | undefined,
    settings: AuthSettings,
) {
    const scope = modelPriceBindingScope(capability, operation, "standard");
    const model = settings.logicalModels.find((item) => item.id === modelId);
    return Boolean(
        model &&
        selection.logicalModelId === modelId &&
        selection.scope === scope &&
        selection.officialVersionId === version.id &&
        binding?.current &&
        binding.status === "active" &&
        binding.logicalModelId === modelId &&
        binding.scope === scope &&
        binding.capability === capability &&
        binding.operation === operation &&
        binding.processingMode === "standard" &&
        binding.id === selection.bindingId &&
        binding.revision === selection.bindingRevision &&
        binding.officialVersionId === version.id &&
        !version.logicalModelId &&
        model.capability === capability &&
        model.manufacturer === version.manufacturer &&
        version.capability === capability &&
        version.tier === "paid" &&
        (version.processingTier || "standard") === "standard" &&
        hasExecutableUsdPrice(version),
    );
}

/** Resolve the published model/scope reference, checking its current binding before a new call. */
export async function resolvePublishedModelPrice(
    modelId: string,
    capability: ModelPriceBinding["capability"],
    operation: ModelPriceBinding["operation"],
    policy: SalesVersion | undefined,
    settings?: AuthSettings,
): Promise<{ version: OfficialPriceVersion; selection?: PublishedPriceSelection } | undefined> {
    if (!policy) return undefined;
    const scope = modelPriceBindingScope(capability, operation, "standard");
    const selected = policy.selectedPriceBindings?.find((item) => item.logicalModelId === modelId && item.scope === scope);
    const legacyId = policy.priceVersionIds[modelId];
    if ((legacyId && policy.selectedPriceBindings?.some((item) => item.logicalModelId === modelId)) || (!selected && !legacyId)) return undefined;
    const versionId = selected?.officialVersionId || legacyId;
    const version = (await getOfficialVersionsByIds([versionId])).find((item) => item.id === versionId);
    if (!version) return undefined;
    if (!selected) return version.logicalModelId === modelId ? { version } : undefined;
    const [binding, currentSettings] = await Promise.all([getCurrentModelPriceBinding(modelId, scope), settings ? Promise.resolve(settings) : getFreshAuthSettings()]);
    if (!publishedSelectionMatchesModel(modelId, capability, operation, version, selected, binding, currentSettings)) return undefined;
    return { version, selection: selected };
}
