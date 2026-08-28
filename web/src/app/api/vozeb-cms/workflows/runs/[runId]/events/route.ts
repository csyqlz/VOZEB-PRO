import { getCurrentUser } from "@/lib/auth/session";
import { requireVozebCmsCapability } from "@/app/api/vozeb-cms-capability";
import { listVozebCmsWorkflowEvents } from "@/lib/server/vozeb-cms/workflow-store";
import { getRecoverableVozebCmsWorkflowRun } from "@/lib/server/vozeb-cms/workflow-runtime";
import { waitForVozebCmsWorkflowEvent } from "@/lib/server/vozeb-cms/workflow-event-signal";

export const dynamic = "force-dynamic";
export const maxDuration = 2400;

export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
    const user = await getCurrentUser(request);
    if (user) {
        const blocked = await requireVozebCmsCapability("workflow.run", user.id);
        if (blocked) return blocked;
    }
    const runId = (await params).runId;
    const run = user ? await getRecoverableVozebCmsWorkflowRun(user.id, runId) : null;
    if (!user || !run) return new Response(user ? "工作流运行不存在" : "请先登录", { status: user ? 404 : 401 });
    const encoder = new TextEncoder();
    const requested = request.headers.get("last-event-id") || new URL(request.url).searchParams.get("lastEventId") || "0";
    const body = new ReadableStream({
        start(controller) {
            let closed = false;
            let cursor = requested;
            let current = run;
            let lastSnapshotVersion = "";
            const close = () => {
                if (closed) return;
                closed = true;
                try {
                    controller.close();
                } catch {
                    // The client may have closed the stream first.
                }
            };
            request.signal.addEventListener("abort", close, { once: true });
            void (async () => {
                const deadline = Date.now() + 60 * 60 * 1000;
                let lastHeartbeat = Date.now();
                while (!closed && Date.now() < deadline) {
                    const events = await listVozebCmsWorkflowEvents(user.id, runId, cursor);
                    for (const event of events) {
                        controller.enqueue(encoder.encode(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
                        cursor = event.id;
                    }
                    if (events.length === 200) continue;
                    const snapshotVersion = `${current.status}:${current.version}`;
                    if (snapshotVersion !== lastSnapshotVersion) {
                        controller.enqueue(encoder.encode(`event: workflow.snapshot\ndata: ${JSON.stringify(current)}\n\n`));
                        lastSnapshotVersion = snapshotVersion;
                    }
                    if (["completed", "failed", "cancelled"].includes(current.status)) {
                        close();
                        return;
                    }
                    await waitForVozebCmsWorkflowEvent(runId, 2_500, request.signal);
                    current = (await getRecoverableVozebCmsWorkflowRun(user.id, runId)) || current;
                    if (!closed && Date.now() - lastHeartbeat >= 15_000) {
                        controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
                        lastHeartbeat = Date.now();
                    }
                }
                close();
            })().catch(close);
        },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
}
