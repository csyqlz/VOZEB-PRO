import { createHash } from "node:crypto";

type MediaConcurrencyScope = "local" | "proxy" | "public";

type MediaConcurrencyPermit = {
    release: () => void;
    setExpiryHandler: (handler: () => void | Promise<void>) => void;
};

const LIMITS: Record<MediaConcurrencyScope, { total: number; perIdentity: number; leaseMs: number }> = {
    local: { total: 64, perIdentity: 8, leaseMs: 10 * 60 * 1000 },
    proxy: { total: 32, perIdentity: 4, leaseMs: 10 * 60 * 1000 },
    public: { total: 96, perIdentity: 24, leaseMs: 10 * 60 * 1000 },
};

const globalMediaConcurrencyStore = globalThis as typeof globalThis & {
    __vozebProMediaConcurrency?: { totals: Map<string, number>; identities: Map<string, number> };
};

const counters = (globalMediaConcurrencyStore.__vozebProMediaConcurrency ??= { totals: new Map(), identities: new Map() });

export function acquireMediaConcurrency(scope: MediaConcurrencyScope, identity: string, overrides?: { total?: number; perIdentity?: number; leaseMs?: number }): MediaConcurrencyPermit | null {
    const defaults = LIMITS[scope];
    const totalLimit = positiveInteger(overrides?.total, defaults.total);
    const identityLimit = positiveInteger(overrides?.perIdentity, defaults.perIdentity);
    const totalKey = scope;
    const identityKey = `${scope}:${createHash("sha256").update(identity).digest("base64url")}`;
    const total = counters.totals.get(totalKey) || 0;
    const identityTotal = counters.identities.get(identityKey) || 0;
    if (total >= totalLimit || identityTotal >= identityLimit) return null;

    counters.totals.set(totalKey, total + 1);
    counters.identities.set(identityKey, identityTotal + 1);
    let released = false;
    let expiryHandler: (() => void | Promise<void>) | undefined;
    const release = () => {
        if (released) return;
        released = true;
        clearTimeout(timer);
        decrement(counters.totals, totalKey);
        decrement(counters.identities, identityKey);
    };
    const timer = setTimeout(
        () => {
            try {
                void expiryHandler?.();
            } finally {
                release();
            }
        },
        positiveInteger(overrides?.leaseMs, defaults.leaseMs),
    );
    timer.unref?.();
    return {
        release,
        setExpiryHandler(handler) {
            if (released) void handler();
            else expiryHandler = handler;
        },
    };
}

export function withMediaConcurrency(response: Response, permit: MediaConcurrencyPermit, signal?: AbortSignal) {
    if (!response.body) {
        permit.release();
        return response;
    }

    const reader = response.body.getReader();
    let abortListener: (() => void) | undefined;
    const release = () => {
        if (signal && abortListener) signal.removeEventListener("abort", abortListener);
        abortListener = undefined;
        permit.release();
    };
    const cancelSource = (reason: unknown) => reader.cancel(reason).catch(() => undefined);
    abortListener = () => {
        release();
        void cancelSource(signal?.reason || "Media request aborted");
    };
    permit.setExpiryHandler(() => {
        release();
        return cancelSource("Media concurrency lease expired");
    });
    if (signal?.aborted) abortListener();
    else signal?.addEventListener("abort", abortListener, { once: true });
    const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const { done, value } = await reader.read();
                if (done) {
                    release();
                    controller.close();
                    return;
                }
                controller.enqueue(value);
            } catch (error) {
                release();
                controller.error(error);
            }
        },
        async cancel(reason) {
            release();
            await reader.cancel(reason);
        },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function positiveInteger(value: number | undefined, fallback: number) {
    return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function decrement(map: Map<string, number>, key: string) {
    const next = (map.get(key) || 0) - 1;
    if (next > 0) map.set(key, next);
    else map.delete(key);
}
