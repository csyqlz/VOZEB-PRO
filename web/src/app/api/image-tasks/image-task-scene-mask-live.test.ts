import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/server/proxy-dispatcher", () => ({ configureServerProxyDispatcher: vi.fn() }));
vi.mock("@/lib/server/database", () => ({ getDatabaseProvider: () => "file" }));
vi.mock("@/lib/server/object-storage-service", () => ({ deleteExternalMediaObject: vi.fn(), persistExternalMediaIfEnabled: async () => null }));
vi.mock("@/lib/server/local-media-registry", () => ({ registerLocalMediaAsset: vi.fn() }));

import { emptyAdvancedConfig } from "@/lib/channel-protocol-registry";
import { buildSceneEditProtection } from "@/lib/server/ecommerce-product-regions";
import { createImageTask, getImageTask } from "@/lib/server/image-task-store";
import { createImageTaskUpstreamStep } from "@/lib/server/image-task-runtime";
import { localAssetUrlToPath } from "@/lib/server/generation-log-repository";

let directory: string;
beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "vozeb-scene-mask-wire-"));
    vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
    vi.stubEnv("VOZEB_PRO_ALLOW_PRIVATE_UPSTREAMS", "1");
    vi.stubEnv("VOZEB_PRO_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1");
});
afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
});

async function setup(protocol: "openai" | "sub2api" | "custom" = "openai", nativeWidth = 6, nativeHeight = 4) {
    const sourcePixels = Buffer.from(Array.from({ length: 6 * 4 * 4 }, (_, index) => (index % 4 === 3 ? 255 : index)));
    const source = await sharp(sourcePixels, { raw: { width: 6, height: 4, channels: 4 } })
        .png()
        .toBuffer();
    const native = await sharp({ create: { width: nativeWidth, height: nativeHeight, channels: 4, background: "red" } })
        .png()
        .toBuffer();
    const protection = await buildSceneEditProtection(source, "scene", { x: 2, y: 1, width: 2, height: 2 }, ["vase and shadow"], "user_selection");
    const requests: FormData[] = [];
    const jsonRequests: Array<{ path: string; body: { model: string; size: string; images: Array<{ image_url: string }>; mask: { image_url: string }; input_fidelity: string } }> = [];
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        if (String(request.headers["content-type"]).includes("application/json")) jsonRequests.push({ path: request.url!, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        else requests.push(await new Request("http://fixture.local", { method: "POST", headers: { "content-type": String(request.headers["content-type"]) }, body: Buffer.concat(chunks) }).formData());
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ b64_json: native.toString("base64") }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TCP fixture did not bind");
    const origin = `http://127.0.0.1:${address.port}`;
    const task = await createImageTask({
        userId: "fixture-user",
        username: "fixture",
        displayName: "fixture",
        kind: "edit",
        source: "agent",
        prompt: "add vase",
        references: [{ id: "scene", dataUrl: "data:image/png;base64," + source.toString("base64"), width: 6, height: 4, ecommerceRole: "scene" }],
        mask: protection.mask,
        sceneProtection: protection,
        ecommerceExecution: {
            state: "ready",
            compilerVersion: "ecommerce-openai-image-2.5.v2",
            providerProfileId: "gpt-image-2.5-flare",
            prompt: "add vase",
            referenceRoles: [{ assetId: "scene", role: "scene" }],
            parameters: { variant: "gpt-image-2.5-flare", size: "6x4" },
            canvas: { mode: "exact", size: { width: 6, height: 4 }, source: "baseline", allowReframe: false },
            protection: { scope: "local", protectedObjectIds: [], preserveOutsideMask: true, allowLightingChange: false },
            mask: { mode: "independent", required: true },
            modelSnapshot: { logicalRole: "image_generation", capability: "image", logicalModelId: "image", channelId: "fixture", upstreamModel: "gpt-image-2.5-flare", apiFormat: "openai" },
        },
        config: { baseUrl: origin, apiKey: "fixture-only", model: "gpt-image-2.5-flare", apiFormat: "openai", size: "6x4", advancedConfig: { ...emptyAdvancedConfig(), protocol } },
    });
    return { task, source, native, sourcePixels, requests, jsonRequests, origin, close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))) };
}

it("submits one native sub2api JSON edit with original source, alpha mask and preserved outside pixels", async () => {
    const fixture = await setup("sub2api");
    try {
        expect(await createImageTaskUpstreamStep(fixture.task, fixture.origin, fixture.origin, "fixture-session")).toMatchObject({ state: "result_ready" });
        expect(fixture.requests).toHaveLength(0);
        expect(fixture.jsonRequests).toHaveLength(1);
        const { path, body } = fixture.jsonRequests[0];
        expect(path).toBe("/v1/images/edits");
        expect(body).toMatchObject({ model: "gpt-image-2.5-flare", size: "6x4", input_fidelity: "high" });
        expect(body.images).toHaveLength(1);
        expect(Buffer.from(body.images[0].image_url.split(",")[1], "base64")).toEqual(fixture.source);
        const rawMask = await sharp(Buffer.from(body.mask.image_url.split(",")[1], "base64"))
            .ensureAlpha()
            .raw()
            .toBuffer();
        expect(rawMask[(1 * 6 + 2) * 4 + 3]).toBe(0);
        expect(rawMask[(1 * 6 + 1) * 4 + 3]).toBe(255);
        const stored = (await getImageTask(fixture.task.id))!.result!;
        expect(stored.sceneProtectionEvidence).toMatchObject({ nativeOutsideChangedPixels: 20, compositeOutsideChangedPixels: 0 });
        const result = await sharp(await readFile(localAssetUrlToPath(stored.serverUrl!)))
            .ensureAlpha()
            .raw()
            .toBuffer();
        for (let y = 0; y < 4; y++)
            for (let x = 0; x < 6; x++)
                if (!(x >= 2 && x < 4 && y >= 1 && y < 3)) {
                    const offset = (y * 6 + x) * 4;
                    expect(result.subarray(offset, offset + 4)).toEqual(fixture.sourcePixels.subarray(offset, offset + 4));
                }
    } finally {
        await fixture.close();
    }
});

it("sends full original image and independent alpha mask over TCP and persists native/composite evidence", async () => {
    const fixture = await setup();
    try {
        expect(await createImageTaskUpstreamStep(fixture.task, fixture.origin, fixture.origin, "fixture-session")).toMatchObject({ state: "result_ready" });
        expect(fixture.requests).toHaveLength(1);
        const form = fixture.requests[0];
        expect(form.getAll("image")).toHaveLength(1);
        const image = Buffer.from(await (form.get("image") as File).arrayBuffer());
        const mask = Buffer.from(await (form.get("mask") as File).arrayBuffer());
        expect(image.equals(fixture.source)).toBe(true);
        expect(await sharp(image).metadata()).toMatchObject({ width: 6, height: 4 });
        const rawMask = await sharp(mask).ensureAlpha().raw().toBuffer();
        expect(rawMask[(1 * 6 + 2) * 4 + 3]).toBe(0);
        expect(rawMask[(1 * 6 + 1) * 4 + 3]).toBe(255);
        const stored = (await getImageTask(fixture.task.id))!.result!;
        const evidence = stored.sceneProtectionEvidence!;
        expect((await readFile(localAssetUrlToPath(evidence.nativeUrl!))).equals(fixture.native)).toBe(true);
        const result = await sharp(await readFile(localAssetUrlToPath(stored.serverUrl!)))
            .ensureAlpha()
            .raw()
            .toBuffer();
        for (let y = 0; y < 4; y++)
            for (let x = 0; x < 6; x++)
                if (!(x >= 2 && x < 4 && y >= 1 && y < 3)) {
                    const offset = (y * 6 + x) * 4;
                    expect(result.subarray(offset, offset + 4)).toEqual(fixture.sourcePixels.subarray(offset, offset + 4));
                }
        expect(evidence).toMatchObject({ nativeOutsideChangedPixels: 20, compositeOutsideChangedPixels: 0, targetRegion: { x: 2, y: 1, width: 2, height: 2 } });
    } finally {
        await fixture.close();
    }
});

it.each([
    { protocol: "openai" as const, width: 3, height: 2 },
    { protocol: "sub2api" as const, width: 3, height: 2 },
    { protocol: "openai" as const, width: 12, height: 8 },
    { protocol: "sub2api" as const, width: 12, height: 8 },
    { protocol: "openai" as const, width: 5, height: 4 },
    { protocol: "sub2api" as const, width: 5, height: 4 },
])("delivers a $protocol $width x $height native on the original canvas with one TCP submission and unchanged source/mask bytes", async ({ protocol, width, height }) => {
    const normalization = width === 5 ? "pixel_grid_scale" : "uniform_scale";
    const fixture = await setup(protocol, width, height);
    try {
        expect(await createImageTaskUpstreamStep(fixture.task, fixture.origin, fixture.origin, "fixture-session")).toMatchObject({ state: "result_ready" });
        expect(fixture.requests.length + fixture.jsonRequests.length).toBe(1);
        let image: Buffer;
        let mask: Buffer;
        if (protocol === "sub2api") {
            expect(fixture.jsonRequests[0]).toMatchObject({ path: "/v1/images/edits", body: { size: "6x4", input_fidelity: "high" } });
            expect(fixture.jsonRequests[0].body.images).toHaveLength(1);
            image = Buffer.from(fixture.jsonRequests[0].body.images[0].image_url.split(",")[1], "base64");
            mask = Buffer.from(fixture.jsonRequests[0].body.mask.image_url.split(",")[1], "base64");
        } else {
            const form = fixture.requests[0];
            expect(form.get("size")).toBe("6x4");
            expect(form.getAll("image")).toHaveLength(1);
            image = Buffer.from(await (form.get("image") as File).arrayBuffer());
            mask = Buffer.from(await (form.get("mask") as File).arrayBuffer());
        }
        expect(image).toEqual(fixture.source);
        expect(mask).toEqual(Buffer.from(fixture.task.mask!.dataUrl.split(",")[1], "base64"));
        expect(await sharp(image).metadata()).toMatchObject({ width: 6, height: 4 });
        expect(await sharp(mask).metadata()).toMatchObject({ width: 6, height: 4 });
        const stored = (await getImageTask(fixture.task.id))!.result!;
        const evidence = stored.sceneProtectionEvidence!;
        const nativeStored = await readFile(localAssetUrlToPath(evidence.nativeUrl!));
        expect(nativeStored).toEqual(fixture.native);
        expect(await sharp(nativeStored).metadata()).toMatchObject({ width, height });
        expect(stored).toMatchObject({ width: 6, height: 4, canvasEvidence: { nativeSize: { width, height }, storedSize: { width: 6, height: 4 }, normalization } });
        expect((await getImageTask(fixture.task.id))!.ecommerceCanvasRequest).toMatchObject({ size: "6x4" });
        expect(evidence).toMatchObject({
            normalization,
            nativeSize: { width, height },
            sourceSize: { width: 6, height: 4 },
            maskSize: { width: 6, height: 4 },
            mappedOutsideChangedPixels: 20,
            compositeOutsideChangedPixels: 0,
            nativeDigest: createHash("sha256").update(fixture.native).digest("hex"),
        });
        expect(evidence).not.toHaveProperty("nativeOutsideChangedPixels");
        const { data, info } = await sharp(await readFile(localAssetUrlToPath(stored.serverUrl!)))
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        expect(info).toMatchObject({ width: 6, height: 4, channels: 4 });
        for (let y = 0; y < 4; y++)
            for (let x = 0; x < 6; x++) {
                const offset = (y * 6 + x) * 4;
                expect(data.subarray(offset, offset + 4)).toEqual(x >= 2 && x < 4 && y >= 1 && y < 3 ? Buffer.from([255, 0, 0, 255]) : fixture.sourcePixels.subarray(offset, offset + 4));
            }
        expect(fixture.requests.length + fixture.jsonRequests.length).toBe(1);
    } finally {
        await fixture.close();
    }
});

it("rejects an unsupported protocol before any TCP submission", async () => {
    const fixture = await setup("custom");
    try {
        expect(await createImageTaskUpstreamStep(fixture.task, fixture.origin, fixture.origin, "fixture-session")).toMatchObject({ state: "needs_review", status: "scene_mask_review_required" });
        expect(fixture.requests).toHaveLength(0);
    } finally {
        await fixture.close();
    }
});

it.each(["corrupt", "wrong_size", "reverse"])("rejects a %s mask before any TCP submission", async (mode) => {
    const fixture = await setup();
    try {
        let bytes = Buffer.from("broken");
        if (mode === "wrong_size")
            bytes = await sharp({ create: { width: 5, height: 4, channels: 4, background: "white" } })
                .png()
                .toBuffer();
        if (mode === "reverse") {
            const original = Buffer.from(fixture.task.mask!.dataUrl.split(",")[1], "base64");
            const { data, info } = await sharp(original).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
            for (let index = 3; index < data.length; index += 4) data[index] = 255 - data[index];
            bytes = await sharp(data, { raw: info }).png().toBuffer();
        }
        const mask = { ...fixture.task.mask!, dataUrl: "data:image/png;base64," + bytes.toString("base64") };
        const task = await createImageTask({ ...fixture.task, mask, sceneProtection: { ...fixture.task.sceneProtection!, mask } });
        expect(await createImageTaskUpstreamStep(task, fixture.origin, fixture.origin, "fixture-session")).toMatchObject({ state: "needs_review", status: "scene_mask_review_required" });
        expect(fixture.requests).toHaveLength(0);
    } finally {
        await fixture.close();
    }
});

it.each(["openai", "sub2api"] as const)("rejects a wrong-size %s native without normalizing it into local success or sending twice", async (protocol) => {
    const fixture = await setup(protocol, 5, 5);
    try {
        const response = await createImageTaskUpstreamStep(fixture.task, fixture.origin, fixture.origin, "fixture-session");
        expect(response).toMatchObject({ state: "failed", error: expect.stringContaining("原生画幅比例") });
        if (response.state === "failed") {
            expect(response.error).toMatch(/6\s*[x×]\s*4/);
            expect(response.error).toMatch(/5\s*[x×]\s*5/);
            expect(response.error).not.toMatch(/fixture-session|fixture-only|data:image/);
        }
        expect(fixture.requests.length + fixture.jsonRequests.length).toBe(1);
        expect((await getImageTask(fixture.task.id))!.result).toBeUndefined();
    } finally {
        await fixture.close();
    }
});
