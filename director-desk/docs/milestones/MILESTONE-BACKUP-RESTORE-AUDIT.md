# 本地副本与恢复能力审计

审计日期：2026-07-17

## 副本盘点

- `/Users/mm/Documents/3D导演台-backups/20260713-before-camera-templates`：约 73 MB。
- `/Users/mm/Documents/3D导演台-backups/20260715-before-v03-development`：约 80 MB。
- 7 月 15 日副本明确记录基准提交 `e6ea123e0d7fdeed906358be724ef963f066e787`，备份范围包含源码、配置、测试、本地模型资源和当时未提交改动。
- 副本按设计不包含 `.git`、`node_modules`、`dist` 和研究临时目录，避免把缓存伪装成可恢复源码。

## 完整性证据

- 7 月 15 日副本包含 128 个源码文件。
- `public/local-assets` 包含 963 个文件，包括 Camille、XBot、Soldier、Robot Expressive、6 个 Mixamo 动作和本地道具/场景资源。
- `baseline-evidence` 包含 16 张运行时问题与修复证据图。
- `package.json`、`package-lock.json`、`src/App.tsx`、`DirectorCanvas.tsx` 和 `README.md` 均可计算稳定 SHA-256，没有空文件或损坏迹象。
- `BASELINE.md` 记录了版本、基准提交、备份范围、已知问题和不覆盖当前工作目录的恢复步骤。

## 独立恢复演练

为避免修改原备份，本轮把 7 月 15 日副本复制到临时目录，并复用当前兼容的 `node_modules` 只读依赖执行：

```bash
./node_modules/.bin/vitest run
npm run build
```

结果：

- 53 个测试文件、457 项测试全部通过。
- TypeScript 与 Vite 生产构建通过。
- 产物主 JavaScript 约 1.63 MB，与副本 `BASELINE.md` 的记录一致。
- 只有当时已经记录的大 chunk 警告。

## 当前 Git 状态

- 当前分支仍是 `codex/mixamo-wasd-audit`。
- HEAD 仍是 `e6ea123`，同时也是 `origin/main` 和标签 `before-mixamo-wasd-audit-20260713`。
- 当前开发内容仍只在本地工作树中，未提交、未推送、未同步 GitHub 或在线版。
- 恢复旧副本时必须复制到新目录，不得覆盖当前含未提交改动的项目目录。
