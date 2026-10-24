import { afterEach, describe, expect, it, vi } from "vitest";
import { createDirectedPricingTask, getDirectedPricingTask } from "./model-pricing";

describe("directed pricing task client", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("uses the normal image task endpoint and pins the exact binding for an edit", async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ task: { id: "task-1", status: "pending" } }), { status: 200 }));
        vi.stubGlobal("fetch", fetchMock);
        await expect(createDirectedPricingTask({ capability: "image", modelId: "image-model", bindingKey: "channel/sku", operation: "edit", prompt: "edit", referenceDataUrl: "data:image/png;base64,AA==" })).resolves.toMatchObject({ id: "task-1" });
        const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("/api/image-tasks");
        expect(new Headers(options.headers).get("x-vozeb-pro-pricing-test-binding")).toBe("channel/sku");
        expect(JSON.parse(String(options.body))).toMatchObject({ kind: "edit", config: { model: "image-model" }, references: [{ dataUrl: "data:image/png;base64,AA==" }] });
    });

    it("reads the existing task status without creating another upstream request", async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ task: { id: "task-1", status: "success" } }), { status: 200 }));
        vi.stubGlobal("fetch", fetchMock);
        await expect(getDirectedPricingTask("video", "task-1")).resolves.toMatchObject({ status: "success" });
        expect(fetchMock).toHaveBeenCalledWith("/api/video-tasks/task-1", expect.objectContaining({ cache: "no-store" }));
    });

    it("reuses a completed creation image as the edit reference on the locked binding", async () => {
        const imageUrl = "/api/generation-log-assets/created.png";
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({ task: { id: "created", status: "success", result: { dataUrl: imageUrl } } }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ task: { id: "edited", status: "pending" } }), { status: 200 }));
        vi.stubGlobal("fetch", fetchMock);
        const created = await getDirectedPricingTask("image", "created");
        await createDirectedPricingTask({ capability: "image", modelId: "image-model", bindingKey: "channel/sku", operation: "edit", prompt: "add a duck", referenceDataUrl: created.result!.dataUrl });
        const [url, options] = fetchMock.mock.calls[1] as [string, RequestInit];
        expect(url).toBe("/api/image-tasks");
        expect(new Headers(options.headers).get("x-vozeb-pro-pricing-test-binding")).toBe("channel/sku");
        expect(JSON.parse(String(options.body))).toMatchObject({ kind: "edit", references: [{ dataUrl: imageUrl }] });
    });
});
