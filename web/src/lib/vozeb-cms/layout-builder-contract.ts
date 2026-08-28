import { getVozebCmsLayoutComponent } from "./layout-contract";
import { listVozebCmsSiteBlocks } from "./site-block-registry";

export type VozebCmsLayoutBuilderDraft = {
    summary?: string;
    nodes: Array<{
        id?: string;
        componentId: string;
        region: string;
        props?: Record<string, unknown>;
        actions?: string[];
    }>;
};

export function normalizeVozebCmsLayoutBuilderDraft(value: unknown): VozebCmsLayoutBuilderDraft {
    const input = record(value);
    const rawNodes = Array.isArray(input.nodes) ? input.nodes : [];
    if (!rawNodes.length) throw new Error("AI 页面方案没有返回组件");
    const ids = new Set<string>();
    const nodes = rawNodes.map((item, index) => {
        const node = record(item);
        const componentId = text(node.componentId);
        if (!getVozebCmsLayoutComponent(componentId)) throw new Error(`AI 页面方案引用了未注册组件：${componentId || index + 1}`);
        const id = text(node.id) || `builder-node-${index + 1}`;
        if (!/^[a-zA-Z0-9_-]{1,120}$/.test(id) || ids.has(id)) throw new Error(`AI 页面方案节点 ID 无效或重复：${id}`);
        ids.add(id);
        const region = text(node.region) || "main";
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(region)) throw new Error(`AI 页面方案区域无效：${region}`);
        return {
            id,
            componentId,
            region,
            props: safeRecord(node.props),
            ...(Array.isArray(node.actions) ? { actions: node.actions.map(text).filter(Boolean) } : {}),
        };
    });
    return { summary: text(input.summary), nodes };
}

export const VOZEB_CMS_LAYOUT_BUILDER_TOOL = {
    name: "build_vozeb_cms_layout",
    description: "根据用户需求生成可审阅的 VOZEB PRO 受控站点区块草稿",
    parameters: {
        type: "object",
        properties: {
            summary: { type: "string", maxLength: 500 },
            nodes: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        id: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,120}$" },
                        componentId: { type: "string", enum: listVozebCmsSiteBlocks().map((component) => component.id) },
                        region: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,80}$" },
                        props: { type: "object", additionalProperties: true },
                        actions: { type: "array", items: { type: "string" } },
                    },
                    required: ["componentId", "region"],
                    additionalProperties: false,
                },
            },
        },
        required: ["nodes"],
        additionalProperties: false,
    },
} as const;

function safeRecord(value: unknown) {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim().slice(0, 240) : "";
}
