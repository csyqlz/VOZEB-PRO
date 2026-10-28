# VOZEB PRO 0.0.6 页面与接口证据矩阵

本矩阵记录页面、浏览器 API Service、Route Handler、服务端业务边界、持久层与浏览器证据。它只描述仓库当前可以复现的能力，不把本机协议夹具等同于真实供应商账号验收。

| 页面或业务面 | 浏览器入口 | Route Handler | 服务端与持久层 | 浏览器/协议证据 | 视口 |
| --- | --- | --- | --- | --- | --- |
| 公开首页、作品广场 | `services/api/work-governance.ts` | `/api/public/gallery`、`/api/public/gallery/ranking` | `work-governance-service.ts`、`work-governance-repository.ts` 或文件 Provider | `home.spec.ts`、`all-pages.spec.ts`、`responsive.spec.ts` | 桌面、390、430 |
| 公告、登录、注册、找回密码 | 认证表单与公告查询 | `/api/announcements`、`/api/auth/*` | `lib/auth/*`、用户/Session/邮箱验证码 Repository 或文件 Provider | `all-pages.spec.ts`、`home.spec.ts`、`core.spec.ts` | 桌面、390、430 |
| 统一创作 Agent `/create` | `services/api/creative.ts`、`agent-skills.ts`、`prompt-optimization.ts`、`create-workbench-overview.ts` | `/api/creative/*`、`/api/agent/runs/*`、`/api/agent/prompt-optimization` | `agent-run-executor.ts`、`agent-run-store.ts`、`creative-runtime-service.ts`、PostgreSQL/文件运行时 Store | `core.spec.ts` 真实本机协议入口、`responsive.spec.ts`、`creative-video-result.spec.ts` | 桌面、390、430 |
| 文本、图片、视频、音频任务 | `services/api/text.ts`、`image.ts`、`video.ts`、`audio.ts` | `/api/text-tasks`、`/api/image-tasks`、`/api/video-generation-tasks`、`/api/audio-tasks` | 任务服务、模型路由、渠道协议适配、生成任务 Repository/文件 Provider、媒体登记 | `core.spec.ts`、协议专项与本机 TCP 夹具 | API + 页面入口 |
| Canvas 列表与编辑器 | `services/api/canvas-projects.ts`、Canvas 页面 Store | `/api/canvas/projects/*`、`/api/agent/runs/*` | Canvas 项目服务、Agent 执行器、Canvas Repository/文件 Provider、媒体登记 | `canvas.spec.ts`、`responsive.spec.ts`、`all-pages.spec.ts` | 桌面、390、430 |
| 短剧列表与生产工作区 | `services/api/drama-projects.ts` 及页面运行时请求 | `/api/drama/projects/*`、`/api/drama/analyze`、`/api/drama/render/*` | 短剧项目服务、生成/合成服务、项目 Repository/文件 Provider | `responsive.spec.ts`、`all-pages.spec.ts` | 桌面、390、430 |
| 作品发布、管理与公开分享 | `services/api/work-publications.ts`、`work-governance.ts` | `/api/works/*`、`/api/public/works/*`、`/share/[slug]` | `work-publication-service.ts`、治理服务、作品 Repository、媒体引用保护 | `all-pages.spec.ts`、`responsive.spec.ts` | 桌面、390、430 |
| 创作者主页与社区互动 | `services/api/work-community.ts` | `/api/public/users/*`、`/api/notifications/interactions/*` | 社区服务、`work-community-repository.ts` | `all-pages.spec.ts`；文件 Provider 明确返回能力限制，不伪造社区数据 | 桌面、390、430 |
| 素材库 | `services/api/library-assets.ts` | `/api/library-assets/*` | `library-asset-service.ts`、素材 Store/Repository、媒体引用保护 | `all-pages.spec.ts`、`responsive.spec.ts` | 桌面、390、430 |
| 公共与个人提示词 | `services/api/prompts.ts`、`my-prompts.ts` | `/api/prompts`、`/api/my-prompts/*` | 内容 Repository/文件 Provider、个人提示词 Store | `all-pages.spec.ts`、`responsive.spec.ts` | 桌面、390、430 |
| 个人主页与个人中心 | 个人资料组件及账务、登录安全、注销 API Service | `/api/auth/profile`、`/api/auth/password`、`/api/points`、`/api/auth/account-deletion` | 用户、积分、登录事件、注销申请 Repository/文件 Provider | `all-pages.spec.ts`、`commerce.spec.ts`、`responsive.spec.ts` | 桌面、390、430 |
| 套餐、订单、优惠券与支付结果 | `services/api/billing.ts`、`points.ts` | `/api/billing/*`、`/api/points`、订单 SSE | 订单、支付、退款和优惠券使用 PostgreSQL Repository；积分钱包沿用现有 Provider | `commerce.spec.ts`、`core.spec.ts`；真实 PostgreSQL 支付与支付商凭据不在仓库验收范围 | 桌面、390、430 |
| 管理后台 26 个分区 | 后台数据 hooks 与页面私有客户端 | `/api/admin/*` | 管理员职责校验、设置/用户/内容/生成/存储/审计服务及对应 Repository | `all-pages.spec.ts` 管理分区矩阵、`responsive.spec.ts`、`core.spec.ts` | 桌面、390、430 |
| 初始化与部署检查 | 安装向导 | `/api/install/*`、`/api/health/*` | 安装状态、Schema 初始化、首个管理员创建 | `installation.spec.ts`、`all-pages.spec.ts` | 桌面、390、430 |
| 隐私、条款、404 与不可用态 | Server Component | 页面 Route | 站点公开配置与明确 404/能力限制 | `all-pages.spec.ts` | 桌面、390、430 |

## 本机协议结论

- 已注册协议和 GlobalAiOpc 兼容预设由协议专项验证真实请求方法、路径、鉴权、请求体、任务查询和结果解析。
- `/create` 的真实页面入口已验证：用户提交 → Agent Run → 默认文本模型规划 → 图片任务 → 本机上游协议 → 媒体登记 → 页面结果展示；浏览器没有拦截或伪造接口响应。
- 文本、图片、视频和音频任务分别由核心 E2E 验证本机上游请求和可读取结果；失败切换、幂等复用与取消按各自测试契约覆盖。
- 没有真实 PostgreSQL、支付商或外部 AI 供应商凭据时，只能确认文件 Provider、本机协议夹具和静态契约；不得宣称真实供应商生产环境已通过。

## 静态审计结论

- 页面展示数据未发现用于冒充真实业务记录的固定假数据；参考文案、空态和协议夹具不计入业务假数据。
- 首页、统一创作、Canvas、作品、素材、提示词、账务等主链路使用现有 Service/Route/服务端持久化。认证、部分后台旧组件和短剧运行时仍存在直接 `fetch`，均调用本站受鉴权 Route；它们是既有客户端边界债务，不在 0.0.6 发布收尾中做跨域重构。
- 按钮静态扫描命中的无 `onClick` 元素均由 `Link`、`Popover`、`Dropdown`、`Popconfirm`、表单提交或禁用过程状态承接；未发现只改变视觉而没有业务行为的新增主操作。
