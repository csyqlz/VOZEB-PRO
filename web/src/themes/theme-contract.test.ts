import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { preProcessFile } from "typescript";
import { describe, expect, it } from "vitest";

import { defineVozebTheme, defineVozebThemeBundle } from "./theme-contract";
import { getVozebThemeRuntimeClassName, validateVozebThemeRuntimes } from "./runtime";
import { DEFAULT_VOZEB_TEMPLATE_ID, getVozebTemplate, listVozebThemeBundles, listVozebThemes, resolveVozebTheme } from "./registry";
import { validateVozebThemeBlocks } from "@/lib/vozeb-cms/site-block-registry";

const tokens = { primary: "#000000", background: "#ffffff", surface: "#f5f5f5", text: "#111111", muted: "#777777", font: "modern", radius: "soft", contentWidth: "wide", spacing: "comfortable" } as const;

describe("VOZEB PRO developer theme contract", () => {
    it("registers code-owned manifests with templates and regions", () => {
        expect(listVozebThemes().map((theme) => theme.id)).toEqual(["vozeb"]);
        expect(listVozebThemeBundles().map((bundle) => bundle.manifest)).toEqual(listVozebThemes());
        expect(listVozebThemeBundles().every((bundle) => bundle.runtimeClassName.length > 0)).toBe(true);
        expect(listVozebThemes().every((theme) => theme.templates.every((template) => template.regions.some((region) => region.id === "main")))).toBe(true);
        expect(getVozebTemplate(DEFAULT_VOZEB_TEMPLATE_ID)?.template.name).toBe("VOZEB PRO 默认首页");
    });

    it("rejects invalid manifests and unknown template regions", () => {
        expect(() =>
            defineVozebTheme({
                id: "Bad Theme",
                name: "坏主题",
                version: "1.0.0",
                author: "test",
                description: "",
                minAppVersion: "0.0.8",
                tokens,
                templates: [{ id: "home", name: "首页", description: "", path: "/", regions: [{ id: "main", name: "主内容", required: true }], blocks: [] }],
            }),
        ).toThrow("主题 ID 无效");
        expect(() =>
            defineVozebTheme({
                id: "test-theme",
                name: "测试",
                version: "1.0.0",
                author: "test",
                description: "",
                minAppVersion: "0.0.8",
                tokens,
                templates: [{ id: "home", name: "首页", description: "", path: "/", regions: [{ id: "main", name: "主内容", required: true }], blocks: [{ componentId: "site.hero", region: "missing" }] }],
            }),
        ).toThrow("未知区域");
    });

    it("falls back to the built-in safe theme without affecting content", () => {
        expect(resolveVozebTheme("removed-third-party-theme").id).toBe("vozeb");
        expect(getVozebThemeRuntimeClassName("removed-third-party-theme")).toBe(getVozebThemeRuntimeClassName("vozeb"));
        expect(() => validateVozebThemeRuntimes()).not.toThrow();
    });

    it("rejects theme bundles without a build-owned stylesheet runtime", () => {
        expect(() => defineVozebThemeBundle({ manifest: resolveVozebTheme("vozeb"), runtimeClassName: "" })).toThrow("主题运行时样式无效");
    });

    it("keeps theme source imports isolated from platform business code", () => {
        const themesRoot = fileURLToPath(new URL(".", import.meta.url));
        const contractTarget = path.join(themesRoot, "theme-contract");
        const themeDirectories = readdirSync(themesRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && existsSync(path.join(themesRoot, entry.name, "index.ts")))
            .map((entry) => path.join(themesRoot, entry.name));

        expect(themeDirectories.length).toBeGreaterThan(0);
        for (const themeDirectory of themeDirectories) {
            for (const file of listTypeScriptFiles(themeDirectory)) {
                const imports = preProcessFile(readFileSync(file, "utf8")).importedFiles.map((item) => item.fileName);
                for (const specifier of imports) {
                    if (specifier.endsWith(".css")) {
                        expect(specifier, `${file} 只能导入自己的 theme.module.css`).toBe("./theme.module.css");
                        continue;
                    }
                    expect(specifier.startsWith("."), `${file} 不得导入平台别名：${specifier}`).toBe(true);
                    const target = path.resolve(path.dirname(file), specifier);
                    const insideTheme = target === themeDirectory || target.startsWith(`${themeDirectory}${path.sep}`);
                    expect(insideTheme || target === contractTarget, `${file} 不得访问主题目录外的业务代码：${specifier}`).toBe(true);
                }
            }
        }
    });

    it("rejects template blocks that are not provided by the platform adapter registry", () => {
        const theme = defineVozebTheme({
            id: "unknown-block",
            name: "未知区块",
            version: "1.0.0",
            author: "test",
            description: "",
            minAppVersion: "0.0.8",
            tokens,
            templates: [{ id: "home", name: "首页", description: "", path: "/", regions: [{ id: "main", name: "主内容", required: true }], blocks: [{ componentId: "plugin.exec", region: "main" }] }],
        });
        expect(() => validateVozebThemeBlocks(theme)).toThrow("未注册站点区块");
    });
});

function listTypeScriptFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) return listTypeScriptFiles(target);
        return entry.isFile() && entry.name.endsWith(".ts") ? [target] : [];
    });
}
