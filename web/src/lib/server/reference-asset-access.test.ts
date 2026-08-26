import { afterEach, describe, expect, it } from "vitest";

import { createSignedGenerationAssetUrl, createSignedReferenceAssetUrl, signGenerationAssetInputUrl, signReferenceAssetInputUrl, verifyGenerationAssetSignature, verifyReferenceAssetSignature } from "./reference-asset-access";

const previousKey = process.env.VOZEB_PRO_REFERENCE_ASSET_SIGNING_KEY;

afterEach(() => {
    if (previousKey === undefined) delete process.env.VOZEB_PRO_REFERENCE_ASSET_SIGNING_KEY;
    else process.env.VOZEB_PRO_REFERENCE_ASSET_SIGNING_KEY = previousKey;
});

describe("reference asset access", () => {
    it("creates and verifies a bounded signed server URL", () => {
        process.env.VOZEB_PRO_REFERENCE_ASSET_SIGNING_KEY = "test-signing-key";
        const now = Date.UTC(2026, 6, 19);
        const url = new URL(createSignedReferenceAssetUrl("temporary/2026/07/19/images/file.png", "https://vozeb.example", "user-one", now));
        const purpose = url.searchParams.get("purpose");

        expect(url.origin).toBe("https://vozeb.example");
        expect(purpose).toBe("provider-read");
        expect(verifyReferenceAssetSignature("temporary/2026/07/19/images/file.png", purpose, url.searchParams.get("expires"), url.searchParams.get("signature"), "user-one", now)).toBe(true);
        expect(verifyReferenceAssetSignature("temporary/2026/07/19/images/file.png", "download", url.searchParams.get("expires"), url.searchParams.get("signature"), "user-one", now)).toBe(false);
        expect(verifyReferenceAssetSignature("temporary/2026/07/19/images/other.png", purpose, url.searchParams.get("expires"), url.searchParams.get("signature"), "user-one", now)).toBe(false);
        expect(verifyReferenceAssetSignature("temporary/2026/07/19/images/file.png", purpose, url.searchParams.get("expires"), url.searchParams.get("signature"), "other-user", now)).toBe(false);
        expect(verifyReferenceAssetSignature("temporary/2026/07/19/images/file.png", purpose, url.searchParams.get("expires"), url.searchParams.get("signature"), "user-one", now + 14 * 60 * 1000)).toBe(true);
        expect(verifyReferenceAssetSignature("temporary/2026/07/19/images/file.png", purpose, url.searchParams.get("expires"), url.searchParams.get("signature"), "user-one", now + 16 * 60 * 1000)).toBe(false);
    });

    it("only signs local reference asset paths", () => {
        process.env.VOZEB_PRO_REFERENCE_ASSET_SIGNING_KEY = "test-signing-key";
        expect(signReferenceAssetInputUrl("https://cdn.example/image.png", "https://vozeb.example", "user-one")).toBe("https://cdn.example/image.png");
        expect(signReferenceAssetInputUrl("/api/reference-assets/permanent/2026/07/19/images/file.png", "https://vozeb.example", "user-one")).toContain("purpose=provider-read");
    });

    it("signs generation assets without allowing cross-scope signature reuse", () => {
        process.env.VOZEB_PRO_REFERENCE_ASSET_SIGNING_KEY = "test-signing-key";
        const now = Date.UTC(2026, 7, 20);
        const token = "permanent/2026/08/20/images/generated.png";
        const url = new URL(createSignedGenerationAssetUrl(token, "https://vozeb.example", "user-one", now));

        expect(url.pathname).toBe(`/api/generation-log-assets/${token}`);
        expect(verifyGenerationAssetSignature(token, url.searchParams.get("purpose"), url.searchParams.get("expires"), url.searchParams.get("signature"), "user-one", now)).toBe(true);
        expect(verifyReferenceAssetSignature(token, url.searchParams.get("purpose"), url.searchParams.get("expires"), url.searchParams.get("signature"), "user-one", now)).toBe(false);
        expect(signGenerationAssetInputUrl(`/api/generation-log-assets/${token}?format=webp&width=320`, "https://vozeb.example", "user-one", now)).toMatch(/^https:\/\/vozeb\.example\/api\/generation-log-assets\/.+purpose=provider-read/);
    });
});
