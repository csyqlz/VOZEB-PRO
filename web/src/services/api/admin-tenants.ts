import type { TenantListItem, TenantMemberItem, TenantRecord } from "@/lib/tenant";
import { serializeApiParams } from "@/services/api/request";

type ApiResponse<T> = { code: number; data: T; msg: string };
export type TenantPage = { items: TenantListItem[]; total: number; page: number; pageSize: number };

export async function listAdminTenants(input: { page?: number; pageSize?: number; keyword?: string } = {}) {
    const query = serializeApiParams(input);
    return request<TenantPage>(`/api/admin/tenants${query.size ? `?${query}` : ""}`);
}

export function createAdminTenant(input: { name: string; slug: string; owner: { username: string; displayName?: string; email?: string; password: string } }) {
    return request<{ tenant: TenantRecord; owner: TenantMemberItem }>("/api/admin/tenants", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
}

export function renameAdminTenant(id: string, name: string) {
    return request<{ tenant: TenantRecord }>(`/api/admin/tenants/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
}

async function request<T>(url: string, init?: RequestInit) {
    const response = await fetch(url, { cache: "no-store", ...init });
    const payload = (await response.json().catch(() => null)) as ApiResponse<T> | null;
    if (!response.ok || !payload) throw new Error(payload?.msg || "请求失败");
    return payload.data;
}
