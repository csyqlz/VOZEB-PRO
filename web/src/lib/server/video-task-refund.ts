import { refundUserPoints } from "@/lib/auth/store";
import { generationModelId } from "@/lib/server/generation-channel";
import { getVideoTask, updateVideoTask, type VideoTask } from "@/lib/server/video-task-store";

export async function refundVideoTask(task: VideoTask) {
    const upstream = task.upstream;
    if ((task.status !== "error" && task.status !== "cancelled") || upstream.pointsCost === undefined || !upstream.pointsRecordId || upstream.refunded) return task;
    await refundUserPoints(task.userId, generationModelId(task.config), upstream.pointsCost, "video", upstream.pointsUnits || 1, videoTaskRefundIdempotencyKey(task), upstream.pointsRecordId);
    await updateVideoTask(task.id, { upstream: { ...upstream, refunded: true } });
    return (await getVideoTask(task.id)) || task;
}

export function videoTaskRefundIdempotencyKey(task: Pick<VideoTask, "id" | "attemptNo">) {
    return `video-task:${task.id}:attempt:${task.attemptNo || 1}:refund`;
}
