import { App } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GenerationOperationsClient } from "./generation-operations-client";

describe("generation operations page hierarchy", () => {
    it("uses one page surface with ordered operational sections", () => {
        const markup = renderToStaticMarkup(
            <App>
                <GenerationOperationsClient />
            </App>,
        );

        expect(markup.match(/admin-page-panel/g)).toHaveLength(1);
        expect(markup).toContain("生成运维");
        expect(markup).toContain('id="generation-runtime-summary-title"');
        expect(markup).toContain('id="generation-task-queue-title"');
        expect(markup).toContain('id="generation-channel-status-title"');
        expect(markup.indexOf('id="generation-runtime-summary-title"')).toBeLessThan(markup.indexOf('id="generation-task-queue-title"'));
        expect(markup.indexOf('id="generation-task-queue-title"')).toBeLessThan(markup.indexOf('id="generation-channel-status-title"'));
    });
});
