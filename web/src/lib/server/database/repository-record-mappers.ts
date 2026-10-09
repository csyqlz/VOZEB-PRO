import { formatAccountId } from "@/lib/account-id";
import { normalizeRegistrationPolicyConsent } from "@/lib/registration-consent";
import { normalizeAdminPermissions } from "@/lib/admin-permissions";

import type {
    AnnouncementRecord,
    CdkCodeRecord,
    CdkRedemptionRecord,
    DailyPlanPointWalletRecord,
    EmailCodeRecord,
    GenerationLogAssetRecord,
    GenerationLogRecord,
    JsonValue,
    PointRecord,
    PromptRecord,
    QuotaUsageRecord,
    SessionRecord,
    UsageKind,
    UserRecord,
} from "./repository-shared";

export function dateValue(value: unknown) {
    if (value instanceof Date) {
        const year = value.getFullYear();
        const month = String(value.getMonth() + 1).padStart(2, "0");
        const day = String(value.getDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
    }
    return String(value || "").slice(0, 10);
}

export function usageKindValue(value: unknown): UsageKind {
    return value === "image" || value === "video" || value === "audio" || value === "text" ? value : "api";
}

export function jsonValue(value: unknown): JsonValue {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") {
        try {
            return JSON.parse(value) as JsonValue;
        } catch {
            return value;
        }
    }
    return value as JsonValue;
}

export function optionalJson(value: unknown): JsonValue | undefined {
    if (value === null || value === undefined) return undefined;
    return jsonValue(value);
}

export function stringValue(value: unknown) {
    return String(value ?? "");
}

export function optionalString(value: unknown) {
    return value === null || value === undefined || value === "" ? undefined : String(value);
}

export function numberValue(value: unknown) {
    return Number(value || 0);
}

export function optionalNumber(value: unknown) {
    return value === null || value === undefined ? undefined : Number(value);
}

export function isoValue(value: unknown) {
    return value instanceof Date ? value.toISOString() : String(value || new Date().toISOString());
}

export function optionalIso(value: unknown) {
    if (value === null || value === undefined || value === "") return undefined;
    return value instanceof Date ? value.toISOString() : String(value);
}
export function mapUser(row: Record<string, unknown>): UserRecord {
    return {
        id: stringValue(row.id),
        accountId: formatAccountId(row.account_id),
        username: stringValue(row.username),
        email: optionalString(row.email),
        displayName: stringValue(row.display_name),
        bio: stringValue(row.bio),
        avatarStorageKey: optionalString(row.avatar_storage_key),
        role: row.role === "admin" ? "admin" : "user",
        adminPermissions: row.role === "admin" ? normalizeAdminPermissions(jsonValue(row.admin_permissions)) : [],
        status: row.status === "disabled" ? "disabled" : "active",
        planId: stringValue(row.plan_id),
        pointsBalance: numberValue(row.points_balance),
        passwordHash: stringValue(row.password_hash),
        mfaSecretCiphertext: optionalString(row.mfa_secret_ciphertext),
        mfaEnabledAt: optionalIso(row.mfa_enabled_at),
        registrationConsent: normalizeRegistrationPolicyConsent({
            termsVersion: row.terms_version,
            termsUrl: row.terms_url,
            privacyVersion: row.privacy_version,
            privacyUrl: row.privacy_url,
            acceptedAt: row.policy_accepted_at,
        }),
        lastLoginAt: optionalIso(row.last_login_at),
        createdAt: isoValue(row.created_at),
        updatedAt: isoValue(row.updated_at),
    };
}

export function mapSession(row: Record<string, unknown>): SessionRecord {
    return {
        id: stringValue(row.id),
        userId: stringValue(row.user_id),
        tokenHash: stringValue(row.token_hash),
        createdAt: isoValue(row.created_at),
        expiresAt: isoValue(row.expires_at),
    };
}

export function mapEmailCode(row: Record<string, unknown>): EmailCodeRecord {
    return {
        id: stringValue(row.id),
        purpose: row.purpose === "email-change" || row.purpose === "password-reset" ? row.purpose : "register",
        email: stringValue(row.email),
        userId: optionalString(row.user_id),
        codeHash: stringValue(row.code_hash),
        createdAt: isoValue(row.created_at),
        expiresAt: isoValue(row.expires_at),
        consumedAt: optionalIso(row.consumed_at),
        attempts: numberValue(row.attempts),
    };
}

export function mapPointRecord(row: Record<string, unknown>): PointRecord {
    const amount = numberValue(row.amount);
    const balanceAfter = numberValue(row.balance_after);
    return {
        id: stringValue(row.id),
        userId: stringValue(row.user_id),
        type: row.type === "consume" || row.type === "refund" || row.type === "credit" ? row.type : "admin-adjust",
        amount,
        balanceAfter,
        permanentAmount: row.permanent_amount === undefined ? amount : numberValue(row.permanent_amount),
        dailyAmount: numberValue(row.daily_amount),
        permanentBalanceAfter: row.permanent_balance_after === undefined ? balanceAfter : numberValue(row.permanent_balance_after),
        dailyBalanceAfter: numberValue(row.daily_balance_after),
        description: stringValue(row.description),
        model: optionalString(row.model),
        idempotencyKey: optionalString(row.idempotency_key),
        requestFingerprint: optionalString(row.request_fingerprint),
        sourceRecordId: optionalString(row.source_record_id),
        sourceDate: row.source_date === null || row.source_date === undefined ? undefined : dateValue(row.source_date),
        createdAt: isoValue(row.created_at),
    };
}

export function mapDailyPlanPointWallet(row: Record<string, unknown>): DailyPlanPointWalletRecord {
    return {
        userId: stringValue(row.user_id),
        date: dateValue(row.date),
        planId: stringValue(row.plan_id),
        assignmentId: optionalString(row.assignment_id),
        grantedPoints: numberValue(row.granted_points),
        remainingPoints: numberValue(row.remaining_points),
        createdAt: isoValue(row.created_at),
        updatedAt: isoValue(row.updated_at),
    };
}

export function mapQuotaUsage(row: Record<string, unknown>): QuotaUsageRecord {
    return {
        userId: stringValue(row.user_id),
        date: dateValue(row.date),
        usageKind: usageKindValue(row.usage_kind),
        pointsSpent: numberValue(row.points_spent),
        units: numberValue(row.units),
        updatedAt: isoValue(row.updated_at),
    };
}

export function mapCdkCode(row: Record<string, unknown>): CdkCodeRecord {
    return {
        id: stringValue(row.id),
        codeHash: stringValue(row.code_hash),
        codePreview: stringValue(row.code_preview),
        points: numberValue(row.points),
        maxRedemptions: numberValue(row.max_redemptions),
        redeemedCount: numberValue(row.redeemed_count),
        status: row.status === "disabled" ? "disabled" : "active",
        note: stringValue(row.note),
        expiresAt: optionalIso(row.expires_at),
        createdAt: isoValue(row.created_at),
        updatedAt: isoValue(row.updated_at),
    };
}

export function mapCdkRedemption(row: Record<string, unknown>): CdkRedemptionRecord {
    return {
        cdkCodeId: stringValue(row.cdk_code_id),
        userId: stringValue(row.user_id),
        redeemedAt: isoValue(row.redeemed_at),
    };
}

export function mapAnnouncement(row: Record<string, unknown>): AnnouncementRecord {
    return {
        id: stringValue(row.id),
        title: stringValue(row.title),
        content: stringValue(row.content),
        enabled: row.enabled !== false,
        popupHome: row.popup_home === true,
        popupAfterLogin: row.popup_after_login === true,
        startsAt: optionalIso(row.starts_at),
        endsAt: optionalIso(row.ends_at),
        createdAt: isoValue(row.created_at),
        updatedAt: isoValue(row.updated_at),
    };
}

export function mapPrompt(row: Record<string, unknown>): PromptRecord {
    return {
        id: stringValue(row.id),
        scope: row.scope === "user" ? "user" : "library",
        ownerUserId: optionalString(row.owner_user_id),
        title: stringValue(row.title),
        coverUrl: stringValue(row.cover_url),
        prompt: stringValue(row.prompt),
        tags: jsonValue(row.tags),
        category: stringValue(row.category),
        preview: stringValue(row.preview),
        githubUrl: optionalString(row.github_url),
        source: optionalString(row.source),
        createdAt: isoValue(row.created_at),
        updatedAt: isoValue(row.updated_at),
    };
}

export function mapGenerationLog(row: Record<string, unknown>): GenerationLogRecord {
    return {
        id: stringValue(row.id),
        userId: stringValue(row.user_id),
        conversationId: optionalString(row.conversation_id),
        username: stringValue(row.username),
        displayName: stringValue(row.display_name),
        kind: row.kind === "video" ? "video" : "image",
        source: stringValue(row.source),
        status: row.status === "pending" || row.status === "failed" ? row.status : "success",
        title: stringValue(row.title),
        prompt: stringValue(row.prompt),
        model: stringValue(row.model),
        summary: stringValue(row.summary),
        durationMs: numberValue(row.duration_ms),
        count: numberValue(row.count),
        successCount: numberValue(row.success_count),
        failCount: numberValue(row.fail_count),
        assets: [],
        requestSnapshot: jsonValue(row.request_snapshot),
        ecommerceTrace: jsonValue(row.ecommerce_trace),
        taskId: optionalString(row.task_id),
        error: optionalString(row.error),
        createdAt: isoValue(row.created_at),
        updatedAt: isoValue(row.updated_at),
        completedAt: optionalIso(row.completed_at),
    };
}

export function mapGenerationLogAsset(row: Record<string, unknown>): GenerationLogAssetRecord {
    return {
        type: row.type === "video" ? "video" : "image",
        url: stringValue(row.url),
        remoteUrl: optionalString(row.remote_url),
        serverUrl: optionalString(row.server_url),
        mimeType: optionalString(row.mime_type),
        width: optionalNumber(row.width),
        height: optionalNumber(row.height),
        bytes: optionalNumber(row.bytes),
    };
}
