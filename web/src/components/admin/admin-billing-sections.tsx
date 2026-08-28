"use client";

import { BillingOperations } from "@/app/admin/billing/components/billing-operations";
import { Panel } from "./admin-panel";
import type { AdminDashboardController } from "./use-admin-dashboard-controller";

export function AdminOrdersSection({ controller }: { controller: AdminDashboardController }) {
    const { activeSection, setupSummary } = controller;
    if (activeSection !== "orders") return null;
    return (
        <Panel variant="page">
            <BillingOperations databaseProvider={setupSummary?.databaseProvider || "file"} initialTab="orders" embedded hideTabs />
        </Panel>
    );
}

export function AdminProductsSection({ controller }: { controller: AdminDashboardController }) {
    const { activeSection, setupSummary } = controller;
    if (activeSection !== "products") return null;
    return (
        <Panel variant="page">
            <BillingOperations databaseProvider={setupSummary?.databaseProvider || "file"} initialTab="products" embedded hideTabs />
        </Panel>
    );
}

export function AdminPromotionsSection({ controller }: { controller: AdminDashboardController }) {
    const { activeSection, setupSummary } = controller;
    if (activeSection !== "promotions") return null;
    return (
        <Panel variant="page">
            <BillingOperations databaseProvider={setupSummary?.databaseProvider || "file"} initialTab="promotions" embedded hideTabs />
        </Panel>
    );
}

export function AdminCouponsSection({ controller }: { controller: AdminDashboardController }) {
    const { activeSection, setupSummary } = controller;
    if (activeSection !== "coupons") return null;
    return (
        <Panel variant="page">
            <BillingOperations databaseProvider={setupSummary?.databaseProvider || "file"} initialTab="coupons" embedded hideTabs />
        </Panel>
    );
}

export function AdminPaymentsSection({ controller }: { controller: AdminDashboardController }) {
    const { paymentConfig, activeSection, setupSummary } = controller;
    if (activeSection !== "payments") return null;
    return (
        <Panel variant="page">
            <BillingOperations databaseProvider={setupSummary?.databaseProvider || "file"} initialTab="payments" initialPaymentConfig={paymentConfig || undefined} embedded hideTabs />
        </Panel>
    );
}
