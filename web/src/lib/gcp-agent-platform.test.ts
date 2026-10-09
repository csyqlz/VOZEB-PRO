import { describe, expect, it } from "vitest";

import { gcpAgentPlatformBaseUrl, gcpAgentPlatformTargetUrl, isValidGcpLocation, isValidGcpProjectId } from "./gcp-agent-platform";

describe("GCP Agent Platform endpoint contract", () => {
    it("builds global and regional service endpoints", () => {
        expect(gcpAgentPlatformBaseUrl("global")).toBe("https://aiplatform.googleapis.com");
        expect(gcpAgentPlatformBaseUrl("asia-east1")).toBe("https://asia-east1-aiplatform.googleapis.com");
    });

    it("maps a Gemini model path to the Vertex project resource", () => {
        expect(gcpAgentPlatformTargetUrl({ projectId: "vozeb-prod-123", location: "global" }, ["models", "gemini-2.5-flash:generateContent"], "")).toBe(
            "https://aiplatform.googleapis.com/v1/projects/vozeb-prod-123/locations/global/publishers/google/models/gemini-2.5-flash:generateContent",
        );
    });

    it("preserves streaming query parameters on a regional endpoint", () => {
        expect(gcpAgentPlatformTargetUrl({ projectId: "vozeb-prod-123", location: "asia-east1" }, ["v1beta", "models", "gemini-2.5-flash:streamGenerateContent"], "?alt=sse")).toBe(
            "https://asia-east1-aiplatform.googleapis.com/v1/projects/vozeb-prod-123/locations/asia-east1/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
        );
    });

    it("rejects invalid projects, locations, and methods", () => {
        expect(isValidGcpProjectId("vozeb-prod-123")).toBe(true);
        expect(isValidGcpProjectId("../project")).toBe(false);
        expect(isValidGcpLocation("asia-east1")).toBe(true);
        expect(isValidGcpLocation("asia/east1")).toBe(false);
        expect(() => gcpAgentPlatformTargetUrl({ projectId: "../project", location: "global" }, ["models", "gemini-2.5-flash:generateContent"], "")).toThrow("GCP Project ID");
        expect(() => gcpAgentPlatformTargetUrl({ projectId: "vozeb-prod-123", location: "global" }, ["models", "gemini-2.5-flash:delete"], "")).toThrow("模型路径");
    });
});
