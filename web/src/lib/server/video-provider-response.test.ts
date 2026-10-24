import { describe, expect, it } from "vitest";

import { readVideoProviderId } from "./video-provider-response";

describe("Kling video task identity", () => {
    it("uses the provider task ID when the response also contains request IDs", () => {
        const response = { id: "gateway-request", request_id: "provider-request", data: { task_id: "933825436113981495", task_status: "submitted" } };

        expect(readVideoProviderId(response, "kling")).toBe("933825436113981495");
        expect(readVideoProviderId({ request_id: "provider-request", data: {} }, "kling")).toBe("");
        expect(readVideoProviderId({ id: "other-provider-task" }, "openai")).toBe("other-provider-task");
    });
});
