export const GENERATION_TASK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

type RetainedTask = { type: string; payload: Record<string, unknown> };

/** Pin before any wallet mutation, and release only after the original accounting outcome is saved. */
export function hasPendingTaskBilling(task: RetainedTask) {
    return ["text", "image", "video", "audio"].includes(task.type) && task.payload.billingMode === "official-usage" && task.payload.billingPending === true;
}

export function isGenerationTaskAvailable(task: RetainedTask & { expiresAt: number }, now = Date.now()) {
    return task.expiresAt > now || hasPendingTaskBilling(task);
}

/** Arguments are SQL identifiers/placeholders supplied by repository code, never user input. */
export function pendingTaskBillingSql(alias = "") {
    const prefix = alias ? `${alias}.` : "";
    return `(${prefix}task_type IN ('text', 'image', 'video', 'audio') AND ${prefix}payload @> '{"billingMode":"official-usage","billingPending":true}'::jsonb)`;
}

export function generationTaskAvailableSql(at = "now()", alias = "") {
    return `(${alias ? `${alias}.` : ""}expires_at > ${at} OR ${pendingTaskBillingSql(alias)})`;
}
