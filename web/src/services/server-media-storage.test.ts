import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getServerMediaBlob, parseServerMediaUrl, uploadServerMedia } from "./server-media-storage";

describe("server media storage", () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
        fetchMock.mockReset();
        vi.stubGlobal("fetch", fetchMock);
        vi.stubGlobal(
            "FileReader",
            class {
                result: string | null = null;
                onload: (() => void) | null = null;
                onerror: (() => void) | null = null;

                readAsDataURL(blob: Blob) {
                    this.result = `data:${blob.type};base64,eA==`;
                    this.onload?.();
                }
            },
        );
    });

    afterEach(() => vi.unstubAllGlobals());

    it.each([
        ["reference", "/api/reference-assets/permanent/2026/07/27/images/a%20b.png?format=webp&width=256"],
        ["generation", "/api/generation-log-assets/permanent/2026/07/27/images/a%20b.png"],
    ])("reuses an existing %s image without uploading it again", async (_scope, url) => {
        fetchMock.mockResolvedValueOnce(new Response(null, { headers: { "Content-Type": "image/png", "Content-Length": "1234" } }));

        await expect(uploadServerMedia(url, "image")).resolves.toEqual({
            url: url.split("?", 1)[0],
            storageKey: "permanent/2026/07/27/images/a b.png",
            bytes: 1234,
            mimeType: "image/png",
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith(url.split("?", 1)[0], { method: "HEAD", cache: "no-store" });
        expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    });

    it("keeps the generation scope while parsing a platform media url", () => {
        expect(parseServerMediaUrl("/api/generation-log-assets/permanent/2026/07/27/videos/result.mp4?download=original")).toEqual({
            url: "/api/generation-log-assets/permanent/2026/07/27/videos/result.mp4",
            storageKey: "permanent/2026/07/27/videos/result.mp4",
            scope: "generation",
        });
    });

    it("falls back to the generation route for a legacy storage key without scope", async () => {
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 })).mockResolvedValueOnce(new Response("video", { headers: { "Content-Type": "video/mp4" } }));

        await expect(getServerMediaBlob("permanent/2026/07/27/videos/result.mp4")).resolves.toMatchObject({ type: "video/mp4", size: 5 });
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/reference-assets/permanent/2026/07/27/videos/result.mp4", "/api/generation-log-assets/permanent/2026/07/27/videos/result.mp4"]);
    });

    it("still uploads a new blob", async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ token: "permanent/2026/07/27/images/new.png", key: "permanent/2026/07/27/images/new.png", url: "/api/reference-assets/permanent/2026/07/27/images/new.png", bytes: 1, mimeType: "image/png" }), {
                headers: { "Content-Type": "application/json" },
            }),
        );

        await expect(uploadServerMedia(new Blob(["x"], { type: "image/png" }), "image")).resolves.toMatchObject({ storageKey: "permanent/2026/07/27/images/new.png", mimeType: "image/png" });
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/reference-assets");
        expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
        expect(fetchMock.mock.calls[0]?.[1]?.headers).toBeUndefined();
        const form = fetchMock.mock.calls[0]?.[1]?.body as FormData;
        expect(form).toBeInstanceOf(FormData);
        expect(form.get("type")).toBe("image");
        expect(form.get("persistent")).toBe("true");
        expect(form.get("file")).toBeInstanceOf(File);
    });

    it("continues to copy an external url into managed storage", async () => {
        fetchMock.mockResolvedValueOnce(new Response("x", { headers: { "Content-Type": "image/png" } })).mockResolvedValueOnce(
            new Response(JSON.stringify({ token: "permanent/2026/07/27/images/external.png", url: "/api/reference-assets/permanent/2026/07/27/images/external.png", mimeType: "image/png" }), {
                headers: { "Content-Type": "application/json" },
            }),
        );

        await uploadServerMedia("https://cdn.example/image.png", "image");
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[0]?.[0]).toBe("https://cdn.example/image.png");
        expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/reference-assets");
        expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("POST");
    });

    it("forwards unknown binary media to the server for byte-level validation", async () => {
        fetchMock.mockResolvedValueOnce(new Response("webp", { headers: { "Content-Type": "application/octet-stream" } })).mockResolvedValueOnce(
            new Response(JSON.stringify({ token: "permanent/2026/08/20/images/external.webp", url: "/api/reference-assets/permanent/2026/08/20/images/external.webp", mimeType: "image/webp" }), {
                headers: { "Content-Type": "application/json" },
            }),
        );

        await expect(uploadServerMedia("https://cdn.example/reference.webp", "image")).resolves.toMatchObject({ storageKey: "permanent/2026/08/20/images/external.webp", mimeType: "image/webp" });
        const form = fetchMock.mock.calls[1]?.[1]?.body as FormData;
        expect((form.get("file") as File).type).toBe("application/octet-stream");
    });
});
