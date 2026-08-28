# VOZEB PRO 主题开发

VOZEB PRO 的主题系统只负责公开前端的模板、区域、默认区块和设计 Token。Agent、Canvas、短剧、Task、Asset、Workflow、权限、支付、Provider 和数据库始终属于平台内核；主题不能复制、替换或直接访问这些实现。

## 新增主题

1. 在 `web/src/themes/<theme-id>/` 创建 `manifest.ts`、`theme.module.css` 和 `index.ts`。Manifest 使用 `defineVozebTheme()`，目录入口使用 `defineVozebThemeBundle()` 把 Manifest 与 CSS Module 根样式绑定为一个主题包。
2. 在 `registry.ts` 静态导入该目录入口，并把 Bundle 加入唯一的 `themeBundles` 清单。主题选择器、模板、运行时样式和构建期校验都会从这一个清单读取，不再分别维护主题 ID；页面模板 ID 必须在整个注册表内唯一。
3. 样式通过 `[data-site-block="site.hero"]` 等稳定插槽定制展示，不依赖其他主题的哈希类名。
4. 模板区块只能引用 `site-block-registry.ts` 中 `siteBlock: true` 的稳定平台区块。
5. 运行主题契约测试、类型检查和生产构建。

```ts
import styles from "./theme.module.css";
import { defineVozebThemeBundle } from "../theme-contract";
import { studioThemeManifest } from "./manifest";

export const studioThemeBundle = defineVozebThemeBundle({
    manifest: studioThemeManifest,
    runtimeClassName: styles.root,
});
```

```ts
// manifest.ts
import { defineVozebTheme } from "../theme-contract";

export const studioThemeManifest = defineVozebTheme({
    id: "studio",
    name: "Studio",
    version: "1.0.0",
    author: "Your Team",
    description: "适合创作工作室的公开首页。",
    minAppVersion: "0.0.8",
    tokens: {
        primary: "#111111",
        background: "#f6f5f2",
        surface: "#ffffff",
        text: "#18181b",
        muted: "#71717a",
        font: "modern",
        radius: "soft",
        contentWidth: "wide",
        spacing: "comfortable",
    },
    templates: [
        {
            id: "home",
            name: "首页",
            description: "标准创作平台首页。",
            path: "/",
            regions: [
                { id: "header", name: "页头", required: true },
                { id: "main", name: "主内容", required: true },
                { id: "footer", name: "页脚", required: true },
            ],
            blocks: [
                { componentId: "site.header", region: "header" },
                { componentId: "site.hero", region: "main" },
                { componentId: "agent.entry", region: "main" },
                { componentId: "site.footer", region: "footer" },
            ],
        },
    ],
});
```

## 安全边界

- 主题清单不能包含 HTML、CSS 字符串、JavaScript、远程脚本、函数或数据库查询。
- 主题只控制设计 Token 和构建期样式，切换主题必须保留当前模板和区块；模板只控制受控区块结构，套用模板必须保留当前视觉主题。
- 内置 `creative-home` 是当前 VOZEB PRO 紫蓝品牌首页的默认模板，管理员套用其他模板后仍可一键恢复。
- 仓库内经过审查和构建的主题可以拥有 CSS Module；CSS 只能改变展示，不应隐藏登录、安全、法律或付费确认等必要界面。
- 主题链接由区块契约限制为站内路径或锚点。
- v0.0.8 内置主题只保留 `vozeb`，即首次安装时的 VOZEB PRO 原始首页；未知主题 ID 自动回退该主题，不会影响平台功能和已保存内容。开发者仍可按本契约在源码中新增经过审查与构建的主题。
- 未知模板 ID 自动回退内置 `creative-home`，不会执行未知区块或远程代码。
- 模块停用后，服务端会从公开页面过滤对应功能区块；主题不能绕过模块或套餐权限。
- 可安装第三方代码包不属于 v0.0.8 范围。未来若开放，必须先增加签名、版本兼容、依赖审计和隔离构建，禁止直接执行上传脚本。
