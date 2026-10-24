import { refundUserPoints } from "@/lib/auth/store";
import { getAudioTask, transitionAudioTask, type AudioTask } from "@/lib/server/audio-task-store";
import { generationModelId } from "@/lib/server/generation-channel";
import { refundPricedAudioTask } from "./model-pricing-audio-task";

export async function refundAudioTask(task: AudioTask) {
    if (task.billingMode === "official-usage") {
        await refundPricedAudioTask(task);
        return (await getAudioTask(task.id)) || task;
    }
    const billing = task.billing;
    if ((task.status !== "error" && task.status !== "cancelled") || !billing?.pointsRecordId || billing.refunded) return task;

    await refundUserPoints(task.userId, generationModelId(task.config), billing.pointsCost, "audio", 1, audioTaskRefundIdempotencyKey(task), billing.pointsRecordId);
    await transitionAudioTask(task, [task.status], {
        status: task.status,
        billing: { ...billing, refunded: true },
    });
    return (await getAudioTask(task.id)) || task;
}

export function audioTaskRefundIdempotencyKey(task: Pick<AudioTask, "id" | "attemptNo">) {
    return task.attemptNo === undefined ? `audio-task:${task.id}:refund` : `audio-task:${task.id}:attempt:${task.attemptNo}:refund`;
}
