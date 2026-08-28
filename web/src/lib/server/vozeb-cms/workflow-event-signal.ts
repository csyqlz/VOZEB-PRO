import { getDatabaseProvider, getPostgresConnectionString, subscribePostgresNotification } from "@/lib/server/database";

type Listener = () => void;
const CHANNEL = "vozeb_workflow_events";
const state = globalThis as typeof globalThis & { __vozebCmsWorkflowSignals?: Map<string, Set<Listener>>; __vozebCmsWorkflowBridge?: Promise<unknown> };
const listeners = (state.__vozebCmsWorkflowSignals ??= new Map<string, Set<Listener>>());

export function notifyVozebCmsWorkflowEvent(runId: string) {
    for (const listener of [...(listeners.get(runId) || [])]) listener();
}

export function waitForVozebCmsWorkflowEvent(runId: string, timeoutMs: number, signal?: AbortSignal) {
    ensureBridge();
    return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (notified: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            signal?.removeEventListener("abort", aborted);
            const current = listeners.get(runId);
            current?.delete(changed);
            if (current && !current.size) listeners.delete(runId);
            resolve(notified);
        };
        const changed = () => finish(true);
        const aborted = () => finish(false);
        const timeout = setTimeout(() => finish(false), timeoutMs);
        const current = listeners.get(runId) || new Set<Listener>();
        current.add(changed);
        listeners.set(runId, current);
        if (signal?.aborted) aborted();
        else signal?.addEventListener("abort", aborted, { once: true });
    });
}

function ensureBridge() {
    if (getDatabaseProvider() !== "postgres" || !getPostgresConnectionString() || state.__vozebCmsWorkflowBridge) return;
    state.__vozebCmsWorkflowBridge = subscribePostgresNotification(CHANNEL, (runId) => notifyVozebCmsWorkflowEvent(runId.trim())).catch((error) => {
        state.__vozebCmsWorkflowBridge = undefined;
        console.warn("VOZEBCMS workflow PostgreSQL notification bridge unavailable", { error: error instanceof Error ? error.message : String(error) });
    });
}
