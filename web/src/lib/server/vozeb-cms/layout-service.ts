import { assertVozebCmsModuleEnabled, assertVozebCmsUserCapability } from "@/lib/server/vozeb-cms/module-service";
import { isVozebCmsModuleId } from "@/lib/vozeb-cms/module-contract";
import { createVozebCmsLayoutDefinition, getVozebCmsLayoutComponent, validateVozebCmsLayoutDefinition, type VozebCmsLayoutDefinition } from "@/lib/vozeb-cms/layout-contract";
import { resolveVozebCmsProjectRef } from "./project-ref-service";
import { createVozebCmsLayout, getPublishedVozebCmsLayout, getVozebCmsLayout, listVozebCmsLayouts, publishVozebCmsLayout, rollbackVozebCmsLayout, saveVozebCmsLayoutDraft, VozebCmsLayoutStoreError } from "./layout-store";

export { VozebCmsLayoutStoreError };

export async function createVozebCmsLayoutForUser(userId: string, input: unknown) {
    await assertVozebCmsUserCapability(userId, "layout.compose");
    const value = object(input);
    const projectRef = await resolveVozebCmsProjectRef(userId, value.projectRef, Boolean(value.projectRef));
    const definition = createVozebCmsLayoutDefinition(userId, value, projectRef);
    await assertLayoutModulesEnabled(definition);
    return createVozebCmsLayout(definition);
}

export async function listVozebCmsLayoutsForUser(userId: string, input: { projectId?: string; projectType?: string; sitePath?: string; limit?: number } = {}) {
    await assertVozebCmsUserCapability(userId, "layout.compose");
    return listVozebCmsLayouts(userId, input);
}

export async function getVozebCmsLayoutForUser(userId: string, id: string, published = false) {
    await assertVozebCmsUserCapability(userId, "layout.compose");
    const layout = published ? await getPublishedVozebCmsLayout(userId, id) : await getVozebCmsLayout(userId, id);
    if (layout?.moduleId) await assertVozebCmsModuleEnabled(layout.moduleId as never);
    return layout;
}

export async function saveVozebCmsLayoutDraftForUser(userId: string, id: string, input: unknown) {
    await assertVozebCmsUserCapability(userId, "layout.compose");
    const value = object(input);
    const current = await getVozebCmsLayout(userId, id);
    if (!current) throw new VozebCmsLayoutStoreError("页面不存在", 404);
    const projectRef = value.projectRef === undefined ? current.projectRef : await resolveVozebCmsProjectRef(userId, value.projectRef, true);
    const definition = createVozebCmsLayoutDefinition(userId, { ...value, id, revision: current.revision, projectRef }, projectRef);
    await assertLayoutModulesEnabled(definition);
    const baseRevision = positiveInteger(value.baseRevision);
    const mutationId = text(value.mutationId);
    if (!baseRevision || !mutationId) throw new VozebCmsLayoutStoreError("页面保存参数无效", 400);
    validateVozebCmsLayoutDefinition(definition);
    return saveVozebCmsLayoutDraft(userId, id, baseRevision, definition, mutationId);
}

export async function publishVozebCmsLayoutForUser(userId: string, id: string, input: unknown) {
    await assertVozebCmsUserCapability(userId, "layout.compose");
    const current = await getVozebCmsLayout(userId, id);
    if (!current) throw new VozebCmsLayoutStoreError("页面不存在", 404);
    await assertLayoutModulesEnabled(current);
    const baseRevision = positiveInteger(object(input).baseRevision);
    if (!baseRevision) throw new VozebCmsLayoutStoreError("页面发布参数无效", 400);
    validateVozebCmsLayoutDefinition(current);
    return publishVozebCmsLayout(userId, id, baseRevision, userId);
}

export async function rollbackVozebCmsLayoutForUser(userId: string, id: string, input: unknown) {
    await assertVozebCmsUserCapability(userId, "layout.compose");
    const value = object(input);
    const current = await getVozebCmsLayout(userId, id);
    if (!current) throw new VozebCmsLayoutStoreError("页面不存在", 404);
    await assertLayoutModulesEnabled(current);
    const targetRevision = positiveInteger(value.targetRevision);
    const baseRevision = positiveInteger(value.baseRevision);
    if (!targetRevision || !baseRevision) throw new VozebCmsLayoutStoreError("页面回滚参数无效", 400);
    return rollbackVozebCmsLayout(userId, id, targetRevision, baseRevision, userId);
}

function object(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim().slice(0, 160) : "";
}

function positiveInteger(value: unknown) {
    const result = Number(value);
    return Number.isInteger(result) && result > 0 ? result : undefined;
}

async function assertModuleEnabled(moduleId: string) {
    if (!isVozebCmsModuleId(moduleId)) throw new VozebCmsLayoutStoreError("页面模块未注册", 400);
    return assertVozebCmsModuleEnabled(moduleId);
}

async function assertLayoutModulesEnabled(definition: VozebCmsLayoutDefinition) {
    const moduleIds = new Set<string>();
    if (definition.moduleId) moduleIds.add(definition.moduleId);
    for (const node of definition.nodes) {
        const moduleId = getVozebCmsLayoutComponent(node.componentId)?.moduleId;
        if (moduleId && moduleId !== "platform") moduleIds.add(moduleId);
    }
    for (const moduleId of moduleIds) await assertModuleEnabled(moduleId);
}
