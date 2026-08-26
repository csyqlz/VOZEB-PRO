import { getAuthSettings, getPublicUserSummary, type AuthSettings, type PublicUserSummary } from "@/lib/auth/store";
import { listBillingProducts } from "@/lib/server/billing-service";
import { getDatabaseProvider, getPostgresConnectionString, type BillingProductRecord } from "@/lib/server/database";
import { getPaymentConfigSummary, hasPaymentProductionSecret } from "@/lib/server/payment-config-status";
import { channelConnectionReady } from "@/lib/channel-protocol-registry";

export type AdminSetupStepStatus = "done" | "attention" | "pending";
export type AdminSetupAccent = "blue" | "emerald" | "amber" | "rose" | "violet" | "slate";

type AdminSetupStep = {
    id: string;
    title: string;
    eyebrow: string;
    status: AdminSetupStepStatus;
    statusLabel: string;
    description: string;
    href: string;
    actionLabel: string;
    accent: AdminSetupAccent;
    facts: string[];
};

export type AdminSetupSummary = {
    siteTitle: string;
    completed: number;
    total: number;
    percent: number;
    users: number;
    admins: number;
    totalChannels: number;
    enabledChannels: number;
    modelCount: number;
    enabledProducts: number;
    enabledPlanProducts: number;
    databaseProvider: "file" | "postgres";
    steps: AdminSetupStep[];
};

export async function getAdminSetupSummary(input?: { settings?: AuthSettings; userSummary?: PublicUserSummary }) {
    const [settings, userSummary, products, paymentConfig] = await Promise.all([
        input?.settings ? Promise.resolve(input.settings) : getAuthSettings(),
        input?.userSummary ? Promise.resolve(input.userSummary) : getPublicUserSummary(),
        getBillingProductsSafe(),
        getPaymentConfigSummary(),
    ]);
    return buildAdminSetupSummary({ settings, userSummary, products, paymentConfig });
}

function buildAdminSetupSummary(input: { settings: AuthSettings; userSummary: PublicUserSummary; products?: BillingProductRecord[]; paymentConfig: Awaited<ReturnType<typeof getPaymentConfigSummary>> }): AdminSetupSummary {
    const { settings, userSummary } = input;
    const products = input.products || [];
    const admins = userSummary.activeAdmins;
    const enabledChannels = settings.systemChannels.filter((channel) => channel.enabled && channelConnectionReady(channel)).length;
    const enabledProducts = products.filter((product) => product.enabled).length;
    const enabledPlanProducts = countEnabledPlanProducts(products);
    const paymentConfig = input.paymentConfig;
    const paymentProviders = paymentConfig.providers.filter((provider) => provider.ready && provider.id !== "manual").map((provider) => provider.name);
    const databaseProvider = getDatabaseProvider();
    const hasPostgres = databaseProvider === "postgres" && Boolean(getPostgresConnectionString());
    const siteReady = Boolean(settings.site.title.trim() && settings.site.logoUrl.trim() && settings.site.seoTitle.trim() && settings.site.seoDescription.trim() && settings.site.termsUrl.trim() && settings.site.privacyUrl.trim());
    const channelModels = new Set(settings.systemChannels.flatMap((channel) => channel.models).filter(Boolean));
    const channelReady = enabledChannels > 0 && channelModels.size > 0;
    const defaultModelsReady = Boolean(settings.defaultModels.textModel || settings.defaultModels.imageModel || settings.defaultModels.videoModel);
    const enabledPlans = settings.entitlements.plans.filter((plan) => plan.enabled);
    const plansReady = settings.entitlements.enabled && enabledPlans.length >= 2 && enabledProducts > 0;
    const mailReady = Boolean(settings.mail.host.trim() && settings.mail.username.trim() && settings.mail.password.trim());
    const encryptionReady = hasProductionSecret(process.env.VOZEB_PRO_ENCRYPTION_KEY);

    const steps: AdminSetupStep[] = [
        {
            id: "site",
            title: "站点基础信息",
            eyebrow: "品牌与公开信息",
            status: siteReady ? "done" : "pending",
            statusLabel: siteReady ? "已完成" : "待完善",
            description: siteReady ? "站点名称、Logo、SEO 和协议入口已经具备基础发布条件。" : "补齐站点名称、Logo、SEO 摘要、服务条款和隐私政策入口。",
            href: "/admin?section=site",
            actionLabel: "配置站点",
            accent: "blue",
            facts: [settings.site.title || "未设置站点名", settings.site.logoUrl ? "Logo 已设置" : "Logo 未设置", settings.site.seoDescription ? "SEO 摘要已填写" : "SEO 摘要未填写"],
        },
        {
            id: "models",
            title: "系统模型渠道",
            eyebrow: "AI 能力入口",
            status: channelReady && defaultModelsReady ? "done" : enabledChannels > 0 ? "attention" : "pending",
            statusLabel: channelReady && defaultModelsReady ? "已可用" : enabledChannels > 0 ? "待完善" : "待配置",
            description: enabledChannels > 0 ? "已存在启用渠道，请继续同步模型并配置默认逻辑模型。" : "配置至少一个 OpenAI、Gemini 或兼容接口渠道，并保存可用模型。",
            href: "/admin?section=channels",
            actionLabel: "配置模型",
            accent: "emerald",
            facts: [`已启用 ${enabledChannels} 个渠道`, `模型 ${channelModels.size} 个`, defaultModelsReady ? "默认模型已选择" : "默认模型未选择"],
        },
        {
            id: "plans",
            title: "套餐与人民币价格规则",
            eyebrow: "商业权益",
            status: plansReady ? "done" : enabledPlans.length >= 2 || enabledProducts > 0 ? "attention" : "pending",
            statusLabel: plansReady ? "已启用" : "待启用",
            description: plansReady ? "套餐权益、默认套餐和可售商品已经串起来。" : "启用套餐权益，并确认免费版、创作者版、专业版和可售商品配置。",
            href: "/admin?section=products",
            actionLabel: "配置套餐",
            accent: "violet",
            facts: [`权益开关${settings.entitlements.enabled ? "已开启" : "未开启"}`, `权益套餐 ${enabledPlans.length} 个`, `在售套餐 ${enabledPlanProducts} 个`],
        },
        {
            id: "payments",
            title: "支付渠道",
            eyebrow: "收款闭环",
            status: paymentProviders.length > 0 ? "done" : "attention",
            statusLabel: paymentProviders.length > 0 ? "已配置" : "人工确认可用",
            description: paymentProviders.length > 0 ? "真实支付渠道已具备下单和回调接入条件。" : "当前可先用后台人工确认收款；正式运营前建议配置 Stripe、支付宝、微信支付或 PayPly。",
            href: "/admin?section=payments",
            actionLabel: "查看支付",
            accent: "amber",
            facts: [
                `真实渠道 ${paymentProviders.length} 个`,
                paymentProviders.length ? paymentProviders.join(" / ") : "Stripe / 支付宝 / 微信 / PayPly 待配置",
                hasPaymentProductionSecret(process.env.VOZEB_PRO_PAYMENT_WEBHOOK_SECRET) ? "通用回调密钥已设置" : "通用回调密钥待设置",
            ],
        },
        {
            id: "mail",
            title: "邮件与安全",
            eyebrow: "账号可信度",
            status: mailReady && encryptionReady ? "done" : mailReady || encryptionReady ? "attention" : "pending",
            statusLabel: mailReady && encryptionReady ? "已完成" : "待加固",
            description: mailReady && encryptionReady ? "SMTP 和生产加密密钥已经配置。" : "配置 SMTP 发信能力，并使用生产级 VOZEB_PRO_ENCRYPTION_KEY 保存后台凭据。",
            href: "/admin?section=settings",
            actionLabel: "配置安全",
            accent: "rose",
            facts: [mailReady ? "SMTP 已配置" : "SMTP 待配置", encryptionReady ? "加密密钥已设置" : "加密密钥待替换", settings.emailRegistrationEnabled ? "邮箱注册已开启" : "邮箱注册未开启"],
        },
        {
            id: "storage",
            title: "存储与备份",
            eyebrow: "部署可维护性",
            status: hasPostgres ? "done" : "attention",
            statusLabel: hasPostgres ? "已配置" : "文件模式",
            description: hasPostgres ? "业务数据使用 PostgreSQL，媒体统一保存在服务器本地目录并按临时与长期分类。" : "当前业务数据与媒体都使用服务器文件目录，正式部署需要挂载持久数据卷并做好目录备份。",
            href: "/admin?section=settings",
            actionLabel: "管理媒体",
            accent: "slate",
            facts: [hasPostgres ? "PostgreSQL 已启用" : "业务数据使用文件模式", "媒体保存在服务器本地", "临时文件自动清理", "长期文件由管理员删除"],
        },
    ];
    const completed = steps.filter((step) => step.status === "done").length;
    return {
        siteTitle: settings.site.title,
        completed,
        total: steps.length,
        percent: Math.round((completed / steps.length) * 100),
        users: userSummary.total,
        admins,
        totalChannels: settings.systemChannels.length,
        enabledChannels,
        modelCount: channelModels.size,
        enabledProducts,
        enabledPlanProducts,
        databaseProvider,
        steps,
    };
}

export function countEnabledPlanProducts(products: BillingProductRecord[]) {
    return products.filter((product) => product.enabled && product.productKind === "plan").length;
}

async function getBillingProductsSafe() {
    try {
        return await listBillingProducts(true);
    } catch {
        return [];
    }
}

function hasProductionSecret(value: string | undefined) {
    const text = value?.trim() || "";
    return Boolean(text && !/replace-with|change-me|your-|example|local-dev/i.test(text));
}
