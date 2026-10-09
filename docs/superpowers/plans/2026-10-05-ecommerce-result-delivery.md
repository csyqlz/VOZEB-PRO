# 电商图片交付与可选视觉质检实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 成图通过技术检查即可交付；模型视觉质检默认关闭，开启时仅给建议，连续编辑沿已交付的稳定结果继续。

**Architecture:** 使用既有管理员设置、Agent Run、图片任务和流水，不新增服务。每轮冻结 `qualityPolicy=disabled|advisory`，把技术检查与模型报告分开；关闭时没有模型调用，流水如实记录 `not_run`。公开状态和连续编辑只依据实际交付与技术证据，保留原商品锚点。

**Tech Stack:** TypeScript、Next.js、React/Ant Design、PostgreSQL/文件 Provider、Vitest、桌面 Chromium。

## Global Constraints

- 仅现有隔离测试分支与测试环境；不改生产、不 push、不创建 PR。
- 仅桌面验收，复用未变证据；不增加手机适配、固定等待或重试预算。
- 关闭质检不等于质检通过；禁止用虚构模型 ID 或伪造 `passed` 补角色。
- 原媒体解码、尺寸、蒙版保护、落盘、归属、父链和并发租约条件保留。
- 原已生成但被质检阻断的轮次复用原结果、任务和次数恢复，不再次提交图片模型。
- 公开文稿不含部署地址、服务器目录、数据库名、账号或真实会话身份。

## Task 1：管理员开关与冻结策略

**Files:** `web/src/lib/auth/store-{types,foundation,normalizers,repository}.ts`、`web/src/lib/auth/postgres-auth-settings-service.ts`、`web/src/lib/server/database/{schema,repository-types,repositories}.ts`、`web/src/app/api/admin/settings/route.ts`、`web/src/components/admin/admin-{upstream-sections,ecommerce-model-role-manager}.tsx`、`web/src/components/admin/channels/admin-channel-workspace{,-model}.tsx`、`web/src/lib/server/{agent-run-executor,ecommerce-edit-plan,ecommerce-edit-planner,ecommerce-generation-snapshot}.ts`。

**Interfaces:** 管理员稳定字段 `ecommerceVisualQualityCheckEnabled:boolean=false`；快照 `qualityPolicy?:"disabled"|"advisory"`；编辑计划 `modelRoles.qualityCheck:string|null`。分析、规划、生图角色继续必填，关闭时不解析 QA 路由。

- [x] 增加开关写入、权限、立即回读、删除渠道保持开关的失败用例。
- [x] 执行受影响设置测试，确认旧实现不能保存新开关。
- [x] 接通两套持久化映射、schema、后台开关和冻结策略。
- [x] nullable QA 同步 planner 原始/工具输出和冻结校验，缺 QA 模型也能完成主流程。
- [x] 运行设置、planner、executor 定向回归和类型检查；隔离 PostgreSQL 设置两项实际执行通过。

```ts
// Only the first creation uses current settings; resumes keep the stored policy.
// Already-started legacy tasks with no policy keep their legacy execution path.
const qualityPolicy = settings.ecommerceVisualQualityCheckEnabled
  ? "advisory"
  : "disabled";
const qualityCheckRole =
  qualityPolicy === "advisory"
    ? resolveEcommerceRoleCandidates(settings, "quality_check", "text")[0]
    : undefined;
```

## Task 2：技术检查、交付与连续编辑

**Files:** `web/src/lib/server/{ecommerce-quality-check,ecommerce-result-delivery,agent-run-execution,agent-run-public,agent-run-store,ecommerce-generation-trace}.ts` 及对应 `.test.ts`；`web/src/app/(user)/create/components/creative-messages.tsx` 及相关测试。

**Interfaces:** `checkEcommerceTechnicalResult(input):Promise<EcommerceResultTechnicalCheck>`；快照 `technicalCheck?:EcommerceResultTechnicalCheck`。`ecommerceResultDeliveryGate(technical,quality?)` 只允许技术失败/不可读阻断，模型报告只产生可选调整建议。

读取链路同步覆盖 `create-workbench-overview-service.ts` 和 PostgreSQL `content-repository.ts`：首页最近作品不能残留 `quality_check=passed` 的旧过滤条件。新策略按技术通过、图片执行完成和已交付读取，任一相关日志的技术失败、策略冲突或归属错误仍拒绝；旧无策略任务保持原语义。

- [x] 增加视觉误判不隐藏、默认关闭无伪造通过、技术失败仍阻断的公开投影失败用例。
- [x] 增加无 QA 的已交付结果可继承，错误归属、缺父链或技术失败仍拒绝的连续编辑失败用例。
- [x] 执行失败用例，固定症状。
- [x] 提取既有尺寸/保护检查，关闭 QA 时仍独立执行；开启时复用同份技术证据。
- [x] 技术通过后校验结果、登记资产并公开展示；模型报告保留实际状态与证据，不暂停或隐藏结果。
- [x] 记录冻结策略、技术状态和真实 QA/not_run 流水，连续编辑保留已交付父结果与原商品锚点。
- [x] 执行真实文件/runtime fixture，覆盖关闭、视觉误判、模型故障、技术失败和稳定任务恢复。
- [x] 修复首页文件/PG 读取的旧视觉过滤；相关单元 61 项、隔离 PostgreSQL 7 项均实际通过，拒绝缺技术、真实技术失败、冲突策略与跨用户记录。

```ts
const technical = await checkEcommerceTechnicalResult(input);
const gate = ecommerceResultDeliveryGate(technical);
// Publish assets and complete the Run before any visual model request.
// Advisory stores review_pending in the existing durable queue.
// The worker calls processAgentRunReview separately and CAS-freezes its report.
```

并发与恢复：任务完成、助手完成消息和 `review_pending` 调度在同一持久化边界提交，不能在交付后另写队列而留下崩溃空窗；保留当前 Worker 租约，交由原执行器释放。文件 Provider 的任务写入失败须补偿原消息。`reviewAttempts` 和原任务集合为 fencing 条件，报告与 `reviewed=true` 同次冻结。局部选区恢复按存储策略重新排队；生成 release 或验收启动 CAS 落空都不能吞掉未完成复盘。日志补偿只读取同归属 child/已冻结 Run 的证据，按旧 trace CAS 写入，不调用模型。建议到达后主标题和总体状态仍为已完成，建议卡独立显示。

## Task 3：SOP、测试发布与原结果恢复

**Files:** 本计划、既有商品生成 SOP、质量优化计划、分项验收记录、`CONTEXT.md`、todo/pending-test、CHANGELOG；原结果恢复使用私有定向工具，不加入真实身份到源码。

- [x] 补充 SOP 关键原则：模型结论不是图像事实，多个阶段一致也可能共同误判；用户确认用途不代表确认商品结构数量。
- [x] 固定差异 Spec/Standards 独立复审无剩余 must-fix；相关单元、真实 PostgreSQL、类型、Lint、格式、Web/Docs 构建及受影响桌面自动流程通过。
- [x] 应用与 Worker 同镜像测试发布，健康与新鲜 Worker 心跳已核验，保留回退镜像。
- [x] 管理员可选视觉质检开关两向保存、立即回读与重载均通过，最终关闭。
- [x] 授权原轮核验原字节、解码与技术证据后原子恢复交付、消息与流水；原 child、结果、上游身份与尝试不变，新增生图请求为零，只读复核与重复应用通过。
- [x] 部署后原会话显示已完成与参考建议；原图下载字节与原件一致，引用/移除正常，首页最近生成可见。引用加短编辑指令后发送可用，清空草稿与引用，未提交；血缘与继续编辑准入已核验。
- [ ] 用户业务验收：确认实际成图、体验与真实续写；本轮没有生成新的连续编辑图片。

固定 `fd4a541`：首页读取四文件增量前全量单元 3911 passed / 0 failed / 42 条件跳过；随后相关单元 61 passed / 0 failed，隔离 PostgreSQL 首页 7 passed / 0 failed / 0 skipped、设置 2 passed / 0 failed。类型、Lint、格式与 Web/Docs 构建均 exit 0；受影响桌面浏览器 6 passed / 0 failed / 0 skipped / 0 flaky。原视觉报告仍为 blocked/advisory，技术交付完成；未把旧报告改成 passed，也未重新生图。最终文稿修改后的 Docs 检查另行登记。

验证入口采用项目真实管理员设置与创作页。自动回归使用固定本地 fixture；已保存案例的恢复是原结果交付核验，不再次调用生图模型。用户确认之前仅标记开发完成/待验收。
