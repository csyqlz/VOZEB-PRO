import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { applyChannelProtocol } from "@/lib/channel-protocol-registry";
import type { SystemModelChannel } from "@/lib/auth/store";

import { GcpAgentPlatformFields } from "./gcp-agent-platform-fields";

describe("GCP Agent Platform channel fields", () => {
    it("renders project, location, derived endpoint, and both credential modes", () => {
        const channel = applyChannelProtocol({ id: "gcp", name: "GCP", baseUrl: "", apiKey: "", apiFormat: "openai", models: [], enabled: false } satisfies SystemModelChannel, "gcp-agent-platform");
        channel.advancedConfig = { ...channel.advancedConfig!, gcpProjectId: "vozeb-prod-123", gcpLocation: "asia-east1" };
        channel.baseUrl = "https://stale.example.com/v1";

        const html = renderToStaticMarkup(<GcpAgentPlatformFields channel={channel} onChange={vi.fn()} />);

        expect(html).toContain("GCP Project ID");
        expect(html).toContain("Location");
        expect(html).toContain("ADC");
        expect(html).toContain("API Key");
        expect(html).toContain("https://asia-east1-aiplatform.googleapis.com");
        expect(html).not.toContain("https://stale.example.com/v1");
    });
});
