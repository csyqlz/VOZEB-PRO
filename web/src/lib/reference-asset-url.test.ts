import { describe, expect, it } from "vitest";

import { hasProviderReadSignatureShape, isProviderMediaAssetUrl, isReferenceAssetUrl } from "./reference-asset-url";

describe("reference asset url", () => {
    it("recognizes relative and absolute protected reference routes", () => {
        expect(isReferenceAssetUrl("/api/reference-assets/permanent/file.png")).toBe(true);
        expect(isReferenceAssetUrl("https://vozeb.example/api/reference-assets/permanent/file.png")).toBe(true);
        expect(isReferenceAssetUrl("https://cdn.example/file.png")).toBe(false);
        expect(isProviderMediaAssetUrl("/api/generation-log-assets/permanent/file.png")).toBe(true);
    });

    it("requires the provider purpose, expiration and signature shape", () => {
        expect(hasProviderReadSignatureShape("https://vozeb.example/api/reference-assets/file.png?purpose=provider-read&expires=1&signature=test")).toBe(true);
        expect(hasProviderReadSignatureShape("https://vozeb.example/api/generation-log-assets/file.png?purpose=provider-read&expires=1&signature=test")).toBe(true);
        expect(hasProviderReadSignatureShape("https://vozeb.example/api/reference-assets/file.png?expires=1&signature=test")).toBe(false);
        expect(hasProviderReadSignatureShape("https://vozeb.example/api/reference-assets/file.png?purpose=download&expires=1&signature=test")).toBe(false);
        expect(hasProviderReadSignatureShape("https://vozeb.example/api/reference-assets/file.png?purpose=provider-read&expires=never&signature=test")).toBe(false);
    });
});
