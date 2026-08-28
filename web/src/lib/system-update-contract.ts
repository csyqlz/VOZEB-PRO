export type SystemUpdateOperationStatus = "idle" | "preparing" | "backing_up" | "pulling" | "applying" | "health_check" | "completed" | "failed" | "rolling_back";

export type SystemUpdateOperation = {
    id?: string;
    action?: "upgrade" | "rollback";
    status: SystemUpdateOperationStatus;
    currentVersion?: string;
    targetVersion?: string;
    previousVersion?: string;
    startedAt?: string;
    updatedAt?: string;
    completedAt?: string;
    imageDigest?: string;
    error?: string;
    rollbackSucceeded?: boolean;
    pollAfterMs?: number;
};

export type SystemReleaseInfo = {
    version: string;
    name: string;
    body: string;
    publishedAt: string;
    htmlUrl: string;
};

export type SystemUpdateInfo = {
    currentVersion: string;
    latestVersion: string;
    hasUpdate: boolean;
    checkedAt: string;
    release?: SystemReleaseInfo;
    releaseCheck: {
        status: "succeeded" | "deferred" | "unavailable";
        reason?: string;
    };
    onlineUpgrade: {
        supported: boolean;
        reason?: string;
        operation: SystemUpdateOperation;
    };
};

export type SystemUpdateRequest = {
    action: "upgrade" | "rollback";
    targetVersion: string;
    idempotencyKey: string;
    confirmations: {
        databaseBackup: boolean;
        environmentReviewed: boolean;
        changelogReviewed: boolean;
        rollbackReviewed: boolean;
    };
};

export const SYSTEM_UPDATE_CONFIRMATION_KEYS = ["databaseBackup", "environmentReviewed", "changelogReviewed", "rollbackReviewed"] as const;

export function hasCompleteSystemUpdateConfirmations(value: unknown): value is SystemUpdateRequest["confirmations"] {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return Object.keys(record).length === SYSTEM_UPDATE_CONFIRMATION_KEYS.length && SYSTEM_UPDATE_CONFIRMATION_KEYS.every((key) => record[key] === true);
}

export function normalizeSystemVersion(value: unknown) {
    const match = typeof value === "string" ? value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/) : null;
    return match ? `v${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : "";
}

export function compareSystemVersions(left: string, right: string) {
    const a = normalizeSystemVersion(left).slice(1).split(".").map(Number);
    const b = normalizeSystemVersion(right).slice(1).split(".").map(Number);
    if (a.length !== 3 || b.length !== 3) return 0;
    for (let index = 0; index < 3; index += 1) {
        if (a[index] !== b[index]) return a[index] - b[index];
    }
    return 0;
}
