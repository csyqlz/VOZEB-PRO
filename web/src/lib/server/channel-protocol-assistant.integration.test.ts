import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProtocolFixtureServer } from "../../../scripts/protocol-fixture-server.mjs";
import { createChannelProtocolDraft } from "./channel-protocol-assistant";

let fixture: ReturnType<typeof createProtocolFixtureServer>;
let origin = "";

beforeEach(async () => {
    vi.stubEnv("VOZEB_PRO_ALLOW_PRIVATE_UPSTREAMS", "1");
    vi.stubEnv("VOZEB_PRO_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1");
    fixture = createProtocolFixtureServer();
    await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
    const address = fixture.server.address();
    if (!address || typeof address === "string") throw new Error("Protocol fixture did not expose a TCP port");
    origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve, reject) => fixture.server.close((error) => (error ? reject(error) : resolve())));
});

describe("channel protocol assistant local documentation", () => {
    it("reads an arbitrary documentation path and extracts image and video request contracts", async () => {
        const documentationUrl = `${origin}/vendor-space/knowledge/article-947`;

        const result = await createChannelProtocolDraft({
            requestUrl: "http://localhost/api/admin/channel-protocol-draft",
            cookie: "",
            userId: "admin",
            documentationUrl,
            useTextModel: false,
        });

        expect(result).toMatchObject({ sourcePages: 1, warnings: [], drafts: [{ baseUrl: origin, documentationUrl }] });
        const draft = result.drafts[0];
        expect(draft.modelCatalogPaths).toContain("/api/v3/models");
        expect(draft.operations).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ capability: "image", models: ["custom-image-v9"], config: expect.objectContaining({ createPath: "/custom/images", resultField: "data.image_url" }) }),
                expect.objectContaining({
                    capability: "video",
                    models: ["custom-video-v9"],
                    config: expect.objectContaining({ createPath: "/custom/videos", queryPath: "/custom/results/:task_id", statusField: "data.status", resultField: "data.video_url" }),
                }),
            ]),
        );
        expect(fixture.requests.map((request) => request.path)).toEqual(["/vendor-space/knowledge/article-947"]);
    });
});
