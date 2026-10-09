# v0.0.8 PR 审查与本地整合

版本保持 `0.0.8`，`VERSION` 为 `v0.0.8`，根、Web、Docs 的包版本一致。本轮在 `codex/v0.0.8-pr-review` 分支整合；审查基线为本地 `559857340cd497a5ee872ec6fef2699097be6d2a`，远端主线为 `3573154a12bab922c132df0159787cbe430eee17`。本地基线已有两个未推送提交，不能只根据 GitHub 的可合并标志判断兼容性。

本文件记录本地审查与整合结论，未直接整包合并所审查的远端 PR。整合结果已通过 `codex/v0.0.8-pr-review` 进入 `main`，`v0.0.8` 标签指向版本代码提交 `b0a0c5bf848202196b71fdf0aa4caa58627b101b`，并已创建 GitHub Release。用户原有的四份未跟踪授权协议 DOCX 不在改动范围内。

## 17 个 PR 的处理结论

| PR | 审查的 Head | 结论 | 理由与采用范围 |
| --- | --- | --- | --- |
| [#42 OSS 兼容](https://github.com/csyqlz/VOZEB-PRO/pull/42) | `ef04f2dcbb1b` | 核心修复已包含 | 对象读取、批量删除和相关运行时代码已进入本地基线；剩余主要是提交者环境的部署记录，不重复应用整包。 |
| [#43 短剧重复 Schema](https://github.com/csyqlz/VOZEB-PRO/pull/43) | `d36e3d8d40b5` | 已包含 | `merge-tree` 结果与本地 HEAD 的树相同，无新增代码可合并。 |
| [#44 GCP ADC 渠道](https://github.com/csyqlz/VOZEB-PRO/pull/44) | `247d56915274` | 暂缓 | 自定义模型目录仍走同步鉴权，`google-adc` 返回空鉴权头；生成代理的异步 ADC 接入没有覆盖目录。应补齐目录与分页鉴权后重新审查。 |
| [#45 文本超时](https://github.com/csyqlz/VOZEB-PRO/pull/45) | `1c2c0db4aa00` | 已包含 | `merge-tree` 结果与本地 HEAD 的树相同，既有绑定超时语义继续保留。 |
| [#46 短剧任务恢复](https://github.com/csyqlz/VOZEB-PRO/pull/46) | `2bcd00f22618` | 暂缓 | 与当前基线有 16 处冲突；文件 Provider 的版本创建与项目保存分成两步，没有共同锁与回滚，不能保证原子恢复。 |
| [#47 剧本原文权威](https://github.com/csyqlz/VOZEB-PRO/pull/47) | `8e328376cc10` | 已本地采纳 | 采用分析器与 Route Handler 的四个文件差异，按原始剧本恢复对白顺序、说话人和结构，拒绝模型额外添加的对白。 |
| [#48 流式降级计费](https://github.com/csyqlz/VOZEB-PRO/pull/48) | `6114aabc6073` | 已本地采纳 | 非流式降级使用独立且稳定的 `:stream-fallback` 业务身份并重新签名，避免正文变化触发幂等冲突。 |
| [#49 Fixture 代理隔离](https://github.com/csyqlz/VOZEB-PRO/pull/49) | `e7435fea9516` | 已本地采纳 | 本地协议矩阵显式隔离系统代理配置，防止回环 fixture 请求被代理接管。 |
| [#50 Skill 与暂停状态](https://github.com/csyqlz/VOZEB-PRO/pull/50) | `7cec1fd2cdbb` | 部分采纳并修正 | 采用 Skill 能力校验、提交后偏好清理、真实模型参数摘要和公开待确认原因；区分用户暂停与提交未知。未采用按媒体总数扣减任务槽位的新加载网格。 |
| [#51 New API 视频引用](https://github.com/csyqlz/VOZEB-PRO/pull/51) | `2d9c984eee3a` | 补齐回归 | 运行时支持基本已在基线中；补齐多参考素材、渠道、参数和运维测试，保留本地模块权限门禁与 payload 作用域修正。 |
| [#52 图册图片路径](https://github.com/csyqlz/VOZEB-PRO/pull/52) | `11633ad33cb0` | 不合并 | 将公开 URL 错改成磁盘路径。实际 Docs HTTP 检查：40 张现有 `/screenshots/pages/*.webp` 均为 200，提案的 `/docs/public/screenshots/pages/*.webp` 均为 404。 |
| [#61 多租户 MVP](https://github.com/csyqlz/VOZEB-PRO/pull/61) | `1f2761cfeb64` | 不直接合并 | 102 个文件的架构扩展不属于本轮版本修复；成员更新只校验旧角色，租户 admin 可以把 member 提升为 admin，绕过新角色授权约束。 |
| [#65 Docs 依赖](https://github.com/csyqlz/VOZEB-PRO/pull/65) | `355d47d87e17` | 自行更新 | 提案 Next 16.3.5 仍有已公开漏洞；改用 16.3.8，并同步锁文件和安全修复。 |
| [#66 Web 开发依赖](https://github.com/csyqlz/VOZEB-PRO/pull/66) | `08f0c54201d6` | 选择性更新 | 更新 Vitest、Next ESLint 与受影响传递依赖；未整体升级 Playwright、Prettier 或 shadcn。 |
| [#67 Web 运行依赖](https://github.com/csyqlz/VOZEB-PRO/pull/67) | `d8d12949831b` | 自行更新 | Next 使用 16.3.8，Sharp 使用 0.35.5 并同步 override；Tiptap 统一 3.31.4，修复 Axios、Undici 等安全依赖。避免 manifest 升级却仍被旧 override 覆盖。 |
| [#69 SBOM Action](https://github.com/csyqlz/VOZEB-PRO/pull/69) | `79664869b0c4` | 已本地采纳 | 两个镜像工作流同步到 v0.24.3 对应提交 `66cbf4bc1f1c0d2edc94016e65bc221b6bb0ad6c`，并更新工作流契约测试；已核验 GitHub annotated tag 指向。 |
| [#70 电商与恢复整包](https://github.com/csyqlz/VOZEB-PRO/pull/70) | `35210ad664f1` | 不合并整包 | 336 个文件、约四万新增行、24 处冲突；版本变成 v0.0.24、镜像归属改为提交者仓库、取消 arm64，并移除视频首尾帧等既有能力。可用修复必须拆分后单独评估。 |

## 关键缺陷依据

- **#44**：`web/src/app/api/admin/models/route.ts` 的目录请求调用 `protocolAuthHeaders`；该 PR 在 `channel-protocol-registry.ts` 中让 `google-adc` 分支返回 `{}`。生成入口使用的异步 ADC helper 没有贯穿模型目录请求。默认手动模型配置只能避开这个问题，不能证明目录功能可用。
- **#46**：新增 `applyDramaVisualResult` 的文件分支先调用 `createDramaProjectVersion`，再调用 `updateDramaProject`。后一步失败会留下版本；并发重放也可能创建重复版本。PostgreSQL 分支有事务，文件分支必须提供相同的原子边界。
- **#50**：提案按媒体类型总输出数抵消每个活动任务的数量，没有按任务身份关联已完成输出，可能把仍在生成的任务槽位抵消。沿用当前等待组件，仅修正暂停/失败语义。
- **#61**：`tenant-service.ts` 的 `updateTenantMember` 只验证目标成员当前角色，没有验证 `patch.role`。创建路径校验新角色，而更新路径遗漏；这与 `canManageTenantMember("admin", "admin") === false` 的权限规则相冲突。

## 本轮自行修复

- 暂停媒体 Run 显示具体待确认原因；手动暂停显示“任务已暂停，进度已保存”，停止等待动画与直接重试入口，已成功的媒体结果继续保留。
- 短剧分镜/尾帧异步回调仅在任务 ID 和运行状态仍匹配时应用结果。清理回调只释放自己持有的任务标识，防止创建请求的迟到 `finally` 清除后继轮询的标识，重复处理图片完成结果并递增视频尝试次数。浏览器保留单镜头仅一次视频上游创建与刷新后 `generationAttempt: 1` 的断言。
- 390px 下短剧顶部操作不再挤掉项目名称与集数入口；手机端分行排列项目身份与全局操作，保留四阶段导航。手机端网格规则仅作用于 `max-sm`，避免命名断点覆盖 1366px 宽屏规则。新增几何断言先复现了 64px 顶栏内阶段按钮延伸到 80px 的裁切，再验证四种宽度与浅深主题下全部按钮处于顶栏内；截图等待真实主题切换结束。
- 后台作品筛选栏在 1024px 继续换行，到 `xl` 才切换为单行，避免筛选控件挤出内容区；使用实际宽度、坐标和滚动边界验收。
- 将后台布局的旧源码类名断言迁移到浏览器最终 `display`、控件坐标、宽度及溢出检查；同步现有桌面隐藏重复标题的测试定位。暂停状态 fixture 正常结束 SSE，截图复用真实滚轮产生的紧凑状态。

## 验证记录

- 根、Web、Docs 版本均为 0.0.8；使用 CI 声明的 pnpm 11.9.0 成功完成两个包的冻结锁文件安装。
- 最终全量 Vitest：595 个测试文件结果、2849 项通过、10 项 PostgreSQL 环境测试跳过、零失败。报告为 `web/.e2e-artifacts/pr-review-vitest-final.json`；之后的纯布局修改另以受影响单测和浏览器验证，未重复未受影响的已通过用例。
- Playwright 全量及定向补测按项目、文件、测试标题取最新结果：176 项中 158 通过、18 跳过、零剩余失败。17 项跳过来自视口/项目范围，1 项因缺少隔离 PostgreSQL 支付环境；汇总为 `web/.e2e-artifacts/pr-review-browser-summary.json`。首轮失败和修复后报告均保留，汇总不冒充单次全量运行结果。
- 短剧顶部栏额外覆盖 1672px、1440px、390px、430px 和浅深主题；包含安装前置的专项 4 项通过。回归检查项目名称、集数入口、四个阶段按钮的真实矩形与页面无横向溢出；截图位于 `web/.e2e-artifacts/pr-review-browser-header-final/`。单镜头生成流程另已确认只创建一次上游视频任务，刷新后 `generationAttempt` 仍为 1。
- Web 类型检查、ESLint、Prettier 与最终生产构建通过，静态生成 62 页；构建记录为 `web/.e2e-artifacts/pr-review-build-header.log`。全量检查后新增的布局和测试改动均补做相关检查。
- Docs 类型检查与生产构建通过，静态生成 39 页；内容更新后的最终构建记录为 `web/.e2e-artifacts/pr-review-docs-build-final.log`。40 张图册图片的正确/提案 URL 已实际 HTTP 对比验证，结果为 `web/.e2e-artifacts/pr-review-doc-paths.json`。
- 第三方许可证一致性、差异空白检查和严格 UTF-8/常见中文乱码扫描通过。构建产生的无关 Fumadocs 源索引差异已排除。
- 首次同步主分支时，Gitleaks 命中升级服务单测中的六处固定示例令牌。经核实均为 mock 隔离的测试凭据，已按现有 `.gitleaksignore` 机制记录精确历史提交、文件、规则和行号；使用与 CI 相同的 Gitleaks 8.24.3 复验原始三个提交，结果为零发现。

## 发布阻断与外部验收边界

Web 依赖审计剩余一个开发依赖高危公告：[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)。`braces@3.0.3` 通过 Next ESLint plugin 和 shadcn 的 `fast-glob → micromatch` 引入；审计返回 `patched_versions: null`，修复版本尚未发布。Docs 审计为零已知漏洞。

`pnpm --dir web run check:release` 已通过前置部署契约检查，并在依赖审计处正常阻断。没有忽略该公告、降低审计阈值或将开发依赖排除出门禁。当前不能宣称整个发布门禁通过。

本轮生成请求全部使用独立空闲端口、隔离文件 Provider 和固定测试凭据的本地 fixture。没有调用管理员已配置的真实渠道；未配置隔离 PostgreSQL 测试库，因此 PostgreSQL 事务/并发与支付 E2E、真实供应商计费/质量、生产 Docker 多架构镜像和部署恢复仍需各自的验收证据。

## GitHub 发布结果

- [VOZEB PRO v0.0.8](https://github.com/csyqlz/VOZEB-PRO/releases/tag/v0.0.8) 已发布并设为 Latest，发布说明显式标注主应用镜像不可用及完整门禁未通过。
- [主应用工作流](https://github.com/csyqlz/VOZEB-PRO/actions/runs/37922993044) 因上述依赖审计失败，构建、镜像合并、更新器和签名步骤被跳过；GHCR 主应用 `v0.0.8` manifest 返回 404。
- [文档镜像工作流](https://github.com/csyqlz/VOZEB-PRO/actions/runs/37922992817) 全部成功。`ghcr.io/csyqlz/vozeb-pro-docs:v0.0.8` 与 `latest` 的 digest 均为 `sha256:d94db9d84e00f926b0b914aabe9bf435287f99727defc61c5038e52099595236`；amd64、arm64 两个镜像的 revision 均已核对为版本代码提交，并完成 SBOM、签名与 attestation。
