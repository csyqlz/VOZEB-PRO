"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
    Activity,
    BadgePercent,
    Building2,
    BookOpen,
    CircleDollarSign,
    Cloud,
    ChevronDown,
    CreditCard,
    Database,
    DatabaseBackup,
    ExternalLink,
    Film,
    Gift,
    GalleryVerticalEnd,
    Globe2,
    HardDrive,
    KeyRound,
    Megaphone,
    Menu,
    PanelLeftClose,
    PanelLeftOpen,
    PlugZap,
    ReceiptText,
    SlidersHorizontal,
    Sparkles,
    TicketPercent,
    UserPlus,
    UsersRound,
    UserRoundX,
    WalletCards,
    X,
} from "lucide-react";
import { canAccessAdminSection, type AdminSectionKey } from "@/components/admin/admin-sections";
import { SiteLogo } from "@/components/layout/site-logo";
import type { PublicUser } from "@/lib/auth/store";
import { DEFAULT_SITE_TITLE } from "@/lib/site-brand";
import { usePublicSessionStore } from "@/stores/use-public-session-store";

type AdminSection = { key: AdminSectionKey; label: string; description: string; shortDescription: string; icon: ReactNode };
type AdminSectionGroup = { title: string; items: AdminSection[] };

export function AdminSectionNav({
    activeKey,
    onChange,
    onIntent,
    mobileOpen,
    desktopCollapsed,
    onDesktopToggle,
    onMobileToggle,
    onMobileClose,
    currentUser,
}: {
    activeKey: AdminSectionKey;
    onChange: (key: AdminSectionKey) => void;
    onIntent?: (key: AdminSectionKey) => void;
    mobileOpen: boolean;
    desktopCollapsed: boolean;
    onDesktopToggle: () => void;
    onMobileToggle: () => void;
    onMobileClose: () => void;
    currentUser: PublicUser;
}) {
    const allowedGroups = adminSectionGroups.map((group) => ({ ...group, items: group.items.filter((section) => canAccessAdminSection(currentUser, section.key)) })).filter((group) => group.items.length);
    const activeGroup = allowedGroups.find((group) => group.items.some((section) => section.key === activeKey));
    const activeGroupTitle = activeGroup?.title;
    const site = usePublicSessionStore((state) => state.payload?.settings?.site) || { title: DEFAULT_SITE_TITLE, logoUrl: "/logo.svg" };
    const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

    useEffect(() => {
        if (!activeGroupTitle) return;
        setCollapsedGroups((current) => {
            const next = { ...current };
            if (next[activeGroupTitle]) next[activeGroupTitle] = false;
            return next;
        });
    }, [activeGroupTitle]);

    const renderSectionItems = (items: AdminSection[]) =>
        items.map((section) => {
            const active = section.key === activeKey;
            return (
                <button
                    key={section.key}
                    type="button"
                    title={desktopCollapsed ? section.label : undefined}
                    aria-label={section.label}
                    className={`admin-section-nav-item relative flex h-9 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-left text-sm transition ${active ? "is-active bg-zinc-100 font-medium text-zinc-950 dark:bg-zinc-900 dark:text-zinc-50" : "text-zinc-600 hover:bg-zinc-50 hover:text-zinc-950 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-white"}`}
                    onPointerEnter={() => onIntent?.(section.key)}
                    onPointerDown={() => onIntent?.(section.key)}
                    onFocus={() => onIntent?.(section.key)}
                    onClick={() => {
                        onChange(section.key);
                        onMobileClose();
                    }}
                >
                    <span className="admin-section-nav-icon flex size-4 shrink-0 items-center justify-center">{section.icon}</span>
                    <span className="admin-section-nav-copy min-w-0 truncate">{section.label}</span>
                </button>
            );
        });

    return (
        <aside className={`admin-section-nav h-dvh min-w-0 border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 lg:sticky lg:top-0 lg:z-40 ${mobileOpen ? "is-open" : ""} ${desktopCollapsed ? "is-collapsed" : ""}`}>
            <div className="admin-section-nav-shell flex h-full max-w-full flex-col overflow-hidden">
                <div className="admin-section-mobile-head flex h-[58px] shrink-0 items-center justify-between border-b border-zinc-200 px-3 dark:border-zinc-800 lg:hidden">
                    <button
                        type="button"
                        className="admin-section-nav-toggle flex size-8 shrink-0 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-700 transition hover:bg-zinc-50 hover:text-zinc-950 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900"
                        aria-label={mobileOpen ? "收起后台侧边栏" : "展开后台侧边栏"}
                        aria-expanded={mobileOpen}
                        onClick={onMobileToggle}
                    >
                        {mobileOpen ? <X className="size-4" /> : <Menu className="size-4" />}
                    </button>
                    <Link href="/" className="admin-section-mobile-brand flex min-w-0 flex-1 items-center gap-2.5 px-1 text-zinc-950 dark:text-zinc-100" onClick={onMobileClose}>
                        <SiteLogo logoUrl={site.logoUrl} className="size-7" />
                        <span className="min-w-0">
                            <span className="block truncate text-sm font-semibold">{site.title}</span>
                            <span className="block truncate text-[10px] text-zinc-400 dark:text-zinc-500">管理控制台</span>
                        </span>
                    </Link>
                </div>
                <div className="admin-section-desktop-head hidden h-[58px] shrink-0 min-w-0 items-center gap-2 border-b border-zinc-200 px-3 dark:border-zinc-800 lg:flex">
                    <Link href="/" className="admin-section-brand flex min-w-0 flex-1 items-center gap-2.5 text-zinc-950 dark:text-zinc-100">
                        <SiteLogo logoUrl={site.logoUrl} className="size-7" />
                        <span className="admin-section-brand-copy min-w-0">
                            <span className="block truncate text-sm font-semibold">{site.title}</span>
                            <span className="block truncate text-[10px] text-zinc-400 dark:text-zinc-500">管理控制台</span>
                        </span>
                    </Link>
                    <button
                        type="button"
                        className="admin-section-desktop-toggle flex size-8 shrink-0 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-500 transition hover:bg-zinc-50 hover:text-zinc-950 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-white"
                        aria-label={desktopCollapsed ? "展开后台侧边栏" : "收起后台侧边栏"}
                        aria-expanded={!desktopCollapsed}
                        title={desktopCollapsed ? "展开侧边栏" : "收起侧边栏"}
                        onClick={onDesktopToggle}
                    >
                        {desktopCollapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
                    </button>
                </div>
                <div className="admin-section-nav-list flex flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-3 py-4">
                    {allowedGroups.map((group) => {
                        const collapsed = Boolean(collapsedGroups[group.title]) && !desktopCollapsed;
                        return (
                            <div key={group.title} className="admin-section-nav-group block min-w-0">
                                <button
                                    type="button"
                                    className="admin-section-nav-group-title relative flex w-full items-center rounded-md px-2 pb-1.5 pr-7 text-left text-[10px] font-semibold text-zinc-400 transition hover:text-zinc-700 dark:text-zinc-600 dark:hover:text-zinc-300"
                                    aria-expanded={!collapsed}
                                    aria-controls={`admin-section-group-${group.title}`}
                                    onClick={() => setCollapsedGroups((current) => ({ ...current, [group.title]: !current[group.title] }))}
                                >
                                    <span>{group.title}</span>
                                    <ChevronDown className={`admin-section-nav-group-chevron absolute right-2 top-1/2 size-3 shrink-0 -translate-y-1/2 transition-transform ${collapsed ? "-rotate-90" : ""}`} />
                                </button>
                                {!collapsed ? (
                                    <div id={`admin-section-group-${group.title}`} className="admin-section-nav-group-items flex flex-col gap-1">
                                        {renderSectionItems(group.items)}
                                    </div>
                                ) : null}
                            </div>
                        );
                    })}
                </div>
            </div>
        </aside>
    );
}

export const adminSections: AdminSection[] = [
    { key: "overview", label: "经营看板", description: "查看用户增长、调用趋势、收入概览和模型请求分布。", shortDescription: "数据总览", icon: <Database className="size-4" /> },
    { key: "users", label: "用户运营", description: "管理用户角色、账号状态、套餐归属和积分余额。", shortDescription: "账户与权益", icon: <UsersRound className="size-4" /> },
    { key: "tenants", label: "租户管理", description: "创建租户、维护负责人并查看成员与调用概况。", shortDescription: "企业与团队", icon: <Building2 className="size-4" /> },
    { key: "logs", label: "调用记录", description: "追踪用户生成任务、模型调用、入口来源和失败原因。", shortDescription: "生成与模型", icon: <Film className="size-4" /> },
    { key: "generationOperations", label: "生成运维", description: "统一排查生成任务、会话、项目、渠道健康、失败原因和积分成本。", shortDescription: "任务排障", icon: <Activity className="size-4" /> },
    { key: "products", label: "套餐管理", description: "配置充值中心展示的套餐、价格、积分权益和有效期。", shortDescription: "商品与权益", icon: <CreditCard className="size-4" /> },
    { key: "promotions", label: "促销活动", description: "配置限时活动价、促销标签、生效时间和适用商品。", shortDescription: "活动价", icon: <BadgePercent className="size-4" /> },
    { key: "coupons", label: "优惠券", description: "管理优惠券规则、领取库存、适用商品和定向发放。", shortDescription: "领券与核销", icon: <TicketPercent className="size-4" /> },
    { key: "referrals", label: "邀请奖励", description: "配置邀请码、首单奖励、冷静期、风控与结算。", shortDescription: "拉新与奖励", icon: <UserPlus className="size-4" /> },
    { key: "orders", label: "订单管理", description: "处理充值订单、收款确认、退款标记和基础对账。", shortDescription: "收款与售后", icon: <ReceiptText className="size-4" /> },
    { key: "points", label: "积分规则", description: "配置免费每日积分、模型基础扣费和生成参数倍率。", shortDescription: "额度与扣费", icon: <CircleDollarSign className="size-4" /> },
    { key: "payments", label: "支付渠道", description: "配置 Stripe、支付宝、微信支付、PayPly 和人工确认渠道。", shortDescription: "密钥与回调", icon: <PlugZap className="size-4" /> },
    { key: "cdk", label: "CDK 兑换", description: "生成和管理积分或套餐兑换码，用于活动发放和售后补偿。", shortDescription: "兑换码", icon: <Gift className="size-4" /> },
    { key: "wallet", label: "财务流水", description: "查看资金流水、积分负债和收入/退款对账口径。", shortDescription: "收入对账", icon: <WalletCards className="size-4" /> },
    { key: "site", label: "站点资料", description: "管理前台网站标题、Logo、SEO 标题、描述和关键词。", shortDescription: "品牌与 SEO", icon: <Globe2 className="size-4" /> },
    { key: "channels", label: "模型渠道", description: "添加上游接口，维护模型目录、逻辑绑定和各能力默认模型。", shortDescription: "上游接口", icon: <PlugZap className="size-4" /> },
    { key: "skills", label: "Agent Skills", description: "管理 Agent 专业能力、触发词、来源和执行规则。", shortDescription: "专业能力", icon: <Sparkles className="size-4" /> },
    { key: "settings", label: "基础设置", description: "管理注册、邮箱、生成与数据维护。", shortDescription: "账号与生成", icon: <SlidersHorizontal className="size-4" /> },
    { key: "accountDeletion", label: "注销申请", description: "查看用户账号注销申请，完成身份核验、受理或拒绝并保留审计记录。", shortDescription: "用户权利请求", icon: <UserRoundX className="size-4" /> },
    { key: "mediaStorage", label: "本地媒体", description: "查看服务器图片、视频和音频文件，管理临时期限与长期存储。", shortDescription: "文件与期限", icon: <HardDrive className="size-4" /> },
    { key: "externalStorage", label: "外部存储", description: "配置 S3 兼容存储，迁移本地媒体并管理外部对象。", shortDescription: "S3 与 OSS", icon: <Cloud className="size-4" /> },
    { key: "backup", label: "数据备份", description: "导出和恢复脱敏业务数据，并区分整库与媒体备份边界。", shortDescription: "导入与恢复", icon: <DatabaseBackup className="size-4" /> },
    { key: "updates", label: "版本更新", description: "集中查看版本更新、更新日志和 GitHub 开源仓库入口。", shortDescription: "升级维护", icon: <ExternalLink className="size-4" /> },
    { key: "announcements", label: "公告通知", description: "发布站内公告，并设置首页或登录后弹窗触达。", shortDescription: "弹窗触达", icon: <Megaphone className="size-4" /> },
    { key: "works", label: "作品管理", description: "审核用户发布版本，处理驳回、公开预览和作品下架。", shortDescription: "审核与下架", icon: <GalleryVerticalEnd className="size-4" /> },
    { key: "prompts", label: "提示词运营", description: "维护用户端提示词库展示的公共提示词。", shortDescription: "公共资产", icon: <KeyRound className="size-4" /> },
    { key: "adminHelp", label: "使用文档", description: "查看后台配置顺序、运营操作、检查项和风险提示。", shortDescription: "配置与运营", icon: <BookOpen className="size-4" /> },
];

export const adminSectionGroups: AdminSectionGroup[] = [
    { title: "经营分析", items: sectionsFor(["overview", "users", "tenants", "logs", "generationOperations"]) },
    { title: "商品运营", items: sectionsFor(["products", "orders"]) },
    { title: "营销推广", items: sectionsFor(["promotions", "coupons", "referrals"]) },
    { title: "财务管理", items: sectionsFor(["points", "payments", "cdk", "wallet"]) },
    { title: "上游配置", items: sectionsFor(["channels", "skills"]) },
    { title: "系统管理", items: sectionsFor(["site", "settings", "accountDeletion"]) },
    { title: "存储与备份", items: sectionsFor(["mediaStorage", "externalStorage", "backup"]) },
    { title: "内容运营", items: sectionsFor(["works", "announcements", "prompts"]) },
    { title: "帮助与支持", items: sectionsFor(["updates", "adminHelp"]) },
];

function sectionsFor(keys: AdminSectionKey[]) {
    const sections = new Map(adminSections.map((section) => [section.key, section]));
    return keys.map((key) => sections.get(key)).filter((section): section is AdminSection => Boolean(section));
}
