import type { AdminSectionKey } from "@/components/admin/admin-sections";

import { adminHelpGuidance } from "./admin-help-guidance";

export const ADMIN_HELP_ARTICLE_IDS = ["getting-started", "operations", "commerce", "finance", "models", "system", "storage", "content", "maintenance"] as const;

export type AdminHelpArticleId = (typeof ADMIN_HELP_ARTICLE_IDS)[number];

export type AdminHelpStep = {
    title: string;
    description: string;
    checks?: string[];
};

export type AdminHelpLink = { label: string; description: string; section: AdminSectionKey; href?: never } | { label: string; description: string; href: string; section?: never };

export type AdminHelpArticle = {
    id: AdminHelpArticleId;
    category: string;
    title: string;
    summary: string;
    keywords: string[];
    purpose: string;
    steps: AdminHelpStep[];
    checks: string[];
    warnings?: string[];
    links: AdminHelpLink[];
};

export const adminHelpArticles: AdminHelpArticle[] = [
    {
        id: "getting-started",
        category: "开始使用",
        title: "首次配置与上线顺序",
        summary: "从数据库初始化到模型、商品、支付和存储，按依赖顺序完成后台首次配置。",
        keywords: ["初始化", "首次配置", "上线", "安装", "数据库", "管理员", "配置顺序"],
        purpose: "先建立可登录、可调用、可计费、可保存和可恢复的最小运行闭环，再开放注册和支付，避免用户进入尚未准备好的功能。",
        steps: [
            {
                title: "完成安装向导",
                description: "确认 PostgreSQL 连接、加密密钥和表结构状态正常，再创建首个管理员。",
                checks: ["数据库状态为正常", "表结构已显式初始化", "首个管理员可以登录后台"],
            },
            {
                title: "配置站点和模型能力",
                description: "先设置站点名称与星启智域 Logo，再配置上游渠道、逻辑模型和默认文本模型。",
                checks: ["前台、登录页和后台品牌一致", "用户端文本调用成功", "已设置默认文本逻辑模型"],
            },
            {
                title: "配置商品、余额和支付",
                description: "创建可售套餐或人民币余额商品，核对模型扣费，再按实际商户资质启用支付渠道。",
                checks: ["至少一个商品已启用", "模型人民币价格有明确规则", "支付回调地址与站点 HTTPS 域名一致"],
            },
            {
                title: "确定存储和恢复方案",
                description: "选择本地媒体或 S3 兼容存储，并同时确定 PostgreSQL 与媒体文件的备份恢复方式。",
                checks: ["媒体写入测试成功", "数据目录或 Bucket 已持久化", "完成一次可复现的恢复演练"],
            },
        ],
        checks: ["管理员、普通用户和禁用用户权限符合预期", "文本、图片和视频按实际启用能力完成一次真实调用", "下单、支付、余额入账、失败退款和媒体读取均有验证记录"],
        warnings: ["不要在模型、存储和支付尚未验证时开放公开注册或对外收费。", "数据库、媒体和加密密钥必须作为同一套恢复资产管理，缺少其中任何一项都不算可恢复。"],
        links: [
            { label: "初始化配置", description: "查看上线准备进度和下一项配置", href: "/admin/setup" },
            { label: "站点资料", description: "配置名称、Logo 和 SEO", section: "site" },
            { label: "模型渠道", description: "配置上游和逻辑模型", section: "channels" },
            { label: "套餐管理", description: "创建用户可购买商品", section: "products" },
            { label: "支付渠道", description: "配置商户密钥与回调", section: "payments" },
            { label: "数据备份", description: "导出、恢复并核对备份边界", section: "backup" },
        ],
    },
    {
        id: "operations",
        category: "经营分析",
        title: "经营看板、用户与生成运维",
        summary: "查看平台运行趋势，管理用户权益，并定位生成任务和上游调用问题。",
        keywords: ["经营看板", "用户运营", "调用记录", "生成运维", "任务", "日志", "用户", "失败原因"],
        purpose: "用摘要判断平台是否健康，再从用户、任务和调用记录逐层定位问题；不要依赖单一成功率或请求量判断经营状态。",
        steps: [
            {
                title: "先看经营看板",
                description: "关注活跃用户、收入、余额负债、请求趋势、成功率和模型分布是否出现异常变化。",
                checks: ["统计时间范围明确", "收入与订单口径一致", "异常峰值能够定位到日期和模型"],
            },
            {
                title: "按用户核对权限和权益",
                description: "在用户运营中查看账号状态、角色、套餐和人民币余额；人工调整前先确认业务原因。",
                checks: ["未误改管理员角色", "套餐与余额调整有明确原因", "禁用用户无法继续创建任务"],
            },
            {
                title: "从调用记录定位单次请求",
                description: "按用户、类型、来源、状态和时间筛选，查看模型、耗时、错误和关联媒体。",
                checks: ["确认逻辑模型与真实上游模型", "区分创建失败和查询失败", "核对失败是否已退款"],
            },
            {
                title: "在生成运维处理任务",
                description: "统一查看任务、会话、项目、渠道健康和人民币成本，只有用户显式重试时才重新创建上游任务。",
                checks: ["没有重复创建同类上游任务", "失败记录仍可审计", "取消、超时和退款状态一致"],
            },
        ],
        checks: ["经营指标能够下钻到真实订单或任务", "用户权限、套餐和余额不存在明显错配", "失败任务有错误、退款和用户可见状态"],
        warnings: ["不要为了清理列表直接删除仍用于审计、退款或媒体引用的记录。", "人工增加人民币余额会改变财务负债，应保留原因并同步核对流水。"],
        links: [
            { label: "经营看板", description: "查看平台运营摘要", section: "overview" },
            { label: "用户运营", description: "管理用户状态与权益", section: "users" },
            { label: "调用记录", description: "查看单次生成详情", section: "logs" },
            { label: "生成运维", description: "排查任务与渠道状态", section: "generationOperations" },
        ],
    },
    {
        id: "commerce",
        category: "商品运营",
        title: "套餐、促销、优惠券、邀请与订单",
        summary: "配置真实日常价与活动价，管理优惠券和邀请奖励，并以订单快照完成收款和售后。",
        keywords: ["套餐", "商品", "促销", "活动价", "日常价", "删除线", "优惠券", "邀请", "邀请码", "冷静期", "风控", "订单", "退款"],
        purpose: "让用户看到真实、可解释的价格优惠，建立可撤销的单层邀请增长，并确保订单创建后不受后续商品、促销或优惠券修改影响。",
        steps: [
            {
                title: "先创建商品和日常价",
                description: "设置商品名称、人民币价格、余额或套餐权益、有效期和展示状态；日常价必须是真实可售价格。",
                checks: ["价格单位和权益数量正确", "商品启停符合投放计划", "购买后可得到对应余额或套餐"],
            },
            {
                title: "配置限时促销",
                description: "为已有日常价的商品设置活动时间、活动标签和活动价；同一商品不能配置重叠活动。",
                checks: ["活动价低于真实日常价", "开始和结束时间正确", "前台仅在满足条件时显示删除线"],
            },
            {
                title: "创建和发行优惠券",
                description: "配置固定金额或比例优惠、适用商品、门槛、有效期、库存和每用户限制，再决定领取或定向发放。",
                checks: ["优惠范围与活动规则不冲突", "库存和用户上限合理", "已发行模板只修改允许变化的说明、开关和总量"],
            },
            {
                title: "配置邀请奖励",
                description: "在营销推广中设置邀请人余额、新用户余额或优惠券、首单最低实付、冷静期、月度/活动上限和风险冻结策略，再启用计划。",
                checks: ["奖励和门槛与获客成本预算一致", "优惠券有效期覆盖预计结算时间", "维护任务与人工结算入口可用"],
            },
            {
                title: "按订单快照处理售后",
                description: "核对日常价、活动优惠、优惠券优惠和实付金额，再执行人工确认、关闭或整单退款。",
                checks: ["支付金额与订单实付一致", "待支付优惠券锁定能在取消或超时后释放", "退款后权益和优惠券状态符合规则"],
            },
        ],
        checks: ["前台价格、结算页和订单详情金额一致", "活动边界时间前后展示正确", "优惠券领取、锁定、释放、核销和退款链路可追踪", "邀请注册、首单、待结算、已发放和撤销口径能够区分"],
        warnings: ["禁止用虚构原价制造删除线；只有真实日常价高于当前售价时才能显示折扣。", "订单创建后只能使用订单保存的价格和规则快照，不能重新按当前活动计算。", "邀请奖励只支持单层关系；单一网络信号只能触发复核或冻结，不能直接认定欺诈。"],
        links: [
            { label: "套餐商品", description: "管理商品价格与权益", section: "products" },
            { label: "促销活动", description: "管理活动时间和活动价", section: "promotions" },
            { label: "优惠券", description: "创建模板并向用户发放", section: "coupons" },
            { label: "邀请奖励", description: "配置首单奖励、冷静期与风控", section: "referrals" },
            { label: "订单管理", description: "处理收款、关闭与退款", section: "orders" },
        ],
    },
    {
        id: "finance",
        category: "财务管理",
        title: "人民币余额、支付渠道、CDK 与财务流水",
        summary: "统一核对模型扣费、支付配置、兑换码和资金及余额流水。",
        keywords: ["人民币余额", "模型单价", "倍率", "支付渠道", "Stripe", "支付宝", "微信支付", "PayPly", "CDK", "流水", "对账"],
        purpose: "保证一次购买、生成、退款或兑换都能在订单、支付流水、余额流水和套餐用量之间相互核对。",
        steps: [
            {
                title: "建立统一人民币价格规则",
                description: "按逻辑模型配置成本价、销售价，并设置图片数量、视频时长、清晰度等参数倍率。",
                checks: ["用户预计扣费与服务端实际扣费使用同一规则", "免费调用也会记录幂等流水和套餐次数", "失败任务能撤销余额与套餐用量"],
            },
            {
                title: "配置并检测支付渠道",
                description: "只启用已经具备商户资质、密钥、证书和 HTTPS 回调的渠道，逐项完成测试支付。",
                checks: ["回调验签通过", "重复和乱序事件不重复发放权益", "退款能够回写订单和流水"],
            },
            {
                title: "发行和追踪 CDK",
                description: "按活动或售后场景生成余额或套餐兑换码，设置次数、有效期和备注，明文仅在生成当次导出。",
                checks: ["发放范围和数量可追踪", "过期或停用码不可兑换", "兑换用户和时间可核对"],
            },
            {
                title: "每日核对财务流水",
                description: "对比订单、支付渠道实收、退款、余额负债和异常对账项，发现差异后先保留证据再处理。",
                checks: ["已支付订单存在成功支付流水", "退款订单的退款流水和权益状态一致", "人工调整有备注和责任人"],
            },
        ],
        checks: ["支付回调具备幂等证据", "人民币余额与流水汇总一致", "订单金额、支付实收和退款金额可相互核对"],
        warnings: ["API Key、私钥、证书和 webhook secret 只能保存在服务端配置或环境变量中。", "不要通过直接改数据库修正账务；应使用已有业务入口并保留审计。"],
        links: [
            { label: "人民币价格规则", description: "配置模型成本价、销售价与参数倍率", section: "points" },
            { label: "支付渠道", description: "管理商户配置和回调", section: "payments" },
            { label: "CDK 兑换", description: "生成和管理兑换码", section: "cdk" },
            { label: "财务流水", description: "核对资金与余额变化", section: "wallet" },
        ],
    },
    {
        id: "models",
        category: "上游配置",
        title: "模型渠道、逻辑模型与 Agent Skills",
        summary: "把真实上游模型封装成稳定逻辑能力，并为 Agent 配置可执行的专业 Skill。",
        keywords: ["模型渠道", "上游", "API Key", "Base URL", "协议中心", "自定义协议", "逻辑模型", "默认模型", "工作台验证", "Agent Skills", "Skill"],
        purpose: "让普通用户只选择稳定的产品能力，服务端负责上游渠道、模型别名、优先级和失败切换，避免密钥与供应商细节暴露到浏览器。",
        steps: [
            {
                title: "添加并启用上游渠道",
                description: "按五步向导选择协议、配置连接、添加模型、自动同步逻辑模型并复核启用；没有公开目录时手动填写模型 ID，未知上游使用自定义协议助手生成可复核草稿。",
                checks: ["SD2 与 Stable Diffusion 协议没有混用", "Base URL 不包含错误重复路径", "无鉴权协议不会强制要求 API Key", "对应用户工作台已完成真实调用", "密钥不会返回普通用户端"],
            },
            {
                title: "同步逻辑模型和路由",
                description: "按上游模型名自动生成逻辑模型；跨渠道同名模型自动合并，不同名模型保持独立，再维护能力、启停、优先级和权重。",
                checks: ["同名上游模型已跨渠道合并", "每个渠道目录模型都有对应绑定", "价格档案键使用逻辑模型 ID"],
            },
            {
                title: "设置系统默认模型",
                description: "文本默认模型同时服务工作台 Agent、Canvas 规划、内部分析和创作复盘，必须优先验证。",
                checks: ["默认文本模型可稳定返回", "图片、视频和音频默认值指向对应能力", "停用渠道不会继续被选中"],
            },
            {
                title: "配置 Agent Skills",
                description: "为专业能力设置名称、分类、触发词、能力约束和执行规则，保持 Skill 与真实可用模型相匹配。",
                checks: ["触发描述清晰且不互相冲突", "Skill 不包含用户不可用的能力", "启停后用户端选择状态正确"],
            },
        ],
        checks: ["文本、图片、视频和音频按启用范围在用户工作台逐项真实调用", "默认逻辑模型、绑定渠道和计费规则一致", "Agent 与 Canvas 的内部文本任务显式携带逻辑模型 ID"],
        warnings: [
            "自定义协议分析结果只是渠道级草稿，必须复核后再启用，并在对应用户工作台完成真实调用；当前没有全局协议版本发布和回滚。",
            "不要把上游真实模型名当作长期价格配置键；渠道更换后会造成前端预计和服务端扣费不一致。",
            "测试密钥时不要把完整请求、响应或密钥复制到公告、文档和浏览器日志。",
        ],
        links: [
            { label: "模型渠道", description: "配置渠道、模型和默认能力", section: "channels" },
            { label: "Agent Skills", description: "管理专业能力与触发规则", section: "skills" },
            { label: "人民币价格规则", description: "核对逻辑模型成本与销售价", section: "points" },
            { label: "调用记录", description: "验证实际路由和错误", section: "logs" },
        ],
    },
    {
        id: "system",
        category: "系统管理",
        title: "站点资料、基础设置与用户权利",
        summary: "统一管理品牌、注册与邮箱、生成、数据维护、账号注销和版本信息。",
        keywords: ["站点资料", "Logo", "ICO", "SEO", "注册", "SMTP", "邮箱", "默认参数", "数据维护", "注销申请", "版本更新"],
        purpose: "保持公开页面、用户工作区和后台品牌一致，并让注册、邮件、生成、技术数据维护和用户权利处理具有明确运营边界。",
        steps: [
            {
                title: "维护站点资料和品牌",
                description: "设置站点名称、SEO、社交入口、首页展示和星启智域 Logo；浏览器图标与助手头像使用同一品牌来源。",
                checks: ["Logo、ICO、favicon 和后台标识一致", "默认与回退图标均不是三角形品牌", "浅色和深色背景下清晰可读"],
            },
            {
                title: "配置注册、SMTP、生成与数据维护",
                description: "先测试 SMTP，再开启依赖邮件的注册、找回和换绑流程；生成参数按真实模型能力设置，技术到期数据按部署负载分批维护。",
                checks: ["测试邮件成功到达", "注册策略与运营计划一致", "生成参数不会超出上游支持范围", "维护批次和生产调度已验证"],
            },
            {
                title: "处理注销申请",
                description: "核验申请人身份、业务记录和保留义务，记录受理或拒绝原因，并按规则处理公开内容和个人数据。",
                checks: ["申请状态和备注完整", "财务与审计数据按制度保留", "公开内容和媒体权限同步更新"],
            },
            {
                title: "查看版本与升级信息",
                description: "升级前阅读版本变更和部署要求，备份数据库与媒体，再按发布流程更新。",
                checks: ["当前版本与目标版本明确", "升级前备份可恢复", "升级后执行核心页面与能力回归"],
            },
        ],
        checks: ["站点所有品牌入口使用星启智域 Logo", "注册、验证码和找回密码流程与 SMTP 状态一致", "注销和升级操作都有可追踪记录"],
        warnings: ["更换 Logo 后要同时检查 favicon、manifest、metadata、登录页、用户端、后台和助手头像。", "开启邮箱注册前必须完成真实收件测试，避免用户无法登录或找回密码。"],
        links: [
            { label: "站点资料", description: "管理品牌、SEO 与首页内容", section: "site" },
            { label: "基础设置", description: "管理注册、邮箱、生成与数据维护", section: "settings" },
            { label: "注销申请", description: "处理用户权利请求", section: "accountDeletion" },
            { label: "版本更新", description: "查看版本与升级信息", section: "updates" },
        ],
    },
    {
        id: "storage",
        category: "存储与备份",
        title: "本地媒体、外部存储与数据备份",
        summary: "管理媒体真实存放位置、历史 Provider、引用保护、迁移和恢复边界。",
        keywords: ["本地媒体", "S3", "OSS", "COS", "MinIO", "外部存储", "迁移", "备份", "恢复", "媒体删除"],
        purpose: "确保新媒体写入位置明确、历史媒体始终可读、删除不会破坏业务引用，并且数据库与媒体能够成套恢复。",
        steps: [
            {
                title: "检查本地媒体",
                description: "按类型、来源、用户和期限查看服务器媒体，删除前确认创作会话、素材、Canvas、短剧和生成记录引用。",
                checks: ["媒体登记了用户归属和来源", "临时与永久文件边界清楚", "被引用文件无法被强制删除"],
            },
            {
                title: "配置 S3 兼容存储",
                description: "填写 Endpoint、Region、Bucket、凭据、对象前缀和 path-style，连接测试成功后再启用。",
                checks: ["上传、读取和删除权限符合最小权限", "外部访问使用短期签名 URL", "业务记录只保存稳定 storageKey"],
            },
            {
                title: "迁移历史媒体",
                description: "分批迁移并逐项核对对象上传、登记和站内读取；只有确认外部对象可用后才能删除本地源文件。",
                checks: ["迁移任务可重试且不重复登记", "历史记录仍按原 storage_provider 读取", "当前开关不会改变历史媒体位置"],
            },
            {
                title: "建立完整备份",
                description: "业务数据导出不能替代数据库和媒体备份；生产恢复必须同时覆盖 PostgreSQL、媒体或 Bucket、配置和加密密钥。",
                checks: ["备份文件已脱敏并受控保存", "恢复步骤有明确顺序", "定期执行抽样恢复或完整演练"],
            },
        ],
        checks: ["本地和外部媒体都能按登记 Provider 读取", "引用中的媒体不能被后台清理误删", "恢复环境能重新读取用户、任务和媒体"],
        warnings: ["外部存储开关只决定新媒体写入位置，不能用它切换历史媒体读取位置。", "不要使用 force 绕过媒体引用保护；文件删除成功但业务记录失效属于数据事故。"],
        links: [
            { label: "本地媒体", description: "查看文件、期限与引用", section: "mediaStorage" },
            { label: "外部存储", description: "配置 S3 并迁移媒体", section: "externalStorage" },
            { label: "数据备份", description: "导入导出并确认恢复边界", section: "backup" },
        ],
    },
    {
        id: "content",
        category: "内容运营",
        title: "公告通知与公共提示词运营",
        summary: "发布站内通知和公共创作素材，同时控制触达范围、内容质量和下线节奏。",
        keywords: ["内容运营", "公告", "通知", "弹窗", "提示词", "公共提示词", "标签", "封面"],
        purpose: "用公告传递必要信息，用公共提示词降低用户创作门槛；两者都应服务真实运营目标，避免无节制弹窗和低质量内容堆积。",
        steps: [
            {
                title: "创建和预览公告",
                description: "填写清晰标题与正文，决定是否启用、首页弹窗或登录后弹窗，再检查移动端阅读长度。",
                checks: ["发布时间和触达范围正确", "重要链接可打开", "弹窗不会阻挡用户完成登录或创作"],
            },
            {
                title: "控制公告生命周期",
                description: "活动结束、故障恢复或规则失效后及时下线旧公告，避免用户继续按过期信息操作。",
                checks: ["置顶内容仍然有效", "重复公告已合并", "下线后用户端不再弹出"],
            },
            {
                title: "维护公共提示词",
                description: "为可复用提示词配置标题、正文、分类、标签、封面和预览，确认在目标模型或工作台中可执行。",
                checks: ["提示词不包含密钥和内部规划", "分类和标签便于搜索", "示例效果与描述一致"],
            },
        ],
        checks: ["公告和提示词只展示已启用内容", "手机端标题、正文和按钮没有溢出", "内容不泄露用户数据、上游密钥或平台内部提示词"],
        warnings: ["登录后弹窗应只用于确有必要的信息；频繁打断会降低用户完成创作和付费的概率。", "公共提示词发布前应执行内容安全和真实模型可用性检查。"],
        links: [
            { label: "公告通知", description: "创建、编辑和下线公告", section: "announcements" },
            { label: "提示词运营", description: "管理公共提示词库", section: "prompts" },
        ],
    },
    {
        id: "maintenance",
        category: "日常维护",
        title: "日常巡检与故障排查",
        summary: "按固定顺序检查用户、任务、渠道、账务、存储和版本，快速缩小故障范围。",
        keywords: ["巡检", "排障", "故障", "错误", "失败", "退款", "渠道健康", "磁盘", "备份", "监控"],
        purpose: "先判断影响范围和数据一致性，再定位单一用户、任务、渠道或基础设施，避免在证据不足时反复改配置。",
        steps: [
            {
                title: "确认影响范围",
                description: "判断是所有用户、某类能力、某个渠道还是单个任务异常，并记录开始时间和可复现步骤。",
                checks: ["登录和普通页面是否正常", "文本、图片、视频是否同时失败", "是否只影响新任务或历史媒体"],
            },
            {
                title: "检查任务和渠道",
                description: "从生成运维进入调用记录，核对逻辑模型、上游模型、请求状态、错误、耗时和渠道检测。",
                checks: ["上游只创建了一次任务", "轮询查询的是同一个任务 ID", "失败退款和套餐次数撤销正确"],
            },
            {
                title: "检查账务和存储",
                description: "生成故障核对余额流水，支付故障核对订单与支付流水，媒体故障核对 storage_provider、对象或本地文件。",
                checks: ["没有重复扣费或发放权益", "退款不依赖页面再次打开", "媒体 URL 没有泄露对象 Key 或永久上游地址"],
            },
            {
                title: "恢复后复盘",
                description: "验证用户主链路，记录根因、修复、影响数据和预防项；涉及数据时先完成备份再批量处理。",
                checks: ["桌面与移动端功能恢复", "历史任务和媒体仍可读取", "同类故障有测试、告警或文档预防"],
            },
        ],
        checks: ["故障时间线、影响范围和证据完整", "任务、账务和媒体最终状态一致", "恢复后完成至少一次真实用户路径验证"],
        warnings: ["不要通过删除失败记录来制造成功率正常；失败记录是退款、审计和复盘依据。", "没有数据库、媒体和配置备份时，不执行批量修复、迁移或升级。"],
        links: [
            { label: "经营看板", description: "确认整体异常趋势", section: "overview" },
            { label: "生成运维", description: "查看任务和渠道健康", section: "generationOperations" },
            { label: "调用记录", description: "定位单次请求错误", section: "logs" },
            { label: "财务流水", description: "核对扣费、退款与余额", section: "wallet" },
            { label: "数据备份", description: "批量操作前保存恢复点", section: "backup" },
        ],
    },
];

export function findAdminHelpArticle(value?: string | null) {
    return adminHelpArticles.find((article) => article.id === value);
}

export function searchAdminHelpArticles(query: string) {
    const terms = normalizeSearchText(query).split(" ").filter(Boolean);
    if (!terms.length) return adminHelpArticles;

    return adminHelpArticles.filter((article) => {
        const guidance = adminHelpGuidance[article.id];
        const haystack = normalizeSearchText(
            [
                article.category,
                article.title,
                article.summary,
                article.purpose,
                ...article.keywords,
                ...article.steps.flatMap((step) => [step.title, step.description, ...(step.checks || [])]),
                ...guidance.stepActions.flat(),
                ...guidance.troubleshooting.flatMap((item) => [item.symptom, item.cause, ...item.actions, item.caution || ""]),
                ...article.checks,
                ...(article.warnings || []),
                ...article.links.flatMap((link) => [link.label, link.description]),
            ].join(" "),
        );
        return terms.every((term) => haystack.includes(term));
    });
}

function normalizeSearchText(value: string) {
    return value.trim().toLocaleLowerCase("zh-CN").replace(/\s+/g, " ");
}
