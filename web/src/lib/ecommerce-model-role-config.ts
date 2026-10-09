import type { EcommerceLogicalModelRole, EcommerceModelRoles, LogicalModel, LogicalModelCapability } from "@/lib/auth/store-types";

export const ECOMMERCE_MODEL_ROLE_DEFINITIONS: ReadonlyArray<{
    role: EcommerceLogicalModelRole;
    label: string;
    capability: LogicalModelCapability;
}> = [
    { role: "vision_analysis", label: "视觉分析", capability: "text" },
    { role: "edit_planning", label: "编辑规划", capability: "text" },
    { role: "image_generation", label: "图片生成", capability: "image" },
    { role: "quality_check", label: "视觉质检（可选）", capability: "text" },
];

export const EMPTY_ECOMMERCE_MODEL_ROLES: EcommerceModelRoles = {
    vision_analysis: [],
    edit_planning: [],
    image_generation: [],
    quality_check: [],
};

export function ecommerceModelCapabilityForRole(role: EcommerceLogicalModelRole): LogicalModelCapability {
    return role === "image_generation" ? "image" : "text";
}

export function normalizeEcommerceModelRoles(value: unknown, logicalModels: LogicalModel[]): EcommerceModelRoles {
    const source = record(value);
    const modelsById = new Map(logicalModels.map((model) => [model.id, model]));
    return Object.fromEntries(ECOMMERCE_MODEL_ROLE_DEFINITIONS.map(({ role, capability }) => [role, uniqueTextList(source[role]).filter((id) => modelsById.get(id)?.capability === capability)])) as EcommerceModelRoles;
}

export function ecommerceModelRoleValidationErrors(value: unknown, logicalModels: LogicalModel[]): string[] {
    const source = record(value);
    const modelsById = new Map(logicalModels.map((model) => [model.id, model]));
    const errors: string[] = [];
    for (const { role, label, capability } of ECOMMERCE_MODEL_ROLE_DEFINITIONS) {
        for (const id of uniqueTextList(source[role])) {
            const model = modelsById.get(id);
            if (!model) errors.push(`${label}候选模型“${id}”不存在`);
            else if (model.capability !== capability) errors.push(`${label}候选模型“${id}”必须是${capability === "image" ? "图片" : "文本"}能力`);
        }
    }
    return errors;
}

function uniqueTextList(value: unknown) {
    if (!Array.isArray(value)) return [];
    return Array.from(new Set(value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean)));
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
