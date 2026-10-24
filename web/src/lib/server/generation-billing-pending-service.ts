import { readAuthDb } from "@/lib/auth/store-repository";
import Fraction from "fraction.js";

import { ensurePostgresSchema, getDatabaseProvider, postgresQuery } from "./database";
import { listStoredGenerationTaskRecordsByProjectIds, listStoredGenerationTaskRecordsByRunIds } from "./generation-task-store";

const TYPES = ["text", "image", "video", "audio"] as const;
type TaskType = (typeof TYPES)[number];
export type GenerationPendingHold = { type: TaskType; logicalModelId: string; heldPoints: number; count: number };

export async function readGenerationPendingHolds(userId: string, scope: { kind: "run" | "project"; id: string }): Promise<GenerationPendingHold[]> {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const column = scope.kind === "run" ? "run_id" : "project_id";
        const result = await postgresQuery<{ task_type: TaskType; model_id: string; held_points: string; hold_count: number }>(
            `SELECT task.task_type, reservation.data->>'modelId' AS model_id,
                    sum(COALESCE((reservation.data #>> '{estimatedHold,heldPoints}')::numeric, (reservation.data #>> '{allocation,heldPoints}')::numeric))::text AS held_points,
                    count(*)::int AS hold_count
             FROM model_pricing_wallet_reservations reservation
             JOIN generation_tasks task ON task.id = reservation.data #>> '{preparation,taskId}' AND task.user_id = reservation.user_id
             WHERE reservation.user_id = $1 AND task.${column} = $2 AND reservation.status = 'reserved'
               AND task.task_type = ANY($3::text[])
             GROUP BY task.task_type, reservation.data->>'modelId'`,
            [userId, scope.id, TYPES],
        );
        return result.rows.map((row) => ({ type: row.task_type, logicalModelId: row.model_id, heldPoints: Number(row.held_points), count: Number(row.hold_count) }));
    }
    const tasks = scope.kind === "run" ? await listStoredGenerationTaskRecordsByRunIds([scope.id], [userId]) : await listStoredGenerationTaskRecordsByProjectIds([scope.id], userId);
    const taskTypes = new Map<string, TaskType>(tasks.filter((task) => TYPES.includes(task.type as TaskType)).map((task) => [task.id, task.type as TaskType]));
    const groups = new Map<string, { type: TaskType; logicalModelId: string; held: Fraction; count: number }>();
    for (const reservation of (await readAuthDb()).pricingReservations) {
        if (reservation.userId !== userId || reservation.status !== "reserved") continue;
        const type = taskTypes.get(reservation.preparation?.taskId || "");
        if (!type) continue;
        const key = JSON.stringify([type, reservation.modelId]);
        const current = groups.get(key) || { type, logicalModelId: reservation.modelId, held: new Fraction(0), count: 0 };
        current.held = current.held.add((reservation.estimatedHold || reservation.allocation).heldPoints);
        current.count += 1;
        groups.set(key, current);
    }
    return Array.from(groups.values(), ({ type, logicalModelId, held, count }) => ({ type, logicalModelId, heldPoints: held.valueOf(), count }));
}
