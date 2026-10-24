import type { DramaCostSummary } from "@/lib/drama-project-contract";
import { getDramaProjectForUser } from "@/lib/server/drama-project-service";
import { getGenerationProjectBillingSummary } from "@/lib/server/generation-project-billing-service";
import { summarizeStoredGenerationTaskCosts } from "@/lib/server/generation-task-store";

export async function getDramaProjectCostSummary(userId: string, projectId: string): Promise<DramaCostSummary> {
    await getDramaProjectForUser(userId, projectId);
    const [aggregates, billing] = await Promise.all([summarizeStoredGenerationTaskCosts({ userId, projectId, types: ["text", "image", "video", "audio"] }), getGenerationProjectBillingSummary(userId, projectId)]);
    const byType: DramaCostSummary["byType"] = {};
    let estimatedPoints = 0;
    for (const aggregate of aggregates) {
        const type = aggregate.type as "text" | "image" | "video" | "audio";
        estimatedPoints += aggregate.estimatedPoints;
        const current = byType[type] || { tasks: 0, estimatedPoints: 0, actualPoints: 0 };
        byType[type] = {
            tasks: current.tasks + aggregate.taskCount,
            estimatedPoints: round(current.estimatedPoints + aggregate.estimatedPoints),
            actualPoints: current.actualPoints,
        };
    }
    for (const charge of billing.charges) {
        const current = byType[charge.type] || { tasks: 0, estimatedPoints: 0, actualPoints: 0 };
        byType[charge.type] = { ...current, actualPoints: round(current.actualPoints + charge.actualPoints) };
    }
    return {
        estimatedPoints: round(estimatedPoints),
        actualPoints: billing.actualPoints,
        pendingHeldPoints: billing.pendingHeldPoints,
        taskCount: aggregates.reduce((total, item) => total + item.taskCount, 0),
        successCount: aggregates.filter((item) => item.status === "success").reduce((total, item) => total + item.taskCount, 0),
        failedCount: aggregates.filter((item) => item.status === "error" || item.status === "cancelled").reduce((total, item) => total + item.taskCount, 0),
        byType,
        charges: billing.charges,
        pending: billing.pending,
    };
}

function round(value: number) {
    return Number(value.toFixed(2));
}
