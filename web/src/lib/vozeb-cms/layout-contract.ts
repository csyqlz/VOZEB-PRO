import { getVozebCmsCapability, getVozebCmsModuleManifest } from "./module-registry";
import { isVozebCmsModuleId } from "./module-contract";
import { normalizeVozebCmsProjectRef, type VozebCmsProjectRef } from "./project-ref";
import { getVozebCmsLayoutComponent, normalizeVozebCmsBlockProps, VOZEB_CMS_LAYOUT_COMPONENTS } from "./site-block-registry";
import { normalizeVozebCmsSiteTarget, normalizeVozebCmsSiteTheme, type VozebCmsSiteTarget, type VozebCmsSiteTheme } from "./site-design-contract";

export { getVozebCmsLayoutComponent, VOZEB_CMS_LAYOUT_COMPONENTS } from "./site-block-registry";

export const VOZEB_CMS_LAYOUT_STATUSES = ["draft", "published"] as const;
export type VozebCmsLayoutStatus = (typeof VOZEB_CMS_LAYOUT_STATUSES)[number];

export type VozebCmsLayoutNode = {
    id: string;
    componentId: string;
    region: string;
    props: Record<string, unknown>;
    dataSource?: string;
    actions?: string[];
    responsive?: Record<string, Record<string, unknown>>;
};

export type VozebCmsLayoutDefinition = {
    id: string;
    userId: string;
    name: string;
    version: number;
    status: VozebCmsLayoutStatus;
    site?: VozebCmsSiteTarget;
    theme?: VozebCmsSiteTheme;
    projectRef?: VozebCmsProjectRef;
    moduleId?: string;
    permissions: string[];
    capabilities: string[];
    nodes: VozebCmsLayoutNode[];
    revision: number;
    lastMutationId?: string;
    publishedRevision?: number;
    createdAt: number;
    updatedAt: number;
    publishedAt?: number;
};

export const VOZEB_CMS_LAYOUT_ACTIONS = ["navigate", "agent.run", "image.generate", "video.generate", "workflow.start", "task.open", "asset.open"] as const;
export type VozebCmsLayoutAction = (typeof VOZEB_CMS_LAYOUT_ACTIONS)[number];

export function createVozebCmsLayoutDefinition(userId: string, input: unknown, projectRef?: VozebCmsProjectRef): VozebCmsLayoutDefinition {
    const value = record(input);
    const now = Date.now();
    const definition: VozebCmsLayoutDefinition = {
        id: text(value.id) || `layout-${globalThis.crypto.randomUUID()}`,
        userId,
        name: text(value.name).slice(0, 160) || "未命名页面",
        version: positiveInteger(value.version) || 1,
        status: "draft",
        ...(value.site ? { site: normalizeVozebCmsSiteTarget(value.site) } : {}),
        ...(value.site || value.theme ? { theme: normalizeVozebCmsSiteTheme(value.theme) } : {}),
        ...(projectRef ? { projectRef } : {}),
        moduleId: optionalText(value.moduleId),
        permissions: stringList(value.permissions),
        capabilities: stringList(value.capabilities),
        nodes: Array.isArray(value.nodes) ? value.nodes.flatMap(normalizeNode) : [],
        revision: 1,
        createdAt: positiveInteger(value.createdAt) || now,
        updatedAt: now,
    };
    validateVozebCmsLayoutDefinition(definition);
    return definition;
}

export function normalizeStoredVozebCmsLayout(value: unknown, userId: string): VozebCmsLayoutDefinition {
    const input = record(value);
    const projectRef = normalizeVozebCmsProjectRef(input.projectRef, userId);
    const definition = createVozebCmsLayoutDefinition(userId, { ...input, projectRef }, projectRef);
    return {
        ...definition,
        id: text(input.id) || definition.id,
        status: input.status === "published" ? "published" : "draft",
        revision: positiveInteger(input.revision) || 1,
        lastMutationId: optionalText(input.lastMutationId),
        publishedRevision: positiveInteger(input.publishedRevision),
        publishedAt: positiveInteger(input.publishedAt),
    };
}

export function validateVozebCmsLayoutDefinition(definition: VozebCmsLayoutDefinition) {
    if (!definition.userId.trim()) throw new Error("页面归属用户不能为空");
    if (definition.projectRef && definition.projectRef.ownerId !== definition.userId) throw new Error("页面项目归属不一致");
    const nodeIds = new Set<string>();
    for (const node of definition.nodes) {
        if (!/^[a-zA-Z0-9_-]{1,120}$/.test(node.id) || nodeIds.has(node.id)) throw new Error(`页面节点 ID 无效或重复：${node.id}`);
        nodeIds.add(node.id);
        const component = getVozebCmsLayoutComponent(node.componentId);
        if (!component) throw new Error(`页面组件未注册：${node.componentId}`);
        if (!node.region.trim()) throw new Error(`页面节点区域不能为空：${node.id}`);
        for (const action of node.actions || []) {
            if (!VOZEB_CMS_LAYOUT_ACTIONS.includes(action as VozebCmsLayoutAction) || !component.actions.includes(action)) throw new Error(`页面动作未注册或组件不支持：${node.componentId} -> ${action}`);
        }
        assertSafeValue(node.props, 0);
        if (node.responsive) assertSafeValue(node.responsive, 0);
    }
    for (const permission of definition.permissions) if (!permission.trim()) throw new Error("页面权限不能为空");
    for (const capabilityId of definition.capabilities) {
        const capability = getVozebCmsCapability(capabilityId);
        if (!capability) throw new Error(`页面能力未注册：${capabilityId}`);
        if (definition.moduleId && capability.moduleId !== "platform" && capability.moduleId !== definition.moduleId) throw new Error(`页面能力不属于当前模块：${capabilityId}`);
    }
    if (definition.moduleId && (!isVozebCmsModuleId(definition.moduleId) || !getVozebCmsModuleManifest(definition.moduleId))) throw new Error(`页面模块未注册：${definition.moduleId}`);
}

function normalizeNode(value: unknown): VozebCmsLayoutNode[] {
    const input = record(value);
    const componentId = text(input.componentId);
    if (!componentId) throw new Error("页面组件不能为空");
    if (!getVozebCmsLayoutComponent(componentId)) throw new Error(`页面组件未注册：${componentId}`);
    return [
        {
            id: text(input.id),
            componentId,
            region: text(input.region) || "main",
            props: normalizeVozebCmsBlockProps(componentId, safeRecord(input.props)),
            ...(text(input.dataSource) ? { dataSource: text(input.dataSource) } : {}),
            ...(Array.isArray(input.actions) ? { actions: stringList(input.actions) } : {}),
            ...(input.responsive && typeof input.responsive === "object" && !Array.isArray(input.responsive) ? { responsive: safeRecord(input.responsive) as Record<string, Record<string, unknown>> } : {}),
        },
    ];
}

function assertSafeValue(value: unknown, depth: number): void {
    if (depth > 4) throw new Error("页面配置嵌套层级过深");
    if (typeof value === "string") {
        if (/<\/?[a-z][^>]*>|javascript:|data:text\/html|on[a-z]+=|__proto__|constructor\s*\./i.test(value)) throw new Error("页面配置包含不安全内容");
        return;
    }
    if (value === null || typeof value === "number" || typeof value === "boolean") return;
    if (Array.isArray(value)) {
        if (value.length > 50) throw new Error("页面数组配置过大");
        value.forEach((item) => assertSafeValue(item, depth + 1));
        return;
    }
    if (!value || typeof value !== "object") throw new Error("页面配置类型不支持");
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(key) || /^(children|dangerouslySetInnerHTML|ref|key)$/i.test(key)) throw new Error(`页面属性不允许：${key}`);
        assertSafeValue(item, depth + 1);
    }
}

function safeRecord(value: unknown) {
    const result = record(value);
    assertSafeValue(result, 0);
    return result;
}

function stringList(value: unknown) {
    return Array.from(new Set((Array.isArray(value) ? value : []).map(text).filter(Boolean))).slice(0, 32);
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim().slice(0, 240) : "";
}

function optionalText(value: unknown) {
    const result = text(value);
    return result || undefined;
}

function positiveInteger(value: unknown) {
    const result = Number(value);
    return Number.isInteger(result) && result > 0 ? result : undefined;
}
