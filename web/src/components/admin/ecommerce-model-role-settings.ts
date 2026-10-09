import type { EcommerceLogicalModelRole, LogicalModel } from "@/lib/auth/store";
import { ecommerceModelCapabilityForRole } from "@/lib/ecommerce-model-role-config";

export function availableEcommerceRoleModels(models: LogicalModel[], role: EcommerceLogicalModelRole) {
    const capability = ecommerceModelCapabilityForRole(role);
    return models.filter((model) => model.enabled && model.capability === capability);
}

export function addEcommerceRoleModel(modelIds: string[], modelId: string) {
    const id = modelId.trim();
    return id && !modelIds.includes(id) ? [...modelIds, id] : modelIds;
}

export function removeEcommerceRoleModel(modelIds: string[], modelId: string) {
    return modelIds.filter((id) => id !== modelId);
}

export function moveEcommerceRoleModel(modelIds: string[], index: number, offset: -1 | 1) {
    const target = index + offset;
    if (index < 0 || index >= modelIds.length || target < 0 || target >= modelIds.length) return modelIds;
    const next = [...modelIds];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
}
