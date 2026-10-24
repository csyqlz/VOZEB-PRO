import Fraction from "fraction.js";
import { readGenerationPendingHolds } from "./generation-billing-pending-service";
import { summarizeGenerationRunChargeDetails } from "./generation-task-charge-attribution";

const TYPES = ["text", "image", "video", "audio"] as const;

export async function getGenerationRunBillingSummary(userId: string, runId: string) {
    const [charges, pending] = await Promise.all([summarizeGenerationRunChargeDetails(userId, runId, [...TYPES]), readGenerationPendingHolds(userId, { kind: "run", id: runId })]);
    const sum = (values: number[]) => values.reduce((total, value) => total.add(value), new Fraction(0)).valueOf();
    return {
        chargedPoints: sum(charges.map((item) => item.chargedPoints)),
        refundedPoints: sum(charges.map((item) => item.refundedPoints)),
        actualPoints: sum(charges.map((item) => item.actualPoints)),
        pendingHeldPoints: sum(pending.map((item) => item.heldPoints)),
        charges,
        pending,
    };
}
