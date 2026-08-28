import { describe, expect, it } from "vitest";

import { createVozebCmsLayoutDefinition, getVozebCmsLayoutComponent } from "./layout-contract";

describe("VOZEBCMS controlled layout contract", () => {
    it("accepts registered components and actions", () => {
        const layout = createVozebCmsLayoutDefinition("user-one", {
            id: "layout-one",
            name: "创作首页",
            moduleId: "create",
            capabilities: ["agent.run"],
            nodes: [{ id: "entry", componentId: "agent.entry", region: "main", props: { title: "开始创作" }, actions: ["agent.run"] }],
        });
        expect(layout.nodes[0]).toMatchObject({ componentId: "agent.entry", actions: ["agent.run"] });
        expect(getVozebCmsLayoutComponent("agent.entry")?.moduleId).toBe("create");
    });

    it("rejects unknown components and executable-looking values", () => {
        expect(() => createVozebCmsLayoutDefinition("user-one", { nodes: [{ id: "bad", componentId: "custom.html", props: {} }] })).toThrow("页面组件未注册");
        expect(() => createVozebCmsLayoutDefinition("user-one", { nodes: [{ id: "bad", componentId: "module.header", props: { content: "<script>alert(1)</script>" } }] })).toThrow("不安全");
    });

    it("rejects actions that are not declared by the component", () => {
        expect(() => createVozebCmsLayoutDefinition("user-one", { nodes: [{ id: "asset", componentId: "asset.library", actions: ["video.generate"], props: {} }] })).toThrow("组件不支持");
    });

    it("normalizes developer themes and only keeps registered site block fields", () => {
        const layout = createVozebCmsLayoutDefinition("user-one", {
            site: { kind: "page", path: "/", title: "首页" },
            theme: { presetId: "vozeb", templateId: "creative-home", tokens: { primary: "#112233" } },
            nodes: [{ id: "hero", componentId: "site.hero", region: "main", props: { title: "商业首页", unknownInternalField: "drop-me", primaryHref: "/create" }, actions: ["navigate"] }],
        });
        expect(layout.theme).toMatchObject({ presetId: "vozeb", templateId: "creative-home", tokens: { primary: "#112233" } });
        expect(layout.nodes[0].props).toMatchObject({ title: "商业首页", primaryHref: "/create" });
        expect(layout.nodes[0].props).not.toHaveProperty("unknownInternalField");
    });

    it("rejects unregistered public paths, unsafe theme colors and external block links", () => {
        expect(() => createVozebCmsLayoutDefinition("user-one", { site: { path: "/custom" }, nodes: [] })).toThrow("路径未注册");
        expect(() => createVozebCmsLayoutDefinition("user-one", { site: { path: "/" }, theme: { tokens: { primary: "url(javascript:alert(1))" } }, nodes: [] })).toThrow("主题颜色无效");
        expect(() => createVozebCmsLayoutDefinition("user-one", { site: { path: "/" }, nodes: [{ id: "hero", componentId: "site.hero", region: "main", props: { primaryHref: "https://evil.test" } }] })).toThrow("区块链接无效");
    });
});
