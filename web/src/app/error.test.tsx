import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import GlobalErrorPage from "./error";

describe("global consumer error page", () => {
    it("shows a retry and home path without exposing the internal error", () => {
        const markup = renderToStaticMarkup(<GlobalErrorPage error={new Error("database password") as Error & { digest?: string }} reset={vi.fn()} />);

        expect(markup).toContain("页面暂时无法打开");
        expect(markup).toContain("重新加载");
        expect(markup).toContain('href="/"');
        expect(markup).not.toContain("database password");
    });
});
