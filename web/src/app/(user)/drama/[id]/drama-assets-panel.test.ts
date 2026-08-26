import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { imageResultsToReferences } from "./drama-assets-panel";
import { filterAndSortDramaAssets, type DramaAssetLibraryRow } from "./drama-asset-library-utils";
import { stableTaskUrl } from "./drama-editor-elements";

describe("drama asset image results", () => {
    it("prefers the persisted platform file over the upstream result url", () => {
        expect(stableTaskUrl("https://provider.example/result.png", "/api/generation-log-assets/permanent/result.png", "data:image/png;base64,result")).toBe("/api/generation-log-assets/permanent/result.png");
    });

    it("keeps every generated image as a candidate reference", () => {
        const references = imageResultsToReferences({
            dataUrl: "data:image/png;base64,first",
            serverUrl: "/api/generation-log-assets/first.png",
            results: [
                { dataUrl: "data:image/png;base64,first", serverUrl: "/api/generation-log-assets/first.png", width: 1024, height: 1024 },
                { serverUrl: "/api/generation-log-assets/second.png", width: 1024, height: 1024 },
            ],
        });

        expect(references).toHaveLength(2);
        expect(references.map((item) => item.url)).toEqual(["/api/generation-log-assets/first.png", "/api/generation-log-assets/second.png"]);
        expect(references.map((item) => item.label)).toEqual(["AI 候选图 1", "AI 候选图 2"]);
    });

    it("uses an asset card library and moves create/edit fields into a responsive drawer", async () => {
        const [panel, editor] = await Promise.all([readFile(resolve(process.cwd(), "src/app/(user)/drama/[id]/drama-assets-panel.tsx"), "utf8"), readFile(resolve(process.cwd(), "src/app/(user)/drama/[id]/drama-asset-editor-drawer.tsx"), "utf8")]);

        expect(panel).toContain("data-drama-asset-grid");
        expect(panel).toContain("data-drama-assets-toolbar");
        expect(panel).toContain("待补基准");
        expect(panel).toContain("当前集涉及");
        expect(panel).toContain("下载项目基准图");
        expect(panel).toContain("downloadDramaAssetBundle");
        expect(panel).toContain("未被引用");
        expect(panel).toContain("data-drama-source-assets");
        expect(panel).toContain("<DramaAssetEditorDrawer");
        expect(editor).toContain("<Modal");
        expect(editor).toContain("width={640}");
        expect(editor).toContain("if (!asset)");
        expect(editor).toContain("size={620}");
        expect(editor).toContain('maxWidth: "100vw"');
        expect(editor).toContain("从来源选择");
        expect(editor).toContain("上传候选");
        expect(editor).toContain("生成候选");
    });

    it("filters derived readiness and usage states without changing project data", () => {
        const rows: DramaAssetLibraryRow[] = [
            { asset: { id: "ready", name: "已引用角色", description: "主角" }, referenceCount: 2, usageCount: 4, currentEpisodeUsageCount: 2, incomplete: false },
            { asset: { id: "missing", name: "待补角色", description: "" }, referenceCount: 0, usageCount: 0, currentEpisodeUsageCount: 0, incomplete: true },
            { asset: { id: "unused", name: "备用角色", description: "配角" }, referenceCount: 1, usageCount: 0, currentEpisodeUsageCount: 0, incomplete: false },
        ];

        expect(filterAndSortDramaAssets(rows, "current-episode", "default", "").map((row) => row.asset.id)).toEqual(["ready"]);
        expect(filterAndSortDramaAssets(rows, "missing-reference", "default", "").map((row) => row.asset.id)).toEqual(["missing"]);
        expect(filterAndSortDramaAssets(rows, "used", "default", "").map((row) => row.asset.id)).toEqual(["ready"]);
        expect(filterAndSortDramaAssets(rows, "unused", "attention", "").map((row) => row.asset.id)).toEqual(["missing", "unused"]);
    });
});
