import Fraction from "fraction.js";

import { readGenerationPendingHolds } from "./generation-billing-pending-service";
import { summarizeGenerationProjectChargeDetails } from "./generation-task-charge-attribution";

export async function getGenerationProjectBillingSummary(userId: string, projectId: string) {
    const [charges, pending] = await Promise.all([summarizeGenerationProjectChargeDetails(userId, projectId, ["text", "image", "video", "audio"]), readGenerationPendingHolds(userId, { kind: "project", id: projectId })]);
    const actualPoints = charges.reduce((total, charge) => total.add(charge.actualPoints), new Fraction(0)).valueOf();
    const pendingHeldPoints = pending.reduce((total, hold) => total.add(hold.heldPoints), new Fraction(0)).valueOf();
    return { actualPoints, pendingHeldPoints, charges, pending };
}
