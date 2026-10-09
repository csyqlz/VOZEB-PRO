"use client";

import { GenerationLogDetail } from "@/components/admin/admin-generation-log";
import { AdminOverview } from "@/components/admin/admin-overview";
import { AdminSectionNav } from "@/components/admin/admin-section-nav";
import type { AdminSectionKey } from "@/components/admin/admin-sections";
import { Button, Form, Input, Modal } from "antd";
import { ArrowRight, Copy, Menu, Plus, Sparkles } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import type { AuthSettings, PublicUser, PublicUserSummary } from "@/lib/auth/store";
import type { AdminSetupSummary } from "@/lib/server/admin-setup-status";
import { CdkRedemptionDetail } from "./admin-dashboard-elements";
import { AdminUserEditorModal } from "./admin-user-editor-modal";
import { useAdminDashboardController } from "./use-admin-dashboard-controller";

type AdminDashboardProps = {
    initialUsers: PublicUser[];
    initialUserSummary: PublicUserSummary;
    initialSettings: AuthSettings;
    initialPromptCount: number;
    currentUser: PublicUser;
    initialSection?: AdminSectionKey;
    setupSummary?: AdminSetupSummary;
    headerActions?: ReactNode;
};
const loadSiteSection = () => import("./admin-configuration-sections").then((module) => module.AdminSiteSection);
const loadSettingsSection = () => import("./admin-configuration-sections").then((module) => module.AdminSettingsSection);
const loadMediaStorageSection = () => import("./admin-system-sections").then((module) => module.AdminMediaStorageSection);
const loadExternalStorageSection = () => import("./admin-system-sections").then((module) => module.AdminExternalStorageSection);
const loadBackupSection = () => import("./admin-system-sections").then((module) => module.AdminBackupSection);
const loadUpdatesSection = () => import("./admin-system-sections").then((module) => module.AdminUpdatesSection);
const loadWalletSection = () => import("./admin-wallet-section").then((module) => module.AdminWalletSection);
const loadPointsSection = () => import("./admin-points-section").then((module) => module.AdminPointsSection);
const loadOrdersSection = () => import("./admin-billing-sections").then((module) => module.AdminOrdersSection);
const loadProductsSection = () => import("./admin-billing-sections").then((module) => module.AdminProductsSection);
const loadPromotionsSection = () => import("./admin-billing-sections").then((module) => module.AdminPromotionsSection);
const loadCouponsSection = () => import("./admin-billing-sections").then((module) => module.AdminCouponsSection);
const loadPaymentsSection = () => import("./admin-billing-sections").then((module) => module.AdminPaymentsSection);
const loadCdkSection = () => import("./admin-cdk-section").then((module) => module.AdminCdkSection);
const loadReferralsSection = () => import("./admin-marketing-sections").then((module) => module.AdminReferralsSection);
const loadChannelsSection = () => import("./admin-upstream-sections").then((module) => module.AdminChannelsSection);
const loadSkillsSection = () => import("./admin-upstream-sections").then((module) => module.AdminSkillsSection);
const loadAnnouncementsSection = () => import("./admin-content-sections").then((module) => module.AdminAnnouncementsSection);
const loadPromptsSection = () => import("./admin-content-sections").then((module) => module.AdminPromptsSection);
const loadWorksSection = () => import("@/app/admin/works/components/admin-works-section").then((module) => module.AdminWorksSection);
const loadHelpSection = () => import("./admin-help-section").then((module) => module.AdminHelpSection);
const loadUsersSection = () => import("./admin-users-section").then((module) => module.AdminUsersSection);
const loadTenantsSection = () => import("./admin-tenants-section").then((module) => module.AdminTenantsSection);
const loadLogsSection = () => import("./admin-logs-section").then((module) => module.AdminLogsSection);
const loadGenerationOperationsSection = () => import("./admin-generation-operations-section").then((module) => module.AdminGenerationOperationsSection);
const loadAccountDeletionSection = () => import("./admin-account-deletion-section").then((module) => module.AdminAccountDeletionSection);

const sectionLoaders: Partial<Record<AdminSectionKey, () => Promise<unknown>>> = {
    site: loadSiteSection,
    settings: loadSettingsSection,
    mediaStorage: loadMediaStorageSection,
    externalStorage: loadExternalStorageSection,
    backup: loadBackupSection,
    updates: loadUpdatesSection,
    wallet: loadWalletSection,
    points: loadPointsSection,
    orders: loadOrdersSection,
    products: loadProductsSection,
    payments: loadPaymentsSection,
    cdk: loadCdkSection,
    promotions: loadPromotionsSection,
    coupons: loadCouponsSection,
    referrals: loadReferralsSection,
    channels: loadChannelsSection,
    skills: loadSkillsSection,
    announcements: loadAnnouncementsSection,
    prompts: loadPromptsSection,
    works: loadWorksSection,
    adminHelp: loadHelpSection,
    users: loadUsersSection,
    tenants: loadTenantsSection,
    logs: loadLogsSection,
    generationOperations: loadGenerationOperationsSection,
    accountDeletion: loadAccountDeletionSection,
};

const AdminSiteSection = dynamic(loadSiteSection, { loading: AdminSectionLoading });
const AdminSettingsSection = dynamic(loadSettingsSection, { loading: AdminSectionLoading });
const AdminBackupSection = dynamic(loadBackupSection, { loading: AdminSectionLoading });
const AdminExternalStorageSection = dynamic(loadExternalStorageSection, { loading: AdminSectionLoading });
const AdminMediaStorageSection = dynamic(loadMediaStorageSection, { loading: AdminSectionLoading });
const AdminUpdatesSection = dynamic(loadUpdatesSection, { loading: AdminSectionLoading });
const AdminWalletSection = dynamic(loadWalletSection, { loading: AdminSectionLoading });
const AdminPointsSection = dynamic(loadPointsSection, { loading: AdminSectionLoading });
const AdminOrdersSection = dynamic(loadOrdersSection, { loading: AdminSectionLoading });
const AdminProductsSection = dynamic(loadProductsSection, { loading: AdminSectionLoading });
const AdminPromotionsSection = dynamic(loadPromotionsSection, { loading: AdminSectionLoading });
const AdminCouponsSection = dynamic(loadCouponsSection, { loading: AdminSectionLoading });
const AdminReferralsSection = dynamic(loadReferralsSection, { loading: AdminSectionLoading });
const AdminPaymentsSection = dynamic(loadPaymentsSection, { loading: AdminSectionLoading });
const AdminCdkSection = dynamic(loadCdkSection, { loading: AdminSectionLoading });
const AdminChannelsSection = dynamic(loadChannelsSection, { loading: AdminSectionLoading });
const AdminSkillsSection = dynamic(loadSkillsSection, { loading: AdminSectionLoading });
const AdminAnnouncementsSection = dynamic(loadAnnouncementsSection, { loading: AdminSectionLoading });
const AdminPromptsSection = dynamic(loadPromptsSection, { loading: AdminSectionLoading });
const AdminWorksSection = dynamic(loadWorksSection, { loading: AdminSectionLoading });
const AdminHelpSection = dynamic(loadHelpSection, { loading: AdminSectionLoading });
const AdminUsersSection = dynamic(loadUsersSection, { loading: AdminSectionLoading });
const AdminTenantsSection = dynamic(loadTenantsSection, { loading: AdminSectionLoading });
const AdminLogsSection = dynamic(loadLogsSection, { loading: AdminSectionLoading });
const AdminGenerationOperationsSection = dynamic(loadGenerationOperationsSection, { loading: AdminSectionLoading });
const AdminAccountDeletionSection = dynamic(loadAccountDeletionSection, { loading: AdminSectionLoading });

function AdminSectionLoading() {
    return <div className="flex min-h-36 items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">正在加载分区...</div>;
}

export function AdminDashboard(props: AdminDashboardProps) {
    const [hydrated, setHydrated] = useState(false);
    useEffect(() => setHydrated(true), []);
    const controller = useAdminDashboardController(props);
    const {
        currentUser,
        setupSummary,
        headerActions,
        promptForm,
        logoInputRef,
        iconInputRef,
        promptCount,
        assetStats,
        promptSaving,
        operationsSummaryLoading,
        viewingGenerationLog,
        setViewingGenerationLog,
        billingSummary,
        billingSummaryLoading,
        viewingCdkCode,
        setViewingCdkCode,
        promptModalOpen,
        activeSection,
        setActiveSection,
        mobileNavOpen,
        setMobileNavOpen,
        desktopNavCollapsed,
        setDesktopNavCollapsed,
        stats,
        settingsSummary,
        walletSummary,
        operationsSummary,
        loadBillingSummary,
        loadOperationsSummary,
        createPrompt,
        copyCdkPlainCode,
        closePromptModal,
        uploadSiteLogo,
        uploadSiteIcon,
        activeSectionInfo,
        nextSetupStep,
    } = controller;
    return (
        <div data-hydrated={hydrated ? "true" : "false"} className={`admin-mobile-safe admin-dashboard-shell min-h-dvh w-full min-w-0 ${desktopNavCollapsed ? "is-sidebar-collapsed" : ""}`}>
            {mobileNavOpen ? <button type="button" className="admin-section-nav-backdrop lg:hidden" aria-label="收起后台侧边栏" onClick={() => setMobileNavOpen(false)} /> : null}
            <AdminSectionNav
                activeKey={activeSection}
                currentUser={currentUser}
                onChange={setActiveSection}
                onIntent={(section) => void sectionLoaders[section]?.()}
                mobileOpen={mobileNavOpen}
                desktopCollapsed={desktopNavCollapsed}
                onDesktopToggle={() => setDesktopNavCollapsed((collapsed) => !collapsed)}
                onMobileToggle={() => setMobileNavOpen((open) => !open)}
                onMobileClose={() => setMobileNavOpen(false)}
            />
            <div className="w-full min-w-0 max-w-full overflow-x-hidden">
                <header className="admin-dashboard-header sticky top-0 z-20 border-b border-zinc-200 bg-white px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-950 sm:px-6 lg:px-5">
                    <div className="admin-dashboard-header-inner mx-auto flex min-h-9 w-full max-w-[1600px] min-w-0 items-center justify-between gap-3">
                        <div className="admin-dashboard-title-row flex min-w-0 items-center gap-3">
                            <button
                                type="button"
                                className="admin-mobile-menu-trigger flex size-9 shrink-0 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-700 transition hover:bg-zinc-50 hover:text-zinc-950 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-900 lg:hidden"
                                aria-label="展开后台侧边栏"
                                onClick={() => setMobileNavOpen(true)}
                            >
                                <Menu className="size-4" />
                            </button>
                            <div className="min-w-0 items-center gap-2 text-xs text-zinc-400 lg:flex">
                                <span>后台</span>
                                <span>/</span>
                                <strong className="truncate font-medium text-zinc-700 dark:text-zinc-300">{activeSectionInfo.label}</strong>
                            </div>
                        </div>
                        <div className="admin-dashboard-actions flex min-w-0 items-center gap-2 sm:justify-end">
                            {setupSummary && nextSetupStep ? (
                                <Link
                                    href="/admin/setup"
                                    title={`下一项：${nextSetupStep.title}`}
                                    className="admin-dashboard-setup-pill group flex min-w-0 items-center gap-2 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-left transition hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:bg-zinc-900"
                                >
                                    <span className="admin-dashboard-setup-icon grid size-5 shrink-0 place-items-center text-zinc-500 dark:text-zinc-400">
                                        <Sparkles className="size-3.5" />
                                    </span>
                                    <span className="admin-dashboard-setup-copy flex min-w-0 items-center gap-2">
                                        <span className="admin-dashboard-setup-title flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-zinc-700 dark:text-zinc-200">
                                            初始化 {setupSummary.percent}%
                                            <ArrowRight className="admin-dashboard-setup-arrow size-3 text-zinc-400 transition group-hover:translate-x-0.5" />
                                        </span>
                                        <span className="admin-dashboard-setup-track block h-1 w-16 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                                            <span className="admin-dashboard-setup-progress block h-full rounded-full bg-zinc-700 dark:bg-zinc-300" style={{ width: `${setupSummary.percent}%` }} />
                                        </span>
                                    </span>
                                </Link>
                            ) : null}
                            {headerActions ? <div className="admin-dashboard-header-actions flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">{headerActions}</div> : null}
                        </div>
                    </div>
                </header>

                <div className="mx-auto w-full max-w-[1600px] min-w-0 space-y-3 px-3 py-3 sm:space-y-5 sm:px-6 sm:py-6 lg:px-8 xl:px-9 xl:py-7">
                    <section className="border-b border-zinc-200 pb-3 sm:pb-5 dark:border-zinc-800">
                        <h1 className="text-lg font-semibold text-zinc-950 sm:text-xl dark:text-zinc-100">{activeSectionInfo.label}</h1>
                        <div className="mt-1 line-clamp-2 max-w-3xl text-xs leading-5 text-zinc-500 sm:mt-1.5 sm:line-clamp-none sm:text-sm sm:leading-6 dark:text-zinc-400">{activeSectionInfo.description}</div>
                    </section>

                    {activeSection === "overview" ? (
                        <AdminOverview
                            stats={stats}
                            settingsSummary={settingsSummary}
                            walletSummary={walletSummary}
                            billingSummary={billingSummary}
                            operationsSummary={operationsSummary}
                            promptCount={promptCount}
                            assetStats={assetStats}
                            enabledProducts={setupSummary?.enabledProducts || 0}
                            billingLoading={billingSummaryLoading}
                            loading={operationsSummaryLoading}
                            onRefreshBilling={loadBillingSummary}
                            onRefresh={() => void loadOperationsSummary()}
                        />
                    ) : null}
                    {activeSection === "site" ? <AdminSiteSection controller={controller} /> : null}
                    {activeSection === "settings" ? <AdminSettingsSection controller={controller} /> : null}
                    {activeSection === "accountDeletion" ? <AdminAccountDeletionSection active /> : null}
                    {activeSection === "mediaStorage" ? <AdminMediaStorageSection controller={controller} /> : null}
                    {activeSection === "externalStorage" ? <AdminExternalStorageSection controller={controller} /> : null}
                    {activeSection === "backup" ? <AdminBackupSection controller={controller} /> : null}
                    {activeSection === "wallet" ? <AdminWalletSection controller={controller} /> : null}
                    {activeSection === "points" ? <AdminPointsSection controller={controller} /> : null}
                    {activeSection === "orders" ? <AdminOrdersSection controller={controller} /> : null}
                    {activeSection === "products" ? <AdminProductsSection controller={controller} /> : null}
                    {activeSection === "promotions" ? <AdminPromotionsSection controller={controller} /> : null}
                    {activeSection === "coupons" ? <AdminCouponsSection controller={controller} /> : null}
                    {activeSection === "referrals" ? <AdminReferralsSection controller={controller} /> : null}
                    {activeSection === "payments" ? <AdminPaymentsSection controller={controller} /> : null}
                    {activeSection === "updates" ? <AdminUpdatesSection controller={controller} /> : null}
                    {activeSection === "channels" ? <AdminChannelsSection controller={controller} /> : null}
                    {activeSection === "skills" ? <AdminSkillsSection controller={controller} /> : null}
                    {activeSection === "cdk" ? <AdminCdkSection controller={controller} /> : null}
                    {activeSection === "announcements" ? <AdminAnnouncementsSection controller={controller} /> : null}
                    {activeSection === "works" ? <AdminWorksSection /> : null}
                    {activeSection === "prompts" ? <AdminPromptsSection controller={controller} /> : null}
                    {activeSection === "users" ? <AdminUsersSection controller={controller} /> : null}
                    {activeSection === "tenants" ? <AdminTenantsSection currentUser={currentUser} /> : null}
                    {activeSection === "logs" ? <AdminLogsSection controller={controller} /> : null}
                    {activeSection === "generationOperations" ? <AdminGenerationOperationsSection controller={controller} /> : null}
                    {activeSection === "adminHelp" ? <AdminHelpSection onOpenSection={setActiveSection} /> : null}
                </div>
            </div>

            <Modal
                title="添加公共提示词"
                open={promptModalOpen}
                okText="保存提示词"
                cancelText="取消"
                confirmLoading={promptSaving}
                mask={{ closable: !promptSaving }}
                keyboard={!promptSaving}
                width={760}
                onOk={() => promptForm.submit()}
                onCancel={closePromptModal}
            >
                <Form className="admin-prompt-form" form={promptForm} layout="vertical" requiredMark={false} onFinish={createPrompt}>
                    <div className="max-h-[min(68dvh,680px)] overflow-y-auto pr-1">
                        <div className="admin-prompt-note mb-5 rounded-xl p-4">
                            <div className="flex items-center gap-2 text-sm font-semibold text-stone-950 dark:text-stone-100">
                                <Plus className="size-4 text-stone-600 dark:text-stone-300" />
                                新增公共提示词
                            </div>
                            <p className="mt-1 text-xs leading-5 text-stone-600 dark:text-stone-400">建议填写远程图片封面 URL，用户端会直接显示封面，不走本地素材存储。</p>
                        </div>
                        <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
                            <Form.Item label="提示词标题" name="title" rules={[{ required: true, message: "请输入标题" }]}>
                                <Input placeholder="例如：赛博城市海报" />
                            </Form.Item>
                            <Form.Item label="分类" name="category">
                                <Input placeholder="商业海报 / 人像 / 产品" />
                            </Form.Item>
                        </div>
                        <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
                            <Form.Item label="标签" name="tags">
                                <Input placeholder="用逗号分隔，例如：霓虹, 海报, 科幻" />
                            </Form.Item>
                            <Form.Item label="封面 URL" name="coverUrl">
                                <Input placeholder="https://example.com/image.png" />
                            </Form.Item>
                        </div>
                        <Form.Item label="提示词内容" name="prompt" rules={[{ required: true, message: "请输入提示词内容" }]}>
                            <Input.TextArea rows={7} placeholder="写入可直接用于生成的完整提示词，支持中英文描述。" />
                        </Form.Item>
                        <Form.Item label="备注 / 预览说明" name="preview">
                            <Input.TextArea rows={3} placeholder="可补充适用场景、参数建议或出图效果。" />
                        </Form.Item>
                    </div>
                </Form>
            </Modal>
            <AdminUserEditorModal controller={controller} />
            <Modal title="生成日志详情" open={Boolean(viewingGenerationLog)} footer={null} onCancel={() => setViewingGenerationLog(null)} width={860}>
                {viewingGenerationLog ? <GenerationLogDetail log={viewingGenerationLog} /> : null}
            </Modal>
            <Modal title="CDK 明细" open={Boolean(viewingCdkCode)} footer={null} onCancel={() => setViewingCdkCode(null)} width={760}>
                {viewingCdkCode ? (
                    <div className="space-y-3">
                        <div className="rounded-lg border border-stone-200 bg-stone-50/80 p-3 dark:border-stone-800 dark:bg-stone-900/60">
                            <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                <div className="text-sm font-semibold text-stone-950 dark:text-stone-100">兑换码</div>
                                <Button size="small" icon={<Copy className="size-3.5" />} disabled={!viewingCdkCode.code} onClick={() => void copyCdkPlainCode(viewingCdkCode)}>
                                    复制明文
                                </Button>
                            </div>
                            <div className="break-all rounded-md border border-stone-200 bg-white px-3 py-2 font-mono text-sm font-semibold text-stone-950 dark:border-stone-800 dark:bg-stone-950 dark:text-stone-100">
                                {viewingCdkCode.code || "CDK 明文不可用"}
                            </div>
                            {!viewingCdkCode.code ? <div className="mt-2 text-xs text-stone-500 dark:text-stone-400">这个 CDK 没有可复制的明文。</div> : null}
                        </div>
                        <CdkRedemptionDetail code={viewingCdkCode} />
                    </div>
                ) : null}
            </Modal>
            <input
                ref={logoInputRef}
                type="file"
                accept="image/png,image/jpeg,image/svg+xml"
                className="hidden"
                onChange={(event) => {
                    uploadSiteLogo(event.target.files?.[0]);
                    event.target.value = "";
                }}
            />
            <input
                ref={iconInputRef}
                type="file"
                accept="image/png,image/jpeg,image/svg+xml,image/x-icon,image/vnd.microsoft.icon"
                className="hidden"
                onChange={(event) => {
                    uploadSiteIcon(event.target.files?.[0]);
                    event.target.value = "";
                }}
            />
        </div>
    );
}
