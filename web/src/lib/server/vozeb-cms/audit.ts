import type { PublicUser } from "@/lib/auth/store";
import { auditActorFromRequest, safeRecordAuditLog } from "@/lib/server/audit-log-store";

type AuditUser = Partial<Pick<PublicUser, "id" | "username" | "role">>;
type AuditMetadata = Record<string, unknown>;

const AUDIT_METADATA_KEYS = new Set([
    "autoStart",
    "baseRevision",
    "capabilityId",
    "controlAction",
    "decision",
    "definitionVersion",
    "errorStatus",
    "errorType",
    "idempotent",
    "moduleId",
    "nodeCount",
    "nodeId",
    "permissionId",
    "projectId",
    "projectType",
    "publishedRevision",
    "resultCount",
    "revision",
    "runId",
    "sitePath",
    "status",
    "targetRevision",
    "templateId",
    "version",
    "workflowId",
]);

export function createVozebCmsAuditScope(request: Request, user: AuditUser, action: string, target: { type: string; id?: string }) {
    const actor = auditActorFromRequest(request, user);
    const write = (status: "success" | "failure", input: { targetId?: string; metadata?: AuditMetadata } = {}) =>
        safeRecordAuditLog({
            action,
            status,
            actor,
            target: { type: target.type, id: cleanText(input.targetId) || target.id },
            metadata: sanitizeMetadata(input.metadata),
        });

    return {
        success: (input?: { targetId?: string; metadata?: AuditMetadata }) => write("success", input),
        failure: (error: unknown, input: { targetId?: string; metadata?: AuditMetadata } = {}) =>
            write("failure", {
                ...input,
                metadata: { ...input.metadata, ...errorMetadata(error) },
            }),
    };
}

export function recordVozebCmsAccessBlock(input: { request: Request; user: AuditUser; kind: "capability" | "permission"; id: string; status: number }) {
    const metadataKey = input.kind === "capability" ? "capabilityId" : "permissionId";
    return safeRecordAuditLog({
        action: `vozeb.access.${input.kind}.blocked`,
        status: "failure",
        actor: auditActorFromRequest(input.request, input.user),
        target: { type: input.kind, id: cleanText(input.id) },
        metadata: sanitizeMetadata({ [metadataKey]: input.id, errorStatus: input.status }),
    });
}

function sanitizeMetadata(metadata: AuditMetadata | undefined) {
    if (!metadata) return undefined;
    const entries = Object.entries(metadata).flatMap(([key, value]) => {
        if (!AUDIT_METADATA_KEYS.has(key)) return [];
        const normalized = auditValue(value);
        return normalized === undefined ? [] : [[key, normalized] as const];
    });
    return entries.length ? Object.fromEntries(entries) : undefined;
}

function auditValue(value: unknown) {
    if (typeof value === "string") return cleanText(value).slice(0, 240) || undefined;
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
    if (typeof value === "boolean") return value;
    return undefined;
}

function errorMetadata(error: unknown) {
    const status = error && typeof error === "object" && "status" in error ? Number(error.status) : undefined;
    return {
        errorType: error instanceof Error ? error.name || "Error" : "UnknownError",
        ...(Number.isInteger(status) && status! >= 400 && status! <= 599 ? { errorStatus: status } : {}),
    };
}

function cleanText(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}
