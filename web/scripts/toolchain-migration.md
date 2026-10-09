# 本地工具链维护

本项目保留原有全量依赖审计、Next ESLint 规则和 UI 样式。这次工具链迁移由项目维护，不代表上游已经发布安全修复，也不添加审计豁免。

## shadcn 样式来源

`src/app/styles/shadcn-tailwind.css` 来自 [shadcn@4.16.2 官方 npm 包](https://registry.npmjs.org/shadcn/-/shadcn-4.16.2.tgz) 的 `dist/tailwind.css`，按官方 eject 方法保留完整内容后移除 CLI 开发依赖。它仍在 `globals.css` 的原位置导入，位于 Tailwind 与动画库之后、基础样式之前；现有 UI 组件仍使用完整的 data variants、keyframes 和 utilities。

原始 CSS 为 16,041 字节，SHA-256 为 `bc7d83425702955b4cb67cb14ede9d603f9d912376d57a2d81d661094d2a782a`；仓库仅作 Prettier 机械格式化。完整 MIT 许可与 `(c) 2023 shadcn` 版权声明独立保存在同目录的 `shadcn-tailwind.LICENSE.md`，原件 SHA-256 为 `1564074e13439397221ffd522e2e504d56561994a23d371aa5e3ad43e4f5423f`。根许可证清单只列运行时包，不替代这份复制源码许可。

以后需要更新这些样式时，应取得明确版本的官方包，保留完整许可、比较来源差异、更新完整性测试，并完成受影响桌面流程的深浅主题真实 UI 回归；重新安装依赖不会自动更新这份本地 CSS。

## Next ESLint 局部补丁

`patches/@next__eslint-plugin-next@16.3.0.patch` 只针对官方 `@next/eslint-plugin-next@16.3.0` 的 `dist/utils/get-root-dirs.js`。其原始文件 SHA-256 为 `886677432990a735e5ebdfb345ff1cbd40e264f9947a8432eeeb254b3a926bde`。完整插件及其 MIT 许可继续由官方包安装，不复制或删减任何规则。

`pnpm-workspace.yaml` 将该精确包的 `fast-glob` 依赖移除，并为该精确包增加固定的 `glob@13.0.6` 和 `minimatch@10.2.6`。局部源码补丁使用 glob 的公开 `raw` 导出和 minimatch 的 braceExpand，让实际扫描使用锁文件中的外置依赖。扫描以目录后缀限定目录并跟随符号链接；必要的路径规范化保留相对/绝对形式、显式 `./`、Windows 分隔符和输入尾斜杠，并按 brace 分支顺序返回去重结果。没有全局 alias、通用自制扫描器或其他包的 API 替换。pnpm 11 使用 `patchedDependencies` 固定该补丁，补丁未命中或冻结安装不一致都应阻断。

`toolchain-migration.test.mjs` 在独立 Node fixture 中验证当前安装的补丁字节、20 个目录扫描案例和20 个完整 lint 诊断，严格检查40/40及零失败、取消、跳过；目录 fixture 改变工作目录，因此继续隔离运行。完整规则用例直接调用共享 `toolchain-rules-check.mjs`，实际计算项目 ESLint 配置并验证全部 113 个规则的名称/严重级别哈希（其中 Next 为 22 个），保留既有默认测试预算，省去另一层 Node 测试进程与 TAP 包装。独立 `toolchain-rules-fixture.mjs` 仍调用同一校验，支持1/1单独复核。期望来自迁移前官方锁定插件的实际输出，绝对路径只在本次独立 fixture 内动态构造，最终回归不保留 fast-glob 基线依赖。既有 nested App、group/intercepted 案例的零诊断也保持原结果；这次迁移没有改写路由规则。执行依赖树变化后必须重新运行该真实回归，不能用源码静态断言或临时安装树的结果代替。

升级 Next ESLint 时，必须重新核对实际版本和原始扫描源码、消费扫描结果的完整规则，以及包的实际依赖图，再更新精确补丁与配置。需要在真实目录中比较相对和绝对根目录、数组、monorepo 通配符、brace/extglob、dot 目录、符号链接、Windows 分隔符、重复与顺序，并验证真实内部链接拒绝和既有允许项、完整规则名称与 severity。不能只更新版本号、放宽规则或忽略补丁失败。

Docker 安装阶段先复制 `web/patches`，再执行冻结安装。更新配置或补丁后，以正常包管理器生成锁文件，并重新冻结安装；使用 `pnpm why braces`、`pnpm why micromatch`、`pnpm why fast-glob` 核实际可达路径，再执行原全量官方审计：

```sh
pnpm audit --registry https://registry.npmjs.org/ --audit-level moderate
```

只有实际目录与 lint 兼容性、冻结安装、全量审计、类型、lint、格式、测试、构建和浏览器回归全部通过后，才能发布该工具链变更。
