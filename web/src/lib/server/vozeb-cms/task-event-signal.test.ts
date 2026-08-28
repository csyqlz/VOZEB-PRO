import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    notify: undefined as ((payload: string) => void) | undefined,
    subscribe: vi.fn(async (_channel: string, listener: (payload: string) => void) => {
        mocks.notify = listener;
        return () => undefined;
    }),
}));

vi.mock("@/lib/server/database", () => ({
    getDatabaseProvider: vi.fn(() => "postgres"),
    getPostgresConnectionString: vi.fn(() => "postgres://fixture"),
    subscribePostgresNotification: mocks.subscribe,
}));

import { notifyVozebCmsTaskEvent, VOZEB_CMS_TASK_NOTIFY_CHANNEL, waitForVozebCmsTaskEvent } from "./task-event-signal";

describe("VOZEBCMS task event signal", () => {
    it("ignores an empty task identifier without creating a timer", async () => {
        await expect(waitForVozebCmsTaskEvent("  ", 10_000)).resolves.toBe(false);
        expect(mocks.subscribe).not.toHaveBeenCalled();
    });

    it("wakes a local SSE waiter when the task changes", async () => {
        const waiting = waitForVozebCmsTaskEvent("task-local", 10_000);
        notifyVozebCmsTaskEvent("task-local");
        await expect(waiting).resolves.toBe(true);
    });

    it("keeps a timeout fallback when no notification arrives", async () => {
        vi.useFakeTimers();
        const waiting = waitForVozebCmsTaskEvent("task-timeout", 2_500);
        await vi.advanceTimersByTimeAsync(2_500);
        await expect(waiting).resolves.toBe(false);
        vi.useRealTimers();
    });

    it("bridges PostgreSQL notifications to the matching task waiter", async () => {
        const waiting = waitForVozebCmsTaskEvent("task-remote", 10_000);
        await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledWith(VOZEB_CMS_TASK_NOTIFY_CHANNEL, expect.any(Function)));
        mocks.notify?.(" task-remote ");
        await expect(waiting).resolves.toBe(true);
    });
});
