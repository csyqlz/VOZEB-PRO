import { describe, expect, it, vi } from "vitest";

import { acquireMediaConcurrency, withMediaConcurrency } from "./media-concurrency";

describe("media concurrency", () => {
    it("bounds one identity and releases the permit idempotently", () => {
        const identity = crypto.randomUUID();
        const first = acquireMediaConcurrency("local", identity, { total: 2, perIdentity: 1 });
        expect(first).not.toBeNull();
        expect(acquireMediaConcurrency("local", identity, { total: 2, perIdentity: 1 })).toBeNull();
        first?.release();
        first?.release();
        const next = acquireMediaConcurrency("local", identity, { total: 2, perIdentity: 1 });
        expect(next).not.toBeNull();
        next?.release();
    });

    it("bounds total concurrency across identities", () => {
        const scope = "proxy" as const;
        const first = acquireMediaConcurrency(scope, crypto.randomUUID(), { total: 1, perIdentity: 1 });
        expect(first).not.toBeNull();
        expect(acquireMediaConcurrency(scope, crypto.randomUUID(), { total: 1, perIdentity: 1 })).toBeNull();
        first?.release();
    });

    it("releases the permit after the response stream finishes or is cancelled", async () => {
        const finishedIdentity = crypto.randomUUID();
        const finished = acquireMediaConcurrency("public", finishedIdentity, { total: 2, perIdentity: 1 });
        expect(await withMediaConcurrency(new Response("media"), finished!).text()).toBe("media");
        const afterFinished = acquireMediaConcurrency("public", finishedIdentity, { total: 2, perIdentity: 1 });
        expect(afterFinished).not.toBeNull();
        afterFinished?.release();

        const cancelledIdentity = crypto.randomUUID();
        const cancelled = acquireMediaConcurrency("public", cancelledIdentity, { total: 2, perIdentity: 1 });
        await withMediaConcurrency(new Response("media"), cancelled!).body?.cancel();
        const afterCancelled = acquireMediaConcurrency("public", cancelledIdentity, { total: 2, perIdentity: 1 });
        expect(afterCancelled).not.toBeNull();
        afterCancelled?.release();
    });

    it("releases the permit when the source stream errors", async () => {
        const identity = crypto.randomUUID();
        const permit = acquireMediaConcurrency("local", identity, { total: 2, perIdentity: 1 });
        const source = new ReadableStream<Uint8Array>({ pull: () => Promise.reject(new Error("stream failed")) });
        await expect(withMediaConcurrency(new Response(source), permit!).arrayBuffer()).rejects.toThrow("stream failed");
        const next = acquireMediaConcurrency("local", identity, { total: 2, perIdentity: 1 });
        expect(next).not.toBeNull();
        next?.release();
    });

    it("cancels the source and releases the permit when the request is aborted", async () => {
        const identity = crypto.randomUUID();
        const cancel = vi.fn();
        const source = new ReadableStream<Uint8Array>({ cancel });
        const permit = acquireMediaConcurrency("local", identity, { total: 2, perIdentity: 1 });
        const request = new AbortController();
        withMediaConcurrency(new Response(source), permit!, request.signal);

        request.abort("navigation");
        await Promise.resolve();

        expect(cancel).toHaveBeenCalledWith("navigation");
        const next = acquireMediaConcurrency("local", identity, { total: 2, perIdentity: 1 });
        expect(next).not.toBeNull();
        next?.release();
    });

    it("cancels an unread source stream when its lease expires", async () => {
        vi.useFakeTimers();
        const identity = crypto.randomUUID();
        const cancel = vi.fn();
        const source = new ReadableStream<Uint8Array>({ cancel });
        const permit = acquireMediaConcurrency("local", identity, { total: 2, perIdentity: 1, leaseMs: 100 });
        withMediaConcurrency(new Response(source), permit!);

        await vi.advanceTimersByTimeAsync(100);
        expect(cancel).toHaveBeenCalledWith("Media concurrency lease expired");
        const next = acquireMediaConcurrency("local", identity, { total: 2, perIdentity: 1 });
        expect(next).not.toBeNull();
        next?.release();
        vi.useRealTimers();
    });
});
