# Web 应用

该目录包含星启智域主应用，包括用户创作工作台、Canvas、短剧项目、管理后台、Route Handler、身份认证、服务端存储和生成任务 Worker。

## 本地开发

```bash
pnpm install
pnpm dev
```

## 生产构建

```bash
pnpm build
pnpm start:standalone
```

构建脚本先在独立进程中执行严格 TypeScript 检查，再运行 Next.js 构建。默认使用 Node.js 与 Next.js 的可用资源策略；只有部署环境确有资源限制时才显式设置 `NEXT_BUILD_CPUS` 或 `NODE_OPTIONS`。

## 服务端数据

PostgreSQL 或 JSON Provider 保存用户会话、Canvas、短剧、素材、工作台记录、生成任务和 Agent 事件。图片、视频与音频写入 `VOZEB_PRO_DATA_DIR`；Docker 部署必须持久化该目录，并与数据库一起备份。
