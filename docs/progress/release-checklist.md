# VOZEB PRO 发布检查清单

页面、API Service、Route Handler、服务层、持久层与 E2E 的对应关系见[页面与接口证据矩阵](./page-api-evidence.md)。

发布前先在 `web` 目录执行：

```bash
pnpm run check:release
```

该命令会检查 Prettier、TypeScript、隔离生产构建、补丁空白，以及 `.data`、`.next`、`node_modules` 等运行时文件是否被误提交。

## 手动页面检查

- 桌面端：首页、统一创作 Agent、画布、短剧、提示词库、素材库、管理员后台。
- 手机端：首页导航、统一创作 Agent、画布顶部工具、积分弹窗、短剧生成记录、管理员生成日志、日期选择器。
- 深浅色：首页、画布、弹窗、勾选框、生成中状态、后台表格。

## 数据安全

- 不提交 `web/.data`、`web/.next`、`web/node_modules`、`web/tsconfig.tsbuildinfo`。
- 数据库导入前会保存当前快照，导入快照只保留最近 3 份。
- 管理员密码重置前会备份 `auth.json`，密码重置备份只保留最近 3 份。
- 升级 Docker 镜像时不要执行 `docker compose down -v`。

## 错误提示

- 面向用户的接口错误使用中文。
- 不在错误提示中暴露 API Key、完整 Base URL、服务器内部路径或代理细节。
- 默认渠道连接失败时提示检查 Base URL、服务器网络、DNS、HTTPS 证书或代理配置。

## GitHub 发布

- Release 只记录 VOZEB PRO 当前版本的真实变更。
- Release 标题使用 `VOZEB PRO v版本号`，例如 `VOZEB PRO v0.0.6`。
- README 首页不写更新列表，只保留 GitHub Releases 入口。
- 版本更新后同步 `VERSION`、`web/package.json`、README、docs 首页、CHANGELOG 和 README 截图。
