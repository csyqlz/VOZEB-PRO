import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/safe-outbound-fetch", () => ({ fetchSafeOutbound: (url: string | URL, init?: RequestInit) => fetch(url, init) }));

import { emptyAdvancedConfig } from "@/lib/channel-protocol-registry";
import { createProtocolFixtureServer } from "../../../scripts/protocol-fixture-server.mjs";
import { requestUpstreamGenerationCancellation, type GenerationCancellationTarget } from "./generation-task-cancellation-service";

describe("generation task upstream cancellation", () => {
    let close: (() => Promise<void>) | undefined;

    afterEach(async () => {
        await close?.();
        close = undefined;
    });

    it("sends the configured method and task path with provider authentication", async () => {
        const fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        if (!address || typeof address === "string") throw new Error("Protocol fixture did not bind a TCP port");
        const origin = `http://127.0.0.1:${address.port}`;
        close = () => new Promise<void>((resolve, reject) => fixture.server.close((error?: Error) => (error ? reject(error) : resolve())));

        const result = await requestUpstreamGenerationCancellation(target(origin, "/videos/:task_id/cancel"), "");

        expect(result).toBe("accepted");
        expect(fixture.requests).toHaveLength(1);
        expect(fixture.requests[0]).toMatchObject({ method: "POST", path: "/v1/videos/upstream-one/cancel" });
        expect(fixture.requests[0]?.headers.authorization).toBe("Bearer fixture-key");
    });

    it("supports documented DELETE cancellation contracts through the local fixture", async () => {
        const fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        if (!address || typeof address === "string") throw new Error("Protocol fixture did not expose a TCP port");
        const origin = `http://127.0.0.1:${address.port}`;
        close = () => new Promise<void>((resolve, reject) => fixture.server.close((error?: Error) => (error ? reject(error) : resolve())));

        const result = await requestUpstreamGenerationCancellation(
            {
                ...target(origin, "/videos/:task_id"),
                config: {
                    ...target(origin, "/videos/:task_id").config,
                    advancedConfig: { ...emptyAdvancedConfig(), protocol: "custom", cancelPath: "/videos/:task_id", cancelMethod: "DELETE" },
                },
            },
            "",
        );

        expect(result).toBe("accepted");
        expect(fixture.requests).toHaveLength(1);
        expect(fixture.requests[0]).toMatchObject({ method: "DELETE", path: "/v1/videos/upstream-one" });
        expect(fixture.requests[0]?.headers.authorization).toBe("Bearer fixture-key");
    });

    it("reports unsupported without contacting the provider when no cancel contract exists", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch");

        await expect(requestUpstreamGenerationCancellation(target("https://provider.example", ""), "")).resolves.toBe("unsupported");
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("does not treat a direct synchronous result as a cancellable upstream task", async () => {
        await expect(requestUpstreamGenerationCancellation({ ...target("https://provider.example", "/videos/:task_id/cancel"), upstreamTaskId: "direct:result-one" }, "")).resolves.toBe("not_submitted");
    });
});

function target(baseUrl: string, cancelPath: string): GenerationCancellationTarget {
    return {
        type: "video",
        taskId: "video-one",
        userId: "user-one",
        executionPhase: "submitted",
        upstreamTaskId: "upstream-one",
        config: {
            baseUrl: `${baseUrl}/v1`,
            apiKey: "fixture-key",
            apiFormat: "openai",
            model: "mock-video",
            channelId: "fixture-channel",
            advancedConfig: { ...emptyAdvancedConfig(), protocol: "custom", cancelPath, cancelMethod: "POST" },
        },
    };
}
