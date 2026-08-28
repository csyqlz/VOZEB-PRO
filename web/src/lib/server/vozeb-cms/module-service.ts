import type { VozebCmsModuleId, VozebCmsModuleStateMutation } from "@/lib/vozeb-cms/module-contract";
import { getAuthSettings, getPublicUsersByIds } from "@/lib/auth/store";
import { getVozebCmsCapability, getVozebCmsModuleManifest, moduleDependents, resolveVozebCmsModuleViews, resolveEnabledVozebCmsCapabilities } from "@/lib/vozeb-cms/module-registry";
import { listVozebCmsModuleStates, updateVozebCmsModuleState } from "@/lib/server/vozeb-cms/module-state-store";

export class VozebCmsModuleAccessError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}

export async function listVozebCmsModules() {
    return resolveVozebCmsModuleViews(await listVozebCmsModuleStates());
}

export async function listEnabledVozebCmsCapabilities() {
    return resolveEnabledVozebCmsCapabilities(await listVozebCmsModules());
}

export async function changeVozebCmsModuleState(mutation: VozebCmsModuleStateMutation) {
    const modules = await listVozebCmsModules();
    const moduleView = modules.find((item) => item.id === mutation.moduleId);
    if (!moduleView) throw new VozebCmsModuleAccessError("模块不存在", 404);

    if (!mutation.enabled) {
        const dependents = moduleDependents(moduleView.id, modules);
        if (dependents.length) throw new VozebCmsModuleAccessError(`请先停用依赖模块：${dependents.map((item) => item.name).join("、")}`, 409);
    } else {
        const missing = moduleView.dependencies.filter((dependency) => !modules.find((item) => item.id === dependency)?.enabled);
        if (missing.length) throw new VozebCmsModuleAccessError(`请先启用依赖模块：${missing.map((id) => getVozebCmsModuleManifest(id)?.name || id).join("、")}`, 409);
    }

    await updateVozebCmsModuleState(mutation);
    return (await listVozebCmsModules()).find((item) => item.id === mutation.moduleId)!;
}

export async function assertVozebCmsModuleEnabled(moduleId: VozebCmsModuleId) {
    const modules = await listVozebCmsModules();
    const moduleView = modules.find((item) => item.id === moduleId);
    if (!moduleView?.enabled) throw new VozebCmsModuleAccessError(`${moduleView?.name || moduleId}模块已停用`, 403);
    const dependencies = moduleView.dependencies.filter((dependency) => !modules.find((item) => item.id === dependency)?.enabled);
    if (dependencies.length) throw new VozebCmsModuleAccessError(`${moduleView.name}依赖模块未启用`, 403);
    return moduleView;
}

export async function assertVozebCmsCapabilityEnabled(capabilityId: string) {
    const capability = getVozebCmsCapability(capabilityId);
    if (!capability) throw new VozebCmsModuleAccessError("能力未注册", 404);
    if (capability.moduleId !== "platform") await assertVozebCmsModuleEnabled(capability.moduleId);
    return capability;
}

export async function assertVozebCmsUserCapability(userId: string, capabilityId: string) {
    const capability = await assertVozebCmsCapabilityEnabled(capabilityId);
    if (!capability.feature) return capability;
    const settings = await getAuthSettings();
    if (!settings.entitlements.enabled) return capability;
    const user = (await getPublicUsersByIds([userId]))[0];
    if (!user) throw new VozebCmsModuleAccessError("用户不存在", 404);
    if (user.role === "admin") return capability;
    const plan = settings.entitlements.plans.find((item) => item.enabled && item.id === user.planId);
    if (!plan?.features.includes(capability.feature)) throw new VozebCmsModuleAccessError(`当前套餐不包含${capability.name}能力`, 403);
    return capability;
}
