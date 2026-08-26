import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { canvasImageLayerSlotId, type CanvasImageDecomposition } from "@/lib/canvas-image-decomposition";

const GRANT_VERSION = 1;
const PROCESS_SECRET_KEY = "__vozebProCanvasLayerGrantSecret" as const;

type CanvasImageLayerGrantPayload = {
    version: typeof GRANT_VERSION;
    userId: string;
    requestId: string;
    sourceDigest: string;
    slots: string[];
};

export type CanvasImageLayerBatchRequest = {
    grant: string;
    slotId: string;
};

export function createCanvasImageLayerGrant(input: { userId: string; requestId: string; source: string; decomposition: CanvasImageDecomposition }) {
    const payload: CanvasImageLayerGrantPayload = {
        version: GRANT_VERSION,
        userId: input.userId,
        requestId: input.requestId,
        sourceDigest: digest(input.source),
        slots: [...input.decomposition.layers.map((layer) => canvasImageLayerSlotId(layer.id)), "background"],
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${encoded}.${sign(encoded)}`;
}

export function verifyCanvasImageLayerGrant(input: { userId: string; source: string; batch: CanvasImageLayerBatchRequest | undefined; outputBackground?: string }) {
    const token = input.batch?.grant?.trim() || "";
    const slotId = input.batch?.slotId?.trim() || "";
    const separator = token.lastIndexOf(".");
    if (!token || !slotId || separator <= 0) return null;
    const encoded = token.slice(0, separator);
    const signature = token.slice(separator + 1);
    const expected = Buffer.from(sign(encoded));
    const received = Buffer.from(signature);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;

    let payload: CanvasImageLayerGrantPayload;
    try {
        payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as CanvasImageLayerGrantPayload;
    } catch {
        return null;
    }
    if (payload.version !== GRANT_VERSION || payload.userId !== input.userId || payload.sourceDigest !== digest(input.source) || !payload.slots.includes(slotId)) return null;
    if ((slotId === "background") === (input.outputBackground === "transparent")) return null;
    return {
        requestId: `canvas-layer:${digest([payload.userId, payload.requestId, payload.sourceDigest, slotId].join("\0"))}`,
        slotId,
    };
}

function digest(value: string) {
    return createHash("sha256").update(value.trim()).digest("hex");
}

function sign(value: string) {
    return createHmac("sha256", signingSecret()).update(`canvas-image-layer-grant-v1\0${value}`).digest("base64url");
}

function signingSecret() {
    const configured = process.env.VOZEB_PRO_ENCRYPTION_KEY?.trim();
    if (configured) return configured;
    const scope = globalThis as typeof globalThis & { __vozebProCanvasLayerGrantSecret?: Buffer };
    scope[PROCESS_SECRET_KEY] ||= randomBytes(32);
    return scope[PROCESS_SECRET_KEY];
}
