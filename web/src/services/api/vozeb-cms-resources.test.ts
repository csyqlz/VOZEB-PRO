import { afterEach, describe, expect, it, vi } from "vitest";

import { subscribeVozebCmsTask } from "./vozeb-cms-resources";

class FakeEventSource extends EventTarget {
    static instance: FakeEventSource;
    onerror: (() => void) | null = null;
    closed = false;

    constructor(public readonly url: string) {
        super();
        FakeEventSource.instance = this;
    }

    close() {
        this.closed = true;
    }

    emit(type: string, data: unknown) {
        this.dispatchEvent(new MessageEvent(type, { data: typeof data === "string" ? data : JSON.stringify(data) }));
    }
}

describe("VOZEBCMS task API", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("subscribes to authoritative task snapshots and closes after terminal state", () => {
        vi.stubGlobal("EventSource", FakeEventSource);
        const snapshots: unknown[] = [];
        const stop = subscribeVozebCmsTask("task one", (task) => snapshots.push(task));

        FakeEventSource.instance.emit("task.snapshot", { id: "task one", type: "image", status: "running", input: {}, owner: "user", cost: 0, metadata: {}, created_at: "2026-08-26T00:00:00.000Z" });
        FakeEventSource.instance.emit("task.snapshot", { id: "task one", type: "image", status: "success", input: {}, owner: "user", cost: 0, metadata: {}, created_at: "2026-08-26T00:00:00.000Z" });

        expect(FakeEventSource.instance.url).toBe("/api/vozeb-cms/tasks/task%20one/events");
        expect(snapshots).toEqual([expect.objectContaining({ status: "running" }), expect.objectContaining({ status: "success" })]);
        expect(FakeEventSource.instance.closed).toBe(true);
        stop();
    });

    it("ignores malformed snapshots without closing the reconnectable stream", () => {
        vi.stubGlobal("EventSource", FakeEventSource);
        const listener = vi.fn();
        const stop = subscribeVozebCmsTask("task-two", listener);

        FakeEventSource.instance.emit("task.snapshot", "not-json");

        expect(listener).not.toHaveBeenCalled();
        expect(FakeEventSource.instance.closed).toBe(false);
        stop();
        expect(FakeEventSource.instance.closed).toBe(true);
    });

    it("closes when the server reports that the task was deleted", () => {
        vi.stubGlobal("EventSource", FakeEventSource);
        const stop = subscribeVozebCmsTask("task-three", vi.fn());

        FakeEventSource.instance.emit("task.deleted", { id: "task-three" });

        expect(FakeEventSource.instance.closed).toBe(true);
        stop();
    });
});
