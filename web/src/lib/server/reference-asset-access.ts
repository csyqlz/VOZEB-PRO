import { createHmac, timingSafeEqual } from "node:crypto";

import { REFERENCE_ASSET_SIGNATURE_PURPOSE } from "@/lib/reference-asset-url";

const SIGNED_URL_TTL_MS = 15 * 60 * 1000;
const SIGNED_URL_TTL_SECONDS = SIGNED_URL_TTL_MS / 1000;
const GENERATION_ASSET_SIGNATURE_SCOPE = "generation";

export function createSignedReferenceAssetUrl(token: string, origin: string, ownerUserId: string, now = Date.now()) {
    return createSignedAssetUrl("reference-assets", token, token, ownerUserId, origin, now);
}

export function createSignedGenerationAssetUrl(token: string, origin: string, ownerUserId: string, now = Date.now()) {
    return createSignedAssetUrl("generation-log-assets", token, scopedGenerationToken(token), ownerUserId, origin, now);
}

export function signReferenceAssetInputUrl(value: string, origin: string, ownerUserId: string, now = Date.now()) {
    return signAssetInputUrl(value, "/api/reference-assets/", origin, ownerUserId, (token) => createSignedReferenceAssetUrl(token, origin, ownerUserId, now));
}

export function signGenerationAssetInputUrl(value: string, origin: string, ownerUserId: string, now = Date.now()) {
    return signAssetInputUrl(value, "/api/generation-log-assets/", origin, ownerUserId, (token) => createSignedGenerationAssetUrl(token, origin, ownerUserId, now));
}

function signAssetInputUrl(value: string, prefix: string, origin: string, ownerUserId: string, createSignedUrl: (token: string) => string) {
    const raw = value.trim();
    if (!raw) return "";
    let url: URL;
    try {
        url = new URL(raw, normalizeOrigin(origin));
    } catch {
        return raw;
    }
    if (!url.pathname.startsWith(prefix)) return raw;
    const token = url.pathname
        .slice(prefix.length)
        .split("/")
        .map((part) => decodeURIComponent(part))
        .join("/");
    return ownerUserId.trim() ? createSignedUrl(token) || raw : raw;
}

export function verifyReferenceAssetSignature(token: string, purpose: string | null, expiresValue: string | null, signature: string | null, ownerUserId: string, now = Date.now()) {
    return verifyAssetSignature(token, purpose, expiresValue, signature, ownerUserId, now);
}

export function verifyGenerationAssetSignature(token: string, purpose: string | null, expiresValue: string | null, signature: string | null, ownerUserId: string, now = Date.now()) {
    return verifyAssetSignature(scopedGenerationToken(token), purpose, expiresValue, signature, ownerUserId, now);
}

function createSignedAssetUrl(route: "reference-assets" | "generation-log-assets", token: string, signedToken: string, ownerUserId: string, origin: string, now: number) {
    const secret = signingSecret();
    const normalizedOrigin = normalizeOrigin(origin);
    const owner = ownerUserId.trim();
    if (!secret || !normalizedOrigin || !token || !owner) return "";
    const expires = Math.floor((now + SIGNED_URL_TTL_MS) / 1000);
    const signature = sign(signedToken, REFERENCE_ASSET_SIGNATURE_PURPOSE, expires, owner, secret);
    const path = token.split("/").map(encodeURIComponent).join("/");
    return `${normalizedOrigin}/api/${route}/${path}?purpose=${REFERENCE_ASSET_SIGNATURE_PURPOSE}&expires=${expires}&signature=${signature}`;
}

function verifyAssetSignature(token: string, purpose: string | null, expiresValue: string | null, signature: string | null, ownerUserId: string, now: number) {
    const secret = signingSecret();
    const owner = ownerUserId.trim();
    const expires = Number(expiresValue);
    const nowSeconds = Math.floor(now / 1000);
    if (!secret || !token || !owner || purpose !== REFERENCE_ASSET_SIGNATURE_PURPOSE || !signature || !Number.isInteger(expires) || expires <= nowSeconds || expires > nowSeconds + SIGNED_URL_TTL_SECONDS + 1) return false;
    const expected = Buffer.from(sign(token, purpose, expires, owner, secret));
    const actual = Buffer.from(signature);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function scopedGenerationToken(token: string) {
    return `${GENERATION_ASSET_SIGNATURE_SCOPE}\0${token}`;
}

function sign(token: string, purpose: string, expires: number, ownerUserId: string, secret: string) {
    return createHmac("sha256", secret).update(`v1\0${purpose}\0${expires}\0${ownerUserId}\0${token}`).digest("base64url");
}

function signingSecret() {
    return process.env.VOZEB_PRO_REFERENCE_ASSET_SIGNING_KEY?.trim() || process.env.VOZEB_PRO_ENCRYPTION_KEY?.trim() || "";
}

function normalizeOrigin(value: string) {
    try {
        const url = new URL(value.trim());
        return url.protocol === "http:" || url.protocol === "https:" ? url.origin : "";
    } catch {
        return "";
    }
}
