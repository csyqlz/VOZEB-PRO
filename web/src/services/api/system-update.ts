import type { SystemUpdateInfo, SystemUpdateOperation, SystemUpdateRequest } from "@/lib/system-update-contract";

type ApiResponse<T> = { code: number; data: T; msg: string };

export function getAdminSystemUpdate() {
    return request<SystemUpdateInfo>("/api/admin/system-update", { cache: "no-store" });
}

export function startAdminSystemUpdate(input: SystemUpdateRequest) {
    return request<{ operation: SystemUpdateOperation }>("/api/admin/system-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
    });
}

async function request<T>(url: string, init?: RequestInit) {
    const response = await fetch(url, init);
    const payload = (await response.json().catch(() => null)) as ApiResponse<T> | null;
    if (!response.ok || !payload?.data) throw new Error(payload?.msg || "版本更新请求失败");
    return payload.data;
}
