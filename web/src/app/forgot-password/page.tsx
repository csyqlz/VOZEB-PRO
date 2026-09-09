"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { App, Button, Input } from "antd";
import { ArrowLeft, LockKeyhole, Mail, ShieldCheck } from "lucide-react";

import { SiteLogo } from "@/components/layout/site-logo";
import { DEFAULT_SITE_TITLE, resolveSiteTitle } from "@/lib/site-brand";
import { usePublicSessionStore } from "@/stores/use-public-session-store";

export default function ForgotPasswordPage() {
    const { message } = App.useApp();
    const [email, setEmail] = useState("");
    const [code, setCode] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [sendingCode, setSendingCode] = useState(false);
    const [codeCooldown, setCodeCooldown] = useState(0);
    const [submitting, setSubmitting] = useState(false);
    const site = usePublicSessionStore((state) => state.payload?.settings?.site) || { title: DEFAULT_SITE_TITLE, logoUrl: "/logo.svg" };
    const siteTitle = resolveSiteTitle(site.title);
    const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
    const passwordMismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;

    useEffect(() => {
        if (codeCooldown <= 0) return;
        const timer = window.setInterval(() => setCodeCooldown((current) => (current <= 1 ? 0 : current - 1)), 1000);
        return () => window.clearInterval(timer);
    }, [codeCooldown]);

    const sendCode = async () => {
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
                body: JSON.stringify({ purpose: "password-reset", email }),
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

    const resetPassword = async () => {
        if (!validEmail) {
            message.warning("请输入有效的邮箱地址");
            return;
        }
        if (!/^\d{6}$/.test(code)) {
            message.warning("请输入 6 位验证码");
            return;
        }
        if (newPassword.length < 8) {
            message.warning("新密码至少需要 8 位");
            return;
        }
        if (passwordMismatch) {
            message.warning("两次输入的新密码不一致");
            return;
        }
        setSubmitting(true);
        try {
            const response = await fetch("/api/auth/password/reset", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, code, newPassword }),
            });
            const payload = (await response.json()) as { error?: string };
            if (!response.ok) throw new Error(payload.error || "重置密码失败");
            message.success("密码已重置，请登录");
            window.location.href = "/login";
        } catch (error) {
            message.error(error instanceof Error ? error.message : "重置密码失败");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <main className="auth-page-bg app-scroll-page flex items-center justify-center px-4 py-6 text-foreground sm:px-6 sm:py-10">
            <section className="auth-reset-card w-full max-w-md border p-6 backdrop-blur sm:p-8">
                <Link href="/" className="mb-6 inline-flex items-center gap-2 text-base font-semibold text-stone-950 dark:text-white">
                    <SiteLogo logoUrl={site.logoUrl} className="size-9" />
                    <span>{siteTitle}</span>
                </Link>
                <Link href="/login" className="mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-stone-600 hover:text-stone-950 dark:text-stone-300 dark:hover:text-white">
                    <ArrowLeft className="size-4" />
                    返回登录
                </Link>
                <div className="mb-5">
                    <p className="auth-form-kicker text-sm font-medium">账号安全</p>
                    <h1 className="mt-2 text-2xl font-semibold text-stone-950 dark:text-white">重置密码</h1>
                    <p className="mt-2 text-sm leading-6 text-stone-500 dark:text-stone-400">输入注册时绑定的邮箱，获取验证码后重新设置登录密码。</p>
                </div>
                <div className="space-y-4">
                    <label className="block space-y-2">
                        <span className="text-sm font-medium text-stone-700 dark:text-stone-200">注册邮箱</span>
                        <Input size="large" prefix={<Mail className="size-4 text-stone-500" />} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="输入注册邮箱" type="email" autoComplete="email" />
                    </label>
                    <label className="block space-y-2">
                        <span className="text-sm font-medium text-stone-700 dark:text-stone-200">验证码</span>
                        <Input.Search
                            size="large"
                            value={code}
                            onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                            placeholder="输入 6 位验证码"
                            enterButton={sendingCode ? "发送中" : codeCooldown > 0 ? `${codeCooldown} 秒后重试` : "获取验证码"}
                            loading={sendingCode}
                            disabled={codeCooldown > 0 || submitting}
                            onSearch={() => void sendCode()}
                            inputMode="numeric"
                            maxLength={6}
                        />
                    </label>
                    <label className="block space-y-2">
                        <span className="text-sm font-medium text-stone-700 dark:text-stone-200">新密码</span>
                        <Input.Password size="large" prefix={<LockKeyhole className="size-4 text-stone-500" />} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="设置新密码，至少 8 位" autoComplete="new-password" />
                    </label>
                    <label className="block space-y-2">
                        <span className="text-sm font-medium text-stone-700 dark:text-stone-200">确认新密码</span>
                        <Input.Password
                            size="large"
                            prefix={<ShieldCheck className="size-4 text-stone-500" />}
                            value={confirmPassword}
                            onChange={(event) => setConfirmPassword(event.target.value)}
                            placeholder="再次输入新密码"
                            autoComplete="new-password"
                            status={passwordMismatch ? "error" : undefined}
                        />
                    </label>
                    <Button type="primary" size="large" block loading={submitting} disabled={!validEmail || !/^\d{6}$/.test(code) || newPassword.length < 8 || passwordMismatch} onClick={() => void resetPassword()}>
                        保存新密码并返回登录
                    </Button>
                </div>
            </section>
        </main>
    );
}
