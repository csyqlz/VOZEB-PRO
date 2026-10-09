# 电商局部编辑稳定性与家居质感优化实施计划

> 执行时使用 `executing-plans` 按任务推进，每项独立验证、记录与交付。已进入实施，按 Task12–18 逐项开发和验收；先在服务器开发测试环境验证，不提交 PR。

**Goal:** 在一句话图生图体验下，稳定保持商品、画幅与未编辑区域，并在保真通过后提升欧美家居场景的材质和摄影质感。

**Architecture:** 沿用现有 Next.js 单体、EcommerceEditPlan、逻辑角色路由、图片执行器与管理员流水。先把自然语言约束变成可执行契约和确定性检查，再完善场景连续编辑、独立蒙版与视觉验收，最后增加摄影规划。原有 Task1–11、Task10A 的记录与完成证据不重置。

**Tech Stack:** TypeScript、Next.js App Router、PostgreSQL/JSON Provider、Sharp/现有媒体处理、Vitest、Playwright、本地 TCP provider fixture。

规格来源：[电商生成 SOP](../specs/2026-09-23-ecommerce-product-generation-sop.md)。基础任务：[原实施计划](2026-09-23-ecommerce-product-generation.md)。

## Global Constraints

- 后续产品开发与默认验收以桌面端为目标；不新增手机端专用适配代码或回归矩阵。测试优先覆盖本次改动、原失败路径和受影响公共契约，未变化的有效证据继续使用；Playwright 显式选择 `chromium`。既有手机端记录仅保留为历史证据。
- 图片内容事实与本轮用途独立保存；近景可靠线索不补造完整场景，明确“参考 A、修改 B”锁定实际目标与商品事实来源。
- 连续编辑新增参考按用途加入，辅助图不自动替换继承目标或商品锚点；同图多用途、原始置信度、实际线索和最终图片位置映射贯穿计划、编译、独立 QA 与流水。
- 用途确认不能弥补商品事实、保护核心或范围缺失。当前严格策略不支持的商品属性请求须具体说明，否定商品修改与仅环境编辑沿合法路径处理。
- 确认用途和重新分析保持同 Run 的互斥 typed 操作；核对冻结原图真实字节并原子消费当前复核。已提交/未知提交只查询原上游，不重编或创建新任务。
- 仅优化 `/create` 的商品到场景和场景/非商品区域编辑，不扩展 Canvas、短剧、视频、音频或计费。
- 用户只上传/引用图片并说一句话；不要求用户理解模型、蒙版或内部计划。
- 图生图入口是否进入编排由有效素材、当前编辑链路和管理员启用范围决定，不能再次依赖 LLM 的媒体分类结论。
- 分析、规划、生成与可选视觉质检模型保持独立逻辑配置；可使用相同或不同模型，不能绑定具体模型简称。视觉质检默认关闭，开启只在交付后提供建议。
- 尺寸统一优先级：本轮文字明确尺寸 > 当前精确自定义宽高 > 本轮主基线图比例 > Agent 规划 > 后台默认。保持原尺寸属于明确文字约束；场景风格参考不是主基线。
- `auto` 表示未锁定，不能转换成能力列表首项或平台固定比例；不新增任意像素、宽高比、重试次数或等待常数。
- 上游原生文件与落盘文件分别记录；复用既有源尺寸继承、真实解码、尺寸规范化、原生蒙版和媒体权限能力。不能用拉伸、裁切、补边或插值证明原生高分辨率与局部保真。
- 固定镜头局部编辑必须有可信区域及独立蒙版；蒙版能力按真实 provider 协议判断，不支持时待复核或走已验证的同策略候选，禁止静默整图重绘。
- 真实媒体解码、尺寸、蒙版像素保护、保存、归属与父链属于技术交付门禁。视觉模型的身份、结构、材质和审美判断仅为可选建议，不撤回已交付图片；不确定或不可用不伪造通过。研发人工发现真实商品失真仍可否决升级发布。
- 用户原话、内部分析、计划、执行请求、验收和公开消息分开，业务证据服务端持久化；普通用户不见内部输出。
- 沿用稳定 Run/任务/结果/父结果身份与上游幂等恢复。QA 失败不自动重新生图，提交结果不明不切渠道重发。
- 每项完成先更新待测试清单；用户确认后才更新正式能力说明。公开提交只写业务与技术，不包含环境地址、目录、数据库、账号、凭据或真实会话 ID。

## 证据与优先级

既有测试、审查和部署数字属于各自固定提交的历史证据。参考用途与分析可靠性增量另行登记，历史绿色结果不直接作为该增量的最终通过证明；复用证据须核对相同源码字节、执行条件和覆盖范围。自动回归、真实供应商表现、人工检查和用户验收分别记录。

真实场景局部编辑样本的主基线为 3840×2160，前三轮输出为 2880×2880、3312×2480、3520×2352，第四轮才恢复 3840×2160。第一轮 QA 发现裁切却误描述方向；第三轮 QA 将变化后的画幅判为保持。第二轮未见电商流水。另一个柜体样本把三层抽屉误判为四层，错误进入规划与验收。

立项时源码显示：`createEcommerceSceneEditTask` 的 ratio 来自生成偏好；自然语言保持尺寸尚未构成硬画布字段；`scene_edit` 编译没有独立蒙版；场景基线会将商品硬检查整体置为 N/A；场景结果血缘仍依赖商品锚点。以上是本方案的历史输入证据，现已按 Task12–18 接通相应契约与自动回归；实际供应商与用户验收仍按分项记录，不能将立项缺口继续写为当前待实现。

| 任务   | 依赖                        | 独立交付             |
| ------ | --------------------------- | -------------------- |
| Task12 | 既有尺寸/媒体基础能力       | 真实画幅门禁         |
| Task13 | 既有 Run/资产/分支存储      | 无商品锚点连续编排   |
| Task14 | Task12、Task13              | 场景蒙版与保护执行   |
| Task15 | Task12；范围检查接入 Task14 | 事实复核与硬/软验收  |
| Task16 | Task15；区域证据接入 Task14 | 用户状态和管理员流水 |
| Task17 | Task14–16                   | 材质与摄影规划       |
| Task18 | Task12–17                   | 综合回归与发布证据   |

Task12 和 Task13 可独立交付；后续按表中依赖逐项上线。黄金案例随每项扩充，Task18 汇总验收，不允许前面任务没有测试先上线。

复选框按该步骤实际范围更新：实现或自动回归完成不等于真实供应商和用户验收完成。各项最新证据与未完成边界集中记录在分项验收索引；有效失败、根因、固定修复、复审和部署里程碑同步会话记忆及私有记录。

无商品锚点连续编辑保留固定“再生成”原话。若实际局部策略等待可信位置，浏览器应确认原任务后继续并核对根图、父结果及分支；不得换全局改光输入或取消门禁来取得通过。Worker 三入口鉴权已取得有效失败与修复通过，综合门禁及部署仍以分项验收索引的最新终态为准。

## 契约增量与版本接续

下列契约已按 Task12–17 分项接入 `ecommerce-edit-plan.ts`，实际运行沿任务不可变版本快照；实现状态与真实验收按各任务记录，不将内部契约描述为用户公开 API。复用既有 EcommerceOperation 与 EcommerceManualRegion。输入尺寸均由服务端真实解码或已有参数解析获得，不使用 LLM 猜测宽高。

```ts
type EcommerceDimensions = { width: number; height: number };
type EcommerceCanvasConstraint = {
  mode: "exact" | "ratio";
  size: EcommerceDimensions;
  source: "user_text" | "explicit_size" | "baseline" | "planning" | "default";
  allowReframe: boolean;
};
type EcommerceCanvasInput = {
  operation: EcommerceOperation;
  userRequest?:
    | { mode: "preserve" }
    | {
        mode: "exact" | "ratio";
        size: EcommerceDimensions;
      };
  explicitSize?: EcommerceDimensions;
  baselineSize?: EcommerceDimensions;
  planningSize?: EcommerceDimensions;
  defaultSize?: EcommerceDimensions;
};
type EcommerceVisibleStructure = {
  objectId: string;
  feature: "drawers" | "doors" | "handles" | "legs";
  count: number | null;
  certainty: "confirmed" | "uncertain";
  evidenceRegion: EcommerceManualRegion; // 主基线像素坐标
};
type EcommerceEditProtection = {
  scope: "local" | "global";
  protectedObjectIds: string[];
  preserveOutsideMask: boolean;
  allowLightingChange: boolean;
};
type EcommercePhotographyPlan = {
  materials: Array<{
    objectId: string;
    textureDirection: string;
    textureScale: string;
    roughness: string;
    gloss: string;
  }>;
  lighting: {
    keyLight: string;
    fillLight: string;
    whiteBalance: string;
    contactShadow: string;
  };
  composition: {
    focalSubject: string;
    depth: string;
    negativeSpace: string;
  };
};
```

EditPlan 增量字段统一命名为 `canvas?: EcommerceCanvasConstraint`、`protection?: EcommerceEditProtection`、`visibleStructure?: EcommerceVisibleStructure[]` 和 `photography?: EcommercePhotographyPlan`。局部编辑必须有 protection；已解析出画幅约束时必须保存 canvas；可见结构为空时不得宣称完成结构保真核验。字段在对应 Task 中逐项接入，不要求未部署的后续任务先填空壳数据。

增量以契约版本和不可变任务快照保存，更新 normalizer、validator、structured schema 与持久化 round-trip，禁止仅在 prompt 加文字。已开始任务沿用原快照，不能受后台模型或策略变化覆盖。媒体证据及 QA 明细进入内部快照，不进入用户公开消息。

## 参考用途与分析可靠性补充

R1 事实/用途契约和 R2 规划、编译、独立验收及流水接线已固定至 `dccd937` / `3e31554`。R3 的代码、相关回归与完整差异两轴复审，以及 R4 的全量/浏览器/Docs 门禁和开发部署，分别登记固定范围及实际证据。开发部署须核对应用与 Worker 版本，不能从合同或单项回归推断已发布；原两图和原指令的真实模型输出、独立验收、人工比较及用户结论分别登记，用户验收待确认。

补充按 R1 事实/用途契约、R2 执行接线、R3 同 Run 确认、分析重试与源核对恢复、R4 门禁及真实验收登记，关联 Task13 连续编辑、Task15 独立验收、Task16 可操作状态和 Task17 摄影规划；最终门禁归入 Task18。原 Task12–18 编号、已完成步骤和历史数字保持原范围。

R3 候选及补修合同沿既有 `resume` 入口提交原 `conversationId` 和互斥 `referenceRecovery`：用途确认为 `reviewId`、`action=confirm_purposes`、`decisionVersion=ecommerce-reference-decision.v1` 与 `bindings`，每个 binding 仅含 `assetId`、`assetVersion`、`purposes`；分析实际失败，或 completed 分析的可靠线索不足以形成任何合法用途组合时，分析重试仅为 `reviewId`、`action=retry_analysis`；原件暂时不可读的源核对恢复仅为 `reviewId`、`action=retry_source`，公开 `kind=retry_source` 提供“重试并继续”。不同时提交 `sceneSelection`，普通继续不能消费参考复核；可选 `inheritedEditTarget` 仅显示继承目标，不成为新增 binding。公开用户只见必要问题、合法用途和素材预览。源恢复及提交前原子任务恢复的前台接线、相关回归与完整门禁按各自固定范围核验。

补充验收要求：

- 近景可给可靠光线、风格或构图线索，`completeScene=false`、原始置信度与实际证据保留；缺商品事实不能确认绕过。
- 明确 A 参考/B 目标、同图多用途、连续目标/商品锚点、实际 mask 和保护范围在分析、计划、编译、QA 与流水中一致。
- 正向商品属性修改得到具体限制和零冲突提交；否定商品修改、仅环境属性编辑及纯风格引用不误拦截，QA 不从辅助参考借商品答案。
- 确认复用合法有效 completed 分析；接管已完成分析也核对原件并复用实际角色路由。原件 GET 暂时失败不得把 completed 分析降为 failed 或清空分析、请求身份与路由；源恢复核同 SHA 后继续且零额外分析请求。分析实际失败，或 completed 分析的可靠线索不足以形成任何合法用途组合时，才单独消费分析重试身份，沿现有角色候选预算；确认或重试不能补造缺失商品事实。
- 并发、重复、过期、越权或素材失效操作仅允许一次合法消费；消费与调度意图一起持久化，刷新、断线和新 Worker 保留同 Run、原消息及检查点。
- 规划及真实图片提交再次核对原始 bytes；已核对原件作为临时上游输入，稳定记录不保存参考副本或内联载荷。只有明确身份/hash 漂移才以 `reference_source_changed` 暂停；源读取或父任务校验存储暂时故障按真实原因处理，失败时零尝试、零图片 POST 且不进入 submitting。
- 提交前上述暂时故障从原 Run 的“检查状态”接续原 child：合法且符合原任务契约的 frozen dispatch、阶段、权限、当前状态与租约，以及未提交、零尝试/账单、无提交时间/上游/结果必须同时满足；recover 与 scheduler CAS 采用同一组准入门禁，`canCheckStatus` 派生复用同一恢复资格，才可原子恢复至 created，核同原件后提交。任一条件不满足均拒绝该提交前恢复。真正漂移仍拒绝；已提交、提交状态未知或已有结果只查询或保存原上游，不能重建 child 或再次提交。实际前台接线及故障窗口门禁按固定回执登记。
- 同批补修合同候选：可恢复 review 项不得被正常 polling/completed 或严格未提交的 created sibling 阻断；正常 sibling 仅继续原任务 GET，不发 recover、不重建。此项执行接线与相关回归单列固定证据，文稿候选不能代作已测试结论。
- 最终完整自动门禁与固定差异两轴复审分别记录；其后登记测试发布、原两图及原指令真实生成、视觉检查和用户结论，不称受控摄影 A/B 或整个 SOP 完成。

详细契约与状态见[电商生成 SOP](../specs/2026-09-23-ecommerce-product-generation-sop.md)和[分项验收记录](ecommerce-edit-quality-acceptance.md)。

### Task12：原尺寸与画幅硬契约

**Files:**

- Modify: `web/src/lib/server/ecommerce-edit-plan.ts`
- Modify: `web/src/lib/server/ecommerce-edit-planner.ts`
- Modify: `web/src/lib/server/ecommerce-image-compiler.ts`
- Modify: `web/src/lib/server/ecommerce-generation-service.ts`
- Modify: `web/src/lib/server/ecommerce-quality-check.ts`
- Test: `web/src/lib/server/ecommerce-edit-plan.test.ts`
- Test: `web/src/lib/server/ecommerce-quality-check.test.ts`
- Test: `web/src/lib/server/ecommerce-image-compiler.test.ts`

**Interfaces:**

- 新增 `resolveEcommerceCanvasConstraint(input: EcommerceCanvasInput): EcommerceCanvasConstraint | null`，放在契约模块；返回最高优先级的确定性约束，无法确定时保留未锁定。
- 新增 `evaluateEcommerceCanvas(constraint: EcommerceCanvasConstraint, nativeSize: EcommerceDimensions, storedSize: EcommerceDimensions): { hardFailures: string[]; nativeMatches: boolean; storedMatches: boolean }`，放在质量检查模块；exact 比较宽高，ratio 比较实际比例。落盘不符合约束或原生画幅已改变即产生 canvas_geometry 硬失败；同画幅规范化不掩盖 nativeMatches=false，其插值与局部合成情况单独记录，不能通过原生分辨率验收。
- 编译器与 `createEcommerceSceneEditTask` 消费同一画布约束；任务内部保存请求/原生/落盘尺寸和约束来源。

- [x] **Step 1：固定冲突测试**

```ts
expect(
  resolveEcommerceCanvasConstraint({
    operation: "scene_edit",
    userRequest: { mode: "preserve" },
    explicitSize: { width: 3000, height: 2000 },
    baselineSize: { width: 3840, height: 2160 },
  }),
).toMatchObject({
  mode: "exact",
  size: { width: 3840, height: 2160 },
  source: "user_text",
  allowReframe: false,
});
```

补充无文字时精确自定义优先、无自定义时 scene_edit 锁定主基线、product_to_scene 继承主图比例、auto 未锁定、风格参考不夺取画幅、非正整数拒绝。

- [x] **Step 2：运行定向测试确认缺口**

在仓库根执行：`pnpm -C web exec vitest run src/lib/server/ecommerce-edit-plan.test.ts src/lib/server/ecommerce-image-compiler.test.ts src/lib/server/ecommerce-quality-check.test.ts`。预期新增保持尺寸断言失败，不能用旧测试全绿代替。

- [x] **Step 3：接通计划、编译、任务与文件验收**

把 resolve 的结果写入版本化 EditPlan 和任务快照；实际尺寸与自然语言冲突时以 resolve 结果编译。保持原尺寸却无法取得主基线尺寸时待复核，不选默认比例。保留原生文件证据；同画幅规范化可复用已有流程，但改变构图的裁切/补边不能让硬检查通过。原生与落盘检查独立，不能用放大后的宽高声明原生 4K。

- [x] **Step 4：运行真实尺寸反例**

```ts
expect(
  evaluateEcommerceCanvas(
    {
      mode: "exact",
      size: { width: 3840, height: 2160 },
      source: "baseline",
      allowReframe: false,
    },
    { width: 2880, height: 2880 },
    { width: 2880, height: 2880 },
  ).hardFailures,
).toContain("canvas_geometry");
```

同时验证 QA 文本写 passed/竖幅也不能覆盖实际尺寸。完成服务端保存和读取 round-trip。

- [x] **Step 5：记录交付证据**

定向测试全部通过后保存请求与文件尺寸对照，将该任务移入待测试清单；单独提交中文变更“修复电商编辑尺寸契约与真实画幅验收”。发布/PR 必须遵循当时用户授权。

**实施证据：** Task12 代码与同模型独立规格/质量复审通过；请求链回归 219 项、最终 mapper 相关 69 项、协议回归 144 项与隔离 PostgreSQL 9 项通过。最终测试构建通过，完整电商浏览器矩阵 16 passed / 23 按项目范围 skipped。原生文件与落盘文件独立检查；实际请求尺寸写入内部证据。当前不能表达画布约束的适配器提交前待复核，未猜测供应商能力。已部署开发应用与 Worker。真实上游请求 1024×1024 却返回原生/落盘 1254×1254，确定性画幅硬失败覆盖视觉 passed，结果 blocked，拦截反例通过；供应商精确尺寸正例、原生 4K 与用户人工验收仍未完成。详情见 [分项验收索引](ecommerce-edit-quality-acceptance.md)。

**独立验收：** 保持 3840×2160 的请求不会生成成功状态的方图/3:2 图；真实上游不支持时清楚显示待复核，旧 text-to-image 的 auto 行为不变。

### Task13：无商品锚点的场景连续编辑

**Files:**

- Modify: `web/src/lib/server/agent-run-store.ts`
- Modify: `web/src/lib/server/agent-run-executor.ts`
- Modify: `web/src/lib/server/ecommerce-generation-service.ts`
- Modify: `web/src/lib/server/ecommerce-reference-roles.ts`
- Modify: `web/src/lib/server/ecommerce-generation-snapshot.ts`
- Test: `web/src/lib/server/ecommerce-continuity.test.ts`
- Test: `web/src/lib/server/agent-run-store.test.ts`

**Interfaces:**

- 保留 `selectCurrentSceneBaseline(conversationId, explicitResultId?, userId?)` 签名，内部按场景根资产、父结果、分支、实际技术交付与合法归属选择；商品锚点仅在存在商品来源时要求。Task19 新策略不要求视觉 QA passed。
- 内部 continuity 快照增加 `sceneRootAssetId: string | null`；沿用 `parentResultId` 和 `branchId`。所有素材读取校验 userId 与 conversationId。
- executor 使用有效图像引用/基线决定是否编排；LLM 的意图分类不能取消已建立的图片编辑链。

- [x] **Step 1：固定最小连续案例**

在现有 continuity fixture 中创建同用户同对话的场景根资产和已验收 scene_edit 结果，productAnchorId 为 null：

```ts
expect(
  await selectCurrentSceneBaseline(
    "conversation-scene-case",
    undefined,
    "user-scene-case",
  ),
).toMatchObject({ id: "asset-scene-passed" });
```

补充明确历史结果分支、跨用户拒绝、跨对话拒绝、真实技术失败或未交付结果不继承；已技术交付的视觉待调整结果可默认继承，已有报告保留，缺报告不补造。

- [x] **Step 2：运行缺口测试**

`pnpm -C web exec vitest run src/lib/server/ecommerce-continuity.test.ts src/lib/server/agent-run-store.test.ts src/lib/server/agent-run-executor.test.ts`。预期无商品锚点继承与简短续写断言先失败。

- [x] **Step 3：接通场景血缘**

拆开商品锚点校验和场景根来源校验，保留已有资产归属、父结果和分支规则。第一次上传场景图建立根来源，后续无附件“重新生成”“再加一个花瓶”沿用当前通过的基线；新图建立新根，明确选旧图建立分支，不根据 prompt 文本猜图。

- [x] **Step 4：验证编排与持久恢复**

本地 fixture 记录两轮独立 taskId、相同场景根和正确父结果，断言两轮都有分析/规划/生成/验收流水；刷新及 Worker 恢复不得重新创建已提交上游任务。纯文生图没有图片引用/基线时保持原行为。

- [x] **Step 5：记录交付证据**

保存根资产/父结果/分支对照和定向测试结果，更新待测试清单；中文提交“修复场景连续编辑血缘与编排继承”。

**实施证据：** 代码与同模型独立规格/质量复审通过。首次相关 10 文件 159 项，审查修复后 7 文件 134 项定向测试通过；类型、改动文件 Lint、格式、差异及严格 UTF-8 检查通过。真实文件 Provider 回归覆盖无商品场景根、两轮独立任务、准确父结果、待调整结果不自动继承、显式历史分支保留父 QA、查询失败后复用已提交任务，以及运行中 v1 快照不升级。明确旧场景加新场景风格图保留旧基线、父链与旧画幅；当时的场景编译/执行接口只支持单主场景，此组合在该版本提交前待复核，恢复不创建上游图片任务；这是历史契约限制，不能描述为供应商模型限制。参考用途增量按冻结用途保留目标并映射新参考，其验证单独登记。本轮非图片附件不会被无附件续写逻辑截获。Task18 已补齐隔离 PostgreSQL、真实鉴权 Route/页面刷新与跨进程 Worker 自动证据；对应历史源码整体门禁见 Task18，真实供应商效果和部署后用户验收仍待，不将自动夹具等同人工结论。

**独立验收：** 上传完整家居场景后连续一句话修改，每轮都进入编排，最近已技术交付结果被正确引用，历史图片不覆盖；关闭视觉质检也能续写。

### Task14：场景局部蒙版与不可变区域保护

保护执行代码与范围判定修复已通过同模型独立规格/质量复审；分项定向回归 170 项通过。并列禁止默认继承禁止，“把/将”不作为扩大范围授权；明确独立的改光指令仍可全局编辑。Task15/16 已实现结构材质质检、用户选区和安全等待态，Task18 已取得 TCP/PNG、真实鉴权确认、页面及 PostgreSQL 双进程/重启恢复自动证据；当前整体门禁见 Task18。真实供应商选区内语义、视觉效果、部署后人工与用户验收仍待，不能标为整体业务验收完成。详见[分项验收记录](ecommerce-edit-quality-acceptance.md)。

**Files:**

- Modify: `web/src/lib/server/ecommerce-product-regions.ts`
- Modify: `web/src/lib/server/ecommerce-image-compiler.ts`
- Modify: `web/src/lib/server/ecommerce-generation-service.ts`
- Modify: `web/src/lib/server/ecommerce-image-task-orchestration.ts`
- Test: `web/src/lib/server/ecommerce-product-regions.test.ts`
- Test: `web/src/lib/server/ecommerce-image-compiler.test.ts`
- Test: `web/src/app/api/image-tasks/route.test.ts`

**Interfaces:**

- 增加契约 `EcommerceEditProtection`，scene_edit 的 local 范围要求独立蒙版与保护证据。
- 编译器复用 `EcommerceCompiledImageRequest.mask`；scene_edit 的 local 模式也要求 `{ mode: "independent", required: true }`。
- 区域模块复用现有生成/校验与合成能力，保存源尺寸、蒙版尺寸、目标区域、语义、选区外保护方法及差异证据。

- [x] **Step 1：固定局部请求反例**

使用现有 provider profile fixture：

```ts
expect(
  compileEcommerceImageRequest(localScenePlan, maskedProfile),
).toMatchObject({
  state: "ready",
  mask: { mode: "independent", required: true },
});
expect(
  compileEcommerceImageRequest(localScenePlan, unmaskedProfile),
).toMatchObject({
  state: "needs_review",
  reason: "independent_mask_unsupported",
});
```

localScenePlan 为加柜面花瓶的 scene_edit，scope=local、preserveOutsideMask=true；两个 profile 仅独立蒙版能力不同。

- [x] **Step 2：验证现有缺口**

`pnpm -C web exec vitest run src/lib/server/ecommerce-product-regions.test.ts src/lib/server/ecommerce-image-compiler.test.ts src/app/api/image-tasks/route.test.ts`。预期 scene_edit 独立蒙版断言失败。

- [x] **Step 3：发送真实蒙版并保护原图**

将目标区域映射为主基线像素坐标，按 provider 的真实黑白/alpha 语义编译。矩形提示不等于可信语义蒙版；多个目标有歧义时只追问一个问题。柜体门板、抽屉、把手和非目标背景应保护；新增物体及其接触阴影可进入明确的允许区域。固定镜头使用主基线合成选区外像素，保留原坐标，不在非选区重采样。

- [x] **Step 4：自动验证执行保护**

本地 TCP fixture 已检查请求同时有完整源图与独立蒙版，而非裁片冒充主图；确定性 PNG fixture 已断言选区外像素恢复一致。真实鉴权选区确认、页面恢复与 PostgreSQL 双进程回归由 Task18 接续完成。损坏、错尺寸、反向蒙版或不支持协议不得产生局部成功状态。全局改光或视角变化必须明确 scope=global，不作像素不变承诺。真实供应商视觉样本的蒙版、生成原件、合成差异及家具语义仍需单独验收，自动检查不代替此项。

- [x] **Step 5：记录交付证据**

保存 provider 请求形态、保护结果和定向测试，移入待测试；中文提交“增加场景局部蒙版与选区外保护”。

**独立验收：** “只加柜面花瓶”不改变柜门/抽屉结构与两侧环境，蒙版和保护方法有可查证据；不能用整图变好看替代局部保护。

### Task15：可见结构事实与独立结果验收

> 以下已完成步骤和数字记录当时的视觉硬门禁实现。当前交付行为由 Task19 替代：真实技术失败拦截，视觉模型判断只建议；历史证据不重新计为本轮通过。

参考用途增量要求独立 QA 只从目标或商品锚点建立商品标准，辅助图仅参与获准风格、光线或构图比较；缺观察与已知硬失败仍拦截，规划和参考图不能提供商品答案。

实现与统一修复已通过同模型独立规格/质量复审，分项审查问题关闭，已随 `753cefd` 开发部署；本轮 QA 契约说明增量已随 `89ca22d` 开发部署。新任务使用 v4 结构契约与 v2 独立质检；已开始的旧任务沿原 schema 和快照执行，合法 v3/v4 待选区任务继续支持同 Run 确认。分项修复回归 3 文件、162 项通过，类型、改动 Lint/格式、完整任务 UTF-8 与隐私检查通过。必要保护对象必须有两侧独立观察；同结果原生与落盘媒体分别保留已知失败，没有当前或耐久真实尺寸事实的不可读侧匹配为 null，不造尺寸。Task16/18 已接通管理员新证据投影并取得 PostgreSQL、鉴权 TCP、浏览器和 Worker 恢复自动证据；新批次与合法旧 native 事实接续见 Task18。真实视觉准确性、实际候选模型切换、高分辨率多图及用户验收仍待，不以夹具结果证明真实视觉能力。

**Files:**

- Modify: `web/src/lib/server/ecommerce-edit-plan.ts`
- Modify: `web/src/lib/server/ecommerce-visual-analysis.ts`
- Modify: `web/src/lib/server/ecommerce-edit-planner.ts`
- Modify: `web/src/lib/server/ecommerce-quality-check.ts`
- Modify: `web/src/lib/server/ecommerce-generation-snapshot.ts`
- Test: `web/src/lib/server/ecommerce-quality-check.test.ts`
- Test: `web/src/lib/server/ecommerce-edit-plan.test.ts`

**Interfaces:**

- 增加 `EcommerceVisibleStructure[]` 及源图证据；不确定数量为 null，不能臆测遮挡处数量。
- 扩展既有质量检查键：`canvas_geometry`、`protected_structure`、`protected_material`、`unmodified_region`；沿用既有检查项状态与 QualityCheck 总状态。
- 扩展 `checkEcommerceResult` 输入，接收主基线/原始商品锚点（有则传）、结果整图、关键区域裁片和确定性媒体/保护证据。裁片仅用于内部 QA，不替代上游生图主参考。
- 更新 `ecommerceQualityGate`：硬失败 blocked、软失败 needs_adjustment、不可检查 unavailable/needs_review；不得以场景 role 将所有硬检查 N/A。

- [x] **Step 1：固定“规划也错”的反例**

本地 QA fixture 分别给基线三层抽屉、计划误写四层、结果三层与四层。QA 必须重新观察基线，不能把四层计划当答案：

```ts
expect(threeDrawerResultQuality.hardFailures).toHaveLength(0);
expect(fourDrawerResultQuality.hardFailures).toEqual(
  expect.arrayContaining([
    expect.objectContaining({ key: "protected_structure", status: "failed" }),
  ]),
);
```

补充场景基线家具结构依然适用、源图没有 Logo 时可 N/A、有 Logo 却无法阅读时待复核。

- [x] **Step 2：运行缺口测试**

`pnpm -C web exec vitest run src/lib/server/ecommerce-quality-check.test.ts src/lib/server/ecommerce-edit-plan.test.ts`。预期场景硬检查和结构反例先失败。

- [x] **Step 3：独立取证并合并门禁**

分析阶段给结构计数附基线区域；QA 独立观察基线及结果的整图/对应裁片。原图、分析、计划和 QA 有矛盾时保存矛盾与证据，不互相覆盖。真实尺寸由 Task12 提供，选区保护由 Task14 提供；确定性失败优先，不允许 LLM passed 覆盖。结构身份、被保护材质/色彩变化为硬失败；构图摄影审美为软项。

- [ ] **Step 4：验证恢复和模型切换**

换 vision_analysis、edit_planning、quality_check 的候选模型后仍适用相同门禁，保存实际角色快照。检查质检请求图片数量/字节通过既有 boundEcommerceVisionImage 控制；解析失败、图像不可读、结构不确定按待复核，不自动新生图。模型相同可运行，模型不同也不自动视为更可信。

自动恢复、不可读/解析失败、请求预算和不可变快照已有 Task18 证据；本步骤尚未完成的是实际供应商候选切换后的视觉核验，不再将 PG、页面或管理员投影列为待实现。

- [x] **Step 5：记录交付证据**

保存每个硬/软检查的原因、来源和局部证据，更新待测试；中文提交“完善家具结构事实与独立验收门禁”。

**独立验收：** 三层变四层、柜门/把手变化、画幅变化不会因场景美观而 passed；没有商品锚点也能检查要保护的家具。

### Task16：公开验收状态与管理员可观测流水

> 以下步骤保留历史验收状态投影及验证证据。Task19 将交付状态与可选视觉建议分开，已技术交付结果不会因报告失败或不可用退回。

参考用途增量的可操作状态区分用途确认、分析重试、保留 completed 分析的源核对恢复、提交前原 child 检查状态、商品事实不足和真正原图变化；分析实际失败，或 completed 分析的可靠线索不足以形成任何合法用途组合时，才提供 `retry_analysis`，不能清空合法有效分析或补造缺失商品事实。公开 DTO 保持白名单，原 Run“检查状态”由服务端派生 `canCheckStatus`，普通 resume 接续可恢复 review child 的 recover，不暴露 child 内部 ID。同批正常 polling/completed 或严格未提交的 created sibling 仅继续原任务 GET，不发 recover、不重建，也不阻断可恢复 review 项；这是补修合同候选，其执行证据单列核验。管理员流水保留事实、用途来源、采用线索、图片顺序及各已完成阶段。R3 候选及补修入口的完整 Route/GET/SSE/页面与持久恢复证据按固定范围登记，不把临时基础设施故障显示为素材漂移。

**实施状态：** 公开状态、可信用户选区入口、首页合格媒体筛选与管理员证据投影已实现；完整任务及 SQL 明确空状态发布修复通过同模型独立规格/质量复审。分项定向合集 258 项通过，修复覆盖 61 项通过；隔离 PostgreSQL 25 类矩阵及三个具名空状态反例共 4 项通过。Task18 已补桌面/390px/430px 与深浅主题公开 DTO 交互、真实鉴权等待态→确认→同任务提交、管理员耐久回读及 PostgreSQL 双进程/Worker 恢复自动证据。DTO 模拟、真实 Route 与 Worker 的证据分别记录，固定 `89ca22d` 的历史增量已开发部署，部署后人工与用户验收仍待。

**Files:**

- Modify: `web/src/lib/server/ecommerce-generation-snapshot.ts`
- Modify: `web/src/lib/server/agent-run-public.ts`
- Modify: `web/src/app/(user)/create/components/creative-generation-waiting.tsx`
- Test: `web/src/lib/server/agent-run-public.test.ts`
- Test: `web/e2e/ecommerce-product-generation.spec.ts`
- 管理员流水沿用 Task10A 的现有读取与详情界面，不另建一套日志服务。

**Interfaces:**

- 复用公开 `qualityCheck.publicStatus`，映射 passed→已完成、needs_adjustment→需要调整、needs_review→待复核；不能只依据生成任务 completed。
- 内部快照提供画布来源/请求/原生/落盘尺寸、场景根/父结果/分支、区域/蒙版/保护证据、结构事实、QA 检查、角色模型与失败原因。
- 硬失败结果不作为合格输出发布；软失败可保留带标记预览，默认基线选择沿用 Task13。显式重试使用原任务快照，不拼接内部日志给普通用户。

- [x] **Step 1：固定状态反例**

```ts
// 既有 public serializer 的真实 Run fixture：
expect(publicRun.qualityCheck.publicStatus).toBe("needs_adjustment");
// 浏览器对该 fixture 必须显示“需要调整”，不能显示“已完成”。
expect(JSON.stringify(publicRun)).not.toContain("textureDirection");
expect(JSON.stringify(publicRun)).not.toContain("compiledPrompt");
```

补充 unavailable→待复核、hard failure 不合格、管理员能看到证据且普通用户无权读取详情。

- [x] **Step 2：运行缺口测试**

`pnpm -C web exec vitest run src/lib/server/agent-run-public.test.ts src/lib/server/ecommerce-quality-check.test.ts`，以及 `pnpm -C web exec playwright test e2e/ecommerce-product-generation.spec.ts --project=chromium`。预期 completed+needs_adjustment 的文案断言先失败。

- [x] **Step 3：统一状态与详情**

后台每轮可查看分析、规划、编译/生图、验收及实际证据；用户只看到简短公开状态和一句可执行建议。软失败给明确调整入口，质检暂不可用给复核状态，不增加自动重生图。现有调用记录和 Run/任务/结果相互关联，模型响应与传输错误区分保存，敏感字段沿用既有脱敏。

- [x] **Step 4：自动验证服务端恢复**

刷新、对话切换、移动端 390px/430px 与管理员日志回读自动验证同一验收状态；无浏览器业务缓存。公开 DTO 深浅主题交互与真实鉴权确认/恢复分别有证据，用语义定位点击，不用 force 或固定延时掩盖失败。部署后的实际用户人工体验继续待验收。

- [x] **Step 5：记录交付证据**

保存状态映射、权限断言与截图，移入待测试；中文提交“统一电商验收状态与任务证据展示”。

**独立验收：** 不再把“需要调整”显示为普通完成；管理员能从一条任务看到为什么失败、引用哪张图和实际执行参数。

真实局部确认在图片请求提交前因当前协议不支持可信独立蒙版进入 needs_review，没有发出生图请求。原 Agent 丢失子任务 reviewReason，导致泛称上游创建状态未知；`970bd6d` 透传既有安全原因，并在 run.paused 时将已保存复核原因持久化到原助手消息。修复仅影响新执行路径，不迁移历史消息，不改变调度、同任务身份或自动重发规则；空缺或非法原因沿安全回退。

### Task17：家居材质与摄影质感规划

近景辅助参考可提供局部可靠摄影线索；原图事实、参考用途和本轮摄影目标分别保存，不能把新光线回填为原图事实，或以材质外观线索授权商品改材质。连续局部编辑继续受原目标画幅和保护范围约束。

**实施状态：** 新摄影计划 v5、分析事实 v3 和摄影 compiler v3 已贯通规划、执行快照、实际图片任务创建校验、独立 QA 与 Trace；完整实现及主光/补光/白平衡授权词表修复通过同模型独立规格/质量复审。分项定向 13 文件、383 项通过，无跳过，类型与必要静态检查通过；两项既有 Trace Lint 提示已在分支收尾中关闭。合法旧 v3/v4 确认与 v4 独立结构验收保持原契约。Task18 已补摄影字段的 PG/双进程、鉴权 TCP/页面与 Worker 恢复自动证据，当前整体门禁仍按固定源码记录。已随 `753cefd` 开发部署并生成首个真实摄影样本；受控摄影比较未完成，不能以提示词、fixture 或单样本复检证明质感提升。

**Files:**

- Modify: `web/src/lib/server/ecommerce-edit-plan.ts`
- Modify: `web/src/lib/server/ecommerce-visual-analysis.ts`
- Modify: `web/src/lib/server/ecommerce-edit-planner.ts`
- Modify: `web/src/lib/server/ecommerce-image-compiler.ts`
- Modify: `web/src/lib/server/ecommerce-quality-check.ts`
- Test: `web/src/lib/server/ecommerce-edit-planner.test.ts`
- Test: `web/src/lib/server/ecommerce-image-compiler.test.ts`
- Test: `web/src/lib/server/ecommerce-quality-check.test.ts`

**Interfaces:**

- 增加可选 `EcommercePhotographyPlan`；分析记录原始材质和光线事实，规划只给本轮允许变化的摄影目标，compiler 按 provider 能力编译。
- QA 使用 `protected_material` 验证保留项，`composition_lighting`/scene_intent 验证主补光、接触阴影、空间和风格目标；不新增“高级感总分”替代具体检查。
- 基线本身质感良好、用户仅加摆件时，摄影计划优先保持现有光线与材质；全局优化需要用户本轮意图及相应 scope。

- [x] **Step 1：固定材质和范围案例**

```ts
expect(photographyPlan.materials[0]).toMatchObject({
  objectId: "cabinet",
  textureDirection: "沿原图木纹方向",
  gloss: "保留原有低光泽",
});
expect(localPropPlan.protection).toMatchObject({
  scope: "local",
  allowLightingChange: false,
});
```

fixture 为木边柜加花瓶，不能默默新增台灯照明、改变柜体颜色或重画木纹。白底商品到场景另设可生成环境光/接触阴影的案例。

- [x] **Step 2：运行规划与编译反例**

`pnpm -C web exec vitest run src/lib/server/ecommerce-edit-planner.test.ts src/lib/server/ecommerce-image-compiler.test.ts src/lib/server/ecommerce-quality-check.test.ts`。预期材质目标与局部不改光断言先失败。

- [x] **Step 3：生成有边界的摄影计划**

逐项给出木纹方向/尺度、粗糙度/光泽、主光方向/面积、补光与白平衡、接触阴影、商品明度层次、留白和空间纵深。仅使用可见事实；场景参考借鉴空间、光线和风格，不覆盖商品。禁止套用统一暖黄滤镜、油亮高光、过锐化或夸张豪华装饰。局部加摆件的光影融合限制在允许区域。

明确全局调整主光、补光或白平衡可执行本轮目标；仅改光不自动授权换机位/构图，仅改机位也不授权改光。保持、并列禁止和局部范围由服务端继续收紧，不能让规划模型解除保护。材质目标来自可信商品锚点或主基线，旧快照不补造摄影事实。

- [ ] **Step 4：做独立效果比较**

同一素材、同一用户指令和相同模型/尺寸/保护策略，对比基础规划与摄影规划，人工复核商品保真、纹理、光泽、接触阴影、色偏、空间层次和需求完成。真实上游调用需在执行阶段确认授权，并单独记录；不可把 fixture 提示词断言当真实质感提升。保真门禁不通过的图片不参加“更美观”评选。

既有摄影样本与旧基准的角色条件不同，跨条件结果不称受控 A/B。比较需另取得同源、同原话、同实际角色模型、尺寸和保护策略的合格样本；人工与用户结论仍待。

首个新摄影样本已真实生成并保存，原 QA 的基线/结果 `readable=false` 使验收 unavailable，历史任务仍暂停。`a3e6805` 仅澄清 readable 表示整张实际图片足以独立视觉检查，无文字/Logo 不等于不可检查；不强制布尔、不放宽硬门禁。原计划、源图、结果与角色冻结后完成一次私有同图 QA 复检，两侧原始 readable=true、质量 passed；只计算 publish 决策，未执行发布、重新生图或改写历史 paused/助手消息。单样本不证明原 false 的原因、普遍有效或受控质感提升；独立 HTTP 传输采集仍有缺口，不能以捕获计数 0 推断无请求或供应商验收完成。

- [x] **Step 5：记录实现交付证据**

实现、分项回归和复审证据已按稳定案例索引移入待测试，中文实现提交已完成。真实摄影参数对照及人工结论仍待 Step 4 补齐，不提前填入通过结论。

**独立验收：** 背景与新物体融合自然，木纹/织物尺度、低光泽和阴影可信；没有为了高级感改变商品或整图染黄。

### Task18：黄金回归与逐项上线

参考用途增量另登记完整源码范围、File/PostgreSQL/Route/Worker/浏览器门禁及完整差异复审，passed/skipped/failed/notrun 分开；作者单测、收集到的必跑身份及历史绿色均不代替最终实际执行。测试发布、原两图与原指令真实生成、人工视觉和用户验收保持待完成状态，具体见分项验收记录。

**完整批次验收补充：** 全分支复审发现普通电商多图准备会过滤读取或保存失败项，导致仅对幸存结果验收。结果准备改为成功媒体与完整批次证据的直接接口；原始槽位身份、实际原生尺寸、读取/解码/保存状态与安全原因耐久保存。验收覆盖完整批次，全不可用也安全待复核；已解码尺寸违规不被后续读取失败抹除，不退款、重建或自动生成新上游任务。该范围从执行器实际收到的结果开始，不声称覆盖协议解析之前的去重行为。公开投影使用白名单，管理员证据与原 child/upstream 恢复分别验证。

**合法旧原生事实接续：** 旧 v4/compiler.v2 媒体无新批次证据但已有真实 `canvasEvidence.nativeSize` 时，Agent 两处媒体投影透传既有尺寸，QA 当前实际解码优先；失败时先消费新批次真实事实，再用可信旧媒体事实。公开原本仍 needs_review/pause，此修复补回丢失的尺寸及具体硬失败，非发布绕过修复。wrong 继续 blocked/canvas_geometry，valid 但当前落盘或视觉不可读仍 unavailable，无原生事实仍 unknown。旧任务不补 batch/身份/序号、不升级版本、不改媒体或原创建时间，恢复同 child/upstream，不退款或重发。六个实际 File/runtime/Agent/QA 场景覆盖旧顶层空结果列表与旧非空列表的 wrong/valid/unknown，另有三个 QA 控制；有效 RED 6 failed / 3 passed → 同命令 GREEN 9 passed，均另有 76 项具名过滤跳过。既有相关定向 18 文件/371 项通过、零跳过，不能代替整体门禁。

**历史整体证据：** Task18 业务源码 `e7b2f3c` 的生产构建含类型检查、同 CI 六文件 PostgreSQL 24 项、全量 Web 单元 581 文件/3295 项通过；单元另有 7 文件/25 项环境门控跳过。完整电商浏览器 40 passed / 41 按项目分工 skipped / 0 failed / 0 notrun，固定完整 Task18 两轴复审 Critical/Important/Minor 均零。后续新批次及旧 native 源码变更后，这些整体结果属于历史源码，不能直接视作当前固定分支终态。

**历史已部署基线与 QA/原因增量状态：** 已部署基线 `753cefd` 的源码证据沿固定提交记录：`be869a0` 相对 `5e2385a` 仅修正 PostgreSQL 测试夹具生命周期，应用源码相同；当时的生产构建含类型检查和完整电商浏览器 40 passed / 41 按项目分工 skipped / 0 failed / 0 notrun 证据有效。`be869a0` 的准确六文件 PostgreSQL 25 passed / 0 skipped / 0 failed（145.92s，exit 0）；全量 Web 单元 582 文件 passed / 7 文件 skipped，3331 passed / 26 skipped / 0 failed（254.15s，exit 0）。main 到 `be869a0` 的规格、标准/质量两轴正式复审均通过，Critical/Important/Minor 均零。`753cefd` 已完成 Docs 门禁并部署独立开发环境，应用与 Worker 使用同一镜像，旧媒体保留，生产未变。 后续 `a3e6805` 的 QA 可检查性说明与 `970bd6d` 的复核原因/暂停消息修复已随 `89ca22d` 开发部署，分别取得 97 项和 174 项定向测试通过。`970bd6d` 的生产构建及 pree2e 通过；其完整浏览器中间结果为 30 passed / 1 failed / 42 按项目分工 skipped / 11 notrun。唯一失败已定位为新增用例误读管理员 DTO 的父任务 ID 与可选 attempts 字段，`89ca22d` 仅修正该用例，应用源码相同，既有生产构建证据可复用；修正后的完整三项目电商浏览器为 41 passed / 43 按项目分工 skipped / 0 failed / 0 notrun（7.2m，exit 0），未改变项目跳过逻辑。新增 child-review-reason 实际通过（7.5s），覆盖子任务 GET、安全原因、原助手消息、刷新、同任务身份与零图片 POST。`a3e6805..89ca22d` 固定六文件原因修复的独立复审为 Spec compliant / Approved，Critical/Important/Minor 均零；`89ca22d` 新执行的准确六文件 PostgreSQL 为 6 files / 25 passed / 0 failed / 0 skipped（150.85s，exit 0），不引用旧基线的 25 项作为本轮结果；`89ca22d` 全量 Web 单元新运行 582 files passed / 7 环境门控 files skipped，3361 tests passed / 26 环境门控 skipped / 0 failed（262.38s，exit 0）。固定 `89ca22d` 范围的完整浏览器、准确六文件 PG 与全量单元均已通过；全量非 quiet ESLint 为 0 errors / 1657 条既有基线 warnings，未将通过解释为零警告；全量 Web format、第三方许可证检查及官方 registry 的 Web/Docs audits 均 exit 0，两份 metadata 的 info/low/moderate/high/critical 均为 0。新镜像构建与 Sharp PNG、Standalone、Worker、静态资源验证均已通过；固定 `89ca22d` 已部署独立开发环境，应用与 Worker 使用同一运行镜像，原端口与全部媒体挂载保持，其他服务及生产未变。开发页面刷新后可访问，新建对话准备态及历史生成图片正常；原暂停历史消息未迁移，本次未提交新任务或重跑真实 QA，不能作为新局部编辑或摄影 A/B 验收。历史 QA/原因增量的 Docs 已通过首轮最终文稿验证；文档提交以固定文稿的复审与检查结果为依据。历史门禁不直接计作本轮增量通过，真实供应商与用户验收仍待，不代表整个 Task18、SOP 或生产发布完成。

**夹具准入回归：** 新增真实 TCP 回归取得有效 RED 1 failed / 11 具名过滤跳过 → 同命令 GREEN 1 passed / 11 具名过滤跳过；与原 source-barrier、active image POST 合集 3 passed / 9 具名过滤跳过。清理先停子进程、保留监听排完真实 Route，再关闭准入/连接、最终排完 handler 后处理 owned rows，下一用例复用首次实际端口；原业务断言未变。此修复关闭已复现的准入缺口，原活动 POST 清理失败的具体 handler 尚未确定，不把新回归归作原失败路径证明。

**综合行为证据：** 实际 Worker 四阶段重启、React 暂停订阅和三入口无 Cookie 鉴权保留同任务、原提交时间与唯一创建；原“再生成”、真实选区确认、独立蒙版与合成、历史分支及严格失败过滤已有自动证据。商品场景明确改光保留商品锚点、机位、材质和画幅；亮暗语法的否定控制与非承诺选区外像素 N/A 保持，不取消必需观察或硬门禁。供应商视觉与人工结论独立待验收；正常 Cookie 单次通过不能证明原间歇暂停因果，非 quiet Lint 保留既有警告来源。

**初始化边界：** 同一完整实际 DDL 的 SHA256 指纹在原事务和 advisory 锁内成功登记后，新进程跳过重复 DDL，避免与已就绪认证读取形成锁循环；首次和变更结构仍执行完整初始化。不同结构版本发布与回退需协调应用和 Worker，不承诺无协调在线升级，也不通过重试或预热掩盖问题。

**Files:**

- Modify: `web/e2e/fixtures/ecommerce-product-cases.json`
- Modify: `web/e2e/ecommerce-product-generation.spec.ts`
- Modify: `docs/content/docs/progress/todo.mdx`
- Modify: `docs/content/docs/progress/pending-test.mdx`
- Modify: `docs/content/docs/overview/features.mdx` 仅在用户确认验收后
- Create: `docs/superpowers/plans/ecommerce-edit-quality-acceptance.md` 交付证据索引，不含真实用户/环境信息

**Interfaces:**

- 黄金案例以稳定 caseId 关联源图、用户一句话、操作、保护项、期望画幅/结构、期望 QA 和实际证据。
- fixture 自动回归与真实模型人工验收分列，保存原生/落盘尺寸与基线差异，不混写“已通过”。
- 管理员现有启用开关与任务快照承担发布/回退，不增加手改环境变量要求。

- [x] **Step 1：固定回归表**

| caseId                        | 一句话/输入                     | 预期                                                         |
| ----------------------------- | ------------------------------- | ------------------------------------------------------------ |
| white-product-scene           | 白底家居商品，放到简约客厅      | product_to_scene；商品身份、结构与材质通过                   |
| white-product-style-reference | 商品图+场景风格图               | 商品图是主参考，场景图不能成为商品                           |
| landscape-prop-add            | 3840×2160 场景，只加柜面花瓶    | 同尺寸/同构图，局部蒙版，柜体与选区外保护                    |
| three-drawer-preservation     | 三层抽屉柜，增删背景摆件        | 人工核对真实计数；可选视觉报告只给建议，不撤回技术已交付图片 |
| scene-no-product-continuity   | 无商品锚点场景，随后“再生成”    | 两轮均有编排，根/父结果准确                                  |
| historical-branch             | 明确选历史结果修改              | 创建分支，其他结果不覆盖                                     |
| conflicting-canvas            | 保持原尺寸+界面残留 3:2         | 本轮文字胜出，实际不一致不能 passed                          |
| unsupported-mask              | 局部请求+不支持独立蒙版协议     | 待复核，不整图重绘、不自动重发                               |
| quality-unavailable           | 视觉验收解析失败/技术媒体不可读 | 视觉服务不可用仍交付并如实记录；真实媒体不可读阻断技术交付   |
| soft-quality-failure          | 无技术失败但光线不达标          | 任务完成、图片保留，开启视觉质检时显示参考建议               |
| local-no-relight              | 好质感场景只加花瓶              | 不新增光源，不改全局木纹/色调                                |

- [x] **Step 2：补齐自动断言**

服务端断言请求、媒体尺寸、蒙版、结构门禁、任务血缘和权限；浏览器断言公开状态、显式重试、管理员详情及刷新恢复。确定性 fixture 能模拟结构错误与状态，不声称能证明真实模型理解正确。

- [x] **Step 3：运行历史 QA/原因增量交付门禁**

在仓库根执行：

```bash
pnpm -C web exec vitest run src/lib/server/ecommerce-edit-plan.test.ts src/lib/server/ecommerce-image-compiler.test.ts src/lib/server/ecommerce-product-regions.test.ts src/lib/server/ecommerce-continuity.test.ts src/lib/server/ecommerce-quality-check.test.ts src/lib/server/agent-run-public.test.ts
pnpm -C web exec playwright test e2e/ecommerce-product-generation.spec.ts --project=chromium
```

并执行仓库当前已有的类型检查与质量门禁脚本；共享 PostgreSQL 回归按既有规范关闭文件级并行。只在证据失效、相关代码新增修改或失败未解决时重复检查，不反复运行已确认的无关全量矩阵。

基线 `753cefd` 已完成源码自动门禁、两轴复审、Docs 门禁及应用/Worker 同镜像开发部署，原 `be869a0` 的 PG 25 项、单元 3331 项及对应构建/浏览器证据保留为已完成历史。当前 QA 契约和复核原因增量使本步骤需重新按固定源码收敛；已取得的 97/174 项定向测试、生产构建/pree2e 与 `89ca22d` 完整三项目浏览器 41 passed / 43 项目分工 skipped / 0 failed / 0 notrun 分别记录；固定六文件原因修复复审通过，`89ca22d` 新执行的准确六文件 PG 25 passed / 0 failed / 0 skipped（150.85s，exit 0），全量 Web 单元新运行 582 files passed / 7 环境门控 files skipped、3361 tests passed / 26 环境门控 skipped / 0 failed（262.38s，exit 0）。固定 `89ca22d` 范围的完整自动回归已通过；全量非 quiet ESLint 为 0 errors / 1657 条既有 warnings，Web format、许可证及官方 Web/Docs audits 均 exit 0，实际审计 metadata 五档均为 0；新镜像构建及 Sharp PNG/Standalone/Worker/静态资源验证已通过，`89ca22d` 的应用/Worker 同镜像开发部署已完成；本轮 Docs 首轮最终文稿验证的 types:check、build、精确七文件格式与 UTF-8/隐私/差异检查均 exit 0，本步骤据此勾选；文档提交以固定文稿的复审与检查结果为依据。真实供应商/用户验收另列，不重置原已完成实现或以历史数字填当前通过。

- [ ] **Step 4：真实模型与业务人工验收**

各逻辑生成角色/provider 候选独立记录真实图片编辑能力、蒙版语义和原生分辨率；各 QA 候选执行同一结构/尺寸反例。检查受影响桌面流程与深浅主题；每个案例分别列自动结果、人工结论和限制。任一硬失败拦截该任务灰度升级，不用案例平均分豁免。

- [ ] **Step 5：逐任务发布并同步记忆**

`89ca22d` 已完成开发部署；后续仍按管理员内部启用→小范围灰度→人工通过→默认启用推进，开发部署不代替真实业务或用户验收。每个任务保存功能开关/版本与回退步骤；更新 todo→pending-test，用户确认后更新 features。关键缺陷、能力限制、实际证据和未完成项及时同步 mem0，并保存本地记忆备注；没有服务端确认不写记忆“已入库”。中文提交与 PR 仅在用户授权后执行，GitHub 操作使用 GitHub MCP，公开内容禁止环境与用户隐私。

**独立验收：** 所有案例具备可复核的分项证据，Task12–17 分别可交付；本计划状态依实际实施/用户验收更新，不能因为文档写完把任务勾成完成。

### Task19：技术交付与可选视觉质检

依赖 Task12–16，接替其视觉硬门禁交付语义；保护契约、原生尺寸检查和研发人工验收保留。实施明细见[交付计划](2026-10-05-ecommerce-result-delivery.md)。

- [x] 管理员持久开关默认关闭；每轮冻结 disabled/advisory，关闭角色 null、无 QA 调用或虚构 passed。
- [x] 提取真实媒体解码、尺寸与蒙版检查，技术通过后登记原资产并完成任务，视觉报告只为建议。
- [x] 可选建议复用既有持久后台队列；迟到报告 CAS、局部选区恢复、lease 释放和同身份日志补偿不改写已交付消息、不重复模型调用。
- [x] 连续编辑继承最近技术交付结果，校验 ready、用户/对话归属、场景根、商品锚点和父链，缺 QA 不补造。
- [x] 同步主 SOP、领域术语与历史策略边界；模型结论不是图片事实，用途确认不确认结构数量。
- [x] 固定差异两轴复审无剩余 must-fix；真实隔离 PG 设置/首页、类型、Lint、格式、Web/Docs 构建与受影响桌面自动流程通过。
- [x] 应用与 Worker 同镜像测试发布，健康与新鲜 Worker 心跳已核验，回退镜像保留；管理员开关两向保存/回读/重载通过，最终关闭。
- [x] 授权原结果定向原子恢复及只读/重复应用已核验；原媒体、child、结果、上游身份与尝试不变，新增生图请求为零，原 blocked 视觉报告保留为建议。
- [x] 部署后原图完成状态、实际下载、引用/移除与首页最近生成通过；下载字节与原件一致。引用加短编辑指令后发送可用，未提交；共享血缘与继续编辑准入通过。
- [ ] 用户业务验收：确认实际成图、连续编辑与可选建议体验；本轮未生成新的连续编辑图片。

九文件 556 项保留为阶段证据；本轮全量、首页增量、真实 PG、构建、桌面、同镜像测试发布及原结果恢复按固定 `fd4a541` 分别登记于[分项验收记录](ecommerce-edit-quality-acceptance.md)。下载、引用、最近生成与开关已取得部署后人工页面证据；真实续写、供应商表现和用户业务验收仍待确认，不从历史绿色数字推定完成。
