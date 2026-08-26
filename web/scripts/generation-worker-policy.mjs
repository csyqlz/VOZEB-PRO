export function nextGenerationWorkerPollPolicy({ claimed, idleBatches, baseIdleDelayMs, nextDueAt, now = Date.now() }) {
    if (Number(claimed) > 0) return { delayMs: 250, idleBatches: 0 };

    const baseDelayMs = Math.max(1, Math.floor(baseIdleDelayMs));
    const currentIdleBatches = Math.max(0, Math.floor(idleBatches));
    const maximumIdleDelayMs = Math.max(baseDelayMs, 10_000);
    const dueAt = Number(nextDueAt);
    if (Number.isFinite(dueAt) && dueAt > 0) {
        const remainingMs = Math.ceil(dueAt - Number(now));
        return { delayMs: remainingMs > 0 ? Math.min(maximumIdleDelayMs, remainingMs) : 250, idleBatches: 0 };
    }
    return {
        delayMs: Math.min(maximumIdleDelayMs, baseDelayMs * 2 ** Math.min(currentIdleBatches, 10)),
        idleBatches: currentIdleBatches + 1,
    };
}
