"use client";

import type { FormEvent, ReactNode } from "react";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, ChevronDown, Gift, LockKeyhole, Mail, ShieldCheck, UserRound } from "lucide-react";
import { App, Button, Checkbox, Input } from "antd";

import { SiteLogo } from "@/components/layout/site-logo";
import { DEFAULT_SITE_TITLE, resolveSiteTitle } from "@/lib/site-brand";
import { usePublicSessionStore } from "@/stores/use-public-session-store";
import { type LocalUser, useUserStore } from "@/stores/use-user-store";
import { cn } from "@/lib/utils";

type AuthFormProps = {
    mode: "login" | "register";
    nextPath?: string;
    registrationEnabled?: boolean;
    emailRegistrationEnabled?: boolean;
    firstUser?: boolean;
    installToken?: string;
    onInstallTokenChange?: (value: string) => void;
    variant?: "page" | "embedded";
    className?: string;
    headerSlot?: ReactNode;
    authError?: string;
    initialReferralCode?: string;
    referralSource?: string;
    inviteError?: string;
    onModeChange?: (mode: "login" | "register") => void;
};

export function AuthForm({
    mode,
    nextPath = "/create",
    registrationEnabled = true,
    emailRegistrationEnabled = false,
    firstUser = false,
    installToken = "",
    onInstallTokenChange,
    variant = "page",
    className,
    headerSlot,
    authError,
    initialReferralCode = "",
    referralSource = "registration-form",
    inviteError,
    onModeChange,
}: AuthFormProps) {
    const router = useRouter();
    const { message } = App.useApp();
    const site = usePublicSessionStore((state) => state.payload?.settings?.site) || { title: DEFAULT_SITE_TITLE, logoUrl: "/logo.svg" };
    const siteTitle = resolveSiteTitle(site.title);
    const setUser = useUserStore((state) => state.setUser);
    const [username, setUsername] = useState("");
    const [email, setEmail] = useState("");
    const [emailCode, setEmailCode] = useState("");
    const [displayName, setDisplayName] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [totpCode, setTotpCode] = useState("");
    const [mfaRequired, setMfaRequired] = useState(false);
    const [referralCode, setReferralCode] = useState(initialReferralCode);
    const [policyAccepted, setPolicyAccepted] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [sendingCode, setSendingCode] = useState(false);
    const [codeCooldown, setCodeCooldown] = useState(0);
    const isRegister = mode === "register";
    const disabled = isRegister && !registrationEnabled;
    const installTokenReady = !firstUser || installToken.trim().length >= 32;
    const passwordMismatch = isRegister && confirmPassword.length > 0 && password !== confirmPassword;
    const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
    const emailCodeReady = !isRegister || !emailRegistrationEnabled || (validEmail && /^\d{6}$/.test(emailCode));

    useEffect(() => {
        if (codeCooldown <= 0) return;
        const timer = window.setInterval(() => setCodeCooldown((current) => (current <= 1 ? 0 : current - 1)), 1000);
        return () => window.clearInterval(timer);
    }, [codeCooldown]);

    const submit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (disabled) return;
        if (isRegister && password !== confirmPassword) {
            message.error("两次输入的密码不一致，请重新确认");
            return;
        }
        setSubmitting(true);
        try {
            const response = await fetch(isRegister ? "/api/auth/register" : "/api/auth/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    username,
                    email,
                    emailCode,
                    displayName,
                    password,
                    totpCode: !isRegister && mfaRequired ? totpCode : undefined,
                    referralCode: isRegister && !firstUser ? referralCode : undefined,
                    referralSource,
                    policyAccepted: isRegister && !firstUser ? policyAccepted : undefined,
                    installToken: firstUser ? installToken.trim() : undefined,
                }),
            });
            const payload = (await response.json()) as { user?: LocalUser; error?: string; mfaRequired?: boolean; securityNotice?: { networkChanged: boolean; deviceChanged: boolean } };
            if (!isRegister && payload.mfaRequired) {
                setMfaRequired(true);
                message.info("请输入身份验证器动态码");
                return;
            }
            if (!response.ok || !payload.user) throw new Error(payload.error || (isRegister ? "注册失败" : "登录失败"));
            setUser(payload.user);
            if (!isRegister && payload.securityNotice) {
                const changed = [payload.securityNotice.deviceChanged ? "设备" : "", payload.securityNotice.networkChanged ? "网络" : ""].filter(Boolean).join("和");
                message.warning(`检测到登录${changed}发生变化，请在账户与安全中核对登录记录`);
            } else {
                message.success(isRegister ? "注册成功" : "登录成功");
            }
            router.replace(nextPath);
            router.refresh();
        } catch (error) {
            message.error(error instanceof Error ? error.message : isRegister ? "注册失败" : "登录失败");
        } finally {
            setSubmitting(false);
        }
    };

    const sendEmailCode = async () => {
        if (!validEmail) {
            message.warning("请输入有效的邮箱地址");
            return;
        }
        if (codeCooldown > 0) return;
        setSendingCode(true);
        try {
            const response = await fetch("/api/auth/email-code", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ purpose: "register", email }),
            });
            const payload = (await response.json()) as { error?: string };
            if (!response.ok) throw new Error(payload.error || "验证码发送失败");
            message.success("验证码已发送，请查看邮箱");
            setCodeCooldown(60);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "验证码发送失败");
        } finally {
            setSendingCode(false);
        }
    };

    const form = (
        <section className={cn("auth-panel flex min-h-full items-center", variant === "embedded" ? "p-6 sm:p-7" : "p-8 sm:p-10", className)}>
            <form onSubmit={submit} className={cn("auth-form-body w-full", variant === "embedded" ? "space-y-4" : "space-y-6")}>
                {headerSlot}
                <div className="auth-form-header">
                    <p className="auth-form-kicker text-sm font-medium">{firstUser ? "首次初始化" : isRegister ? "创建账号" : "欢迎回来"}</p>
                    <h2 className={cn("mt-2 font-semibold tracking-normal text-stone-950 dark:text-white", variant === "embedded" ? "text-2xl" : "text-3xl")}>{firstUser ? "创建首个管理员" : isRegister ? `注册 ${siteTitle}` : `登录 ${siteTitle}`}</h2>
                    <p className="auth-form-description mt-3 text-sm leading-6 text-stone-500 dark:text-stone-400">{isRegister ? "注册后可保存作品并在不同设备继续创作，生成前会显示人民币费用。" : "登录后继续创作、管理作品并查看账号权益。"}</p>
                </div>

                {authError ? <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-400/20 dark:bg-red-400/10 dark:text-red-100">{authError}</div> : null}

                {isRegister && inviteError ? <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-100">{inviteError}</div> : null}

                {disabled ? <div className="rounded-md border border-cyan-200 bg-cyan-50 px-4 py-3 text-sm text-cyan-900 dark:border-cyan-300/20 dark:bg-cyan-300/8 dark:text-cyan-50">当前暂未开放注册，请通过客服邮箱咨询开通方式。</div> : null}

                {firstUser ? (
                    <label className="block space-y-3">
                        <span className="text-sm font-medium text-stone-700 dark:text-stone-200">一次性安装令牌</span>
                        <Input.Password
                            size="large"
                            prefix={<LockKeyhole className="size-4 text-stone-500" />}
                            value={installToken}
                            onChange={(event) => onInstallTokenChange?.(event.target.value)}
                            placeholder="从服务器 .env 中粘贴 VOZEB_PRO_INSTALL_TOKEN"
                            autoComplete="off"
                            disabled={submitting}
                            required
                        />
                        <span className="block text-xs leading-5 text-stone-500 dark:text-stone-400">令牌只保存在当前页面内存中，不会写入浏览器存储。</span>
                    </label>
                ) : null}

                <label className="block space-y-3">
                    <span className="text-sm font-medium text-stone-700 dark:text-stone-200">{isRegister ? "账号" : "账号或邮箱"}</span>
                    <Input
                        size="large"
                        prefix={<UserRound className="size-4 text-stone-500" />}
                        value={username}
                        onChange={(event) => {
                            setUsername(event.target.value);
                            setMfaRequired(false);
                            setTotpCode("");
                        }}
                        placeholder={isRegister ? "设置登录账号" : "输入账号或已绑定邮箱"}
                        autoComplete="username"
                        disabled={submitting || disabled}
                        required
                    />
                    {isRegister ? <span className="block text-xs leading-5 text-stone-500 dark:text-stone-400">用于登录，支持中文、数字、英文字母及其组合；昵称可以之后在个人资料中设置。</span> : null}
                </label>

                {isRegister && emailRegistrationEnabled ? (
                    <div className="space-y-3">
                        <label className="block space-y-3">
                            <span className="text-sm font-medium text-stone-700 dark:text-stone-200">邮箱</span>
                            <Input
                                size="large"
                                prefix={<Mail className="size-4 text-stone-500" />}
                                value={email}
                                onChange={(event) => setEmail(event.target.value)}
                                placeholder="输入常用邮箱"
                                autoComplete="email"
                                type="email"
                                disabled={submitting || disabled}
                                required
                            />
                            <span className="block text-xs leading-5 text-stone-500 dark:text-stone-400">用于接收验证码、找回密码和重要服务通知，请填写本人可以正常收信的邮箱。</span>
                        </label>
                        <label className="block space-y-3">
                            <span className="text-sm font-medium text-stone-700 dark:text-stone-200">验证码</span>
                            <Input.Search
                                size="large"
                                value={emailCode}
                                onChange={(event) => setEmailCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                                placeholder="输入 6 位验证码"
                                inputMode="numeric"
                                maxLength={6}
                                enterButton={sendingCode ? "发送中" : codeCooldown > 0 ? `${codeCooldown} 秒后重试` : "获取验证码"}
                                loading={sendingCode}
                                disabled={submitting || disabled || codeCooldown > 0}
                                onSearch={() => void sendEmailCode()}
                                required
                            />
                            <span className="block text-xs leading-5 text-stone-500 dark:text-stone-400">验证码将发送到上方邮箱，请注意查收垃圾邮件。</span>
                        </label>
                    </div>
                ) : null}

                {isRegister && !firstUser ? (
                    <details className="group rounded-lg border border-stone-200 dark:border-stone-800" open={Boolean(initialReferralCode || inviteError) || undefined}>
                        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-sm font-medium text-stone-700 marker:hidden dark:text-stone-200">
                            <span>有邀请码？（可选）</span>
                            <ChevronDown className="size-4 shrink-0 text-stone-400 transition-transform group-open:rotate-180" aria-hidden="true" />
                        </summary>
                        <div className="border-t border-stone-200 p-3 dark:border-stone-800">
                            <label className="block space-y-2">
                                <span className="sr-only">邀请码</span>
                                <Input
                                    size="large"
                                    prefix={<Gift className="size-4 text-stone-500" />}
                                    value={referralCode}
                                    onChange={(event) => setReferralCode(event.target.value.toUpperCase())}
                                    placeholder="输入邀请码"
                                    autoComplete="off"
                                    maxLength={24}
                                    disabled={submitting || disabled}
                                />
                            </label>
                        </div>
                    </details>
                ) : null}

                {firstUser ? (
                    <label className="block space-y-3">
                        <span className="text-sm font-medium text-stone-700 dark:text-stone-200">管理员昵称（选填）</span>
                        <Input size="large" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="用于后台显示，可留空" autoComplete="name" disabled={submitting} />
                    </label>
                ) : null}

                <label className="block space-y-3">
                    <span className="text-sm font-medium text-stone-700 dark:text-stone-200">密码</span>
                    <Input.Password
                        size="large"
                        prefix={<LockKeyhole className="size-4 text-stone-500" />}
                        value={password}
                        onChange={(event) => {
                            setPassword(event.target.value);
                            setMfaRequired(false);
                            setTotpCode("");
                        }}
                        placeholder={isRegister ? "设置登录密码，至少 8 位" : "输入登录密码"}
                        autoComplete={isRegister ? "new-password" : "current-password"}
                        disabled={submitting || disabled}
                        minLength={isRegister ? 8 : undefined}
                        required
                    />
                </label>

                {isRegister ? (
                    <label className="block space-y-3">
                        <span className="text-sm font-medium text-stone-700 dark:text-stone-200">确认密码</span>
                        <Input.Password
                            size="large"
                            prefix={<LockKeyhole className="size-4 text-stone-500" />}
                            value={confirmPassword}
                            onChange={(event) => setConfirmPassword(event.target.value)}
                            placeholder="再次输入登录密码"
                            autoComplete="new-password"
                            disabled={submitting || disabled}
                            minLength={8}
                            status={passwordMismatch ? "error" : undefined}
                            required
                        />
                        {passwordMismatch ? <span className="block text-xs leading-5 text-red-600 dark:text-red-300">两次输入的密码不一致。</span> : null}
                    </label>
                ) : null}

                {!isRegister && mfaRequired ? (
                    <label className="block space-y-3">
                        <span className="text-sm font-medium text-stone-700 dark:text-stone-200">动态验证码</span>
                        <Input
                            size="large"
                            prefix={<ShieldCheck className="size-4 text-stone-500" />}
                            value={totpCode}
                            autoFocus
                            autoComplete="one-time-code"
                            inputMode="numeric"
                            placeholder="输入身份验证器动态码"
                            disabled={submitting}
                            onChange={(event) => setTotpCode(event.target.value)}
                            required
                        />
                    </label>
                ) : null}

                {isRegister && !firstUser ? (
                    <Checkbox checked={policyAccepted} disabled={submitting || disabled} onChange={(event) => setPolicyAccepted(event.target.checked)}>
                        <span className="text-sm leading-6 text-stone-600 dark:text-stone-300">
                            我已阅读并同意
                            <a className="mx-1 font-medium text-stone-950 hover:underline dark:text-white" href={site.termsUrl || "/terms"} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
                                服务条款
                            </a>
                            和
                            <a className="ml-1 font-medium text-stone-950 hover:underline dark:text-white" href={site.privacyUrl || "/privacy"} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
                                隐私政策
                            </a>
                        </span>
                    </Checkbox>
                ) : null}

                <Button
                    className="auth-submit-button"
                    type="primary"
                    htmlType="submit"
                    size="large"
                    block
                    loading={submitting}
                    disabled={disabled || !installTokenReady || !emailCodeReady || (isRegister && !firstUser && !policyAccepted)}
                    icon={<ArrowRight className="size-4" />}
                    iconPlacement="end"
                >
                    {firstUser ? "创建管理员并进入后台" : isRegister ? "注册并开始使用" : mfaRequired ? "验证并登录" : "登录并继续"}
                </Button>

                <div className="auth-switch-link pt-2 text-center text-sm text-stone-500 dark:text-stone-400">
                    {isRegister ? (
                        <>
                            已有账号？{" "}
                            {onModeChange ? (
                                <button type="button" className="font-medium text-stone-950 hover:underline dark:text-white" onClick={() => onModeChange("login")}>
                                    直接登录
                                </button>
                            ) : (
                                <Link href="/login" className="font-medium text-stone-950 hover:underline dark:text-white">
                                    直接登录
                                </Link>
                            )}
                        </>
                    ) : (
                        <>
                            还没有账号？{" "}
                            {onModeChange ? (
                                <button type="button" className="font-medium text-stone-950 hover:underline dark:text-white" onClick={() => onModeChange("register")}>
                                    立即注册
                                </button>
                            ) : (
                                <Link href="/register" className="font-medium text-stone-950 hover:underline dark:text-white">
                                    立即注册
                                </Link>
                            )}
                            <span className="mx-2 text-stone-300 dark:text-stone-700">/</span>
                            <Link href="/forgot-password" className="font-medium text-stone-950 hover:underline dark:text-white">
                                忘记密码
                            </Link>
                        </>
                    )}
                </div>
            </form>
        </section>
    );

    if (variant === "embedded") return form;

    return (
        <main className="auth-page-bg app-scroll-page flex items-center justify-center px-4 py-6 text-foreground sm:px-6 sm:py-10">
            <div className="auth-page-card grid w-full max-w-5xl overflow-hidden border backdrop-blur md:grid-cols-[0.9fr_1fr]">
                <section className="auth-page-brand-panel flex min-h-[220px] flex-col justify-between gap-5 border-b p-5 text-stone-950 sm:min-h-[360px] sm:gap-8 sm:p-8 md:border-b-0 md:border-r dark:text-white">
                    <div className="flex items-start justify-between gap-4">
                        <Link href="/" className="inline-flex items-center gap-4 text-base font-semibold">
                            <SiteLogo logoUrl={site.logoUrl} className="size-16 sm:size-20" />
                            <span className="text-3xl">{site.title}</span>
                        </Link>
                        <Link
                            href="/"
                            className="auth-back-home inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-stone-200 bg-white/70 px-3 text-sm font-medium text-stone-700 transition hover:border-stone-300 hover:text-stone-950 dark:border-white/10 dark:bg-white/5 dark:text-stone-200 dark:hover:border-white/20 dark:hover:text-white"
                        >
                            <ArrowLeft className="size-4" />
                            <span>返回首页</span>
                        </Link>
                    </div>
                    <div className="auth-page-brand-copy">
                        <h1 className="text-balance text-2xl font-semibold tracking-normal sm:text-3xl">{firstUser ? "创建首个管理员" : isRegister ? "开启你的视觉创作" : "继续你的视觉创作"}</h1>
                    </div>
                    <div className="auth-page-feature-list grid gap-2 text-sm text-stone-600 dark:text-stone-300">
                        {["图片与视频创作", "保存作品与创作记录", "随时继续未完成的灵感"].map((item) => (
                            <div key={item} className="flex items-center gap-2">
                                <span className="auth-feature-dot size-1.5 rounded-full" />
                                <span>{item}</span>
                            </div>
                        ))}
                    </div>
                    <p className="auth-page-brand-description max-w-sm text-sm leading-6 text-stone-500 dark:text-stone-400">注册后即可保存自己的作品与创作记录，随时回来继续完成新的想法。</p>
                </section>
                {form}
            </div>
        </main>
    );
}
