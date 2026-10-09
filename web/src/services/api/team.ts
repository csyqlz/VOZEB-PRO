import type { TeamOverviewSummary, TenantContext, TenantMemberItem, TenantMembershipStatus } from "@/lib/tenant";
import type { TenantRole } from "@/lib/tenant-permissions";
import { serializeApiParams } from "@/services/api/request";

type ApiResponse<T> = { code: number; data: T; msg: string };
export type TenantAuditItem = { id: string; action: string; status: "success" | "failure"; actorUsername?: string; targetLabel?: string; createdAt: string };
export type TenantMemberPage = { tenant: TenantContext; items: TenantMemberItem[]; total: number; page: number; pageSize: number };

export function getTeamOverview() {
    return request<{ tenant: TenantContext; overview: TeamOverviewSummary }>("/api/team/overview");
}

export function listTeamMembers(input: { page?: number; pageSize?: number; keyword?: string; status?: TenantMembershipStatus } = {}) {
    const query = serializeApiParams(input);
    return request<TenantMemberPage>(`/api/team/members${query.size ? `?${query}` : ""}`);
}

export function createTeamMember(input: { username: string; displayName?: string; email?: string; password: string; role: Exclude<TenantRole, "owner"> }) {
    return request<{ member: TenantMemberItem }>("/api/team/members", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
}

export function updateTeamMember(userId: string, patch: { role?: Exclude<TenantRole, "owner">; status?: TenantMembershipStatus }) {
    return request<{ member: TenantMemberItem }>(`/api/team/members/${encodeURIComponent(userId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
}

export function listTeamAuditLogs(input: { page?: number; pageSize?: number; keyword?: string } = {}) {
    const query = serializeApiParams(input);
    return request<{ tenant: TenantContext; items: TenantAuditItem[]; total: number; page: number; pageSize: number }>(`/api/team/audit-logs${query.size ? `?${query}` : ""}`);
}

async function request<T>(url: string, init?: RequestInit) {
    const response = await fetch(url, { cache: "no-store", ...init });
    const payload = (await response.json().catch(() => null)) as ApiResponse<T> | null;
    if (!response.ok || !payload) throw new Error(payload?.msg || "请求失败");
    return payload.data;
}
