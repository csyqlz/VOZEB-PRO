import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TEXT_MODEL_REQUEST_TIMEOUT_MS } from "./model-request-policy";
import { officialModelIdsInPriceText } from "./model-pricing-ai-review";
import { readRenderedOfficialPageText } from "./official-price-browser";

const server = createServer((request, response) => {
    if (request.url === "/redirect") {
        response.writeHead(302, { Location: "https://example.com/" });
        response.end();
        return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html><body><nav>Seedream 99 USD</nav><article id="price-root"></article><script>
      const root = document.querySelector('#price-root');
      root.innerHTML = '<h1>Image pricing</h1><table><tr><td>seedream-4-5-251128</td><td>0.04 USD / image</td></tr><tr hidden><td>hidden-model</td><td>99 USD</td></tr></table><p hidden>Secret hidden price</p>';
    </script></body></html>`);
});
let origin: string;

beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server unavailable");
    origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

describe("browser rendered official price text", () => {
    it("does not open a private URL in the production browser path", async () => {
        await expect(readRenderedOfficialPageText(`${origin}/pricing`, "price")).rejects.toThrow("官网价格链接无效");
    });

    it("reads visible content produced by browser JavaScript without navigation or hidden text", async () => {
        const result = await readRenderedOfficialPageText(`${origin}/pricing`, "price", "127.0.0.1", true);
        expect(result.text).toContain("seedream-4-5-251128");
        expect(result.text).toContain("0.04 USD / image");
        expect(result.text).not.toContain("Seedream 99 USD");
        expect(result.text).not.toContain("Secret hidden price");
        expect(result.tables).toMatchObject([{ id: "t0", rows: [{ id: "t0r0", text: expect.stringContaining("seedream-4-5-251128") }] }]);
        expect(result.tables[0].rows).toHaveLength(1);
    });

    it("rejects a redirect away from the expected host", async () => {
        await expect(readRenderedOfficialPageText(`${origin}/redirect`, "price", "127.0.0.1", true)).rejects.toThrow();
    });

    it.runIf(process.env.RUN_BYTEPLUS_LIVE === "1")(
        "reads the current BytePlus pricing and retirement pages",
        async () => {
            const price = await readRenderedOfficialPageText("https://docs.byteplus.com/en/docs/ModelArk/1544106", "price");
            const retirement = await readRenderedOfficialPageText("https://docs.byteplus.com/en/docs/modelark/model-deprecation-notice", "retirement");
            expect(price.text).toMatch(/seedream/i);
            expect(price.text).toMatch(/\bUSD\b/);
            expect(price.tables.flatMap((table) => table.rows).some((row) => /seedream/i.test(row.text))).toBe(true);
            const ids = officialModelIdsInPriceText(price.text);
            expect(ids).toContain("dreamina-seedance-2-0-260128");
            expect(ids).toContain("dola-seedream-5-0-pro-260628");
            expect(ids).not.toContain("seedance-2-0-260128");
            expect(price.tables.flatMap((table) => table.rows).find((row) => row.text.includes("dreamina-seedance-2-0-260128"))?.modelId).toBe("dreamina-seedance-2-0-260128");
            expect(retirement.text).toMatch(/deprecat/i);
            expect(price.text).not.toContain("window._ROUTER_DATA");
        },
        TEXT_MODEL_REQUEST_TIMEOUT_MS,
    );
});
