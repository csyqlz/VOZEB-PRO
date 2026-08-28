import type { VozebCmsCapabilityDefinition, VozebCmsModuleId, VozebCmsModuleManifest, VozebCmsModuleState, VozebCmsModuleView } from "@/lib/vozeb-cms/module-contract";
import { VOZEB_CMS_CAPABILITIES, VOZEB_CMS_MODULE_MANIFESTS } from "@/lib/vozeb-cms/module-manifests";

const manifestsById = new Map<VozebCmsModuleId, VozebCmsModuleManifest>();
const capabilitiesById = new Map<string, VozebCmsCapabilityDefinition>();

validateVozebCmsRegistry(VOZEB_CMS_MODULE_MANIFESTS, VOZEB_CMS_CAPABILITIES);

for (const manifest of VOZEB_CMS_MODULE_MANIFESTS) {
    manifestsById.set(manifest.id, manifest);
}

for (const capability of VOZEB_CMS_CAPABILITIES) {
    capabilitiesById.set(capability.id, capability);
}

export function validateVozebCmsRegistry(manifests: readonly VozebCmsModuleManifest[], capabilities: readonly VozebCmsCapabilityDefinition[]) {
    const knownModules = new Map<string, VozebCmsModuleManifest>();
    const knownCapabilities = new Map<string, VozebCmsCapabilityDefinition>();
    const knownRoutes = new Set<string>();

    for (const manifest of manifests) {
        if (knownModules.has(manifest.id)) throw new Error(`VOZEBCMS 模块 ID 重复：${manifest.id}`);
        knownModules.set(manifest.id, manifest);
        for (const route of manifest.routes) {
            if (!isValidRoutePattern(route)) throw new Error(`VOZEBCMS 模块路由无效：${manifest.id} -> ${route}`);
            if (knownRoutes.has(route)) throw new Error(`VOZEBCMS 模块路由重复：${route}`);
            knownRoutes.add(route);
        }
    }

    for (const capability of capabilities) {
        if (knownCapabilities.has(capability.id)) throw new Error(`VOZEBCMS 能力 ID 重复：${capability.id}`);
        if (capability.moduleId !== "platform" && !knownModules.has(capability.moduleId)) throw new Error(`VOZEBCMS 能力所属模块不存在：${capability.id}`);
        knownCapabilities.set(capability.id, capability);
    }

    for (const manifest of manifests) {
        for (const dependency of manifest.dependencies) if (!knownModules.has(dependency)) throw new Error(`VOZEBCMS 模块依赖不存在：${manifest.id} -> ${dependency}`);
        for (const capabilityId of manifest.capabilities) {
            const capability = knownCapabilities.get(capabilityId);
            if (!capability || capability.moduleId !== manifest.id) throw new Error(`VOZEBCMS 模块能力引用无效：${manifest.id} -> ${capabilityId}`);
        }
    }

    const visited = new Set<string>();
    const visiting = new Set<string>();
    const visit = (moduleId: string) => {
        if (visiting.has(moduleId)) throw new Error(`VOZEBCMS 模块依赖存在循环：${moduleId}`);
        if (visited.has(moduleId)) return;
        visiting.add(moduleId);
        for (const dependency of knownModules.get(moduleId)?.dependencies || []) visit(dependency);
        visiting.delete(moduleId);
        visited.add(moduleId);
    };
    for (const moduleId of knownModules.keys()) visit(moduleId);
}

function isValidRoutePattern(route: string) {
    return route.length > 1 && route === route.trim() && /^\/(?:[a-z0-9-]+|\*)(?:\/(?:[a-z0-9-]+|\*))*$/i.test(route);
}

export function listVozebCmsModuleManifests() {
    return [...VOZEB_CMS_MODULE_MANIFESTS];
}

export function getVozebCmsModuleManifest(moduleId: VozebCmsModuleId) {
    return manifestsById.get(moduleId);
}

export function getVozebCmsCapability(capabilityId: string) {
    return capabilitiesById.get(capabilityId);
}

export function resolveVozebCmsModuleViews(states: readonly VozebCmsModuleState[]): VozebCmsModuleView[] {
    const stateById = new Map(states.map((state) => [state.moduleId, state]));
    return VOZEB_CMS_MODULE_MANIFESTS.map((manifest) => {
        const state = stateById.get(manifest.id);
        return {
            ...manifest,
            enabled: state?.enabled ?? manifest.enabled,
            revision: state?.revision || 0,
            lastMutationId: state?.lastMutationId,
            updatedAt: state?.updatedAt,
            updatedBy: state?.updatedBy,
        };
    });
}

export function resolveEnabledVozebCmsCapabilities(modules: readonly VozebCmsModuleView[]) {
    const enabled = resolveEnabledVozebCmsModuleIds(modules);
    return VOZEB_CMS_CAPABILITIES.filter((capability) => capability.moduleId === "platform" || (enabled.has(capability.moduleId) && moduleDependenciesEnabled(capability.moduleId, enabled)));
}

export function resolveEnabledVozebCmsModuleIds(modules: readonly VozebCmsModuleView[]) {
    const declaredEnabled = new Set(modules.filter((module) => module.enabled).map((module) => module.id));
    return new Set(modules.filter((module) => module.enabled && moduleDependenciesEnabled(module.id, declaredEnabled)).map((module) => module.id));
}

export function findVozebCmsModuleForPathname(pathname: string) {
    const normalized = normalizePathname(pathname);
    return [...VOZEB_CMS_MODULE_MANIFESTS]
        .flatMap((manifest) => manifest.routes.map((route) => ({ manifest, route, score: route.replaceAll("*", "").length })))
        .filter(({ route }) => routeMatches(route, normalized))
        .sort((left, right) => right.score - left.score)[0]?.manifest;
}

export function moduleDependents(moduleId: VozebCmsModuleId, modules: readonly VozebCmsModuleView[]) {
    return modules.filter((module) => module.enabled && module.dependencies.includes(moduleId));
}

function moduleDependenciesEnabled(moduleId: VozebCmsModuleId, enabled: ReadonlySet<VozebCmsModuleId>, visiting = new Set<VozebCmsModuleId>()): boolean {
    if (visiting.has(moduleId)) return false;
    const manifest = manifestsById.get(moduleId);
    if (!manifest) return false;
    const nextVisiting = new Set(visiting).add(moduleId);
    return manifest.dependencies.every((dependency) => enabled.has(dependency) && moduleDependenciesEnabled(dependency, enabled, nextVisiting));
}

function normalizePathname(pathname: string) {
    const path = `/${
        String(pathname || "")
            .split(/[?#]/, 1)[0]
            ?.split("/")
            .filter(Boolean)
            .join("/") || ""
    }`;
    return path.length > 1 ? path.replace(/\/$/, "") : path;
}

function routeMatches(pattern: string, pathname: string) {
    const patternParts = normalizePathname(pattern).split("/").filter(Boolean);
    const pathParts = pathname.split("/").filter(Boolean);
    if (!patternParts.includes("*") && patternParts.length !== pathParts.length) return false;
    if (patternParts.length > pathParts.length) return false;
    return patternParts.every((part, index) => part === "*" || part === pathParts[index]);
}
