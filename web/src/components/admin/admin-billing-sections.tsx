"use client";

import { BillingOperations } from "@/app/admin/billing/components/billing-operations";
import type { AdminDashboardController } from "./use-admin-dashboard-controller";

export function AdminOrdersSection({ controller }: { controller: AdminDashboardController }) {
    const { activeSection, setupSummary } = controller;
    if (activeSection !== "orders") return null;
    return <BillingOperations databaseProvider={setupSummary?.databaseProvider || "file"} initialTab="orders" embedded hideTabs />;
}

export function AdminProductsSection({ controller }: { controller: AdminDashboardController }) {
    const { activeSection, setupSummary } = controller;
    if (activeSection !== "products") return null;
    return <BillingOperations databaseProvider={setupSummary?.databaseProvider || "file"} initialTab="products" embedded hideTabs />;
}

export function AdminPromotionsSection({ controller }: { controller: AdminDashboardController }) {
    const { activeSection, setupSummary } = controller;
    if (activeSection !== "promotions") return null;
    return <BillingOperations databaseProvider={setupSummary?.databaseProvider || "file"} initialTab="promotions" embedded hideTabs />;
}

export function AdminCouponsSection({ controller }: { controller: AdminDashboardController }) {
    const { activeSection, setupSummary } = controller;
    if (activeSection !== "coupons") return null;
    return <BillingOperations databaseProvider={setupSummary?.databaseProvider || "file"} initialTab="coupons" embedded hideTabs />;
}

export function AdminPaymentsSection({ controller }: { controller: AdminDashboardController }) {
    const { paymentConfig, activeSection, setupSummary } = controller;
    if (activeSection !== "payments") return null;
    return <BillingOperations databaseProvider={setupSummary?.databaseProvider || "file"} initialTab="payments" initialPaymentConfig={paymentConfig || undefined} embedded hideTabs />;
}
