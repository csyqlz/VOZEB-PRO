# 自动化流程

该目录保存 VOZEB PRO 的 GitHub Actions 工作流，用于提交质量检查和多架构容器镜像发布。

- `quality.yml`：检查主应用与文档站的格式、类型、测试、构建和发布条件。
  - 独立检查：`Web / typecheck`、`Web / lint`、`Web / test`、`Web / build`，分别运行 `web/package.json` 中的同名脚本；一个失败不取消其他检查。
  - 使用 Node.js 22、pnpm 11.9.0 和 `pnpm install --frozen-lockfile`。四项检查只有 `contents: read`，不引用部署 secrets、不持久化 checkout 凭据；PR 使用 `pull_request`，不用 `pull_request_target` 执行提交方代码。
  - 保留现有 `web`、`docs`、`security` 综合门禁，包括依赖审计、浏览器与 PostgreSQL 钱包幂等测试、Gitleaks 和 CodeQL。四项基础检查暂时会与 `web` 重复，避免平台必需检查尚未调整时削弱旧门禁。
- `docker-image.yml`：构建并发布主应用多架构镜像。
- `docs-docker-image.yml`：构建并发布文档站多架构镜像。

`main` 分支用于持续集成，`v*` 标签用于正式版本镜像发布。

## 必需检查清单（待管理员在平台核对）

工作流文件不能代替分支保护。本次只提供清单，不修改 GitHub Rulesets 或 Branch protection，也不声称已经阻止合并。

- 在正常测试 PR 中确认四个 `Web / ...` 检查均出现且成功，再从平台实际显示的检查名称选择必需检查。
- 保留现有 `web`、`docs`、`security` 及平台已有的其他必需检查；不得因为新增四项就移除安全、资金、浏览器门禁。
- 在单独测试分支新增 `web/src/t01-ci-negative-fixture.ts`，内容为 `export const t01ExpectedNumber: number = "intentional-type-error";`。确认 `Web / typecheck` 因 TS2322 失败，其他三项仍得到各自状态。`build` 自带类型检查，也可能因此失败，这不是取消执行。
- 删除该故意错误，再确认同一个 PR 四项恢复正常。远程未实际运行时必须标记“未验证”；本地反例不能代替 GitHub 检查或合并阻断证据。
- fork PR 不提供仓库/环境 secrets；不要为使检查通过开启写 token、改用 `pull_request_target` 或批准运行带秘密的 fork 代码。现有安全扫描专用 job 的权限不扩散到四项检查。
- 平台必需检查配置及允许合并的规则另行审批；配置后还需验证类型错误 PR 确实不能合并。

## 本地与回滚门禁

在不含生产 `.env`、真实渠道配置和生产数据库连接的隔离副本内，从 `web/` 运行：

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm run typecheck
corepack pnpm run lint
corepack pnpm run test
corepack pnpm run build
```

本地构建依照当前任务授权和 AGENTS.md 执行；不要因为编辑工作流就启动发布。默认测试使用 mock / 本地 TCP fixture，真实 PostgreSQL 集成仅指专用测试库。保持既有手动必跑门禁：`audit:release`、`format:check`、`e2e`、质量工作流 `PostgreSQL integration tests` 步骤的四个文件（包括 `points-wallet-idempotency.postgres.test.ts`，使用 `--no-file-parallelism`），以及现有 Gitleaks/CodeQL 安全扫描。审计或资金测试失败不能忽略后继续合并。

本卡不改变业务数据或 schema，数据迁移与 feature flag 不适用。回滚仅移除新增四项 job 及对应契约/文档，不删除原有综合门禁，不改安全和计费守卫。若平台已将新检查设为必需，回滚后应保持合并受阻，直到管理员另行批准等效门禁调整；不得自行放宽分支保护。回滚期间仍执行上述手动门禁并留存证据。
