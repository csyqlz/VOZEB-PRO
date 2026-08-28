import { getVozebCmsLayoutComponent, validateVozebCmsLayoutDefinition } from "@/lib/vozeb-cms/layout-contract";
import { resolveEnabledVozebCmsModuleIds } from "@/lib/vozeb-cms/module-registry";
import { normalizeVozebCmsSiteTheme } from "@/lib/vozeb-cms/site-design-contract";
import { listVozebCmsModules } from "./module-service";
import { getPublishedVozebCmsSiteLayout } from "./layout-store";

export async function getPublicVozebCmsSiteLayout(path: string) {
    const [layout, modules] = await Promise.all([getPublishedVozebCmsSiteLayout(path), listVozebCmsModules()]);
    if (!layout?.site || layout.site.path !== path) return null;
    validateVozebCmsLayoutDefinition(layout);
    const enabled = resolveEnabledVozebCmsModuleIds(modules);
    const nodes = layout.nodes.filter((node) => {
        const moduleId = getVozebCmsLayoutComponent(node.componentId)?.moduleId;
        return !moduleId || moduleId === "platform" || enabled.has(moduleId as never);
    });
    return {
        id: layout.id,
        name: layout.name,
        revision: layout.publishedRevision || layout.revision,
        publishedAt: layout.publishedAt,
        site: layout.site,
        theme: normalizeVozebCmsSiteTheme(layout.theme),
        nodes,
        enabledModules: [...enabled],
    };
}

export type PublicVozebCmsSiteLayout = NonNullable<Awaited<ReturnType<typeof getPublicVozebCmsSiteLayout>>>;
