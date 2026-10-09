import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/proxy-dispatcher", () => ({ configureServerProxyDispatcher: vi.fn() }));
vi.mock("@/lib/server/database", () => ({ getDatabaseProvider: () => "file" }));
vi.mock("@/lib/server/object-storage-service", () => ({ deleteExternalMediaObject: vi.fn(), persistExternalMediaIfEnabled: async () => null }));
vi.mock("@/lib/server/local-media-registry", () => ({ registerLocalMediaAsset: vi.fn() }));

import { runOpenAiImageTask } from "./image-task-openai";
import { runCustomImageTask } from "./image-task-custom";
import { runGeminiImageTask } from "./image-task-gemini";
import { resolveCanvasRequestSize } from "./image-task-size";
import { emptyAdvancedConfig } from "@/lib/channel-protocol-registry";
import { ecommerceCanvasSize, type EcommerceCanvasConstraint } from "@/lib/server/ecommerce-edit-plan";
import { createImageTask, getImageTask, updateImageTask, type ImageTask } from "@/lib/server/image-task-store";
import { prepareImageTaskResults } from "@/lib/server/image-task-result-service";
import { localAssetUrlToPath } from "@/lib/server/generation-log-repository";
import { evaluateEcommerceCanvas } from "@/lib/server/ecommerce-quality-check";

const source = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR4nGPQq/3/H4QZYAwAWewKpRUlAtEAAAAASUVORK5CYII=";
let directory: string;
beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "vozeb-canvas-wire-"));
    vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
    vi.stubEnv("VOZEB_PRO_ALLOW_PRIVATE_UPSTREAMS", "1");
    vi.stubEnv("VOZEB_PRO_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1");
});
afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
});

async function fixture(status = 200, message = "unsupported size") {
    const requests: Array<{ path: string; size: string | undefined; ratio?: string; contentType: string }> = [];
    const server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const contentType = String(req.headers["content-type"] || "");
        const request = new Request("http://fixture.local", { method: "POST", headers: { "content-type": contentType }, body: Buffer.concat(chunks) });
        const json = contentType.startsWith("multipart/") ? null : await request.json();
        const size = json ? json.size || json.output_size || (json.width && json.height ? `${json.width}x${json.height}` : undefined) : String((await request.formData()).get("size") || "") || undefined;
        const ratio = json?.ratio || json?.aspect_ratio;
        requests.push({ path: req.url!, size, ratio, contentType });
        res.writeHead(status, { "content-type": "application/json" });
        if (status !== 200) return void res.end(JSON.stringify({ error: { message } }));
        const [width, height] = ratio ? ratio.split(":").map((value: string) => Number(value) * 64) : (size || "1024x1024").split("x").map(Number);
        const bytes = await sharp({ create: { width, height, channels: 3, background: "#287fbd" } })
            .png()
            .toBuffer();
        res.end(JSON.stringify({ data: [{ b64_json: bytes.toString("base64") }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TCP fixture did not bind");
    return { requests, origin: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))) };
}

function task(origin: string, encoding: "multipart" | "json", canvas?: EcommerceCanvasConstraint, size = "auto"): Omit<ImageTask, "id" | "status" | "createdAt" | "updatedAt"> {
    return {
        userId: "fixture-user",
        username: "fixture",
        displayName: "Fixture",
        source: "agent",
        kind: "edit",
        prompt: "preserve source geometry",
        references: [{ name: "source.png", type: "image/png", dataUrl: source }],
        config: {
            baseUrl: origin,
            apiKey: "fixture-key",
            apiFormat: "openai",
            model: "fixture-image",
            size: canvas ? ecommerceCanvasSize(canvas) : size,
            advancedConfig: { ...emptyAdvancedConfig(), protocol: encoding === "json" ? "sub2api" : "openai", createPath: "/images/generations", editPath: "/images/edits", supportsReferenceImage: true },
        },
        ...(canvas
            ? {
                  ecommerceExecution: {
                      state: "ready",
                      compilerVersion: "ecommerce-openai-image-2.5.v1",
                      providerProfileId: "gpt-image-2.5-flare",
                      prompt: "preserve",
                      referenceRoles: [{ assetId: "source", role: "product" }],
                      parameters: { variant: "gpt-image-2.5-flare" },
                      canvas,
                      modelSnapshot: { logicalRole: "image_generation", capability: "image", logicalModelId: "image", channelId: "fixture", upstreamModel: "fixture-image", apiFormat: "openai" },
                  },
              }
            : {}),
    };
}

describe("ecommerce final OpenAI canvas request", () => {
    it.each([
        { quality: "low", shortSide: 4, longSide: 262144 },
        { quality: "medium", shortSide: 8, longSide: 524288 },
        { quality: "high", shortSide: 11, longSide: 720896 },
        { quality: undefined, shortSide: 1024, longSide: 67108864 },
    ])("preserves both extreme ratio orientations at quality $quality without legacy axis rounding", async ({ quality, shortSide, longSide }) => {
        for (const size of [
            { width: 1, height: 65536 },
            { width: 65536, height: 1 },
        ]) {
            const canvas: EcommerceCanvasConstraint = { mode: "ratio", size, source: "user_text", allowReframe: false };
            const created = await createImageTask(task("http://127.0.0.1", "multipart", canvas));
            expect(resolveCanvasRequestSize(created, quality)).toBe(size.width === 1 ? `${shortSide}x${longSide}` : `${longSide}x${shortSide}`);
        }
    });

    it("records an actual ratio field without claiming a requested pixel size", async () => {
        const upstream = await fixture();
        const canvas: EcommerceCanvasConstraint = { mode: "ratio", size: { width: 3840, height: 2160 }, source: "baseline", allowReframe: true };
        try {
            const input = task(upstream.origin, "multipart", canvas);
            input.config.advancedConfig = { ...emptyAdvancedConfig(), protocol: "stable-diffusion", createPath: "/images/edits", requestTemplate: '{"aspect_ratio":"{{aspect_ratio}}","images":"{{images}}"}', resultField: "data" };
            const created = await createImageTask(input);
            const result = await runCustomImageTask(created, upstream.origin, "", "", true);
            expect(upstream.requests).toHaveLength(1);
            expect(upstream.requests[0]).toMatchObject({ ratio: "16:9", size: undefined });
            const restored = (await getImageTask(created.id))!;
            expect(restored.ecommerceCanvasRequest).toEqual({ aspectRatio: "16:9" });
            const {
                results: [stored],
            } = await prepareImageTaskResults(restored, result, upstream.origin, "");
            expect(stored.canvasEvidence?.requestedSize).toBeUndefined();
            expect(stored.canvasEvidence?.providerRequest).toEqual({ aspectRatio: "16:9" });
            expect(evaluateEcommerceCanvas(canvas, stored.canvasEvidence!.nativeSize, stored.canvasEvidence!.storedSize).hardFailures).toEqual([]);
        } finally {
            await upstream.close();
        }
    });

    it("requires review for exact pixels on a GlobalAiOpc ratio-only request contract", async () => {
        const upstream = await fixture();
        const canvas: EcommerceCanvasConstraint = { mode: "exact", size: { width: 384, height: 216 }, source: "baseline", allowReframe: false };
        try {
            const input = task(upstream.origin, "multipart", canvas);
            input.kind = "generation";
            input.references = [];
            input.config.model = "gpt-image-2";
            input.config.advancedConfig = { ...emptyAdvancedConfig(), protocol: "globalaiopc", globalAiOpcPreset: "image-gpt-image-2", createPath: "/image2/images", queryPath: "/result/:task_id" };
            const created = await createImageTask(input);
            await expect(runOpenAiImageTask(created, upstream.origin, "", "", true)).rejects.toThrow("GlobalAiOpc 图片适配器尚不支持画布约束");
            expect(upstream.requests).toHaveLength(0);
        } finally {
            await upstream.close();
        }
    });
    it.each([
        { mode: "exact" as const, template: '{"model":"{{model}}","output_size":"{{size}}","images":"{{images}}"}' },
        { mode: "ratio" as const, template: '{"model":"{{model}}","width":"{{width}}","height":"{{height}}","images":"{{images}}"}' },
    ])("preserves $mode in the final configured declarative request", async ({ mode, template }) => {
        const upstream = await fixture();
        const canvas: EcommerceCanvasConstraint = { mode, size: { width: 384, height: 216 }, source: "baseline", allowReframe: false };
        try {
            const input = task(upstream.origin, "multipart", canvas);
            input.config.advancedConfig = { ...emptyAdvancedConfig(), protocol: "stable-diffusion", createPath: "/images/edits", requestTemplate: template, resultField: "data" };
            const created = await createImageTask(input);
            const result = await runCustomImageTask(created, upstream.origin, "", "", true);
            expect(upstream.requests).toHaveLength(1);
            const [width, height] = upstream.requests[0].size!.split("x").map(Number);
            if (mode === "exact") expect({ width, height }).toEqual(canvas.size);
            expect(BigInt(width) * BigInt(216)).toBe(BigInt(height) * BigInt(384));
            const restored = (await getImageTask(created.id))!;
            expect(restored).toHaveProperty("ecommerceCanvasRequest");
            const {
                results: [stored],
            } = await prepareImageTaskResults(restored, result, upstream.origin, "");
            expect(stored.canvasEvidence?.requestedSize).toEqual({ width, height });
            expect(evaluateEcommerceCanvas(canvas, stored.canvasEvidence!.nativeSize, stored.canvasEvidence!.storedSize).hardFailures).toEqual([]);
        } finally {
            await upstream.close();
        }
    });

    it.each(["gemini", "template-without-geometry"])("requires review before submitting through %s", async (adapter) => {
        const upstream = await fixture();
        const canvas: EcommerceCanvasConstraint = { mode: "exact", size: { width: 384, height: 216 }, source: "baseline", allowReframe: false };
        try {
            const input = task(upstream.origin, "multipart", canvas);
            input.config.advancedConfig = { ...emptyAdvancedConfig(), protocol: "stable-diffusion", createPath: "/images/edits", requestTemplate: '{"model":"{{model}}","images":"{{images}}"}', resultField: "data" };
            if (adapter === "gemini") input.config.apiFormat = "gemini";
            const created = await createImageTask(input);
            const run = adapter === "gemini" ? runGeminiImageTask(created, upstream.origin, "") : runCustomImageTask(created, upstream.origin, "", "", true);
            await expect(run).rejects.toThrow("适配器尚不支持画布约束");
            expect(upstream.requests).toHaveLength(0);
        } finally {
            await upstream.close();
        }
    });

    it.each(["multipart", "json"] as const)("sends exact original pixels in %s and persists actual wire evidence", async (encoding) => {
        const upstream = await fixture();
        const canvas: EcommerceCanvasConstraint = { mode: "exact", size: { width: 384, height: 216 }, source: "baseline", allowReframe: false };
        try {
            const created = await createImageTask(task(upstream.origin, encoding, canvas));
            const snapshot = JSON.stringify(created.ecommerceExecution);
            const result = await runOpenAiImageTask(created, upstream.origin, "", "", true);
            expect(upstream.requests).toHaveLength(1);
            expect(upstream.requests[0]).toMatchObject({ path: "/v1/images/edits", size: "384x216" });
            expect(upstream.requests[0].contentType.startsWith("multipart/")).toBe(encoding === "multipart");
            const restored = (await getImageTask(created.id))!;
            expect(restored).toMatchObject({ ecommerceCanvasRequest: { size: "384x216" } });
            expect(JSON.stringify(restored.ecommerceExecution)).toBe(snapshot);
            const {
                results: [stored],
            } = await prepareImageTaskResults(restored, result, upstream.origin, "");
            expect(stored.canvasEvidence).toMatchObject({ constraint: canvas, providerRequest: { size: "384x216" }, requestedSize: { width: 384, height: 216 }, nativeSize: canvas.size, storedSize: canvas.size });
            expect(await sharp(await readFile(localAssetUrlToPath(stored.serverUrl!))).metadata()).toMatchObject(canvas.size);
            expect(evaluateEcommerceCanvas(canvas, stored.canvasEvidence!.nativeSize, stored.canvasEvidence!.storedSize).hardFailures).toEqual([]);
            await updateImageTask(created.id, { result: stored });
            expect((await getImageTask(created.id))?.result?.canvasEvidence).toEqual(stored.canvasEvidence);
        } finally {
            await upstream.close();
        }
    });

    it.each(["multipart", "json"] as const)("sends mathematically equivalent baseline ratio in %s", async (encoding) => {
        const upstream = await fixture();
        const canvas: EcommerceCanvasConstraint = { mode: "ratio", size: { width: 3840, height: 2160 }, source: "baseline", allowReframe: true };
        try {
            const created = await createImageTask(task(upstream.origin, encoding, canvas));
            const result = await runOpenAiImageTask(created, upstream.origin, "", "", true);
            const size = upstream.requests[0].size!;
            const [width, height] = size.split("x").map(Number);
            expect(BigInt(width) * BigInt(2160)).toBe(BigInt(height) * BigInt(3840));
            expect(upstream.requests).toHaveLength(1);
            const restored = (await getImageTask(created.id))!;
            expect(restored).toMatchObject({ ecommerceCanvasRequest: { size } });
            const {
                results: [stored],
            } = await prepareImageTaskResults(restored, result, upstream.origin, "");
            expect(stored.canvasEvidence).toMatchObject({ constraint: canvas, providerRequest: { size }, requestedSize: { width, height }, nativeSize: { width, height }, storedSize: { width, height } });
            expect(evaluateEcommerceCanvas(canvas, stored.canvasEvidence!.nativeSize, stored.canvasEvidence!.storedSize)).toEqual({ nativeMatches: true, storedMatches: true, hardFailures: [] });
        } finally {
            await upstream.close();
        }
    });

    it.each(["multipart", "json"] as const)("surfaces an upstream 422 without resubmitting %s", async (encoding) => {
        const upstream = await fixture(422);
        const canvas: EcommerceCanvasConstraint = { mode: "exact", size: { width: 384, height: 216 }, source: "user_text", allowReframe: false };
        try {
            const created = await createImageTask(task(upstream.origin, encoding, canvas));
            await expect(runOpenAiImageTask(created, upstream.origin, "", "", true)).rejects.toThrow("unsupported size");
            expect(upstream.requests).toHaveLength(1);
            expect(upstream.requests[0].size).toBe("384x216");
            expect(await getImageTask(created.id)).toMatchObject({ ecommerceCanvasRequest: { size: "384x216" } });
        } finally {
            await upstream.close();
        }
    });

    it.each([
        { encoding: "multipart" as const, width: 1, height: 65536, sent: "4x262144" },
        { encoding: "multipart" as const, width: 65536, height: 1, sent: "262144x4" },
        { encoding: "json" as const, width: 1, height: 65536, sent: "4x262144" },
        { encoding: "json" as const, width: 65536, height: 1, sent: "262144x4" },
    ])("submits legal $width:$height through $encoding and surfaces the actual provider rejection", async ({ encoding, width, height, sent }) => {
        const upstream = await fixture(422, "fixture rejected extreme dimensions");
        const canvas: EcommerceCanvasConstraint = { mode: "ratio", size: { width, height }, source: "user_text", allowReframe: false };
        try {
            const input = task(upstream.origin, encoding, canvas);
            input.config.quality = "low";
            const created = await createImageTask(input);
            await expect(runOpenAiImageTask(created, upstream.origin, "", "", true)).rejects.toThrow("fixture rejected extreme dimensions");
            expect(upstream.requests).toHaveLength(1);
            expect(upstream.requests[0]).toMatchObject({ path: "/v1/images/edits", size: sent });
            expect(await getImageTask(created.id)).toMatchObject({ ecommerceCanvasRequest: { size: sent } });
        } finally {
            await upstream.close();
        }
    });

    it.each([400, 500])("does not try compatibility bodies after HTTP %s for a canvas task", async (status) => {
        const upstream = await fixture(status, "unsupported response_format; images missing");
        try {
            const canvas: EcommerceCanvasConstraint = { mode: "exact", size: { width: 384, height: 216 }, source: "baseline", allowReframe: false };
            const input = task(upstream.origin, "multipart", canvas);
            input.config.advancedConfig!.protocol = "auto";
            const created = await createImageTask(input);
            await expect(runOpenAiImageTask(created, upstream.origin, "", "", true)).rejects.toThrow("unsupported response_format");
            expect(upstream.requests).toHaveLength(1);
        } finally {
            await upstream.close();
        }
    });

    it.each([
        { size: "384x216", sent: "1088x608" },
        { size: "16:9", sent: "1824x1024" },
        { size: "auto", sent: undefined },
    ])("preserves ordinary $size mapping", async ({ size, sent }) => {
        const upstream = await fixture();
        try {
            const created = await createImageTask(task(upstream.origin, "multipart", undefined, size));
            await runOpenAiImageTask(created, upstream.origin, "", "", true);
            expect(upstream.requests).toHaveLength(1);
            expect(upstream.requests[0].size).toBe(sent);
            expect(await getImageTask(created.id)).not.toHaveProperty("ecommerceCanvasRequest");
        } finally {
            await upstream.close();
        }
    });
});
