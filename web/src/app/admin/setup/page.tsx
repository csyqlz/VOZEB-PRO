import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, ArrowRight, Check, ChevronRight, Circle, Database, KeyRound, LockKeyhole, PackageCheck, ReceiptText, Server, Settings2, Sparkles } from "lucide-react";

import { AuthUserHydrator } from "@/components/auth/auth-user-hydrator";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { hasAnyAdminPermission } from "@/lib/admin-permissions";
import { getAdminSetupSummary, type AdminSetupAccent, type AdminSetupStepStatus } from "@/lib/server/admin-setup-status";
import { getAuthenticatedPageAccess } from "@/lib/server/page-access";

const accentClasses: Record<AdminSetupAccent, { icon: string; text: string; border: string }> = {
    blue: { icon: "bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950", text: "text-zinc-700 dark:text-zinc-300", border: "border-zinc-200 dark:border-zinc-800" },
    emerald: { icon: "bg-emerald-600 text-white dark:bg-emerald-400 dark:text-zinc-950", text: "text-emerald-700 dark:text-emerald-300", border: "border-emerald-200 dark:border-emerald-900" },
    amber: { icon: "bg-amber-500 text-white dark:bg-amber-400 dark:text-zinc-950", text: "text-amber-700 dark:text-amber-300", border: "border-amber-200 dark:border-amber-900" },
    rose: { icon: "bg-rose-600 text-white dark:bg-rose-400 dark:text-zinc-950", text: "text-rose-700 dark:text-rose-300", border: "border-rose-200 dark:border-rose-900" },
    violet: { icon: "bg-violet-600 text-white dark:bg-violet-400 dark:text-zinc-950", text: "text-violet-700 dark:text-violet-300", border: "border-violet-200 dark:border-violet-900" },
    slate: { icon: "bg-zinc-800 text-white dark:bg-zinc-200 dark:text-zinc-950", text: "text-zinc-700 dark:text-zinc-300", border: "border-zinc-200 dark:border-zinc-800" },
};

const setupIcons = [Settings2, Sparkles, PackageCheck, ReceiptText, LockKeyhole, Database];

export default async function AdminSetupPage() {
    const access = await getAuthenticatedPageAccess();
    if (!access.user) {
        if (!access.install.database.healthy || access.install.firstAdminRequired) redirect("/install");
        redirect("/login?next=/admin/setup");
    }
    const currentUser = access.user;
    if (!hasAnyAdminPermission(currentUser, ["system.manage", "upstream.manage", "commerce.manage", "billing.manage"])) redirect("/");

    const setup = await getAdminSetupSummary();
    const nextStep = setup.steps.find((step) => step.status !== "done") || setup.steps[setup.steps.length - 1];

    return (
        <AuthUserHydrator
            user={{
                id: currentUser.id,
                accountId: currentUser.accountId,
                username: currentUser.username,
                email: currentUser.email,
                displayName: currentUser.displayName,
                bio: currentUser.bio,
                role: currentUser.role,
                adminPermissions: currentUser.adminPermissions,
                status: currentUser.status,
                planId: currentUser.planId,
                planName: currentUser.planName,
                hasActivePlan: currentUser.hasActivePlan,
                pointsBalance: currentUser.pointsBalance,
                mfaEnabled: currentUser.mfaEnabled,
            }}
        >
            <main className="admin-console-page app-scroll-page bg-white text-zinc-950 dark:bg-zinc-950 dark:text-zinc-100">
                <header className="sticky top-0 z-20 border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
                    <div className="mx-auto flex h-16 max-w-6xl min-w-0 items-center justify-between gap-3 px-4 sm:px-6">
                        <Link href="/admin" className="inline-flex min-w-0 items-center gap-2.5 text-base font-semibold text-zinc-950 dark:text-zinc-100">
                            <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
                                <ArrowLeft className="size-4" />
                            </span>
                            <span className="truncate">初始化配置</span>
                        </Link>
                        <UserStatusActions initialUser={currentUser} />
                    </div>
                </header>

                <div className="mx-auto max-w-6xl px-4 pb-[calc(2rem+env(safe-area-inset-bottom))] pt-5 sm:px-6 sm:pb-[calc(3rem+env(safe-area-inset-bottom))] sm:pt-8">
                    <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
                        <div className="min-w-0 rounded-lg border border-zinc-200 bg-white p-5 sm:p-6 dark:border-zinc-800 dark:bg-zinc-950">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="inline-flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-sm font-medium text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
                                    <Sparkles className="size-4" />
                                    {setup.siteTitle}
                                </span>
                                <span className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">安装后初始化中心</span>
                            </div>
                            <h1 className="mt-5 max-w-2xl text-2xl font-semibold tracking-normal text-zinc-950 sm:text-3xl dark:text-zinc-100">把站点配置到可以上线运营</h1>
                            <p className="mt-3 max-w-3xl text-sm leading-7 text-zinc-500 dark:text-zinc-400">集中检查品牌、模型、套餐、支付、邮件安全和存储，完成后即可按消费者使用场景上线运营。</p>
                            <div className="mt-6 max-w-xl">
                                <div className="flex items-center justify-between text-sm">
                                    <span className="font-medium text-zinc-600 dark:text-zinc-400">完成度</span>
                                    <span className="font-semibold text-zinc-950 dark:text-zinc-100">
                                        {setup.completed}/{setup.total} · {setup.percent}%
                                    </span>
                                </div>
                                <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                                    <div className="h-full rounded-full bg-zinc-950 dark:bg-zinc-100" style={{ width: `${setup.percent}%` }} />
                                </div>
                            </div>
                        </div>

                        <aside className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
                            <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">下一项</p>
                            <h2 className="mt-2 text-lg font-semibold tracking-normal text-zinc-950 dark:text-zinc-100">{nextStep.title}</h2>
                            <p className="mt-3 text-sm leading-6 text-zinc-500 dark:text-zinc-400">{nextStep.description}</p>
                            <div className="mt-5 grid gap-2">
                                <a
                                    href={`#${nextStep.id}`}
                                    className="inline-flex h-10 items-center justify-center gap-2 rounded-md !bg-zinc-950 px-4 text-sm font-semibold !text-white transition hover:!bg-zinc-800 dark:!bg-zinc-100 dark:!text-zinc-950 dark:hover:!bg-white"
                                >
                                    查看下一项
                                    <ArrowRight className="size-4" />
                                </a>
                                <Link
                                    href={nextStep.href}
                                    className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-4 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900"
                                >
                                    打开配置页
                                    <ChevronRight className="size-4" />
                                </Link>
                            </div>
                        </aside>
                    </section>

                    <section className="mt-4 grid gap-3 md:grid-cols-3">
                        <SetupMetric icon={<Server className="size-4" />} label="数据库" value={setup.databaseProvider === "postgres" ? "PostgreSQL" : "文件模式"} />
                        <SetupMetric icon={<KeyRound className="size-4" />} label="模型渠道" value={`${setup.enabledChannels} 个可用`} />
                        <SetupMetric icon={<ReceiptText className="size-4" />} label="上架商品" value={`${setup.enabledProducts} 个`} />
                    </section>

                    <section className="mt-5 grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
                        <aside className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950 lg:sticky lg:top-20 lg:self-start">
                            <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">建议顺序</p>
                            <div className="mt-4 space-y-3">
                                {setup.steps.map((step, index) => (
                                    <a key={step.id} href={`#${step.id}`} className="flex items-center gap-3 rounded-md px-2 py-2 transition hover:bg-zinc-50 dark:hover:bg-zinc-900">
                                        <StepDot status={step.status} />
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{step.title}</span>
                                            <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                                                {index + 1}. {step.statusLabel}
                                            </span>
                                        </span>
                                        <ChevronRight className="size-4 text-zinc-300 dark:text-zinc-600" />
                                    </a>
                                ))}
                            </div>
                            <Link
                                href="/admin"
                                className="mt-5 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md !bg-zinc-950 px-4 text-sm font-semibold !text-white transition hover:!bg-zinc-800 dark:!bg-zinc-100 dark:!text-zinc-950 dark:hover:!bg-white"
                            >
                                进入完整后台
                                <ArrowRight className="size-4" />
                            </Link>
                        </aside>

                        <div className="grid gap-4 md:grid-cols-2">
                            {setup.steps.map((step, index) => {
                                const Icon = setupIcons[index] || Circle;
                                const accent = accentClasses[step.accent];
                                return (
                                    <article key={step.id} id={step.id} className={`scroll-mt-24 rounded-lg border bg-white p-5 dark:bg-zinc-950 ${accent.border}`}>
                                        <div className="flex items-start justify-between gap-4">
                                            <div className="flex min-w-0 items-start gap-3">
                                                <span className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${accent.icon}`}>
                                                    <Icon className="size-5" />
                                                </span>
                                                <div className="min-w-0">
                                                    <p className={`text-sm font-semibold ${accent.text}`}>{step.eyebrow}</p>
                                                    <h2 className="mt-1 text-lg font-semibold tracking-normal text-zinc-950 dark:text-zinc-100">{step.title}</h2>
                                                </div>
                                            </div>
                                            <StatusPill status={step.status} label={step.statusLabel} />
                                        </div>
                                        <p className="mt-4 text-sm leading-7 text-zinc-500 dark:text-zinc-400">{step.description}</p>
                                        <div className="mt-5 border-t border-zinc-100 dark:border-zinc-800">
                                            {step.facts.map((fact) => (
                                                <div key={fact} className="flex items-center gap-2 border-b border-zinc-100 py-2.5 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-300">
                                                    <span className={`size-1.5 rounded-full ${step.status === "done" ? "bg-emerald-500" : step.status === "attention" ? "bg-amber-500" : "bg-zinc-300 dark:bg-zinc-600"}`} />
                                                    <span className="min-w-0 truncate">{fact}</span>
                                                </div>
                                            ))}
                                        </div>
                                        <Link
                                            href={step.href}
                                            className="mt-5 inline-flex h-10 items-center justify-center gap-2 rounded-md !bg-zinc-950 px-4 text-sm font-semibold !text-white transition hover:!bg-zinc-800 dark:!bg-zinc-100 dark:!text-zinc-950 dark:hover:!bg-white"
                                        >
                                            {step.actionLabel}
                                            <ArrowRight className="size-4" />
                                        </Link>
                                    </article>
                                );
                            })}
                        </div>
                    </section>
                </div>
            </main>
        </AuthUserHydrator>
    );
}

function SetupMetric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
    return (
        <div className="flex min-w-0 items-center gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-3 dark:border-zinc-800 dark:bg-zinc-950">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">{icon}</span>
            <span className="min-w-0">
                <span className="block text-xs text-zinc-500 dark:text-zinc-400">{label}</span>
                <span className="block truncate text-sm font-semibold text-zinc-950 dark:text-zinc-100">{value}</span>
            </span>
        </div>
    );
}

function StepDot({ status }: { status: AdminSetupStepStatus }) {
    if (status === "done") {
        return (
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
                <Check className="size-4" />
            </span>
        );
    }
    return <span className={`size-7 shrink-0 rounded-full border-4 ${status === "attention" ? "border-amber-200 bg-amber-500 dark:border-amber-900" : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"}`} />;
}

function StatusPill({ status, label }: { status: AdminSetupStepStatus; label: string }) {
    const className =
        status === "done"
            ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
            : status === "attention"
              ? "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
              : "border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400";
    return <span className={`shrink-0 rounded-full border px-3 py-1 text-xs font-semibold ${className}`}>{label}</span>;
}
