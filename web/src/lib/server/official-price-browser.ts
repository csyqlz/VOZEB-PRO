import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

import { TEXT_MODEL_REQUEST_TIMEOUT_MS } from "@/lib/server/model-request-policy";
import { fetchSafeOutbound } from "@/lib/server/safe-outbound-fetch";

export type OfficialPriceTable = { id: string; header: string; rows: Array<{ id: string; text: string; modelId?: string }> };

export async function readRenderedOfficialPageText(url: string, kind: "price" | "retirement", expectedHost = new URL(url).hostname, allowLocalFixture = false) {
    const source = new URL(url);
    if (source.hostname !== expectedHost || source.username || source.password || (!allowLocalFixture && source.protocol !== "https:")) throw new Error("官网价格链接无效");
    const executablePath = existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined;
    const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-http2"] });
    try {
        const context = await browser.newContext({ serviceWorkers: "block" });
        const page = await context.newPage();
        await page.route("**/*", async (route) => {
            const requestUrl = new URL(route.request().url());
            if (requestUrl.protocol !== (allowLocalFixture ? source.protocol : "https:") || (route.request().resourceType() === "document" && requestUrl.hostname !== expectedHost)) return route.abort();
            if (allowLocalFixture) return requestUrl.hostname === expectedHost ? route.continue() : route.abort();
            try {
                const browserHeaders = route.request().headers();
                const response = await fetchSafeOutbound(requestUrl, {
                    redirect: "manual",
                    headers: {
                        accept: browserHeaders.accept || "*/*",
                        "accept-language": browserHeaders["accept-language"] || "en-US,en;q=0.9",
                        "user-agent": browserHeaders["user-agent"] || "",
                        ...(browserHeaders.referer ? { referer: browserHeaders.referer } : {}),
                    },
                });
                const headers = Object.fromEntries(response.headers);
                for (const name of ["content-encoding", "content-length", "transfer-encoding", "connection"]) delete headers[name];
                await route.fulfill({ status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) });
            } catch {
                await route.abort();
            }
        });
        const response = await page.goto(url, { waitUntil: "commit", timeout: TEXT_MODEL_REQUEST_TIMEOUT_MS });
        if (!response?.ok() || new URL(page.url()).hostname !== expectedHost) throw new Error("官网文档未正常返回");
        const handle = await page.waitForFunction(
            (documentKind) => {
                const viewer = document.querySelector<HTMLElement>("#doc-viewer-container");
                const preferred = viewer?.getClientRects().length ? viewer : null;
                const candidates = [...document.querySelectorAll<HTMLElement>("article, main, [role=main]")];
                const root = preferred || candidates.sort((a, b) => b.innerText.length - a.innerText.length)[0] || document.body;
                if (!root) return false;
                const text = root.innerText.trim();
                const ready = documentKind === "price" ? /\b(?:USD|CNY|EUR)\b|美元|人民币|欧元|(?:\$|¥|€)\s*\d|pricing|价格|价目|计费|费用/i.test(text) && /\d/.test(text) : /deprecat|deactivat|停用|下架/i.test(text) && /\b20\d{2}\b/.test(text);
                if (!ready) return false;
                return {
                    text,
                    tables: [...root.querySelectorAll("table")]
                        .filter((table) => table.getClientRects().length > 0)
                        .map((table, tableIndex) => {
                            const rows = [...table.querySelectorAll("tr")]
                                .filter((row) => row.getClientRects().length > 0)
                                .map((row, rowIndex) => ({
                                    id: `t${tableIndex}r${rowIndex}`,
                                    text: (row as HTMLElement).innerText.trim(),
                                    modelId:
                                        (row.querySelector("th, td") as HTMLElement | null)?.innerText
                                            .replace(/[\u200b-\u200d\ufeff]/g, "")
                                            .trim()
                                            .split(/\s/)[0] || "",
                                }))
                                .filter((row) => row.text);
                            return { id: `t${tableIndex}`, header: rows[0]?.text || "", rows };
                        })
                        .filter((table) => table.rows.length),
                };
            },
            kind,
            { timeout: TEXT_MODEL_REQUEST_TIMEOUT_MS },
        );
        const snapshot = (await handle.jsonValue()) as { text: string; tables: OfficialPriceTable[] };
        if (!snapshot.text) throw new Error("官网文档没有可见正文");
        return { url: page.url(), ...snapshot };
    } finally {
        await browser.close();
    }
}
