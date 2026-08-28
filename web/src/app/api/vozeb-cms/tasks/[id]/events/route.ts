import { getCurrentUser } from "@/lib/auth/session";
import { requireVozebCmsCapability } from "@/app/api/vozeb-cms-capability";
import { getVozebCmsTask, vozebCmsTaskCapabilityId } from "@/lib/server/vozeb-cms/unified-task-service";
import { waitForVozebCmsTaskEvent } from "@/lib/server/vozeb-cms/task-event-signal";
import { waitForVozebCmsWorkflowEvent } from "@/lib/server/vozeb-cms/workflow-event-signal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 2400;

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
    const user = await getCurrentUser(request);
    if (!user) return new Response("请先登录", { status: 401 });
    const resourceBlocked = await requireVozebCmsCapability("asset.manage", user.id);
    if (resourceBlocked) return resourceBlocked;
    const id = (await context.params).id.trim();
    const task = await getVozebCmsTask(user.id, id);
    if (!task) return new Response("任务不存在或已过期", { status: 404 });
    const blocked = await requireVozebCmsCapability(vozebCmsTaskCapabilityId(task.type), user.id);
    if (blocked) return blocked;

    const encoder = new TextEncoder();
    const requested = request.headers.get("last-event-id") || new URL(request.url).searchParams.get("lastEventId") || "";
    const body = new ReadableStream({
        start(controller) {
            let closed = false;
            let current = task;
            let lastCursor = requested;
            let lastSnapshot = "";
            const close = () => {
                if (closed) return;
                closed = true;
                request.signal.removeEventListener("abort", close);
                try {
                    controller.close();
                } catch {
                    // The client may close the stream first.
                }
            };
            request.signal.addEventListener("abort", close, { once: true });
            const send = (event: string, data: unknown, id?: string) => {
                if (closed) return;
                const prefix = id ? `id: ${id}\n` : "";
                controller.enqueue(encoder.encode(`${prefix}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            };
            void (async () => {
                const deadline = Date.now() + 60 * 60 * 1000;
                let lastHeartbeat = Date.now();
                while (!closed && Date.now() < deadline) {
                    const next = await getVozebCmsTask(user.id, id);
                    if (!next) {
                        send("task.deleted", { id });
                        close();
                        return;
                    }
                    current = next;
                    const cursor = taskCursor(current);
                    if (cursor !== lastCursor || !lastSnapshot) {
                        send("task.snapshot", current, cursor);
                        lastCursor = cursor;
                        lastSnapshot = cursor;
                    }
                    if (isTerminal(current.status)) {
                        close();
                        return;
                    }
                    await (current.source === "workflow" ? waitForVozebCmsWorkflowEvent(id, 2_500, request.signal) : waitForVozebCmsTaskEvent(id, 2_500, request.signal));
                    if (!closed && Date.now() - lastHeartbeat >= 15_000) {
                        controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
                        lastHeartbeat = Date.now();
                    }
                }
                close();
            })().catch(close);
        },
    });
    return new Response(body, {
        headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        },
    });
}

function taskCursor(task: { id: string; status: string; execution_phase?: string; metadata?: Record<string, unknown>; updated_at?: string; created_at: string }) {
    const metadata = task.metadata || {};
    return [task.id, task.updated_at || task.created_at, task.status, task.execution_phase || "", String(metadata.attemptNo || "")].join(":");
}

function isTerminal(status: string) {
    return status === "success" || status === "error" || status === "cancelled";
}
