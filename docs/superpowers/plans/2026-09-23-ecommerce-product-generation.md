# 电商商品图生成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `/create` 统一创作入口中建立可切换模型、商品保真、连续编辑的电商商品图生成编排层，首期交付白底商品图到欧美家居场景图和非商品区域局部修改。

**Architecture:** 保持现有 Next.js 单体部署，在 Agent Run 与 image task executor 之间增加 `EcommerceEditPlan` 编排边界。GPT-5.6 或后台配置的同类模型负责视觉分析和编辑规划，gpt-image-2.5 与 nano banana 2 通过逻辑生成角色接入；商品主参考图和场景参考图使用显式角色，连续编辑使用原始商品锚点与当前场景基线双基线。

**Tech Stack:** Next.js App Router、TypeScript、React、PostgreSQL/JSON Provider、现有 Agent Run、图片任务、系统渠道代理、Sharp/现有图像处理能力、Vitest、Playwright、本地 TCP 上游 fixture。

## Global Constraints

- 首期只修改 `/create` 统一创作入口；Canvas 和短剧不接入本计划。
- 用户只提供参考图和一句话；模型、策略、mask 和内部 prompt 不作为首期用户控件。
- 默认策略为 `strict_product`；没有可信商品 mask 时禁止静默降级。
- 用户原话、内部 `EditPlan`、最终执行 prompt 和公开摘要必须分开保存。
- 模型按逻辑角色路由；每次任务保存实际模型、策略、编译器和计划快照。
- 生成任务继续使用稳定 `runId`、`taskId`、`resultId` 和幂等身份，不按 prompt 文本匹配或合并。
- 连续编辑默认继承最近成功结果，但原始商品锚点永久保留；明确引用历史结果创建分支，不覆盖旧结果。
- 商品核心验收失败直接拦截；场景美观不能抵消商品身份、轮廓、包装文字或比例失败。
- 内部视觉分析、规划和验收不进入用户公开消息；当前计划不改造计费规则。
- 上游协议、渠道代理、任务恢复和退款沿用现有契约；新编排层不能重复创建不确定的上游任务。
- 每个阶段必须有旧流程回退开关，并通过影子、内部、灰度、默认四阶段发布。

---

### Task 1: 固化 EcommerceEditPlan 契约

**Files:**

- Create: `web/src/lib/server/ecommerce-edit-plan.ts`
- Create: `web/src/lib/server/ecommerce-edit-plan.test.ts`
- Modify: `web/src/lib/server/agent-run-store.ts` only to add typed internal snapshot fields if the existing task payload cannot carry them

**Interfaces:**

- `EcommerceEditPlan`：包含 `planVersion`、`operation`、`source`、`baseline`、`delta`、`preserve`、`strategy`、`modelRoles`、`continuity`、`validation`。
- `normalizeEcommerceEditPlan(value: unknown): EcommerceEditPlan | null`：拒绝缺少商品来源、操作类型、策略或校验项的计划。
- `validateEcommerceEditPlan(plan: EcommerceEditPlan): void`：校验来源归属、策略与操作组合、严格商品保护项和连续编辑父结果。
- `planPublicSummary(plan: EcommerceEditPlan)`：只返回用户可见的操作摘要，不包含内部 prompt、分析细节或模型选择理由。

- [x] **Step 1: 写失败测试**

覆盖：`product_to_scene` 必须有商品主参考；`strict_product` 必须有商品核心保护项；`local_edit` 必须有目标对象或手动区域；场景参考不能成为商品主参考；无效 `continuity.parentResultId` 不能被静默接受；公开摘要不包含内部字段。

- [x] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run web/src/lib/server/ecommerce-edit-plan.test.ts`

Expected: FAIL because the new contract functions do not exist.

- [x] **Step 3: 实现最小契约与校验**

使用不可变的输入输出对象；规范化字符串数组、稳定 ID 和策略枚举；不要在该模块调用模型、数据库或图片处理库。

- [x] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run web/src/lib/server/ecommerce-edit-plan.test.ts`

Expected: PASS with coverage for valid plans, rejected plans and public summaries.

- [x] **Step 5: Commit**

```bash
git add CONTEXT.md docs/adr/0001-logical-model-roles-for-ecommerce-generation.md docs/adr/0002-strategy-modes-for-product-imaging.md docs/adr/0003-adaptive-multimodal-planning.md web/src/lib/server/ecommerce-edit-plan.ts web/src/lib/server/ecommerce-edit-plan.test.ts
git commit -m "feat: define ecommerce image edit plan contract"
```

### Task 2: 加入影子规划和内部快照

**Files:**

- Create: `web/src/lib/server/ecommerce-generation-snapshot.ts`
- Create: `web/src/lib/server/ecommerce-generation-snapshot.test.ts`
- Modify: `web/src/lib/server/agent-run-executor.ts`
- Modify: `web/src/lib/server/agent-run-store.ts`
- Modify: `.env.example`
- Test: `web/src/lib/server/agent-run-executor.test.ts`

**Interfaces:**

- `buildEcommercePlanningInput(run, assets, conversationContext)`：为规划器提供一句话、图片角色候选和连续编辑上下文。
- `recordEcommerceGenerationSnapshot(task, snapshot)`：只保存服务端内部的计划、模型角色快照、编译器版本和验收状态。
- `legacyPlanFallback(input)`：当新计划不完整或开关关闭时，继续走现有 Agent 任务流程。

- [x] **Step 1: 写失败测试**

验证新开关关闭时生成请求与当前旧路径一致；影子模式不改变任务 prompt 或结果；内部快照不出现在公开 Agent Run、用户消息或公开摘要；新计划解析失败时能记录原因并回退旧流程。

- [x] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run web/src/lib/server/agent-run-executor.test.ts web/src/lib/server/ecommerce-generation-snapshot.test.ts`

Expected: FAIL on missing snapshot and shadow-path assertions.

- [x] **Step 3: 接入影子路径**

在 `agent-run-executor.ts` 中保留原有 `normalizeTasks` 和任务执行行为，只在内部生成并记录快照；不得把分析摘要或执行 prompt 写入公开消息。影子模式由 `ECOMMERCE_GENERATION_ROLLOUT=shadow` 显式开启，默认关闭。

- [x] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run web/src/lib/server/agent-run-executor.test.ts web/src/lib/server/ecommerce-generation-snapshot.test.ts`

Expected: PASS with legacy behavior unchanged and snapshot fields isolated.

- [x] **Step 5: Commit**

```bash
git add .env.example web/src/lib/server/agent-run-executor.ts web/src/lib/server/agent-run-store.ts web/src/lib/server/ecommerce-generation-snapshot.ts web/src/lib/server/ecommerce-generation-snapshot.test.ts web/src/lib/server/agent-run-executor.test.ts
git commit -m "feat: add shadow ecommerce generation planning"
```

## 当前推进状态（2026-09-24）

Task 1–2 已完成，线上开发环境仍使用 `ECOMMERCE_GENERATION_ROLLOUT=shadow`。一次真实白底家具图测试暴露了两个独立问题：本轮上传的草稿附件能够提交给图片任务，但没有进入 `@` 素材候选；在 `/create` 手动选择底层生成模型时，Agent Run 直接进入 `directAgentPlan`，绕过文本 Planner，导致图片模型只收到用户原话和通用约束，生成结果接近原图。

已完成以下桥接修复：

- `@` 素材候选统一读取历史素材和本轮附件，并按稳定资产 ID 去重。
- `/create` 手动选择生成模型时仍经过 Planner；用户选择被作为硬约束传入并校验，Planner 不得改选、遗漏或增加模型。
- Canvas 保留原有 direct-model 行为，避免扩大本期改动范围。

该修复只恢复正确的 Planner 调用链，不代表完整电商编排已经上线。当前 Planner 仍是基于素材元数据和 URL 的文本规划，`shadow` 快照仍使用 `legacy-shadow.v1`；尚未具备多模态商品基线分析、可信商品 mask、`strict_product` provider compiler 或商品核心验收。

当前模型基线：视觉分析、编辑规划和结果验收默认使用 GPT-5.6，但角色必须保持可配置、可切换；底层生图模型共有三个：`nano banana 2`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`。实现采用两个 compiler 家族和三个模型 profile，不能把 flare 与 sunburst 当作同一个执行模型。

Task 3–4 已完成内部契约和适配器：商品图/场景图角色与连续来源使用稳定资产 ID；规划传输已支持 Chat、Responses 和 Gemini 的真实图片内容，自定义文本模板会明确拒绝图片而不是静默退化；视觉分析和编辑规划分别使用可配置逻辑模型角色，只允许同角色候选切换。编辑计划会拒绝缺字段、跨角色来源和不完整的 `strict_product` 保护项，并把最终商品/场景基线重新锚定到视觉分析事实；“商品旁边增加咖啡杯”一类请求不得落入商品核心区。

Task 5–8 已完成开发侧垂直切片：可信商品区域和独立 mask 已接入图片任务；`/create` 可在 `internal/enabled` 下执行 `product_to_scene` 和非商品区域 `local_edit`；连续编辑会自动继承最近成功的电商场景结果，同时永久保留原始商品 `productAnchorId`。明确引用旧结果会创建新分支，父结果不覆盖；新商品建立新锚点，新房间图保持为独立场景参考，上一结果只保存为 `parentResultId`。生成资产与 Run 私有快照持久化商品锚点、场景基线、父结果和稳定 branch ID，刷新或恢复后可重建关系。

开发部署仍保持 `ECOMMERCE_GENERATION_ROLLOUT=shadow`，未调用真实付费模型。Task 1–8 受影响回归、类型、范围 lint、格式和差异检查已通过，但真实商品保持度、场景融合、局部修改准确度、连续编辑分支和 `needs_review` 交互仍需切到 `internal` 后人工验收。自动最近结果当前最多扫描 100 条已完成 Chat Run；更早结果仍可通过明确结果 ID 选择。下一步按 Task 9 接入逻辑模型候选和 provider compiler；在 Task 10 结果验收完成前，不得把当前能力描述为端到端商品保真已验收。

### Task 3: 实现商品/场景参考角色识别

**Files:**

- Create: `web/src/lib/server/ecommerce-reference-roles.ts`
- Create: `web/src/lib/server/ecommerce-reference-roles.test.ts`
- Modify: `web/src/lib/server/agent-run-assets.ts`
- Test: `web/src/lib/server/agent-run-assets.test.ts`

**Interfaces:**

- `classifyReferenceRoles(assets, visualHints): ReferenceRoleDecision`：返回一张商品主参考图、至多一张场景参考图、歧义原因和是否需要澄清。
- `resolveContinuitySources(run, explicitAssets, selectedHistory): EcommerceSources`：解析原始商品锚点、当前场景基线和明确历史引用。

实现边界：Task 3 只消费结构化 `visualHints`，不按标题、prompt 或附件顺序猜测角色；真正生成视觉提示并接入运行时的工作归 Task 4。生成结果的 `parentAssetId` 在存在有效电商计划时优先保存原始商品锚点，为后续双基线解析提供稳定关系。

- [x] **Step 1: 写失败测试**

覆盖：白底单主体优先判为商品图；完整家居空间优先判为场景图；超过两张图片进入拒绝/澄清；新商品图建立新锚点；新场景图不替换商品锚点；明确历史结果创建新分支；无法判断时只返回一个澄清问题。

- [x] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run web/src/lib/server/ecommerce-reference-roles.test.ts web/src/lib/server/agent-run-assets.test.ts`

Expected: FAIL because role and continuity resolvers are not implemented.

- [x] **Step 3: 实现角色与来源解析**

使用稳定资产 ID 和用户明确引用，不按标题相似度或 prompt 文本猜测历史结果。保留商品主参考图和场景参考图的优先级。

- [x] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run web/src/lib/server/ecommerce-reference-roles.test.ts web/src/lib/server/agent-run-assets.test.ts`

Expected: PASS with no source role ambiguity leaking into generation.

- [ ] **Step 5: Commit**

按当前开发约定暂不提交、推送或创建 PR，等待开发环境验收。

```bash
git add web/src/lib/server/ecommerce-reference-roles.ts web/src/lib/server/ecommerce-reference-roles.test.ts web/src/lib/server/agent-run-assets.ts web/src/lib/server/agent-run-assets.test.ts
git commit -m "feat: classify ecommerce product and scene references"
```

### Task 4: 建立多模态视觉分析和编辑规划

**Files:**

- Create: `web/src/lib/server/ecommerce-visual-analysis.ts`
- Create: `web/src/lib/server/ecommerce-visual-analysis.test.ts`
- Create: `web/src/lib/server/ecommerce-edit-planner.ts`
- Create: `web/src/lib/server/ecommerce-edit-planner.test.ts`
- Modify: `web/src/lib/server/text-planning-runtime.ts`
- Modify: `web/src/lib/server/agent-run-surface-policy.ts`
- Modify: `web/src/lib/server/agent-function-call.ts`

**Interfaces:**

- `analyzeEcommerceReferences(input, candidateRole)`：返回商品事实、场景事实、商品核心候选区域、融合光晕候选区域和置信状态。
- `planEcommerceEdit(input, visualAnalysis, candidateRole)`：返回经 `validateEcommerceEditPlan` 校验的 `EcommerceEditPlan`。
- `planEcommerceEdit` 必须支持两阶段调用；简单请求可以使用同一模型的合并实现，但仍返回同一契约。

- [x] **Step 1: 写失败测试**

使用本地结构化模型 fixture 验证：商品图和场景图角色不会混淆；模型返回缺字段时计划被拒绝；核心保护项缺失时严格策略不可用；同角色候选可切换；跨角色降级被拒绝；用户请求“商品旁边增加咖啡杯”不会被规划为修改商品本体。

- [x] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run web/src/lib/server/ecommerce-visual-analysis.test.ts web/src/lib/server/ecommerce-edit-planner.test.ts`

Expected: FAIL before multimodal content and planner adapters exist.

- [x] **Step 3: 扩展规划传输以支持多模态内容**

在 `text-planning-runtime.ts` 中增加结构化内容部分的传输能力，保持已有纯文本规划请求不变；图片 URL 必须经过现有站内权限和媒体访问边界。

- [x] **Step 4: 实现分析和规划适配器**

分析和规划分别使用独立输入输出契约；记录实际逻辑角色和候选模型；分析失败只能同角色切换或进入待复核，不能变成无图文本规划。

- [x] **Step 5: 运行测试确认通过**

Run: `pnpm exec vitest run web/src/lib/server/ecommerce-visual-analysis.test.ts web/src/lib/server/ecommerce-edit-planner.test.ts web/src/lib/server/text-planning-runtime.test.ts`

Expected: PASS with existing text planning tests unchanged.

- [ ] **Step 6: Commit**

按当前开发约定暂不提交、推送或创建 PR，等待开发环境验收。

```bash
git add web/src/lib/server/ecommerce-visual-analysis.ts web/src/lib/server/ecommerce-visual-analysis.test.ts web/src/lib/server/ecommerce-edit-planner.ts web/src/lib/server/ecommerce-edit-planner.test.ts web/src/lib/server/text-planning-runtime.ts web/src/lib/server/agent-run-surface-policy.ts web/src/lib/server/agent-function-call.ts
git commit -m "feat: add multimodal ecommerce visual planning"
```

### Task 5: 实现商品核心区与融合光晕区

**Files:**

- Create: `web/src/lib/server/ecommerce-product-regions.ts`
- Create: `web/src/lib/server/ecommerce-product-regions.test.ts`
- Modify: `web/src/lib/server/image-task-store.ts`
- Modify: `web/src/app/api/image-tasks/image-task-support.ts`
- Modify: `web/src/app/api/image-tasks/image-task-types.ts`
- Modify: `web/src/app/api/image-tasks/image-task-openai.ts`
- Modify: `web/src/app/api/image-tasks/image-task-gemini.ts`
- Modify: `web/src/app/api/image-tasks/route.ts`
- Test: `web/src/app/api/image-tasks/route.test.ts`

**Interfaces:**

- `buildProductProtectionRegions(analysis, sourceSize): ProductProtectionRegions`：返回 `productCore`、`fusionHalo`、`editableBackground`。
- `validateProductProtectionRegions(regions, sourceSize): void`：拒绝越界、空核心区和编辑区覆盖核心区的 mask。
- `compileStrictProductEdit(task, regions)`：把商品角色、独立 mask、融合光晕和保护约束转换为当前 provider 适配器能理解的请求。

- [x] **Step 1: 写失败测试**

覆盖核心区不能为空；融合光晕必须与核心区相邻且范围有限；背景编辑不得覆盖核心区；mask 尺寸与源图一致；provider 不支持可信 mask 时任务进入待复核而非静默整图生成；已有 Canvas mask 行为不回归。

- [x] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run web/src/lib/server/ecommerce-product-regions.test.ts web/src/app/api/image-tasks/route.test.ts`

Expected: FAIL on new region validation and strict-product request assertions.

开发服务器根目录未暴露 `vitest`，实际从 `web` 工作区执行等价命令。RED 已确认区域模块缺失，严格商品 Gemini 请求仍返回 `200` 而非 `202 needs_review`；跨 provider 候选仍保留不安全回退。

- [x] **Step 3: 实现区域校验和 provider 输入编译**

复用现有图片尺寸、参考图访问和蒙版规范化能力；provider-specific 字段留在图片任务适配层，编排层只传递领域区域。

已实现完整且不重叠的商品核心区、融合光晕区和可编辑背景区；可信实际 mask 与逻辑区域均校验源图尺寸。严格商品任务只选择支持独立 mask 的 OpenAI provider，并关闭协议及候选渠道回退；Gemini 或缺少可信 mask 时持久化为 `needs_review`，不进入 Worker 上游提交。

- [x] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run web/src/lib/server/ecommerce-product-regions.test.ts web/src/app/api/image-tasks/route.test.ts web/src/app/api/image-tasks/image-task-openai-live.test.ts`

Expected: PASS with native and legacy provider contracts preserved.

开发服务器实际执行 `pnpm --dir web exec vitest run ...`，专项 3 个文件 43 项通过；Task 1–5 受影响回归 12 个文件 178 项通过，TypeScript、受影响文件 ESLint 与 Prettier 检查通过。

- [ ] **Step 5: Commit**

按当前开发约定暂不提交、推送或创建 PR，等待开发环境验收。

```bash
git add web/src/lib/server/ecommerce-product-regions.ts web/src/lib/server/ecommerce-product-regions.test.ts web/src/lib/server/image-task-store.ts web/src/app/api/image-tasks/image-task-support.ts web/src/app/api/image-tasks/image-task-openai.ts web/src/app/api/image-tasks/image-task-gemini.ts web/src/app/api/image-tasks/route.test.ts
git commit -m "feat: protect ecommerce product regions during edits"
```

### Task 6: 交付 `/create` 的 product_to_scene 垂直切片

**Files:**

- Create: `web/src/lib/server/ecommerce-generation-service.ts`
- Create: `web/src/lib/server/ecommerce-generation-service.test.ts`
- Modify: `web/src/lib/server/agent-run-execution.ts`
- Modify: `web/src/lib/server/agent-run-validation.ts`
- Modify: `web/src/services/api/creative.ts`
- Modify: `web/src/app/(user)/create/components/creative-generation-waiting.tsx`
- Test: `web/src/lib/server/agent-run-executor.test.ts`
- Test: `web/src/app/(user)/create/components/creative-generation-waiting.test.tsx`

**Interfaces:**

- `createEcommerceProductSceneTask(run, plan, assets, productProtectionRegions)`：从合法计划创建 image task，传递商品主参考图、可选场景参考图、区域和模型快照。
- `publicEcommerceProgress(stage)`：将本阶段真实执行的内部阶段映射为“正在识别商品/正在规划场景/正在生成图片”；商品细节质检留到 Task 10，未执行前不提前展示。
- `ecommerceGenerationEnabled(rollout, run)`：只允许显式 `internal/enabled` 的统一创作图片请求进入新链路，`off/shadow` 和其他入口保持旧流程。

- [x] **Step 1: 写失败测试**

验证一句话 + 白底商品图会创建 `product_to_scene`；可选场景图只作为场景参考；没有场景文字时从受控欧美家居场景类别自动规划；结果任务使用 `strict_product`；用户公开消息不包含内部计划；阶段状态映射正确。

- [x] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run web/src/lib/server/ecommerce-generation-service.test.ts web/src/lib/server/agent-run-executor.test.ts web/src/app/(user)/create/components/creative-generation-waiting.test.tsx`

Expected: FAIL before the vertical slice is wired into Agent Run execution.

RED 已确认 4 项预期失败：执行器未调用视觉分析、歧义素材仍走旧流程并失败、SSE 未映射 `ecommerce.progress`、等待页用安慰文案覆盖真实电商阶段。

- [x] **Step 3: 接入商品生成服务**

只在 `/create` 的图片生成意图和特性开关命中时进入新服务；Canvas、短剧和其他能力继续旧路径。

已接入视觉分析、商品/场景角色判定、编辑规划、白底或透明底可信分割蒙版、严格商品图片任务和私有快照。歧义素材持久化为 `needs_review` 并暂停 Run，不提交 provider；图片任务保留商品第一、场景第二的引用顺序、素材 ID、真实尺寸、电商角色和保护区域。公开事件只包含三个真实阶段，不暴露模型角色、分析或内部 prompt。

- [x] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run web/src/lib/server/ecommerce-generation-service.test.ts web/src/lib/server/agent-run-executor.test.ts web/src/app/(user)/create/components/creative-generation-waiting.test.tsx`

Expected: PASS with legacy path and new product-to-scene path both covered.

开发服务器实际执行 Task 1–6 受影响回归 17 个文件 225 项通过，TypeScript 和受影响文件 ESLint 通过。当前部署开关仍保持 `shadow`，未调用真实付费模型；真实商品保持度、场景融合和 `needs_review` 交互仍需在开发环境显式切换到 `internal` 后人工验收。

按当前开发约定暂不提交、推送或创建 PR，等待开发环境验收。

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/server/ecommerce-generation-service.ts web/src/lib/server/ecommerce-generation-service.test.ts web/src/lib/server/agent-run-execution.ts web/src/lib/server/agent-run-validation.ts web/src/services/api/creative.ts web/src/app/(user)/create/components/creative-generation-waiting.tsx web/src/lib/server/agent-run-executor.test.ts web/src/app/(user)/create/components/creative-generation-waiting.test.tsx
git commit -m "feat: add ecommerce product to scene flow"
```

### Task 7: 交付 local_edit 的非商品区域局部修改

**Files:**

- Modify: `web/src/lib/server/ecommerce-visual-analysis.ts`
- Modify: `web/src/lib/server/ecommerce-edit-planner.ts`
- Modify: `web/src/lib/server/ecommerce-generation-service.ts`
- Modify: `web/src/lib/server/ecommerce-product-regions.ts`
- Modify: `web/src/lib/server/ecommerce-generation-snapshot.ts`
- Modify: `web/src/lib/server/agent-run-executor.ts`
- Create: `web/src/lib/server/ecommerce-local-edit.test.ts`
- Test: `web/src/lib/server/agent-run-executor.test.ts`
- Test: `web/src/app/api/image-tasks/route.test.ts`

**Interfaces:**

- `resolveLocalEditTarget(plan, analysis, optionalManualRegion)`：自动定位唯一编辑目标，多个候选返回单个澄清问题，手动区域优先。
- `createEcommerceLocalEditTask(run, plan, regions)`：只允许背景、环境、道具、光线和阴影目标进入首期 local edit。

- [x] **Step 1: 写失败测试**

覆盖“把背景换成厨房”“增加一杯咖啡”“去掉右边绿植”“让光线更亮”；覆盖多个相同目标只返回一个澄清问题；手动 mask 优先；商品颜色、材质、结构和包装文字被拒绝并提示后续能力；局部编辑不扩大到商品核心区。

- [x] **Step 2: 运行测试确认失败**

Run: `pnpm --dir web exec vitest run src/lib/server/ecommerce-local-edit.test.ts src/lib/server/agent-run-executor.test.ts src/app/api/image-tasks/route.test.ts`

Expected: FAIL until target routing and UI clarification behavior exist.

RED 阶段 4 个文件共 16 项按预期失败，55 项既有测试通过。失败覆盖目标解析、局部 mask、双参考顺序和歧义时禁止提交图片任务。

- [x] **Step 3: 实现局部目标路由**

复用当前场景基线和原始商品锚点；本轮只加入当前 `delta`，不拼接历史 prompt。

实现只在用户明确引用一张带 `sourceRunId` 的历史生成图时进入 `local_edit`，并通过该结果的 `parentAssetId` 恢复原始商品锚点。视觉分析同时读取当前场景和原商品图，输出场景内商品核心、融合光晕和带稳定 ID 的可编辑目标；Planner 必须选择这些目标 ID，不能从自然语言猜坐标。局部 mask 只开放唯一目标区域，商品核心、融合边缘和无关场景保持不透明。

首期不增加 `/create` 手动画蒙版 UI；`optionalManualRegion` 仅保留为内部优先输入契约。商品颜色、材质、结构和包装文字修改明确拒绝，多目标或目标缺失只返回一个澄清问题。

- [x] **Step 4: 运行测试确认通过**

Run: `pnpm --dir web exec vitest run src/lib/server/ecommerce-local-edit.test.ts src/lib/server/agent-run-executor.test.ts src/app/api/image-tasks/route.test.ts`

Expected: PASS with strict product core protection.

Task 7 专项与受影响回归先后通过 `108/108`、Executor + Route `62/62`，Task 1–7 扩大回归 `221/221`；本地 TCP provider fixture 另有 `21/21` 通过。TypeScript、Task 7 范围 `ESLint --max-warnings 0`、Prettier 和 `git diff --check` 均通过。以上均未调用真实或付费模型，不能替代真实图片视觉验收。

- [ ] **Step 5: Commit**

按当前开发约定暂不提交、推送或创建 PR，等待开发环境验收。

```bash
git add web/src/lib/server/ecommerce-edit-planner.ts web/src/lib/server/ecommerce-generation-service.ts web/src/lib/server/ecommerce-product-regions.ts web/src/lib/server/ecommerce-local-edit.test.ts web/src/app/(user)/create/components/creative-composer.tsx web/src/app/(user)/create/components/creative-composer.test.tsx
git commit -m "feat: support non-product local ecommerce edits"
```

### Task 8: 交付连续编辑、双基线和编辑分支

**Files:**

- Modify: `web/src/lib/server/ecommerce-generation-service.ts`
- Modify: `web/src/lib/server/ecommerce-reference-roles.ts`
- Modify: `web/src/lib/server/ecommerce-generation-snapshot.ts`
- Modify: `web/src/lib/server/agent-run-store.ts`
- Modify: `web/src/lib/server/agent-run-assets.ts`
- Create: `web/src/lib/server/ecommerce-continuity.test.ts`
- Test: `web/src/lib/server/agent-run-store.test.ts`

**Interfaces:**

- `resolveDualBaseline(run, explicitReference)`：返回不可替换的 `productAnchor` 和当前可分支的 `sceneBaseline`。
- `createEditBranch(parentResultId, run)`：创建稳定 branch ID，保留父结果并为新轮写入快照。
- `selectCurrentSceneBaseline(conversationId, explicitResultId?)`：无明确选择时返回最近成功结果，有明确选择时返回指定结果。

- [x] **Step 1: 写失败测试**

覆盖“再亮一点”继承最近场景结果；商品核心事实仍来自原始白底图；明确引用旧结果创建分支；新商品图建立新锚点；新场景参考图不改变商品锚点；历史结果不会被覆盖；刷新和恢复后仍能读取父子关系。

- [x] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run web/src/lib/server/ecommerce-continuity.test.ts web/src/lib/server/agent-run-store.test.ts`

Expected: FAIL until continuity fields and branch selection are persisted.

RED 已覆盖缺失的双基线、最近结果选择、稳定分支、资产血缘和无新上传入口；独立审查后又补充明确选择普通图片必须拒绝，以及已有结果时同时上传“替换商品 + 新房间”不得丢图或丢失父结果关系。

- [x] **Step 3: 实现双基线和分支持久化**

只用稳定资产、结果和任务 ID 建立关系；禁止按标题或 prompt 文本推断父结果。

实现会自动选择最近成功且具有可信电商血缘的场景结果；明确结果同样执行归属、完成状态和电商血缘校验。`branchId` 由当前 Run ID 稳定生成，父结果不修改。生成资产和 Run 私有快照同时保存 `productAnchorId`、`sceneBaselineId`、`parentResultId` 和 `branchId`。新房间图作为 `sceneReferenceIds`，不会冒充含商品的局部编辑基线；同时上传替换商品和房间时，两张新图进入视觉分析，旧结果仅作为分支父节点。

- [x] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run web/src/lib/server/ecommerce-continuity.test.ts web/src/lib/server/agent-run-store.test.ts`

Expected: PASS with round-trip persistence and no result overwrite.

开发服务器最终验证：Task 8 专项 4 个文件 `80/80` 通过，Task 1–8 受影响回归 19 个文件 `250/250` 通过；TypeScript、Task 8 范围 `ESLint --max-warnings 0`、Prettier 和 `git diff --check` 通过。独立任务复审已确认两个重要问题关闭，仅保留自动扫描最近 100 条已完成 Run 的低频限制。以上未调用真实或付费模型，不能替代真实图片视觉验收。

- [ ] **Step 5: Commit**

按当前开发约定暂不提交、推送或创建 PR，等待开发环境验收。

```bash
git add web/src/lib/server/ecommerce-generation-service.ts web/src/lib/server/ecommerce-reference-roles.ts web/src/lib/server/ecommerce-generation-snapshot.ts web/src/lib/server/agent-run-store.ts web/src/lib/server/agent-run-assets.ts web/src/lib/server/ecommerce-continuity.test.ts web/src/lib/server/agent-run-store.test.ts
git commit -m "feat: preserve ecommerce edit continuity and branches"
```

### Task 9: 接入逻辑模型路由和 provider compiler

**Files:**

- Create: `web/src/lib/server/ecommerce-model-routing.ts`
- Create: `web/src/lib/server/ecommerce-model-routing.test.ts`
- Create: `web/src/lib/server/ecommerce-image-compiler.ts`
- Create: `web/src/lib/server/ecommerce-image-compiler.test.ts`
- Modify: `web/src/lib/server/logical-model-router.ts`
- Modify: `web/src/lib/server/ecommerce-generation-service.ts`
- Test: `web/src/lib/server/logical-model-router.test.ts`

**Interfaces:**

- `resolveEcommerceRoleCandidates(settings, role, capability)`：按逻辑角色返回有序候选。
- `routeEcommerceRole(settings, role, snapshot)`：只在同角色候选内切换，并返回实际模型快照。
- `compileEcommerceImageRequest(plan, providerProfile)`：将领域计划编译为 image task 的提示词、参考图角色、mask 和参数。

- [x] **Step 1: 写失败测试**

验证管理员可以排序多个视觉、规划、验收和生成候选；失败只在同角色切换；不同模型收到不同 provider compiler 输出；已开始任务继续使用保存的快照；策略和模型切换不影响历史任务重试。

- [x] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run web/src/lib/server/ecommerce-model-routing.test.ts web/src/lib/server/ecommerce-image-compiler.test.ts web/src/lib/server/logical-model-router.test.ts`

Expected: FAIL before role candidates and compiler adapters exist.

两轮 RED 分别确认角色配置/API 缺失 4 项，以及 PostgreSQL 未持久化 2 项；失败均来自预期的缺失能力。

- [x] **Step 3: 实现角色候选和编译器**

保持逻辑模型 ID 与上游模型名分离；编译器不得向用户公开 foundation、analysis、model reason 或内部依赖上下文。

已新增持久化 `ecommerceModelRoles` 设置，支持 `vision_analysis`、`edit_planning`、`image_generation` 和 `quality_check` 四类有序候选。后台“模型渠道 -> 电商流程”仅展示启用且能力匹配的逻辑模型，可添加、删除和排序；API、PostgreSQL 设置服务与旧仓储写入路径均校验并保存配置，删除渠道会清理失效候选。旧数据库或空配置继续回退系统默认模型。

运行时仅在同角色候选内切换，记录实际逻辑模型、绑定、渠道、上游模型和 provider profile 快照。图片任务按创建时快照执行，后续后台改序或删除绑定不会静默改变既有任务。OpenAI/Gemini 编译器分别生成 provider 请求，严格商品任务继续执行真实渠道能力和蒙版支持核验。`quality_check` 本轮只保存预选快照，真正结果验收由 Task 10 执行。

- [x] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run web/src/lib/server/ecommerce-model-routing.test.ts web/src/lib/server/ecommerce-image-compiler.test.ts web/src/lib/server/logical-model-router.test.ts`

Expected: PASS with role failover, snapshot stability and provider-specific request fixtures.

Task 9 与后台配置专项通过 `187/187`；Task 1-9 受影响回归 26 个文件 `332/332`。TypeScript 和 Prettier 通过，范围 ESLint 为 `0 error / 179 warning`；告警来自既有拆分式仓储文件未使用导入及一个后台既有未使用参数，未在 Task 9 扩大范围处理。

开发环境验收已完成：独立开发数据库的 `vozeb_pro_app_settings.ecommerce_model_roles` 已迁移为 `jsonb`；后台“模型渠道 -> 电商流程”显示 `已配置 4/4`，视觉分析、编辑规划和结果验收按 `gpt-5.6-sol -> gemini-3.8-flash-high` 排序，图片生成按 `gpt-image-2.5-flare -> gpt-image-2.5-sunburst -> nano banana 2` 排序，刷新后顺序保持不变。app 与 generation-worker 均保持 `ECOMMERCE_GENERATION_ROLLOUT=shadow`，健康和就绪检查通过。

同一白底木床参考图分别提交一次真实图片任务，三次均成功且未重试：Flare `case-task6-flare`（1024x1024 PNG，1,182,887 bytes）、Sunburst `case-task6-sunburst`（1024x1024 PNG，1,208,353 bytes）、Nano Banana 2 `case-task6-nano-banana-2`（1024x1024 JPEG，437,802 bytes）。Flare 与 Sunburst 基本保留白底和原构图，只做轻微亮度变化；Nano Banana 2 增加地面、窗光和地毯，形成基础室内环境且主体整体保持较好。该结果只证明三个真实 provider profile 的路由和图生图能力可用，不代表 Task 10 的商品保真、场景完整度或端到端 `internal` 链路已经验收。

- [ ] **Step 5: Commit**

按当前开发约定暂不提交、推送或创建 PR，等待开发环境验收。

```bash
git add web/src/lib/server/ecommerce-model-routing.ts web/src/lib/server/ecommerce-model-routing.test.ts web/src/lib/server/ecommerce-image-compiler.ts web/src/lib/server/ecommerce-image-compiler.test.ts web/src/lib/server/logical-model-router.ts web/src/lib/server/ecommerce-generation-service.ts web/src/lib/server/logical-model-router.test.ts
git commit -m "feat: route ecommerce roles through model compilers"
```

### Task 10: 加入商品核心验收和发布开关

**Files:**

- Create: `web/src/lib/server/ecommerce-quality-check.ts`
- Create: `web/src/lib/server/ecommerce-quality-check.test.ts`
- Modify: `web/src/lib/server/ecommerce-generation-service.ts`
- Modify: `web/src/lib/server/ecommerce-generation-snapshot.ts`
- Modify: `web/src/lib/server/agent-run-public.ts`
- Modify: `web/src/app/(user)/create/components/creative-generation-waiting.tsx`
- Test: `web/src/lib/server/agent-run-public.test.ts`

**Interfaces:**

- `checkEcommerceResult(input, roleCandidate)`：返回每项检查、硬失败项、可公开状态和内部原因。
- `shouldBlockEcommerceResult(check)`：商品核心、Logo、包装文字或轮廓失败时返回 true。
- `ecommerceRolloutStage(settings, userId)`：返回 shadow、internal、canary 或 default，并提供旧流程回退。

- [x] **Step 1: 写失败测试**

覆盖商品核心失败拦截；场景轻微不符进入待调整；验收模型不可用不自动判定成功；影子结果不影响公开任务；开关关闭时完整回退旧流程；用户只看到简短状态。

- [x] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run web/src/lib/server/ecommerce-quality-check.test.ts web/src/lib/server/agent-run-public.test.ts`

Expected: FAIL before quality check and rollout gates exist.

- [x] **Step 3: 实现双门禁和灰度开关**

自动验收只负责结构和硬失败；业务人工复核通过黄金回归集完成。验收结果写入内部快照，不写入公开消息。商品身份、轮廓、颜色材质、比例视角无法判断时必须按硬失败拦截；Logo/包装文字仅在商品基线明确不存在品牌文字时允许 `not_applicable`。开发过程中临时新增的管理员可观测需求单列为 Task 10A。

- [x] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run web/src/lib/server/ecommerce-quality-check.test.ts web/src/lib/server/agent-run-public.test.ts`

Expected: PASS with strict hard-fail behavior and legacy fallback.

- [x] **Step 5: Commit**

```bash
git add web/src/lib/server/ecommerce-quality-check.ts web/src/lib/server/ecommerce-quality-check.test.ts web/src/lib/server/ecommerce-generation-service.ts web/src/lib/server/ecommerce-generation-snapshot.ts web/src/lib/server/agent-run-public.ts web/src/app/(user)/create/components/creative-generation-waiting.tsx web/src/lib/server/agent-run-public.test.ts
git commit -m "feat: gate ecommerce results and rollout stages"
```

### Task 10A: 补充每个实际电商图片任务的管理员可观测流水（临时突发新增，已完成）

**需求类型：** Task 10 开发过程中新增的临时突发需求。该任务不改变普通用户的一句话创作体验，只为管理员提供端到端诊断和验收证据。

**Files:**

- Create: `web/src/lib/server/ecommerce-generation-trace.ts`
- Create: `web/src/lib/server/ecommerce-generation-trace.test.ts`
- Create: `web/src/lib/server/generation-log-trace-outbox.test.ts`
- Modify: `web/src/lib/server/generation-log-store.ts`
- Modify: `web/src/lib/server/generation-log-repository.ts`
- Modify: `web/src/lib/server/image-task-store.ts`
- Modify: `web/src/lib/server/database/schema.ts`
- Modify: `web/src/app/api/admin/generation-logs/route.ts`
- Modify: `web/src/app/api/generation-logs/route.ts`
- Modify: `web/src/components/admin/admin-generation-log.tsx`

- [x] **Step 1: 定义可观测范围和权限边界**

每个已经创建图片子任务的电商任务记录 `视觉分析 -> 编辑规划 -> 图片生成 -> 结果验收 -> 最终门禁`。每阶段保存状态、实际逻辑角色、渠道、上游模型和结构化输出；图片生成阶段额外保存 provider profile、编译器版本、保护区域、图片任务 ID 和实际执行 Prompt。仅管理员接口返回完整 Trace，普通用户生成日志和公开 Agent Run 必须剥离视觉事实、EditPlan、执行 Prompt、质检内部理由和模型路由细节。

- [x] **Step 2: 建立持久化 Trace 和补写机制**

Trace 使用 `ecommerce-generation-trace.v1` 契约写入 `generation_logs.ecommerce_trace`。为避免生成日志短暂不可用造成永久缺失，完整 Trace 先保存到图片任务作为持久待办，再同步到生成日志；管理员读取日志时会从图片任务补齐缺失 Trace 并回写。持久化内容不得包含 Data URL，跨层关联统一使用 `runId + imageTaskIds`。

- [x] **Step 3: 在管理员调用记录展示完整流水**

管理员可从单条图片调用记录展开四阶段结构化输出，并查看最终门禁 `passed`、`needs_review` 或 `failed`。界面同时适配桌面和移动端长 JSON，不影响普通用户创作入口。

- [x] **Step 4: 覆盖失败关闭、隐私和耐久性回归**

商品身份、轮廓、颜色材质、比例视角返回 `not_applicable` 时按硬失败拦截；Logo/包装文字仅在商品基线没有品牌文字时允许不适用。覆盖管理员可见、普通用户不可见、图片任务 Trace 待办、管理员读取补写、视觉分析候选耗尽进入 `paused/needs_review`，以及 Chat、Responses、Gemini 多模态传输契约。

- [x] **Step 5: 完成真实任务和界面验收**

2026-09-25 开发环境真实任务：Run `case-task10a-trace-run`、图片任务 `case-task10a-trace-image`，实际路由为 `gpt-5.6-sol -> gpt-5.6-sol -> gpt-image-2.5-sunburst -> gemini-3.8-flash-high`，最终门禁 `passed`。PostgreSQL、管理员 API 与 1440px/390px 后台详情均确认包含完整 Trace；普通用户 API 不返回内部流水。

- [x] **Step 6: 完成回归、开发部署和提交**

专项回归 `6 files / 94 tests` 通过；全量 Vitest `574 files / 2905 tests` 通过，另有 `4 files / 9 tests` 因环境条件跳过；TypeScript、ESLint、Prettier、生产构建和暂存差异检查通过。开发环境由 `docker-compose.dev.yml` 重建，`app` 健康、worker 在线、`/api/health/ready` 就绪，`ECOMMERCE_GENERATION_ROLLOUT=internal`。提交：`e1bf34bfe96801b2dd3e948b51a0da7740355c11`。

**边界：** 视觉分析或编辑规划在图片子任务创建前停止时，只存在 Agent Run 事件，不存在图片生成日志。本任务保证“每个实际电商图片任务”的完整 Trace；若要审计全部用户请求的前置失败，必须另建 Agent Run 可观测入口，不能伪造空图片日志。

### Task 11: 建立真实黄金回归集和浏览器验收

**Files:**

- Create: `web/e2e/ecommerce-product-generation.spec.ts`
- Create: `web/e2e/fixtures/ecommerce-product-cases.json`
- Create: `docs/content/docs/progress/pending-test.mdx` entry for the release
- Modify: `docs/content/docs/overview/features.mdx` only after business acceptance

- [ ] **Step 1: 准备真实素材和本地 fixture**

使用真实家居商品素材，覆盖收纳、灯具、厨房、卫浴、软装、家具和小家电；每个案例定义商品图、可选场景图、用户一句话、预期操作类型和硬保护项。上游请求使用本地 TCP fixture，不调用管理员真实渠道。

- [ ] **Step 2: 写浏览器失败断言**

覆盖上传商品图、上传场景图、发送一句话、阶段状态、结果恢复、连续编辑、历史结果分支、歧义追问和严格流程失败提示。不得使用 `force` 点击或固定延时掩盖定位问题。

- [ ] **Step 3: 运行桌面和移动端测试确认失败**

Run: `pnpm exec playwright test web/e2e/ecommerce-product-generation.spec.ts --project=chromium`

Expected: FAIL until `/create` flow, fixtures and result persistence are wired.

- [ ] **Step 4: 完成自动和人工双门禁**

读取真实任务请求、mask、计划快照、模型快照和公开结果；产品/业务负责人逐项确认商品核心和场景可用性。任何商品核心失败都阻止灰度升级。

- [ ] **Step 5: 运行完整相关回归**

Run: `pnpm exec vitest run web/src/lib/server web/src/app/api/image-tasks web/src/app/(user)/create`

Run: `pnpm exec playwright test web/e2e/ecommerce-product-generation.spec.ts --project=chromium`

Expected: all relevant tests pass; no Canvas、短剧、旧图片任务回归。

- [ ] **Step 6: Commit**

```bash
git add web/e2e/ecommerce-product-generation.spec.ts web/e2e/fixtures/ecommerce-product-cases.json docs/content/docs/progress/pending-test.mdx
git commit -m "test: add ecommerce product generation golden regression"
```

## 发布顺序

1. Task 1-2：完成契约和影子快照，默认用户结果不变。
2. Task 3-4：完成素材角色和多模态规划，仅内部账号可见。
3. Task 5-6：完成 `product_to_scene` 严格商品 MVP。
4. Task 7：上线非商品区域 `local_edit`。
5. Task 8：上线连续编辑、双基线和分支。
6. Task 9：接入多模型候选和 provider compiler。
7. Task 10：启用结果验收和灰度门禁。
8. Task 10A：补齐管理员可观测流水和耐久性保障（临时突发新增，已完成）。
9. Task 11：建立真实黄金回归集和浏览器验收门禁。

每一步必须先通过自动测试，再进行内部账号验收，然后才能扩大灰度范围。商品核心失败、参考角色错误、历史结果覆盖或旧流程回退失效，任何一项都停止发布。

## 计划自检

- 规格覆盖：目标、两条工作流、连续编辑、模型路由、商品 mask、失败回退、用户体验、管理员可观测、发布灰度和验收均有对应任务。
- 占位符检查：计划没有依赖未定义的组件名称、任务编号或待补充字段；所有新接口在任务中给出名称和职责。
- 类型一致性：后续任务使用的 `EcommerceEditPlan`、`buildProductProtectionRegions`、`routeEcommerceRole`、`compileEcommerceImageRequest`、`checkEcommerceResult` 均在前置任务中定义。
- 范围检查：首期只覆盖 `/create`，Canvas 和短剧明确排除，商品本体修改单独延后。

## 已纳入 SOP 的后续优化

新增 Task12–18 已分项实现并完成独立审查，范围和证据详见[局部编辑稳定性与家居质感补充计划](2026-10-01-ecommerce-edit-quality-hardening.md)与[分项验收记录](ecommerce-edit-quality-acceptance.md)。

完整分支复审发现的多结果批次证据遗漏已在本轮修复；Task1–11 与 Task10A 的历史证据继续保留，开发部署、真实供应商回归与用户验收仍待完成。
