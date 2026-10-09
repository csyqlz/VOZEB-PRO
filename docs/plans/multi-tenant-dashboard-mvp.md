# VOZEB PRO：看板、多租户与后台管理员系统最小 MVP 方案

状态：已完成架构与对抗性评审，不包含业务代码实现。

## 1. 目标与关键假设

本方案把“看板”理解为经营/用量数据仪表盘，而不是可拖拽的任务 Kanban。如果目标是任务 Kanban，需要另行增加 board、column、card、assignee 和排序模型，不应和本方案混为一项。

项目当前已经有平台级后台、经营看板、管理员职责权限、用户管理、生成运维、财务、内容治理、审计写入和 PostgreSQL Repository。MVP 不重写这些能力，只补齐租户控制面。

推荐的最小边界：

- `/admin` 保持平台后台，`users.role = admin` 只代表平台管理员。
- 新增租户 `tenant` 与租户成员关系 `tenant_membership`。
- MVP 中每个账号只能属于一个租户；数据库以 `UNIQUE(user_id)` 固化，不提供跨租户迁移。
- 租户角色固定为 `owner | admin | member`，不做自定义 RBAC。
- 用户现有 Canvas、短剧、素材、会话和生成记录继续按 `user_id` 私有；租户管理员只能看成员列表、租户聚合看板和租户管理审计，不能查看成员具体创作内容。
- 模型渠道、API Key、对象存储、商品、支付渠道和站点配置仍由平台统一管理。
- 多租户生产模式只支持 PostgreSQL；file Provider 仅保留本地单机体验。

这个边界可以构成安全、可演示、可验收的多租户 SaaS MVP，同时避免一次性改造数十个生成、媒体、Canvas、短剧和 Worker 数据路径。

## 2. 已验证基线

仓库：`https://github.com/csyqlz/VOZEB-PRO.git`

基线提交：`3573154a12bab922c132df0159787cbe430eee17`

本地验证结果：

- Node.js `v22.23.2`、pnpm `11.19.0`、Docker `29.7.2`、Compose `v5.4.0` 可用。
- `pnpm install --frozen-lockfile` 成功。
- 使用 file Provider 启动开发服务成功，`GET /api/health/live` 返回 200。
- 完成首个管理员创建，`POST /api/auth/register` 返回 200。
- `GET /api/health/ready` 返回 200，App、加密配置与 Generation Worker 均为 ready/healthy。
- 管理员登录成功，`GET /admin` 返回 200，并包含现有后台导航。
- `pnpm typecheck` 通过。
- Vitest 全量基线：547 个测试文件通过、4 个跳过；2651 项测试通过、9 项跳过。

本地启动时还发现一个 Windows 细节：默认 Worker ID 会包含中文计算机名，作为 HTTP Header 时触发 ByteString 错误。使用已有环境变量 `VOZEB_PRO_GENERATION_WORKER_ID=local-dev-worker` 后 Worker 正常。该问题不属于本 MVP 方案，本次未修改源码。

## 3. 可直接复用的现有能力

| 能力            | 现有落点                                                                        | MVP 做法                                                    |
| --------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 平台后台入口    | `web/src/app/admin/page.tsx`                                                    | 保留 `/admin`，不另起一套平台后台                           |
| 后台导航/分区   | `web/src/components/admin/admin-sections.ts`、`admin-dashboard.tsx`             | 增加“租户管理”“审计日志”分区                                |
| 经营看板        | `web/src/components/admin/admin-overview.tsx`                                   | 平台看板原样保留；租户看板复用 `Panel`、`Metric` 和图表原语 |
| 平台 RBAC       | `web/src/lib/admin-permissions.ts`                                              | 增加 `tenants.read`、`tenants.manage`，仍只授予平台管理员   |
| 用户管理        | `web/src/app/api/admin/users`、`web/src/lib/server/database/user-repository.ts` | 平台继续全局；租户后台使用独立受限 API                      |
| Session         | `web/src/lib/auth/session.ts`                                                   | 复用登录态，通过 membership 解析唯一租户                    |
| 聚合查询        | `generation-overview-service.ts`、`content-repository.ts`                       | 增加按 tenant membership 聚合的独立方法                     |
| 审计            | `audit-log-store.ts`、`audit-log-repository.ts`                                 | 增加 `tenant_id/scope`，新建平台/租户审计 UI                |
| 参数化 SQL/事务 | `web/src/lib/server/database/`                                                  | 继续使用 Repository 与事务，不在 Route Handler 写 SQL       |

当前源码中未发现 `tenant_id`、`tenantId`、`organization_id`、`currentTenant` 或 membership 等租户标记，因此项目目前仍是“用户级隔离 + 平台后台”，不是多租户系统。

## 4. MVP 功能范围

### 4.1 平台管理员

在现有 `/admin` 中增加：

- 租户列表：名称、slug、owner、活跃成员数、近 7 日调用量。
- 创建租户，同时创建或指定一个全新 owner 账号。
- 修改租户名称。
- 平台审计列表：租户创建、改名，以及租户管理员的高风险操作。

不提供租户暂停、物理删除、合并、成员跨租户迁移和平台管理员无痕代入租户。租户暂停只有在所有普通写接口、Worker claim、Webhook、重试与在途任务都绑定租户后才安全，因此不属于本 MVP。

### 4.2 租户控制台

新增 `/team`，只包含三个分区：

1. 租户看板。
2. 成员管理。
3. 租户审计。

租户看板最小指标：

- 成员总数、活跃成员、owner/admin 数量。
- 近 7 日调用量、成功量、失败量、成功率、活跃创作者。
- 每日调用趋势。
- 模型、入口、生成类型分布。

指标口径固定为：

- 时区使用站点配置时区；默认 `Asia/Shanghai`。日期窗口采用左闭右开区间，近 7 日指含当天在内的 7 个自然日。
- “成员总数”统计永久保留的 membership；“活跃成员”只统计 `membership.status = active` 且用户账号可登录的成员。
- 调用量、成功量和失败量按窗口内生成日志统计；成功率为 `成功量 / (成功量 + 失败量)`，无完成记录时显示 `—`，不伪造为 0%。
- “活跃创作者”是窗口内至少产生一次生成调用、并且当前 membership 与用户账号均为 active 的去重用户数。已禁用成员的历史调用仍计入租户历史调用量，但不计入活跃成员或活跃创作者。
- 所有图表与指标必须来自同一个数据库快照口径，并在 API 响应中返回 `timezone`、`startAt`、`endAt`，防止前后端边界不一致。

不展示收入、租户余额和企业账单，因为当前计费模型以用户为归属；将这些指标提前展示会制造错误财务口径。

### 4.3 成员管理

- `owner`：全部租户权限，不能被其他角色移除或降级。
- `admin`：看板、成员管理、租户审计；不能操作 owner。
- `member`：使用现有创作工作区，不能访问 `/team` 管理分区。
- 为保持 MVP 简单，owner/admin 只能创建一个新的普通账号并加入本租户，不能拉入已有账号，不能把成员迁移到其他租户。
- 创建成员时绝不允许设置 `users.role=admin` 或写入 `admin_permissions`。
- 成员账号由 owner/admin 设置初始密码，数据库只保存 password hash；页面不回显、不记录明文密码，并提示成员首次登录后主动修改密码。统一的强制首次改密网关不在本 MVP 内，避免只增加字段却遗漏业务 API Gate。
- membership 不物理删除，只能改为 `disabled`。这样历史日志通过 membership 聚合时仍有稳定租户归属。

### 4.4 明确不进入 MVP

- 一个账号加入多个租户和租户切换器。
- 团队共享 Canvas、短剧、会话、素材库或媒体。
- 租户独立模型渠道、API Key、对象存储、域名、主题、商品、支付和发票。
- 租户自定义权限编辑器。
- SSO、SAML、SCIM、域名验证。
- 租户物理删除、合并、owner 转移、用户/历史数据跨租户迁移。
- 租户暂停/恢复。
- 租户 owner/admin MFA 扩展；公网生产前应作为紧接 MVP 的安全加固项完成。
- 实时 BI、数据仓库和自定义报表。

## 5. 数据模型

### 5.1 `tenants`

```sql
CREATE TABLE tenants (
    id text PRIMARY KEY,
    slug text NOT NULL,
    name text NOT NULL,
    owner_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX tenants_slug_lower_idx ON tenants (lower(slug));
```

### 5.2 `tenant_memberships`

```sql
CREATE TABLE tenant_memberships (
    tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role text NOT NULL,
    status text NOT NULL DEFAULT 'active',
    created_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id),
    UNIQUE (user_id),
    CONSTRAINT tenant_memberships_role CHECK (role IN ('owner', 'admin', 'member')),
    CONSTRAINT tenant_memberships_status CHECK (status IN ('active', 'disabled'))
);

CREATE INDEX tenant_memberships_tenant_status_idx
    ON tenant_memberships (tenant_id, status, role, user_id);

CREATE UNIQUE INDEX tenant_memberships_single_active_owner_idx
    ON tenant_memberships (tenant_id)
    WHERE role = 'owner' AND status = 'active';
```

业务事务必须保证：

- `tenants.owner_user_id` 对应同租户的 active owner membership。
- 租户始终恰好一个 owner。
- owner 不能自降级、禁用、删除或注销。
- 禁用成员时撤销该用户全部 Session，但永久保留 disabled membership 和历史聚合归属。
- 所有 owner/member 变更先对 tenant 行执行 `SELECT ... FOR UPDATE`，再检查 owner、更新 membership、写审计并提交；部分唯一索引保证并发下至多一个 active owner，事务服务保证至少一个 owner。必须用真实 PostgreSQL 并发测试验证。
- 平台硬删除、用户注销和数据生命周期清理不得物理删除任何 tenant membership；MVP 对租户关联账号只允许禁用。正式账号删除与法定保留流程另行设计。

### 5.3 审计扩展

给 `audit_logs` 增加 nullable `tenant_id`、`scope = platform | tenant`、`actor_tenant_role` 和 `(tenant_id, created_at DESC)` 索引。

成员创建、角色变更、禁用和租户改名必须把业务变更与审计写入放在同一事务；这类高风险操作不能使用现有 fail-open 的 `safeRecordAuditLog()`。

### 5.4 为什么 MVP 不给全部业务表加 `tenant_id`

MVP 的租户只管理账号集合和聚合指标，业务资源仍属于唯一用户。查询路径为：

```text
tenant_id
  → tenant_memberships.user_id
  → generation_logs / generation_tasks / users
```

普通创作 API 继续使用现有 `user_id` 所有权检查；租户管理员不获得读取成员 Canvas、素材或媒体的能力。因此在“一账号一租户、不可迁移”的约束下，不会把同一份用户数据归到多个租户。

一旦需要账号跨租户、团队共享资源或租户级计费，必须进入第 10 节的完整租户化，不得继续靠 membership join 拼接。

## 6. 安全边界

1. `users.role = admin` 永远只表示平台管理员；租户 admin 只存在于 `tenant_memberships.role`。
2. `/api/admin/*` 继续检查现有平台 RBAC；租户管理员调用一律 403。
3. 租户 API 从当前 Session 用户反查唯一 active membership；不接受 body/query/header 中的 tenant ID 作为权威范围。
4. 所有租户级 SQL必须显式包含 `tenant_id`，所有成员级 SQL同时包含 `tenant_id + user_id`。
5. 租户管理员只能获取聚合值和成员公开身份，不返回成员提示词、生成结果、媒体 URL、订单、余额或私有项目。
6. 不允许通过把租户 admin 提升为平台 admin 来复用现有后台。当前部分媒体路由对 `users.role=admin` 存在全局旁路，这样做会直接造成跨租户读取。
7. 多租户模式下必须使用 PostgreSQL；file Provider 不作为生产隔离边界。
8. 租户 slug、名称、分页、排序和筛选均在 HTTP 边界做 schema 校验；唯一性由数据库保证。
9. 跨租户真实 ID 的 GET/PATCH/DELETE 统一返回 404，避免泄露资源存在性。
10. 平台支持人员如未来需要查看租户内容，必须另做限时、填写原因、强审计的 break-glass 流程，MVP 不提供。

功能开关统一命名为 `VOZEB_PRO_TENANT_MVP_ENABLED`，默认 `false`。发布顺序必须是“先部署 Schema 与兼容代码（开关关闭）→ 初始化并验证约束/备份 → 确认普通账号均有 membership → 开启入口与写 API”。开关关闭时租户 API 返回 404，普通账号创建流程不创建 membership，登录也不执行 membership Gate；因此本 MVP 只支持全新安装，或由运维先完成既有普通账号的一次性租户回填。开关首次承载真实租户后不能再作为回滚手段关闭，否则 disabled membership 将失去登录 Gate；只能前滚修复或恢复启用前的整库快照。生产已有真实租户后，禁止部署完全不识别 membership 的旧版本。

## 7. 分阶段实施计划

### Step 0：先写失败测试和边界契约

上下文：先把租户隔离规则固定为可执行测试，防止后续为了复用现有 admin 逻辑而错误扩大权限。

任务：

- 新建 `tenant-permissions.test.ts`、`tenant-context.test.ts`、`tenant-repository.test.ts`。
- 新建 Route 测试，覆盖平台 admin、tenant owner/admin/member 和跨租户请求。
- 新建 PostgreSQL 集成测试夹具，创建 tenant A/B 及真实成员/生成日志。

验证：测试应先因模块不存在而失败，并明确失败原因。

退出标准：测试矩阵涵盖权限、聚合隔离、owner 不变量、平台/租户角色分离；计划新增模块覆盖率至少 80%。

回滚：仅新增测试，无运行时影响。

### Step 1：租户 Schema、类型与 Repository

主要文件：

- `web/src/lib/server/database/schema.ts`
- `web/src/lib/server/database/postgres.ts`
- `web/src/lib/server/database/repository-types.ts`
- `web/src/lib/server/database/repositories.ts`
- 新增 `web/src/lib/server/database/tenant-repository.ts`
- `web/src/lib/auth/store-types.ts`
- `web/src/lib/auth/store-normalizers.ts`
- `web/src/lib/auth/store-repository.ts`
- `docs/content/docs/backend/backend-database.mdx`

任务：

- 新增 `tenants`、`tenant_memberships` 和索引/约束。
- 把新表、索引、触发器加入项目 PostgreSQL 前缀清单。
- Repository 提供按租户分页成员、汇总成员、创建/改名租户和事务内管理成员。
- file Provider 只支持单个本地租户，用于现有测试和本地体验；多租户生产开关遇到 file Provider 直接启动失败。
- 因项目尚未上线，直接按新设计初始化空数据库，不写旧数据回填、双写或兼容迁移。

验证：Schema 连续初始化两次幂等；唯一用户 membership、唯一 slug、owner 约束和并发创建均有真实 PostgreSQL 测试。

退出标准：租户 Repository 全绿，现有 Schema/Repository 测试不回归。

回滚：首次启用前可回滚提交并重建开发数据库；首次启用并承载真实成员后不再关闭开关，只能前滚修复或恢复启用前整库快照，不自动 DROP 数据。

### Step 2：租户上下文、权限与账号生命周期

主要文件：

- 新增 `web/src/lib/tenant-permissions.ts`
- 新增 `web/src/lib/server/tenant-context.ts`
- 新增 `web/src/lib/server/tenant-service.ts`
- `web/src/lib/auth/store-user-access.ts`
- `web/src/lib/auth/session.ts`
- `web/src/lib/server/page-access.ts`
- `web/src/stores/use-user-store.ts`

任务：

- 定义不可变 `TenantContext`，集中解析当前用户唯一 active membership。
- 首个平台注册用户只创建平台管理员，不自动获得全局租户权限。
- 普通公开注册创建个人 tenant + owner membership；租户管理员创建成员时创建普通用户 + 当前 tenant membership。
- 新增 `requireTenantMember()`、`requireTenantRole()`，Route Handler 不自行拼角色判断。
- 创建用户、tenant 和 membership 必须在同一 PostgreSQL 事务。不能调用当前自带事务的高层 `createUser()` 后再补 membership；应抽出接收现有 `QueryExecutor` 的低层建号函数，避免嵌套事务和半成品账号。
- 初始密码只进入服务端 password hash 流程，不写日志、审计 metadata 或 API 响应；统一强制首次改密作为下一阶段认证安全加固项。
- 成员禁用时撤销 Session；disabled membership 永久保留。平台删除用户和注销申请对 tenant 关联账号返回明确冲突，MVP 只允许禁用。

验证：平台 admin 与 tenant admin 权限不互相继承；tenant A 管理员无法定位 tenant B 成员；member 无权进入租户后台。

退出标准：认证、注册、Session、平台管理员权限现有测试与新增跨租户测试全绿。

回滚：首次启用前可保持开关关闭；启用后普通账号登录依赖 membership Gate，不能通过关闭开关回滚。

### Step 3：平台后台增加租户管理与审计

主要文件：

- `web/src/lib/admin-permissions.ts`
- `web/src/components/admin/admin-sections.ts`
- `web/src/components/admin/admin-section-nav.tsx`
- `web/src/components/admin/admin-dashboard.tsx`
- 新增 `admin-tenants-section.tsx`、`admin-audit-section.tsx`
- 新增 `web/src/app/api/admin/tenants/**`
- 新增 `web/src/services/api/admin-tenants.ts`

任务：

- 增加平台权限 `tenants.read`、`tenants.manage`。
- 在现有 `/admin` shell 中按需加载“租户管理”和“审计日志”。
- 支持租户列表、创建、改名。
- 平台列表仅展示租户元数据与聚合，不默认读取成员私有内容。

验证：只读权限不能写；无权限分区不可见且 API 返回 403；新分区不被后台首屏空闲预加载。

退出标准：平台管理员可完成租户生命周期最小闭环，所有动作带脱敏审计。

回滚：首次启用前可保持租户 API 关闭；启用后使用前滚修复或恢复整库快照，不再关闭 membership Gate。

### Step 4：租户看板与成员管理控制台

主要文件：

- 新增 `web/src/app/(user)/team/page.tsx`
- 新增 `web/src/components/team/team-console.tsx`
- 新增 `team-overview.tsx`、`team-members.tsx`、`team-audit.tsx`
- 新增 `web/src/app/api/team/overview/route.ts`
- 新增 `web/src/app/api/team/members/**`
- 新增 `web/src/app/api/team/audit-logs/route.ts`
- 新增 `web/src/services/api/team.ts`
- `web/src/lib/server/generation-overview-service.ts`
- `web/src/lib/server/database/content-repository.ts`
- `web/src/lib/server/database/user-repository.ts`

任务：

- 新增一次有界 PostgreSQL 聚合查询，按 `tenant_memberships` 限定 user IDs 后统计 7 日数据；禁止读整张日志表到 Node.js 再过滤。
- 复用现有 `Panel`、`Metric` 与必要图表原语，不复制整个 `/admin`。
- 成员新增、角色修改、禁用使用 Modal/Drawer，页面文案保持中文。
- 租户审计 API 强制使用 Session 解析出的 tenantId，忽略并拒绝客户端覆盖。

验证：A 租户产生数据后 A 看板增长、B 不变；owner/admin 可进入，member 拒绝；桌面、390px、430px 和浅深主题无横向溢出。

退出标准：看板、成员、审计三个分区形成可演示闭环，空状态、加载、失败状态完整。

回滚：隐藏 `/team` 菜单与路由，保留租户/审计数据。

### Step 5：全链路隔离验收、备份契约与发布门禁

新增 `web/e2e/tenants.spec.ts`，至少覆盖：

1. 安装并创建平台管理员。
2. 创建 tenant A/B 及 owner/admin/member。
3. A admin 只能看到 A 成员。
4. A/B 分别产生生成日志，两个看板数值独立。
5. member 访问 `/team` 被拒绝。
6. tenant admin 访问 `/api/admin/*` 被拒绝。
7. owner 保护、成员禁用和 Session 撤销。
8. 平台管理员查看全局租户列表与审计。
9. 业务备份包含 tenants、memberships 与 tenant audit；恢复后重复隔离检查。

完整门禁：

```powershell
cd D:\CodexProjects\CodexWorkspaces\VOZEB-PRO\web
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
pnpm audit --prod

$env:VOZEB_PRO_E2E_DATABASE_URL='postgres://...专用测试库...'
pnpm e2e -- e2e/tenants.spec.ts --project=chromium
pnpm e2e -- e2e/tenants.spec.ts --project=mobile-390
pnpm e2e -- e2e/tenants.spec.ts --project=mobile-430
```

退出标准：新增/修改模块覆盖率不低于 80%；真实 PostgreSQL 双租户越权矩阵全绿；现有平台后台、创作、Canvas、短剧、素材、媒体和 Worker 回归通过。

回滚：启用第二个真实租户前做整库备份；一旦已有多租户数据，不允许直接回滚到无租户意识的旧后台，只能前滚修复或停机恢复启用前数据库快照。

## 8. 依赖关系与并行执行

```text
Step 0 测试契约
  └─ Step 1 Schema / Repository
       └─ Step 2 TenantContext / 账号生命周期
            ├─ Step 3 平台租户管理
            └─ Step 4 租户看板与成员管理
                 └─ Step 5 E2E、备份契约与发布门禁
```

Step 1、2 必须串行。Step 2 接口冻结后，Step 3、4 可并行；Step 5 等待二者接口稳定。公共文件 `schema.ts`、`postgres.ts`、`store-types.ts`、`repositories.ts`、`admin-sections.ts` 必须指定单一负责人。

## 9. 估算

单名熟悉项目的全职工程师，以现有测试基础为前提：

- Schema、Repository、权限上下文：2–3 个有效工程日。
- 平台租户管理：1–2 日。
- 租户控制台、看板、成员管理：2–3 日。
- 审计、生命周期保护与备份契约：1 日。
- PostgreSQL 集成、Playwright、文档和修复：1–2 日。

合计约 6–9 个有效工程日。估算不含租户管理员 MFA、真实模型供应商、支付商、生产监控和商业授权验收。

## 10. 升级为完整企业多租户的触发条件

出现以下任一需求时，必须停止沿用“一账号一租户 + 用户所有权”的 MVP 模型：

- 一个账号需要加入/切换多个租户。
- 租户成员需要共享 Canvas、素材、会话、短剧或媒体。
- 套餐、余额、用量、订单或发票归属租户。
- 租户需要独立模型渠道、对象存储或配置。

升级方案至少包含：

1. `sessions.current_tenant_id` 与不可变 `TenantContext`。
2. 所有工作区、生成、媒体、看板、审计和计费根表增加 `tenant_id NOT NULL`，user 只保留动作归因。
3. 子表复制 tenantId 并用 `(tenant_id, parent_id)` 复合外键阻止跨租户挂接。
4. Route/Service/Repository 显式携带 TenantContext，禁止可选 tenant 过滤器。
5. SQL 显式 `tenant_id = $n`，并使用 PostgreSQL `ENABLE/FORCE ROW LEVEL SECURITY` 做最后一道隔离。
6. RLS 上下文只能在同一连接事务内用 `SET LOCAL` 或 `set_config(..., true)` 绑定；禁止在连接池上使用普通 `SET`。
7. Worker/Webhook 按任务或订单中持久化的 tenantId 绑定执行上下文，不能使用用户当前 Session 租户。
8. 媒体对象 Key 与签名绑定 tenantId；客户端切租户时递增 tenant epoch 并清空 Zustand 业务状态，防止旧请求回写新租户。

这已不是 6–9 日 MVP，而是一次平台级数据所有权改造，建议单独立项和威胁建模。

## 11. 法务与发布说明

仓库 README 与 LICENSE 标明 BUSL-1.1，并单独提供商业授权说明。开发、本地评估和方案设计可继续；如果目标是商业 SaaS、收费服务或私有化交付，上线前必须向项目作者确认并取得适用的商业授权，不能把源码可见误解为可直接商业运营。
