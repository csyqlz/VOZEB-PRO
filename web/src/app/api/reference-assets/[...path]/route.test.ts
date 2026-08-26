import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    verify: vi.fn(),
    expired: vi.fn(),
    registration: vi.fn(),
    read: vi.fn(),
    isValidPath: vi.fn(),
    stream: vi.fn(),
    disposition: vi.fn(),
    rate: vi.fn(),
    externalRead: vi.fn(),
    acquire: vi.fn(),
    wrap: vi.fn(),
    head: vi.fn(),
    release: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/server/reference-asset-access", () => ({ verifyReferenceAssetSignature: mocks.verify }));
vi.mock("@/lib/server/local-media-registry", () => ({ getLocalMediaRegistration: mocks.registration, isLocalMediaRegistrationExpired: mocks.expired }));
vi.mock("@/lib/server/reference-asset-store", () => ({ isReferenceAssetPath: mocks.isValidPath, readReferenceAsset: mocks.read }));
vi.mock("@/lib/server/local-media-response", () => ({
    createLocalMediaResponse: mocks.stream,
    createMediaHeadResponse: mocks.head,
    mediaContentDisposition: mocks.disposition,
}));
vi.mock("@/lib/server/media-concurrency", () => ({ acquireMediaConcurrency: mocks.acquire, withMediaConcurrency: mocks.wrap }));
vi.mock("@/lib/server/security", () => ({ checkLocalMediaRateLimit: mocks.rate, rateLimitHeaders: vi.fn(() => ({ "Retry-After": "60" })) }));
vi.mock("@/lib/server/object-storage-service", () => ({ createExternalMediaReadUrl: mocks.externalRead }));

import { GET, HEAD } from "./route";

const context = { params: Promise.resolve({ path: ["permanent", "2026", "07", "20", "images", "file.png"] }) };

describe("reference asset access", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.verify.mockReturnValue(false);
        mocks.isValidPath.mockReturnValue(true);
        mocks.read.mockResolvedValue({ filePath: "asset.png", size: 5, mimeType: "image/png", registration: { ownerUserId: "owner" } });
        mocks.stream.mockResolvedValue(new Response("image"));
        mocks.registration.mockResolvedValue({ ownerUserId: "owner", mimeType: "image/png" });
        mocks.expired.mockReturnValue(false);
        mocks.disposition.mockReturnValue('inline; filename="file.png"');
        mocks.rate.mockResolvedValue({ allowed: true, remaining: 239, resetAt: Date.now() + 60_000 });
        mocks.externalRead.mockResolvedValue("https://storage.example/signed");
        mocks.acquire.mockReturnValue({ release: mocks.release });
        mocks.wrap.mockImplementation((response: Response) => response);
        mocks.head.mockReturnValue(new Response(null, { status: 200, headers: { "Content-Type": "image/png", "Content-Length": "5" } }));
    });

    it("does not expose another user's media to an authenticated user", async () => {
        mocks.getCurrentUser.mockResolvedValue({ id: "other", role: "user" });
        const response = await GET(new Request("http://localhost/api/reference-assets/permanent/2026/07/20/images/file.png"), context);
        expect(response.status).toBe(404);
        expect(mocks.read).not.toHaveBeenCalled();
    });

    it("rejects malformed paths without querying authentication or media registrations", async () => {
        mocks.isValidPath.mockReturnValue(false);
        const response = await GET(new Request("http://localhost/api/reference-assets/not-valid"), { params: Promise.resolve({ path: ["not-valid"] }) });
        expect(response.status).toBe(404);
        expect(mocks.getCurrentUser).not.toHaveBeenCalled();
        expect(mocks.rate).not.toHaveBeenCalled();
        expect(mocks.registration).not.toHaveBeenCalled();
    });

    it("rejects anonymous unsigned access before querying media registrations", async () => {
        mocks.getCurrentUser.mockResolvedValue(null);
        const response = await GET(new Request("http://localhost/api/reference-assets/permanent/2026/07/20/images/file.png"), context);
        expect(response.status).toBe(401);
        expect(mocks.rate).not.toHaveBeenCalled();
        expect(mocks.registration).not.toHaveBeenCalled();
    });

    it("allows the owner and administrators to read registered media", async () => {
        mocks.getCurrentUser.mockResolvedValue({ id: "owner", role: "user" });
        const request = new Request("http://localhost/api/reference-assets/permanent/2026/07/20/images/file.png", { headers: { "x-vozeb-pro-worker-user-id": "owner" } });
        expect((await GET(request, context)).status).toBe(200);
        expect(mocks.getCurrentUser).toHaveBeenCalledWith(request);
        expect(mocks.disposition).toHaveBeenCalledWith("inline", "file.png", "image/png", "");
        mocks.getCurrentUser.mockResolvedValue({ id: "admin", role: "admin" });
        expect((await GET(new Request("http://localhost/api/reference-assets/permanent/2026/07/20/images/file.png"), context)).status).toBe(200);
    });

    it("allows a valid short-lived signature without a login", async () => {
        mocks.verify.mockReturnValue(true);
        mocks.getCurrentUser.mockResolvedValue(null);
        const response = await GET(new Request("http://localhost/api/reference-assets/permanent/2026/07/20/images/file.png?purpose=provider-read&expires=1&signature=test"), context);
        expect(response.status).toBe(200);
        expect(mocks.getCurrentUser).not.toHaveBeenCalled();
        expect(mocks.registration).toHaveBeenCalledWith("permanent/2026/07/20/images/file.png");
        expect(mocks.rate.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.registration.mock.invocationCallOrder[0]);
    });

    it("does not allow an upstream signature to become an anonymous original download", async () => {
        mocks.verify.mockReturnValue(true);
        const response = await GET(new Request("http://localhost/api/reference-assets/permanent/2026/07/20/images/file.png?purpose=provider-read&expires=1&signature=test&download=original"), context);
        expect(response.status).toBe(403);
        expect(mocks.registration).toHaveBeenCalled();
    });

    it("does not expose an unregistered file through a signed url", async () => {
        mocks.verify.mockReturnValue(true);
        mocks.registration.mockResolvedValue(null);
        const response = await GET(new Request("http://localhost/api/reference-assets/permanent/2026/07/20/images/file.png?expires=1&signature=test"), context);
        expect(response.status).toBe(404);
        expect(mocks.stream).not.toHaveBeenCalled();
    });

    it("rejects an expired temporary asset before a signed read", async () => {
        mocks.verify.mockReturnValue(true);
        mocks.expired.mockReturnValue(true);
        mocks.registration.mockResolvedValue({ ownerUserId: "owner", storageClass: "temporary", expiresAt: new Date(Date.now() - 1).toISOString() });
        const response = await GET(new Request("http://localhost/api/reference-assets/permanent/2026/07/20/images/file.png?purpose=provider-read&expires=1&signature=test"), context);
        expect(response.status).toBe(404);
        expect(mocks.rate).not.toHaveBeenCalled();
    });

    it("redirects an authorized object-backed asset to a signed url", async () => {
        mocks.getCurrentUser.mockResolvedValue({ id: "owner", role: "user" });
        mocks.registration.mockResolvedValue({ ownerUserId: "owner", storageProvider: "object", externalObjectKey: "bucket/file.png" });
        const response = await GET(new Request("http://localhost/api/reference-assets/permanent/2026/07/20/images/file.png"), context);
        expect(response.status).toBe(307);
        expect(response.headers.get("location")).toBe("https://storage.example/signed");
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
        expect(response.headers.get("cross-origin-resource-policy")).toBe("same-site");
        expect(mocks.read).not.toHaveBeenCalled();
    });

    it("answers object-backed HEAD from registration metadata without creating a GET signature", async () => {
        mocks.getCurrentUser.mockResolvedValue({ id: "owner", role: "user" });
        mocks.registration.mockResolvedValue({ ownerUserId: "owner", storageProvider: "object", mimeType: "image/png", bytes: 5, originalName: "file.png" });
        const response = await HEAD(new Request("http://localhost/api/reference-assets/permanent/2026/07/20/images/file.png", { method: "HEAD" }), context);
        expect(response.status).toBe(200);
        expect(mocks.head).toHaveBeenCalled();
        expect(mocks.externalRead).not.toHaveBeenCalled();
        expect(mocks.acquire).not.toHaveBeenCalled();
    });

    it("marks authenticated original HEAD downloads as attachments", async () => {
        mocks.getCurrentUser.mockResolvedValue({ id: "owner", role: "user" });
        mocks.registration.mockResolvedValue({ ownerUserId: "owner", storageProvider: "object", mimeType: "video/quicktime", bytes: 5, originalName: "generated-video" });
        await HEAD(new Request("http://localhost/api/reference-assets/permanent/2026/07/20/images/file.png?download=original", { method: "HEAD" }), context);
        expect(mocks.disposition).toHaveBeenCalledWith("attachment", "generated-video", "video/quicktime", "permanent/2026/07/20/images/file.png");
    });

    it("rejects excess concurrent reads before opening local media", async () => {
        mocks.getCurrentUser.mockResolvedValue({ id: "owner", role: "user" });
        mocks.acquire.mockReturnValue(null);
        const response = await GET(new Request("http://localhost/api/reference-assets/permanent/2026/07/20/images/file.png"), context);
        expect(response.status).toBe(429);
        expect(mocks.read).not.toHaveBeenCalled();
    });

    it("blocks repeated local media access before reading the file", async () => {
        mocks.getCurrentUser.mockResolvedValue({ id: "owner", role: "user" });
        mocks.rate.mockResolvedValue({ allowed: false, remaining: 0, resetAt: Date.now() + 60_000 });
        const response = await GET(new Request("http://localhost/api/reference-assets/permanent/2026/07/20/images/file.png"), context);
        expect(response.status).toBe(429);
        expect(mocks.read).not.toHaveBeenCalled();
        expect(mocks.stream).not.toHaveBeenCalled();
    });
});
