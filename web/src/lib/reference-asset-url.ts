export const REFERENCE_ASSET_SIGNATURE_PURPOSE = "provider-read";

export function isReferenceAssetUrl(value: string) {
    try {
        return new URL(value, "https://vozeb.invalid").pathname.startsWith("/api/reference-assets/");
    } catch {
        return false;
    }
}

export function isProviderMediaAssetUrl(value: string) {
    try {
        const pathname = new URL(value, "https://vozeb.invalid").pathname;
        return pathname.startsWith("/api/reference-assets/") || pathname.startsWith("/api/generation-log-assets/");
    } catch {
        return false;
    }
}

export function hasProviderReadSignatureShape(value: string) {
    try {
        const url = new URL(value, "https://vozeb.invalid");
        const expires = url.searchParams.get("expires") || "";
        return isProviderMediaAssetUrl(url.toString()) && url.searchParams.get("purpose") === REFERENCE_ASSET_SIGNATURE_PURPOSE && /^\d+$/.test(expires) && Number(expires) > 0 && Boolean(url.searchParams.get("signature"));
    } catch {
        return false;
    }
}
