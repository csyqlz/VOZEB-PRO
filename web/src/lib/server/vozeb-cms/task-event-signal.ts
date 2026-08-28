import { getDatabaseProvider, getPostgresConnectionString, subscribePostgresNotification } from "@/lib/server/database";

type TaskEventListener = () => void;

export const VOZEB_CMS_TASK_NOTIFY_CHANNEL = "vozeb_pro_generation_task_events";

const globalSignals = globalThis as typeof globalThis & {
    __vozebCmsTaskSignals?: Map<string, Set<TaskEventListener>>;
    __vozebCmsTaskSignalBridge?: Promise<unknown>;
};
const listeners = (globalSignals.__vozebCmsTaskSignals ??= new Map<string, Set<TaskEventListener>>());

export function notifyVozebCmsTaskEvent(taskId: string) {
    const id = taskId.trim();
    if (!id) return;
    for (const listener of [...(listeners.get(id) || [])]) {
        try {
            listener();
        } catch {
            // A notification listener must not make the task mutation fail.
        }
    }
}

export function notifyVozebCmsTaskEvents(taskIds: Iterable<string>) {
    for (const taskId of new Set(taskIds)) notifyVozebCmsTaskEvent(taskId);
}

export function waitForVozebCmsTaskEvent(taskId: string, timeoutMs: number, signal?: AbortSignal) {
    const id = taskId.trim();
    if (!id) return Promise.resolve(false);
    ensurePostgresEventBridge();
    return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (notified: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            signal?.removeEventListener("abort", aborted);
            const current = listeners.get(id);
            current?.delete(changed);
            if (current && !current.size) listeners.delete(id);
            resolve(notified);
        };
        const changed = () => finish(true);
        const aborted = () => finish(false);
        const timeout = setTimeout(() => finish(false), Math.max(0, timeoutMs));
        const current = listeners.get(id) || new Set<TaskEventListener>();
        current.add(changed);
        listeners.set(id, current);
        if (signal?.aborted) aborted();
        else signal?.addEventListener("abort", aborted, { once: true });
    });
}

function ensurePostgresEventBridge() {
    if (getDatabaseProvider() !== "postgres" || !getPostgresConnectionString() || globalSignals.__vozebCmsTaskSignalBridge) return;
    globalSignals.__vozebCmsTaskSignalBridge = subscribePostgresNotification(VOZEB_CMS_TASK_NOTIFY_CHANNEL, (taskId) => notifyVozebCmsTaskEvent(taskId)).catch((error) => {
        globalSignals.__vozebCmsTaskSignalBridge = undefined;
        console.warn("VOZEBCMS task PostgreSQL notification bridge unavailable", { error: error instanceof Error ? error.message : String(error) });
    });
}
