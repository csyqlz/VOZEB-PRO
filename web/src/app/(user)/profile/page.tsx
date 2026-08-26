"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { App, Button, Input, Pagination } from "antd";
import { saveAs } from "file-saver";
import { CreditCard, Download, History, ReceiptText, RefreshCw, ShieldCheck, WalletCards } from "lucide-react";

import { CreditSymbol, formatCreditAmount } from "@/constant/credits";
import { CompactEmptyState } from "@/components/compact-empty-state";
import { resetClientSessionState } from "@/lib/client-session-reset";
import { downloadUserDataExport } from "@/services/api/user-data-export";
import { useUserStore, type LocalUser } from "@/stores/use-user-store";

import { AccountDeletionPanel } from "./account-deletion-panel";
import { AdminMfaPanel } from "./admin-mfa-panel";
import { LoginSecurityPanel } from "./login-security-panel";
import { CouponWalletSection } from "./profile-coupon-wallet";
import { ProfileReferralCenter } from "./profile-referral-center";

import {
    ProfileSectionKey,
    RECORD_PAGE_SIZE,
    profilePrimaryButtonClass,
    profileSecondaryButtonClass,
    profileDangerButtonClass,
    ProfileSectionNav,
    BillingCenterSection,
    AccountEmailForm,
    ProfileForm,
    OrderList,
    AccountMetric,
    AccountPanel,
    LoadingBlock,
    RecordList,
    ConsumptionRecordList,
    parseProfileSection,
} from "./profile-elements";
import { useProfileData } from "./use-profile-data";

export default function ProfilePage() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { message } = App.useApp();
    const user = useUserStore((state) => state.user);
    const setUser = useUserStore((state) => state.setUser);
    const requestedSection = parseProfileSection(searchParams.get("section"));
    const [activeSection, setActiveSection] = useState<ProfileSectionKey>(requestedSection);
    const [displayName, setDisplayName] = useState("");
    const [bio, setBio] = useState("");
    const [email, setEmail] = useState("");
    const [emailCode, setEmailCode] = useState("");
    const [currentPassword, setCurrentPassword] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [savingProfile, setSavingProfile] = useState(false);
    const [savingEmail, setSavingEmail] = useState(false);
    const [sendingCode, setSendingCode] = useState(false);
    const [savingPassword, setSavingPassword] = useState(false);
    const [exportingData, setExportingData] = useState(false);
    const { products, coupons, orders, points, consumption, loading: accountLoading, refresh: refreshAccount } = useProfileData(activeSection);

    const boundEmail = user?.email || "";
    const emailChanged = email.trim().toLowerCase() !== boundEmail.toLowerCase();

    useEffect(() => {
        setActiveSection(requestedSection);
    }, [requestedSection]);

    useEffect(() => {
        if (!user) return;
        setDisplayName(user.displayName || user.username);
        setBio(user.bio || "");
        setEmail(user.email || "");
    }, [user]);

    const switchSection = (key: ProfileSectionKey) => {
        setActiveSection(key);
        router.replace(key === "overview" ? "/profile" : `/profile?section=${key}`, { scroll: false });
    };

    const saveProfile = async () => {
        setSavingProfile(true);
        try {
            const response = await fetch("/api/auth/profile", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ displayName, bio }),
            });
            const payload = (await response.json()) as { user?: LocalUser; error?: string };
            if (!response.ok || !payload.user) throw new Error(payload.error || "保存个人资料失败");
            setUser(payload.user);
            setEmailCode("");
            message.success("个人资料已保存");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存个人资料失败");
        } finally {
            setSavingProfile(false);
        }
    };

    const saveEmail = async () => {
        if (!emailChanged || savingEmail) return;
        setSavingEmail(true);
        try {
            const response = await fetch("/api/auth/profile", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, emailCode }),
            });
            const payload = (await response.json()) as { user?: LocalUser; error?: string };
            if (!response.ok || !payload.user) throw new Error(payload.error || "邮箱更新失败");
            setUser(payload.user);
            setEmailCode("");
            message.success("邮箱已更新");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "邮箱更新失败");
        } finally {
            setSavingEmail(false);
        }
    };

    const sendEmailCode = async () => {
        if (!emailChanged) {
            message.info("邮箱未变化，无需获取验证码");
            return;
        }
        setSendingCode(true);
        try {
            const response = await fetch("/api/auth/email-code", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ purpose: "email-change", email }),
            });
            const payload = (await response.json()) as { error?: string };
            if (!response.ok) throw new Error(payload.error || "验证码发送失败");
            message.success("验证码已发送，请查看邮箱");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "验证码发送失败");
        } finally {
            setSendingCode(false);
        }
    };

    const savePassword = async () => {
        setSavingPassword(true);
        try {
            const response = await fetch("/api/auth/password", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ currentPassword, newPassword }),
            });
            const payload = (await response.json()) as { error?: string };
            if (!response.ok) throw new Error(payload.error || "修改密码失败");
            await resetClientSessionState();
            message.success("密码已修改，请重新登录");
            window.location.href = "/login";
        } catch (error) {
            message.error(error instanceof Error ? error.message : "修改密码失败");
        } finally {
            setSavingPassword(false);
        }
    };

    const exportUserData = async () => {
        setExportingData(true);
        try {
            const result = await downloadUserDataExport();
            saveAs(result.blob, result.fileName);
            message.success("个人数据已导出");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "个人数据导出失败");
        } finally {
            setExportingData(false);
        }
    };

    return (
        <main className="profile-page-scroll h-full min-h-0 overflow-x-hidden overflow-y-auto px-2 py-2 text-foreground sm:px-6 sm:py-6" style={{ backgroundColor: "var(--background)" }}>
            <div className="mx-auto w-full max-w-[1280px] pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:pb-[calc(2rem+env(safe-area-inset-bottom))]">
                <div className="mb-1 flex items-center justify-end gap-1.5 sm:mb-5 sm:justify-between sm:gap-3 sm:rounded-xl sm:border sm:border-border sm:bg-card sm:p-6 sm:text-card-foreground">
                    <div className="hidden min-w-0 sm:block">
                        <h1 className="text-lg font-semibold text-stone-950 sm:text-2xl dark:text-white">个人中心</h1>
                        <p className="mt-2 hidden max-w-2xl text-sm leading-6 text-stone-500 sm:block dark:text-stone-400">个人资料、套餐优惠、订单记录、消费记录和人民币余额流水集中在这里管理。</p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                        <Button size="small" className={profileSecondaryButtonClass} icon={<RefreshCw className="size-3.5 sm:size-4" />} loading={accountLoading} onClick={() => void refreshAccount()}>
                            <span className="sm:hidden">刷新</span>
                            <span className="hidden sm:inline">刷新记录</span>
                        </Button>
                        <Button size="small" className={profilePrimaryButtonClass} type="primary" icon={<CreditCard className="size-3.5 sm:size-4" />} onClick={() => switchSection("billing")}>
                            <span className="sm:hidden">套餐</span>
                            <span className="hidden sm:inline">购买套餐</span>
                        </Button>
                    </div>
                </div>

                <div className="mb-1.5 xl:hidden sm:mb-5">
                    <ProfileSectionNav activeKey={activeSection} onChange={switchSection} mode="mobile" />
                </div>

                {activeSection === "overview" ? (
                    <section className="mb-2 grid grid-cols-2 gap-1 overflow-hidden rounded-lg border border-border bg-card p-1 sm:mb-5 xl:grid-cols-4 xl:gap-3 xl:overflow-visible xl:rounded-none xl:border-0 xl:bg-transparent xl:p-0">
                        <AccountMetric label="当前套餐" value={user?.planName || user?.planId || "未加载"} icon={<WalletCards className="size-4" />} />
                        <AccountMetric
                            label="人民币余额"
                            value={`¥${formatCreditAmount(user?.pointsBalance || 0)}`}
                            detail={`今日 ${formatCreditAmount(user?.dailyPointsBalance || 0)} · 永久 ${formatCreditAmount(user?.permanentPointsBalance ?? user?.pointsBalance ?? 0)}`}
                            icon={<CreditSymbol className="text-base" />}
                        />
                        <AccountMetric label="充值订单" value={`${orders.total} 笔`} icon={<ReceiptText className="size-4" />} />
                        <AccountMetric label="余额流水" value={`${points.total} 条`} icon={<History className="size-4" />} />
                    </section>
                ) : null}

                <div className="grid min-w-0 gap-1.5 sm:gap-5 xl:grid-cols-[210px_minmax(0,1fr)]">
                    <div className="hidden xl:block">
                        <ProfileSectionNav activeKey={activeSection} onChange={switchSection} mode="desktop" />
                    </div>
                    <div className="min-w-0 space-y-1.5 sm:space-y-5">
                        {activeSection === "overview" ? (
                            <div className="grid gap-1.5 sm:gap-5 lg:grid-cols-2">
                                <AccountPanel title="最近余额流水" description="展示最近的人民币余额变化，更多记录在余额记录分区。">
                                    {points.loading ? <LoadingBlock /> : points.items.length ? <RecordList records={points.items.slice(0, 4)} /> : <CompactEmptyState title="暂无余额记录" description="每日余额、充值和模型消费记录会显示在这里。" />}
                                </AccountPanel>
                                <AccountPanel title="最近订单" description="展示最近的充值订单，支付完成后权益会自动或由客服确认开通。">
                                    <OrderList loading={orders.loading} orders={orders.items.slice(0, 5)} total={orders.total} page={orders.page} onPageChange={orders.setPage} compact />
                                </AccountPanel>
                            </div>
                        ) : null}

                        {activeSection === "profile" ? (
                            <AccountPanel title="个人资料" description="更换头像、修改显示昵称和个人简介。">
                                <ProfileForm user={user} displayName={displayName} bio={bio} savingProfile={savingProfile} onDisplayNameChange={setDisplayName} onBioChange={setBio} onSave={() => void saveProfile()} />
                            </AccountPanel>
                        ) : null}

                        {activeSection === "billing" ? (
                            <BillingCenterSection
                                products={products.items}
                                productsLoading={products.loading}
                                onRefresh={() => void products.refresh()}
                                onCheckout={(product) => router.push(`/billing/checkout?product=${encodeURIComponent(product.id)}`)}
                            />
                        ) : null}

                        {activeSection === "coupons" ? (
                            <CouponWalletSection
                                coupons={coupons.items}
                                templates={coupons.templates}
                                templatesTotal={coupons.templatesTotal}
                                templatePage={coupons.templatePage}
                                total={coupons.total}
                                page={coupons.page}
                                loading={coupons.loading}
                                onRefresh={coupons.refresh}
                                onTemplatePageChange={coupons.setTemplatePage}
                                onPageChange={coupons.setPage}
                                onClaimed={coupons.refreshAfterClaim}
                            />
                        ) : null}

                        {activeSection === "referrals" ? <ProfileReferralCenter /> : null}

                        {activeSection === "orders" ? (
                            <AccountPanel title="订单记录" description="查看充值订单、支付方式、订单状态和套餐开通结果。">
                                <OrderList loading={orders.loading} orders={orders.items} total={orders.total} page={orders.page} onPageChange={orders.setPage} />
                            </AccountPanel>
                        ) : null}

                        {activeSection === "consume" ? (
                            <AccountPanel title="消费明细" description="文本模型按实际输入和输出用量计费，图片、视频和音频按生成次数计费。">
                                {consumption.loading ? (
                                    <LoadingBlock />
                                ) : consumption.items.length ? (
                                    <>
                                        <ConsumptionRecordList records={consumption.items} />
                                        {consumption.total > RECORD_PAGE_SIZE ? <Pagination size="small" current={consumption.page} pageSize={RECORD_PAGE_SIZE} total={consumption.total} showSizeChanger={false} onChange={consumption.setPage} /> : null}
                                    </>
                                ) : (
                                    <CompactEmptyState title="暂无消费记录" description="产生模型调用或生成任务后会显示在这里。" />
                                )}
                            </AccountPanel>
                        ) : null}

                        {activeSection === "points" ? (
                            <AccountPanel title="余额记录" description="充值、平台调整和失败退回都会以人民币金额记录在这里。">
                                {points.loading ? (
                                    <LoadingBlock />
                                ) : points.items.length ? (
                                    <>
                                        <RecordList records={points.items} />
                                        {points.total > RECORD_PAGE_SIZE ? <Pagination size="small" current={points.page} pageSize={RECORD_PAGE_SIZE} total={points.total} showSizeChanger={false} onChange={points.setPage} /> : null}
                                    </>
                                ) : (
                                    <CompactEmptyState title="暂无余额记录" description="人民币余额变化会按时间记录在这里。" />
                                )}
                            </AccountPanel>
                        ) : null}

                        {activeSection === "security" ? (
                            <AccountPanel title="账户与安全" description="管理绑定邮箱、登录密码和个人数据。">
                                <div className="max-w-2xl space-y-6">
                                    <AccountEmailForm
                                        boundEmail={boundEmail}
                                        emailChanged={emailChanged}
                                        email={email}
                                        emailCode={emailCode}
                                        sendingCode={sendingCode}
                                        savingEmail={savingEmail}
                                        onEmailChange={setEmail}
                                        onEmailCodeChange={setEmailCode}
                                        onSendEmailCode={() => void sendEmailCode()}
                                        onSave={() => void saveEmail()}
                                    />

                                    <AdminMfaPanel />

                                    <LoginSecurityPanel />

                                    <div className="max-w-xl space-y-4 border-t border-stone-200 pt-5 dark:border-stone-800">
                                        <div>
                                            <h3 className="text-sm font-semibold text-stone-950 dark:text-white">登录密码</h3>
                                            <p className="mt-1 text-sm leading-6 text-stone-500 dark:text-stone-400">修改密码后会退出当前登录，需要使用新密码重新登录。</p>
                                        </div>
                                        <label className="block space-y-2">
                                            <span className="text-sm font-medium text-stone-700 dark:text-stone-200">当前密码</span>
                                            <Input.Password value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
                                        </label>
                                        <label className="block space-y-2">
                                            <span className="text-sm font-medium text-stone-700 dark:text-stone-200">新密码</span>
                                            <Input.Password value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="至少 8 位" />
                                        </label>
                                        <Button danger className={profileDangerButtonClass} loading={savingPassword} icon={<ShieldCheck className="size-4" />} onClick={() => void savePassword()}>
                                            修改密码并重新登录
                                        </Button>
                                    </div>

                                    <div className="border-t border-stone-200 pt-5 dark:border-stone-800">
                                        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                                            <div className="min-w-0">
                                                <h3 className="text-sm font-semibold text-stone-950 dark:text-white">个人数据</h3>
                                                <p className="mt-1 text-sm leading-6 text-stone-500 dark:text-stone-400">导出账户、余额、订单和创作记录。媒体原文件与安全凭据不包含在 JSON 中。</p>
                                            </div>
                                            <Button className={`${profileSecondaryButtonClass} shrink-0`} loading={exportingData} icon={<Download className="size-4" />} onClick={() => void exportUserData()}>
                                                导出我的数据
                                            </Button>
                                        </div>
                                    </div>
                                    <AccountDeletionPanel />
                                </div>
                            </AccountPanel>
                        ) : null}
                    </div>
                </div>
            </div>
        </main>
    );
}
