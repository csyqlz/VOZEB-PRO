import { getCurrentUser } from "@/lib/auth/session";
import { getAgentRun } from "@/lib/server/agent-run-store";
import { CREATIVE_RUN_EVENT_BATCH_SIZE, getLatestCreativeRunEventId, listCreativeRunEvents } from "@/lib/server/creative-runtime-store";
import { waitForCreativeRunEvent } from "@/lib/server/creative-run-event-signal";
import { publicAgentRunEvent, publicAgentRunSnapshot } from "@/lib/server/agent-run-public";

export const dynamic = "force-dynamic";
export const maxDuration = 2400;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser();
    const run = user ? await getAgentRun((await params).id) : null;
    if (!user || !run || run.userId !== user.id) return new Response("Agent 任务不存在", { status: user ? 404 : 401 });
    const encoder = new TextEncoder();
    const requestedEventId = request.headers.get("last-event-id") || new URL(request.url).searchParams.get("lastEventId") || "";
    const retryEventIds = requestedEventId ? [] : await Promise.all([getLatestCreativeRunEventId(run.id, "task.retry.requested"), getLatestCreativeRunEventId(run.id, "run.retry.requested")]);
    const lastEventId = requestedEventId || retryEventIds.reduce((latest, id) => (Number(id || 0) > Number(latest || 0) ? id : latest), "");
    const body = new ReadableStream({
        start(controller) {
            let closed = false;
            let cursor = lastEventId;
            let lastSnapshotVersion = "";
            let lastHeartbeatAt = Date.now();
            const close = () => {
                if (closed) return;
                closed = true;
                try {
                    controller.close();
                } catch {
                    // The client may have cancelled the stream before the server loop observes it.
                }
            };
            request.signal.addEventListener("abort", close, { once: true });
            void (async () => {
                const deadline = Date.now() + 60 * 60 * 1000;
                let current: Awaited<ReturnType<typeof getAgentRun>> = run;
                while (!closed && Date.now() < deadline) {
                    if (closed) return;
                    if (!current) {
                        controller.enqueue(encoder.encode(`event: run.failed\ndata: ${JSON.stringify({ message: "Agent 任务不存在" })}\n\n`));
                        close();
                        return;
                    }
                    const events = await listCreativeRunEvents(run.id, cursor);
                    for (const event of events) {
                        controller.enqueue(encoder.encode(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(publicAgentRunEvent(event))}\n\n`));
                        cursor = event.id;
                    }
                    if (events.length === CREATIVE_RUN_EVENT_BATCH_SIZE) continue;
                    const snapshotVersion = `${current.status}:${current.updatedAt}`;
                    if (snapshotVersion !== lastSnapshotVersion) {
                        controller.enqueue(encoder.encode(`event: run.snapshot\ndata: ${JSON.stringify(publicAgentRunSnapshot(current))}\n\n`));
                        lastSnapshotVersion = snapshotVersion;
                    }
                    if (["completed", "failed", "cancelled"].includes(current.status)) {
                        close();
                        return;
                    }
                    await waitForCreativeRunEvent(run.id, 2_500, request.signal);
                    current = await getAgentRun(run.id);
                    if (!closed && Date.now() - lastHeartbeatAt >= 15_000) {
                        controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
                        lastHeartbeatAt = Date.now();
                    }
                }
                close();
            })().catch(() => close());
        },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
}
