import { refundPricedVideoTask } from "./model-pricing-video-task";
import { refundUserPoints } from "@/lib/auth/store";
import { generationModelId } from "@/lib/server/generation-channel";
import { getVideoTask, updateVideoTask, type VideoTask } from "@/lib/server/video-task-store";

export async function refundVideoTask(task: VideoTask) {
    if (task.billingMode === "official-usage") {
        await refundPricedVideoTask(task);
        return (await getVideoTask(task.id)) || task;
    }
    const upstream = task.upstream;
    if ((task.status !== "error" && task.status !== "cancelled") || upstream.pointsCost === undefined || !upstream.pointsRecordId || upstream.refunded) return task;
    await refundUserPoints(task.userId, generationModelId(task.config), upstream.pointsCost, "video", upstream.pointsUnits || 1, `video-task:${task.id}:refund`, upstream.pointsRecordId);
    await updateVideoTask(task.id, { upstream: { ...upstream, refunded: true } });
    return (await getVideoTask(task.id)) || task;
}
