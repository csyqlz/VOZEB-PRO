import { normalizeImagePreviewWidth } from "@/lib/media-image-variant";
import { mediaFileExtension } from "@/lib/media-file";

const PRIVATE_MEDIA_ROUTES = ["/api/reference-assets/", "/api/generation-log-assets/"];
const IMAGE_PREVIEW_ROUTES = [...PRIVATE_MEDIA_ROUTES, "/api/public/works/", "/api/public/prompt-images", "/api/admin/object-storage/files/preview"];

export function imagePreviewUrl(url: string, width = 1600) {
    return withLocalMediaParams(url, IMAGE_PREVIEW_ROUTES, (params) => {
        params.delete("download");
        params.set("format", "webp");
        params.set("width", String(normalizeImagePreviewWidth(width)));
    });
}

export function originalImageSourceUrl(url: string) {
    return withLocalMediaParams(url, IMAGE_PREVIEW_ROUTES, (params) => {
        params.delete("format");
        params.delete("width");
        params.delete("download");
    });
}

export function originalImageDownloadUrl(url: string) {
    return originalMediaDownloadUrl(url);
}

export function originalMediaDownloadUrl(url: string) {
    return withLocalMediaParams(url, PRIVATE_MEDIA_ROUTES, (params) => {
        params.delete("format");
        params.delete("width");
        params.set("download", "original");
    });
}

export function originalImageExtension(url: string, mimeType?: string) {
    return mediaFileExtension(mimeType, url, "png");
}

function withLocalMediaParams(value: string, routes: string[], update: (params: URLSearchParams) => void) {
    const url = value.trim();
    if (!url) return url;
    try {
        const absolute = /^[a-z][a-z\d+.-]*:/i.test(url);
        const parsed = new URL(url, "http://vozeb.local");
        if (!routes.some((route) => parsed.pathname.startsWith(route))) return url;
        update(parsed.searchParams);
        parsed.searchParams.sort();
        parsed.hash = "";
        return absolute ? parsed.toString() : `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
        return url;
    }
}
