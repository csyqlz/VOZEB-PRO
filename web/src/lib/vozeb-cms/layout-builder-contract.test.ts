import { describe, expect, it } from "vitest";

import { normalizeVozebCmsLayoutBuilderDraft } from "./layout-builder-contract";

describe("VOZEBCMS layout builder contract", () => {
    it("normalizes only registered components and stable defaults", () => {
        expect(normalizeVozebCmsLayoutBuilderDraft({ nodes: [{ componentId: "site.header", region: "header" }] })).toMatchObject({ nodes: [{ id: "builder-node-1", componentId: "site.header", region: "header", props: {} }] });
    });

    it("rejects unknown components, duplicate ids and unsafe regions", () => {
        expect(() => normalizeVozebCmsLayoutBuilderDraft({ nodes: [{ componentId: "custom.html", region: "main" }] })).toThrow("未注册组件");
        expect(() =>
            normalizeVozebCmsLayoutBuilderDraft({
                nodes: [
                    { id: "same", componentId: "module.header", region: "main" },
                    { id: "same", componentId: "module.summary", region: "main" },
                ],
            }),
        ).toThrow("重复");
        expect(() => normalizeVozebCmsLayoutBuilderDraft({ nodes: [{ componentId: "module.header", region: "main<script>" }] })).toThrow("区域无效");
    });
});
