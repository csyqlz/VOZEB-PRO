import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ArrowLeft, ReceiptText } from "lucide-react";

import { AuthUserHydrator } from "@/components/auth/auth-user-hydrator";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { ADMIN_BILLING_TABS, resolveAdminBillingTab, type AdminBillingTab } from "@/lib/admin-permissions";
import { getDatabaseProvider } from "@/lib/server/database";
import { getAuthenticatedPageAccess } from "@/lib/server/page-access";
import { getPaymentConfigSummary } from "@/lib/server/payment-config-status";
import { getTrustedProxyHops } from "@/lib/server/trusted-proxy";

import { BillingOperations } from "./components/billing-operations";

type AdminBillingPageProps = {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminBillingPage({ searchParams }: AdminBillingPageProps) {
    const params = searchParams ? await searchParams : {};
    const requestedTab = parseBillingTab(params.tab);
    const access = await getAuthenticatedPageAccess();
    if (!access.user) {
        if (!access.install.database.healthy || access.install.firstAdminRequired) redirect("/install");
        redirect("/login?next=/admin/billing");
    }
    const currentUser = access.user;
    const initialTab = resolveAdminBillingTab(currentUser, requestedTab);
    if (!initialTab) redirect("/");

    const paymentConfig = initialTab === "payments" ? await getPaymentConfigSummary(await resolveRequestOrigin()) : undefined;

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
            <main className="admin-console-page app-scroll-page bg-white text-stone-950 dark:bg-stone-950 dark:text-stone-100">
                <header className="sticky top-0 z-20 border-b border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-950">
                    <div className="mx-auto flex h-16 max-w-[1440px] min-w-0 items-center justify-between gap-3 px-4 sm:gap-4 sm:px-6">
                        <Link href="/admin" className="flex min-w-0 items-center gap-2.5 text-base font-semibold text-stone-950 dark:text-stone-100">
                            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-stone-950 text-white dark:bg-stone-100 dark:text-stone-950">
                                <ArrowLeft className="size-4" />
                            </span>
                            <span className="truncate">财务钱包</span>
                        </Link>
                        <UserStatusActions initialUser={currentUser} />
                    </div>
                </header>

                <div className="mx-auto max-w-[1440px] px-3 py-4 sm:px-6 sm:py-5 lg:py-6">
                    <div className="mb-5 flex flex-col gap-4 rounded-lg border border-stone-200 bg-white px-4 py-4 shadow-sm shadow-stone-200/40 sm:px-5 md:flex-row md:items-center md:justify-between dark:border-stone-800 dark:bg-stone-950 dark:shadow-black/20">
                        <div className="flex min-w-0 items-start gap-3">
                            <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-emerald-600 text-white dark:bg-emerald-400 dark:text-stone-950">
                                <ReceiptText className="size-5" />
                            </span>
                            <div className="min-w-0">
                                <h1 className="text-2xl font-semibold tracking-normal text-stone-950 dark:text-stone-100">财务钱包</h1>
                                <p className="mt-1.5 max-w-2xl text-sm leading-6 text-stone-500 dark:text-stone-400">管理套餐商品、限时促销、优惠券、支付配置、订单收款和退款对账。</p>
                            </div>
                        </div>
                        <Link
                            href="/admin"
                            className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-stone-200 px-3 text-sm font-medium text-stone-700 transition hover:bg-stone-50 dark:border-stone-800 dark:text-stone-200 dark:hover:bg-stone-900"
                        >
                            <ArrowLeft className="size-4" />
                            返回后台
                        </Link>
                    </div>

                    <BillingOperations databaseProvider={getDatabaseProvider()} initialTab={initialTab} initialPaymentConfig={paymentConfig} />
                </div>
            </main>
        </AuthUserHydrator>
    );
}

function parseBillingTab(value: string | string[] | undefined): AdminBillingTab {
    const tab = Array.isArray(value) ? value[0] : value;
    return ADMIN_BILLING_TABS.includes(tab as AdminBillingTab) ? (tab as AdminBillingTab) : "orders";
}

async function resolveRequestOrigin() {
    const requestHeaders = await headers();
    const trustForwarded = getTrustedProxyHops() > 0;
    const host = (trustForwarded ? requestHeaders.get("x-forwarded-host")?.split(",")[0]?.trim() : "") || requestHeaders.get("host") || "localhost:3000";
    const protocol = (trustForwarded ? requestHeaders.get("x-forwarded-proto")?.split(",")[0]?.trim() : "") || (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
    return `${protocol}://${host}`;
}
