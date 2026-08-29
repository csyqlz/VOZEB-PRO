import { describe, expect, it, vi } from "vitest";

import { gcpAgentPlatformAuthHeaders } from "./gcp-agent-platform-auth";

describe("GCP Agent Platform authentication", () => {
    it("uses the channel API key without loading ADC", async () => {
        const accessToken = vi.fn();

        await expect(gcpAgentPlatformAuthHeaders("api-key-secret", "custom-header", accessToken)).resolves.toEqual({ "x-goog-api-key": "api-key-secret" });
        expect(accessToken).not.toHaveBeenCalled();
    });

    it("loads a fresh ADC bearer token server-side", async () => {
        const accessToken = vi.fn(async () => "adc-access-token");

        await expect(gcpAgentPlatformAuthHeaders("", "google-adc", accessToken)).resolves.toEqual({ authorization: "Bearer adc-access-token" });
        expect(accessToken).toHaveBeenCalledOnce();
    });

    it("rejects an unavailable ADC credential", async () => {
        await expect(gcpAgentPlatformAuthHeaders("", "google-adc", async () => null)).rejects.toThrow("ADC");
    });
});
