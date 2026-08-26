import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    getDataDir: vi.fn(),
    canAccess: vi.fn(),
    registration: vi.fn(),
    stream: vi.fn(),
    disposition: vi.fn(),
    rate: vi.fn(),
    externalRead: vi.fn(),
    acquire: vi.fn(),
    wrap: vi.fn(),
    head: vi.fn(),
    release: vi.fn(),
    verify: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/server/data-dir", () => ({ getServerDataDir: mocks.getDataDir }));
vi.mock("@/lib/server/generation-log-store", () => ({ canAccessGenerationAsset: mocks.canAccess }));
vi.mock("@/lib/server/local-media-registry", () => ({ getLocalMediaRegistration: mocks.registration }));
vi.mock("@/lib/server/local-media-response", () => ({
    createLocalMediaResponse: mocks.stream,
    createMediaHeadResponse: mocks.head,
    mediaContentDisposition: mocks.disposition,
}));
vi.mock("@/lib/server/media-concurrency", () => ({ acquireMediaConcurrency: mocks.acquire, withMediaConcurrency: mocks.wrap }));
vi.mock("@/lib/server/security", () => ({ checkLocalMediaRateLimit: mocks.rate, rateLimitHeaders: vi.fn(() => ({ "Retry-After": "60" })) }));
vi.mock("@/lib/server/object-storage-service", () => ({ createExternalMediaReadUrl: mocks.externalRead }));
vi.mock("@/lib/server/reference-asset-access", () => ({ verifyGenerationAssetSignature: mocks.verify }));

import { GET, HEAD } from "./route";

const context = { params: Promise.resolve({ path: ["permanent", "2026", "07", "20", "images", "file.png"] }) };

describe("generation log asset access", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: "owner", role: "user" });
        mocks.verify.mockReturnValue(false);
        mocks.getDataDir.mockReturnValue("C:/vozeb-data");
        mocks.canAccess.mockResolvedValue(true);
        mocks.registration.mockResolvedValue({ originalName: "uploaded-file.png", mimeType: "image/png" });
        mocks.rate.mockResolvedValue({ allowed: true, remaining: 239, resetAt: Date.now() + 60_000 });
        mocks.stream.mockResolvedValue(new Response("image"));
        mocks.disposition.mockReturnValue('inline; filename="uploaded-file.png"');
        mocks.externalRead.mockResolvedValue("https://storage.example/signed");
        mocks.acquire.mockReturnValue({ release: mocks.release });
        mocks.wrap.mockImplementation((response: Response) => response);
        mocks.head.mockReturnValue(new Response(null, { status: 200, headers: { "Content-Type": "image/png", "Content-Length": "5" } }));
    });

    it("redirects an allowed object-backed asset", async () => {
        mocks.registration.mockResolvedValue({ originalName: "uploaded-file.png", storageProvider: "object", externalObjectKey: "bucket/file.png" });
        const response = await GET(new Request("http://localhost/api/generation-log-assets/permanent/2026/07/20/images/file.png"), context);
        expect(response.status).toBe(307);
        expect(response.headers.get("location")).toBe("https://storage.example/signed");
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
        expect(response.headers.get("cross-origin-resource-policy")).toBe("same-site");
        expect(mocks.stream).not.toHaveBeenCalled();
    });

    it("answers object-backed HEAD without signing a GET redirect", async () => {
        mocks.registration.mockResolvedValue({ originalName: "uploaded-file.png", mimeType: "image/png", bytes: 5, storageProvider: "object", externalObjectKey: "bucket/file.png" });
        const response = await HEAD(new Request("http://localhost/api/generation-log-assets/permanent/2026/07/20/images/file.png", { method: "HEAD" }), context);
        expect(response.status).toBe(200);
        expect(mocks.head).toHaveBeenCalled();
        expect(mocks.externalRead).not.toHaveBeenCalled();
    });

    it("rejects excess concurrent reads before opening the file", async () => {
        mocks.acquire.mockReturnValue(null);
        const response = await GET(new Request("http://localhost/api/generation-log-assets/permanent/2026/07/20/images/file.png"), context);
        expect(response.status).toBe(429);
        expect(mocks.stream).not.toHaveBeenCalled();
    });

    it("hides assets from another user", async () => {
        mocks.canAccess.mockResolvedValue(false);
        const response = await GET(new Request("http://localhost/api/generation-log-assets/permanent/2026/07/20/images/file.png"), context);
        expect(response.status).toBe(404);
        expect(mocks.stream).not.toHaveBeenCalled();
    });

    it("limits authenticated asset reads before opening the file", async () => {
        mocks.rate.mockResolvedValue({ allowed: false, remaining: 0, resetAt: Date.now() + 60_000 });
        const response = await GET(new Request("http://localhost/api/generation-log-assets/permanent/2026/07/20/images/file.png"), context);
        expect(response.status).toBe(429);
        expect(mocks.canAccess).not.toHaveBeenCalled();
        expect(mocks.stream).not.toHaveBeenCalled();
    });

    it("checks ownership and streams an allowed asset", async () => {
        const request = new Request("http://localhost/api/generation-log-assets/permanent/2026/07/20/images/file.png", { headers: { "x-vozeb-pro-worker-user-id": "owner" } });
        const response = await GET(request, context);
        expect(response.status).toBe(200);
        expect(mocks.getCurrentUser).toHaveBeenCalledWith(request);
        expect(mocks.canAccess).toHaveBeenCalledWith("owner", "user", "/api/generation-log-assets/permanent/2026/07/20/images/file.png");
        expect(mocks.disposition).toHaveBeenCalledWith("inline", "uploaded-file.png", "image/png", "");
        expect(mocks.stream).toHaveBeenCalled();
    });

    it("allows a provider signature without login or a second media copy", async () => {
        mocks.verify.mockReturnValue(true);
        mocks.getCurrentUser.mockResolvedValue(null);
        const response = await GET(new Request("http://localhost/api/generation-log-assets/permanent/2026/07/20/images/file.png?purpose=provider-read&expires=1&signature=test"), context);

        expect(response.status).toBe(200);
        expect(mocks.getCurrentUser).not.toHaveBeenCalled();
        expect(mocks.canAccess).not.toHaveBeenCalled();
        expect(mocks.rate).toHaveBeenCalledWith("signature:test", expect.any(Request));
    });

    it("does not let a provider signature download the original", async () => {
        mocks.verify.mockReturnValue(true);
        const response = await GET(new Request("http://localhost/api/generation-log-assets/permanent/2026/07/20/images/file.png?purpose=provider-read&expires=1&signature=test&download=original"), context);

        expect(response.status).toBe(403);
        expect(mocks.registration).toHaveBeenCalled();
    });

    it("marks object-backed original HEAD downloads as attachments", async () => {
        mocks.registration.mockResolvedValue({ originalName: "generated-video", mimeType: "video/webm", bytes: 5, storageProvider: "object", externalObjectKey: "bucket/file.webm" });
        await HEAD(new Request("http://localhost/api/generation-log-assets/permanent/2026/07/20/images/file.png?download=original", { method: "HEAD" }), context);
        expect(mocks.disposition).toHaveBeenCalledWith("attachment", "generated-video", "video/webm", "permanent/2026/07/20/images/file.png");
    });
});
