type BillingLogicalModel = {
    id: string;
    bindings?: Array<{ upstreamModel: string; enabled?: boolean; priority?: number }>;
};

const DEFAULT_MODEL_POINT_COST_KEY = "__default__";

export function resolveConfiguredModelPointCost(costs: Record<string, number> | undefined, model: string, logicalModels: BillingLogicalModel[] = []) {
    const direct = configuredCost(costs, model);
    if (direct !== undefined) return direct;

    const logical = logicalModels.find((item) => sameModel(item.id, model));
    if (logical) {
        const bindings = (logical.bindings || []).filter((binding) => binding.enabled !== false).sort((left, right) => (left.priority || 0) - (right.priority || 0));
        for (const binding of bindings) {
            const aliasCost = configuredCost(costs, binding.upstreamModel);
            if (aliasCost !== undefined) return aliasCost;
        }
    }

    return configuredCost(costs, DEFAULT_MODEL_POINT_COST_KEY) ?? 1;
}

export function materializeLogicalModelPointCosts(costs: Record<string, number> | undefined, logicalModels: BillingLogicalModel[] = []) {
    const resolved = { ...(costs || {}) };
    for (const logical of logicalModels) {
        if (configuredCost(costs, logical.id) !== undefined) continue;
        const bindings = (logical.bindings || []).filter((binding) => binding.enabled !== false).sort((left, right) => (left.priority || 0) - (right.priority || 0));
        const aliasCost = bindings.map((binding) => configuredCost(costs, binding.upstreamModel)).find((cost) => cost !== undefined);
        if (aliasCost !== undefined) resolved[logical.id] = aliasCost;
    }
    return resolved;
}

export function configuredModelPointCostKeys(costs: Record<string, number> | undefined, model: string, logicalModels: BillingLogicalModel[] = []) {
    const logical = logicalModels.find((item) => sameModel(item.id, model));
    const candidates = [model, ...(logical?.bindings?.filter((binding) => binding.enabled !== false).map((binding) => binding.upstreamModel) || [])];
    return Object.keys(costs || {}).filter((key) => candidates.some((candidate) => sameModel(key, candidate)));
}

function configuredCost(costs: Record<string, number> | undefined, model: string) {
    const key = Object.keys(costs || {}).find((item) => sameModel(item, model));
    if (!key) return undefined;
    const value = Number(costs?.[key]);
    if (!Number.isFinite(value) || value < 0) return undefined;
    return Math.min(Number(value.toFixed(2)), 1_000_000);
}

function sameModel(left: string, right: string) {
    return rawModelName(left).toLowerCase() === rawModelName(right).toLowerCase();
}

function rawModelName(value: string) {
    const normalized = value.trim();
    const separator = normalized.indexOf("::");
    return separator >= 0 ? normalized.slice(separator + 2).trim() : normalized;
}
