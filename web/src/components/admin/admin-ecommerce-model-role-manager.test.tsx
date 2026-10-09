import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { EMPTY_ECOMMERCE_MODEL_ROLES } from "@/lib/ecommerce-model-role-config";
import { AdminEcommerceModelRoleManager } from "./admin-ecommerce-model-role-manager";

type SwitchProps = {
    "aria-label"?: string;
    checked?: boolean;
    children?: ReactNode;
    onChange?: (checked: boolean) => void;
};

function findSwitch(node: ReactNode, label = "启用电商生图编排"): ReactElement<SwitchProps> | null {
    if (Array.isArray(node)) {
        for (const child of node) {
            const found = findSwitch(child, label);
            if (found) return found;
        }
        return null;
    }
    if (!isValidElement<SwitchProps>(node)) return null;
    if (node.props["aria-label"] === label) return node;
    return findSwitch(node.props.children, label);
}

describe("AdminEcommerceModelRoleManager", () => {
    it("defaults visual quality to off and restores the saved advisory switch", () => {
        const onVisualQualityEnabledChange = vi.fn();
        const props = { logicalModels: [], roles: EMPTY_ECOMMERCE_MODEL_ROLES, enabled: true, onEnabledChange: vi.fn(), onChange: vi.fn(), onVisualQualityEnabledChange };
        const disabled = AdminEcommerceModelRoleManager(props);
        const control = findSwitch(disabled, "启用可选视觉质检");
        expect(control?.props.checked).toBe(false);
        control?.props.onChange?.(true);
        expect(onVisualQualityEnabledChange).toHaveBeenCalledWith(true);
        const restored = AdminEcommerceModelRoleManager({ ...props, visualQualityEnabled: true });
        expect(findSwitch(restored, "启用可选视觉质检")?.props.checked).toBe(true);
        expect(renderToStaticMarkup(restored)).toContain("不会退回或隐藏已生成图片");
    });
    it("renders, toggles, and rehydrates the persisted ecommerce orchestration switch", () => {
        const onEnabledChange = vi.fn();
        const disabledTree = AdminEcommerceModelRoleManager({
            logicalModels: [],
            roles: EMPTY_ECOMMERCE_MODEL_ROLES,
            enabled: false,
            onEnabledChange,
            onChange: vi.fn(),
        });
        const disabledSwitch = findSwitch(disabledTree);

        expect(disabledSwitch?.props.checked).toBe(false);
        disabledSwitch?.props.onChange?.(true);
        expect(onEnabledChange).toHaveBeenCalledWith(true);

        const enabledTree = AdminEcommerceModelRoleManager({
            logicalModels: [],
            roles: EMPTY_ECOMMERCE_MODEL_ROLES,
            enabled: true,
            onEnabledChange,
            onChange: vi.fn(),
        });

        expect(findSwitch(enabledTree)?.props.checked).toBe(true);
        expect(renderToStaticMarkup(enabledTree)).toContain("启用电商生图编排");
    });
});
