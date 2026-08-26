import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.VOZEB_PRO_E2E_PORT || 3100);
const baseURL = `http://127.0.0.1:${port}`;
const protocolFixturePort = Number(process.env.VOZEB_PRO_PROTOCOL_FIXTURE_PORT || 4010);
const paymentFixturePort = Number(process.env.VOZEB_PRO_PAYMENT_FIXTURE_PORT || 4020);
const databaseUrl = process.env.VOZEB_PRO_E2E_DATABASE_URL?.trim() || "";
const storageState = path.join(process.cwd(), ".e2e-data", "admin-state.json");

export default defineConfig({
    testDir: "./e2e",
    outputDir: ".e2e-artifacts",
    fullyParallel: false,
    timeout: 120_000,
    forbidOnly: Boolean(process.env.CI),
    retries: process.env.CI ? 1 : 0,
    workers: process.env.CI || !databaseUrl ? 1 : undefined,
    reporter: process.env.CI ? [["github"], ["html", { open: "never", outputFolder: "playwright-report" }]] : "list",
    use: {
        baseURL,
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
        video: "retain-on-failure",
    },
    projects: [
        { name: "setup", testMatch: /installation\.spec\.ts/ },
        { name: "chromium", testMatch: [/(?:all-pages|canvas(?:-tools)?|commerce|core|creative-video-result|home|responsive(?:-workspaces)?)\.spec\.ts/], dependencies: ["setup"], use: { ...devices["Desktop Chrome"], storageState } },
        {
            name: "mobile-390",
            testMatch: /(?:all-pages|commerce|creative-video-result|home|responsive(?:-workspaces)?)\.spec\.ts/,
            dependencies: ["setup"],
            use: { ...devices["iPhone 13"], browserName: "chromium", viewport: { width: 390, height: 844 }, storageState },
        },
        {
            name: "mobile-430",
            testMatch: /(?:all-pages|commerce|creative-video-result|home|responsive(?:-workspaces)?)\.spec\.ts/,
            dependencies: ["setup"],
            use: { ...devices["iPhone 14 Pro Max"], browserName: "chromium", viewport: { width: 430, height: 932 }, storageState },
        },
    ],
    webServer: [
        {
            command: "node scripts/protocol-fixture-server.mjs",
            url: `http://127.0.0.1:${protocolFixturePort}/health`,
            timeout: 30_000,
            reuseExistingServer: false,
            env: { ...process.env, VOZEB_PRO_PROTOCOL_FIXTURE_PORT: String(protocolFixturePort) },
        },
        {
            command: "node scripts/payment-fixture-server.mjs",
            url: `http://127.0.0.1:${paymentFixturePort}/health`,
            timeout: 30_000,
            reuseExistingServer: false,
            env: { ...process.env, VOZEB_PRO_PAYMENT_FIXTURE_PORT: String(paymentFixturePort) },
        },
        {
            command: "pnpm run start",
            url: `${baseURL}/api/auth/session`,
            timeout: 120_000,
            reuseExistingServer: false,
            env: {
                ...process.env,
                PORT: String(port),
                NEXT_PUBLIC_SITE_URL: baseURL,
                VOZEB_PRO_DATABASE_PROVIDER: databaseUrl ? "postgres" : "file",
                VOZEB_PRO_DATA_DIR: path.join(process.cwd(), ".e2e-data"),
                VOZEB_PRO_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                VOZEB_PRO_INSTALL_TOKEN: "vozeb-pro-e2e-install-token-32chars",
                VOZEB_PRO_MAINTENANCE_TOKEN: "vozeb-pro-e2e-maintenance-token-32chars",
                VOZEB_PRO_WORKER_TOKEN: "vozeb-pro-e2e-worker-token-separate-32chars",
                VOZEB_PRO_ALLOW_PRIVATE_UPSTREAMS: "1",
                VOZEB_PRO_PRIVATE_UPSTREAM_HOSTS: "127.0.0.1",
                ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
                VOZEB_PRO_PAYPLY_API_KEY: "vozeb-pro-e2e-payply-production-key",
                VOZEB_PRO_PAYPLY_CHECKOUT_URL: `http://127.0.0.1:${paymentFixturePort}/payply/checkout`,
                VOZEB_PRO_PAYPLY_QUERY_URL: `http://127.0.0.1:${paymentFixturePort}/payply/query?orderId={{orderId}}&orderNo={{orderNo}}&tradeId={{providerTradeId}}&paymentId={{providerPaymentId}}`,
                VOZEB_PRO_PAYPLY_REFUND_URL: `http://127.0.0.1:${paymentFixturePort}/payply/refund`,
                VOZEB_PRO_PAYPLY_REFUND_QUERY_URL: `http://127.0.0.1:${paymentFixturePort}/payply/refund-query?refundId={{providerRefundId}}`,
                VOZEB_PRO_PAYPLY_WEBHOOK_SECRET: "vozeb-pro-e2e-payply-webhook-secret",
            },
        },
    ],
});
