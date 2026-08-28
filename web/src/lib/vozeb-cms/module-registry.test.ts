import { describe, expect, it } from "vitest";

import type { VozebCmsCapabilityDefinition, VozebCmsModuleManifest } from "@/lib/vozeb-cms/module-contract";
import { findVozebCmsModuleForPathname, moduleDependents, resolveVozebCmsModuleViews, resolveEnabledVozebCmsCapabilities, validateVozebCmsRegistry } from "@/lib/vozeb-cms/module-registry";

describe("VOZEBCMS module registry", () => {
    it("registers the stable release modules with the required manifest fields", () => {
        const modules = resolveVozebCmsModuleViews([]);

        expect(modules.map((module) => module.id)).toEqual(["create", "canvas", "drama", "image", "video"]);
        expect(modules.every((module) => module.version === "0.0.8" && module.routes.length > 0 && module.permissions.length > 0 && module.capabilities.length > 0 && module.enabled)).toBe(true);
    });

    it("resolves the remaining workspaces to their modules", () => {
        expect(findVozebCmsModuleForPathname("/canvas/project-one")?.id).toBe("canvas");
        expect(findVozebCmsModuleForPathname("/drama/project-one")?.id).toBe("drama");
        expect(findVozebCmsModuleForPathname("/help")).toBeUndefined();
    });

    it("removes disabled capabilities and reports enabled dependents", () => {
        const modules = resolveVozebCmsModuleViews([{ moduleId: "create", enabled: false, revision: 1 }]);

        expect(resolveEnabledVozebCmsCapabilities(modules).map((item) => item.id)).not.toContain("agent.run");
        expect(resolveEnabledVozebCmsCapabilities(modules).map((item) => item.id)).not.toContain("image.generate");
        expect(moduleDependents("create", modules).map((item) => item.id)).toEqual(["image", "video"]);
    });

    it("rejects duplicate ids, invalid routes, unknown references and dependency cycles", () => {
        const create = testManifest("create", "/create", ["agent.run"]);
        const canvas = testManifest("canvas", "/canvas", [], ["drama"]);
        const drama = testManifest("drama", "/drama", [], ["canvas"]);
        const agent = testCapability("agent.run", "create");

        expect(() => validateVozebCmsRegistry([create, create], [agent])).toThrow("模块 ID 重复");
        expect(() => validateVozebCmsRegistry([{ ...create, routes: ["create?tab=agent"] }], [agent])).toThrow("模块路由无效");
        expect(() => validateVozebCmsRegistry([{ ...create, dependencies: ["video"] }], [agent])).toThrow("模块依赖不存在");
        expect(() => validateVozebCmsRegistry([{ ...create, capabilities: ["missing.run"] }], [agent])).toThrow("模块能力引用无效");
        expect(() => validateVozebCmsRegistry([canvas, drama], [])).toThrow("模块依赖存在循环");
        expect(() => validateVozebCmsRegistry([create], [agent, agent])).toThrow("能力 ID 重复");
    });
});

function testManifest(id: VozebCmsModuleManifest["id"], route: string, capabilities: string[], dependencies: VozebCmsModuleManifest["dependencies"] = []): VozebCmsModuleManifest {
    return { id, name: id, description: id, version: "0.0.8", routes: [route], permissions: [id], capabilities, enabled: true, dependencies };
}

function testCapability(id: string, moduleId: VozebCmsCapabilityDefinition["moduleId"]): VozebCmsCapabilityDefinition {
    return { id, name: id, description: id, moduleId, actionId: id, billable: false };
}
