import { readAuthDb } from "@/lib/auth/store-repository";
import Fraction from "fraction.js";
import { ensurePostgresSchema, getDatabaseProvider, postgresQuery, type QueryExecutor } from "./database";
import { readJsonDataFile, withJsonDataFileLock, writeJsonDataFile } from "./data-adapter";
import type { GenerationTaskType } from "./generation-task-types";

export type GenerationTaskChargeAttribution = {
    recordId: string;
    userId: string;
    taskId: string;
    projectId?: string;
    taskType: "text" | "image" | "video" | "audio";
    runId?: string;
    purpose: "generation" | "planning" | "review" | "analysis";
    logicalModelId?: string;
};

const FILE = "generation-task-charge-attributions.json";

export async function recordGenerationTaskCharges(type: GenerationTaskType, payload: Record<string, unknown>, executor?: QueryExecutor) {
    if (type !== "text" && type !== "image" && type !== "video" && type !== "audio") return;
    const userId = stringField(payload.userId);
    const taskId = stringField(payload.id);
    const projectId = stringField(payload.projectId);
    const runId = stringField(payload.runId) || undefined;
    if (!userId || !taskId || (!projectId && !runId)) return;
    const ids = new Set([recordId(payload.billing), recordId(payload.upstream), ...(Array.isArray(payload.attempts) ? payload.attempts.map(recordId) : [])].filter(Boolean));
    if (!ids.size) return;
    const logicalModelId = stringField(recordObject(payload.config).logicalModel) || undefined;
    const charges: GenerationTaskChargeAttribution[] = Array.from(ids, (id) => ({
        recordId: id,
        userId,
        taskId,
        ...(projectId ? { projectId } : {}),
        taskType: type,
        ...(runId ? { runId } : {}),
        purpose: "generation",
        ...(logicalModelId ? { logicalModelId } : {}),
    }));
    await storeChargeAttributions(charges, executor);
}

export async function recordAgentAuxiliaryCharge(input: { userId: string; runId: string; projectId?: string; purpose: "planning" | "review"; logicalModelId: string; pointsRecordId?: string }, executor?: QueryExecutor) {
    const userId = stringField(input.userId);
    const runId = stringField(input.runId);
    const projectId = stringField(input.projectId);
    const logicalModelId = stringField(input.logicalModelId);
    const id = stringField(input.pointsRecordId);
    if (!id) return;
    if (!userId || !runId || !logicalModelId) throw new Error("Agent 辅助调用缺少稳定计费身份");
    await storeChargeAttributions([{ recordId: id, userId, taskId: `${runId}:${input.purpose}`, ...(projectId ? { projectId } : {}), taskType: "text", runId, purpose: input.purpose, logicalModelId }], executor);
}

export async function recordDramaAnalysisCharge(input: { userId: string; projectId: string; callId: string; logicalModelId: string; pointsRecordId: string }, executor?: QueryExecutor) {
    const userId = stringField(input.userId);
    const projectId = stringField(input.projectId);
    const callId = stringField(input.callId);
    const logicalModelId = stringField(input.logicalModelId);
    const recordId = stringField(input.pointsRecordId);
    if (!userId || !projectId || !callId || !logicalModelId || !recordId) throw new Error("短剧分析缺少稳定计费归属");
    await storeChargeAttributions([{ recordId, userId, taskId: callId, projectId, taskType: "text", purpose: "analysis", logicalModelId }], executor);
}

async function storeChargeAttributions(charges: GenerationTaskChargeAttribution[], executor?: QueryExecutor) {
    if (!charges.length) return;
    if (getDatabaseProvider() === "postgres") {
        if (!executor) await ensurePostgresSchema();
        const query = executor ? executor.query.bind(executor) : postgresQuery;
        for (const charge of charges) {
            const result = await query<{ record_id: string }>(
                `INSERT INTO generation_task_charge_attributions (record_id, user_id, task_id, project_id, task_type, run_id, purpose, logical_model_id)
                 SELECT id, user_id, $3, $4, $5, $6, $7, $8 FROM point_records WHERE id = $1 AND user_id = $2 AND type = 'consume'
                 ON CONFLICT (record_id) DO UPDATE SET
                   project_id = COALESCE(generation_task_charge_attributions.project_id, EXCLUDED.project_id),
                   run_id = COALESCE(generation_task_charge_attributions.run_id, EXCLUDED.run_id),
                   logical_model_id = COALESCE(generation_task_charge_attributions.logical_model_id, EXCLUDED.logical_model_id)
                 WHERE generation_task_charge_attributions.user_id = EXCLUDED.user_id AND generation_task_charge_attributions.task_id = EXCLUDED.task_id
                   AND generation_task_charge_attributions.task_type = EXCLUDED.task_type AND generation_task_charge_attributions.purpose = EXCLUDED.purpose
                   AND (generation_task_charge_attributions.project_id IS NULL OR EXCLUDED.project_id IS NULL OR generation_task_charge_attributions.project_id = EXCLUDED.project_id)
                   AND (generation_task_charge_attributions.run_id IS NULL OR EXCLUDED.run_id IS NULL OR generation_task_charge_attributions.run_id = EXCLUDED.run_id)
                   AND (generation_task_charge_attributions.logical_model_id IS NULL OR EXCLUDED.logical_model_id IS NULL OR generation_task_charge_attributions.logical_model_id = EXCLUDED.logical_model_id)
                 RETURNING record_id`,
                [charge.recordId, charge.userId, charge.taskId, charge.projectId || null, charge.taskType, charge.runId || null, charge.purpose, charge.logicalModelId || null],
            );
            if (!result.rows.length) throw new Error("生成任务消费流水与项目归属不一致");
        }
        return;
    }
    await withJsonDataFileLock(FILE, async () => {
        const saved = await readJsonDataFile<GenerationTaskChargeAttribution[]>(FILE, []);
        const existingById = new Map(saved.map((item) => [item.recordId, item]));
        const newCharges = charges.filter((charge) => !existingById.has(charge.recordId));
        if (newCharges.length) {
            const pointRecords = (await readAuthDb()).pointRecords;
            if (newCharges.some((charge) => !pointRecords.some((point) => point.id === charge.recordId && point.userId === charge.userId && point.type === "consume"))) throw new Error("生成任务消费流水与用户身份不一致");
        }
        let changed = false;
        for (const charge of charges) {
            const existing = existingById.get(charge.recordId);
            if (
                existing &&
                (existing.userId !== charge.userId ||
                    existing.taskId !== charge.taskId ||
                    existing.taskType !== charge.taskType ||
                    existing.purpose !== charge.purpose ||
                    (existing.projectId && charge.projectId && existing.projectId !== charge.projectId) ||
                    (existing.runId && charge.runId && existing.runId !== charge.runId) ||
                    (existing.logicalModelId && charge.logicalModelId && existing.logicalModelId !== charge.logicalModelId))
            )
                throw new Error("消费流水已归属其他生成任务");
            if (!existing) {
                saved.push(charge);
                changed = true;
            } else if (existing) {
                if (!existing.projectId && charge.projectId) {
                    existing.projectId = charge.projectId;
                    changed = true;
                }
                if (!existing.runId && charge.runId) {
                    existing.runId = charge.runId;
                    changed = true;
                }
                if (!existing.logicalModelId && charge.logicalModelId) {
                    existing.logicalModelId = charge.logicalModelId;
                    changed = true;
                }
            }
        }
        if (changed) await writeJsonDataFile(FILE, saved);
    });
}

export function readFileGenerationTaskChargeAttributions() {
    return readJsonDataFile<GenerationTaskChargeAttribution[]>(FILE, []);
}

export type GenerationChargeDetail = { type: GenerationTaskChargeAttribution["taskType"]; purpose: GenerationTaskChargeAttribution["purpose"]; logicalModelId?: string; chargedPoints: number; refundedPoints: number; actualPoints: number };

export async function summarizeGenerationTaskNetCharges(userId: string, projectId: string, types: GenerationTaskType[]) {
    return collapseByType(await readChargeDetails(userId, "project_id", projectId, types));
}

export async function summarizeGenerationProjectChargeDetails(userId: string, projectId: string, types: GenerationTaskType[]) {
    return readChargeDetails(userId, "project_id", projectId, types);
}

export async function summarizeGenerationRunNetCharges(userId: string, runId: string, types: GenerationTaskType[]) {
    return collapseByType(await summarizeGenerationRunChargeDetails(userId, runId, types));
}

export async function summarizeGenerationRunChargeDetails(userId: string, runId: string, types: GenerationTaskType[]) {
    return readChargeDetails(userId, "run_id", runId, types);
}

function collapseByType(details: GenerationChargeDetail[]) {
    const totals = new Map<GenerationChargeDetail["type"], Fraction>();
    for (const detail of details) totals.set(detail.type, (totals.get(detail.type) || new Fraction(0)).add(detail.actualPoints));
    return Array.from(totals, ([type, actualPoints]) => ({ type, actualPoints: actualPoints.valueOf() }));
}

async function readChargeDetails(userId: string, scopeColumn: "project_id" | "run_id", scopeId: string, types: GenerationTaskType[]): Promise<GenerationChargeDetail[]> {
    if (getDatabaseProvider() === "postgres") {
        await ensurePostgresSchema();
        const result = await postgresQuery<{ task_type: GenerationChargeDetail["type"]; purpose: GenerationChargeDetail["purpose"]; logical_model_id: string | null; charged_points: string; refunded_points: string }>(
            `SELECT attribution.task_type, attribution.purpose, attribution.logical_model_id,
                    COALESCE(sum(-charge.amount), 0)::text AS charged_points,
                    COALESCE(sum(COALESCE(fixed_refunds.amount, 0) + COALESCE(priced_refunds.amount, 0)), 0)::text AS refunded_points
             FROM generation_task_charge_attributions attribution
             JOIN point_records charge ON charge.id = attribution.record_id AND charge.user_id = attribution.user_id AND charge.type = 'consume'
             LEFT JOIN LATERAL (
                 SELECT sum(refund.amount) AS amount FROM point_records refund
                 WHERE refund.user_id = attribution.user_id AND refund.type = 'refund' AND refund.source_record_id = charge.id
             ) fixed_refunds ON true
             LEFT JOIN model_pricing_wallet_reservations reservation ON reservation.user_id = attribution.user_id AND reservation.charge_record_id = charge.id
             LEFT JOIN LATERAL (
                 SELECT max((receipt.data #>> '{calculation,quotaRefundedPoints}')::numeric) AS amount
                 FROM model_pricing_wallet_refunds receipt JOIN point_records refund ON refund.id = receipt.record_id AND refund.user_id = attribution.user_id AND refund.type = 'refund'
                 WHERE receipt.user_id = attribution.user_id AND receipt.request_id = reservation.request_id
             ) priced_refunds ON true
             WHERE attribution.user_id = $1 AND attribution.${scopeColumn} = $2 AND attribution.task_type = ANY($3::text[])
             GROUP BY attribution.task_type, attribution.purpose, attribution.logical_model_id`,
            [userId, scopeId, types],
        );
        return result.rows.map((row) => ({
            type: row.task_type,
            purpose: row.purpose,
            ...(row.logical_model_id ? { logicalModelId: row.logical_model_id } : {}),
            chargedPoints: Number(row.charged_points),
            refundedPoints: Number(row.refunded_points),
            actualPoints: new Fraction(row.charged_points).sub(row.refunded_points).valueOf(),
        }));
    }
    const links = (await readFileGenerationTaskChargeAttributions()).filter((item) => item.userId === userId && (scopeColumn === "project_id" ? item.projectId : item.runId) === scopeId && types.includes(item.taskType));
    if (!links.length) return [];
    const db = await readAuthDb();
    const records = new Map(db.pointRecords.map((record) => [record.id, record]));
    const totals = new Map<string, { type: GenerationChargeDetail["type"]; purpose: GenerationChargeDetail["purpose"]; logicalModelId?: string; charged: Fraction; refunded: Fraction }>();
    const seen = new Set<string>();
    for (const link of links) {
        if (seen.has(link.recordId)) throw new Error("项目消费流水重复归属");
        seen.add(link.recordId);
        const charge = records.get(link.recordId);
        if (!charge || charge.userId !== userId || charge.type !== "consume") throw new Error("项目消费流水缺失或身份不一致");
        const refunds = db.pointRecords.filter((record) => record.userId === userId && record.type === "refund" && record.sourceRecordId === charge.id);
        const pricedRefunds = db.pricingRefunds.filter((refund) => refund.userId === userId && refund.chargeRecordId === charge.id);
        if (pricedRefunds.some((refund) => !records.get(refund.recordId) || records.get(refund.recordId)?.userId !== userId || records.get(refund.recordId)?.type !== "refund")) throw new Error("项目退款流水缺失或身份不一致");
        const pricedRefunded = pricedRefunds.reduce((max, refund) => {
            const value = refund.calculation?.quotaRefundedPoints;
            if (typeof value !== "string") throw new Error("项目按量退款缺少已确认退费积分");
            const points = new Fraction(value);
            return points.gt(max) ? points : max;
        }, new Fraction(0));
        const key = JSON.stringify([link.taskType, link.purpose, link.logicalModelId || ""]);
        const current = totals.get(key) || { type: link.taskType, purpose: link.purpose, ...(link.logicalModelId ? { logicalModelId: link.logicalModelId } : {}), charged: new Fraction(0), refunded: new Fraction(0) };
        current.charged = current.charged.sub(charge.amount);
        current.refunded = refunds.reduce((sum, refund) => sum.add(refund.amount), current.refunded.add(pricedRefunded));
        totals.set(key, current);
    }
    return Array.from(totals.values(), ({ type, purpose, logicalModelId, charged, refunded }) => ({
        type,
        purpose,
        ...(logicalModelId ? { logicalModelId } : {}),
        chargedPoints: charged.valueOf(),
        refundedPoints: refunded.valueOf(),
        actualPoints: charged.sub(refunded).valueOf(),
    }));
}

function stringField(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function recordObject(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function recordId(value: unknown) {
    return stringField(recordObject(value).pointsRecordId);
}
