import { refundPricedImageTask } from "./model-pricing-image-task";
import { getAuthSettings, refundUserPoints } from "@/lib/auth/store";
import { imageUnits } from "@/app/api/image-tasks/image-task-support";
import { generationModelId } from "@/lib/server/generation-channel";
import { getImageTask, updateImageTask, type ImageTask } from "@/lib/server/image-task-store";

export async function refundImageTask(task: ImageTask) {
    if (task.billingMode === "official-usage") {
        await refundPricedImageTask(task);
        return (await getImageTask(task.id)) || task;
    }
    const billing = task.billing;
    if ((task.status !== "error" && task.status !== "cancelled") || !billing?.pointsRecordId || billing.refunded) return task;
    const settings = await getAuthSettings();
    await refundUserPoints(
        task.userId,
        generationModelId(task.config),
        billing.pointsCost,
        "image",
        imageUnits(task.config.quality, settings.generationPointMultipliers.imageQuality, task.config.advancedConfig?.protocol),
        imageTaskRefundIdempotencyKey(task),
        billing.pointsRecordId,
    );
    await updateImageTask(task.id, { billing: { ...billing, refunded: true } });
    return (await getImageTask(task.id)) || task;
}

export function imageTaskRefundIdempotencyKey(task: Pick<ImageTask, "id" | "attemptNo">) {
    return `image-task:${task.id}:attempt:${task.attemptNo || 1}:refund`;
}
