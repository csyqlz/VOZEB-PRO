import type { VozebCmsModuleId, VozebCmsModuleView } from "@/lib/vozeb-cms/module-contract";

type ApiResponse<T> = { code: number; data: T; msg: string };

export function listAdminVozebCmsModules() {
    return request<{ modules: VozebCmsModuleView[] }>("/api/admin/modules", { cache: "no-store" }).then((data) => data.modules);
}

export function updateAdminVozebCmsModule(input: { moduleId: VozebCmsModuleId; enabled: boolean; baseRevision: number; mutationId: string }) {
    return request<{ module: VozebCmsModuleView; modules: VozebCmsModuleView[] }>("/api/admin/modules", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
    });
}

async function request<T>(url: string, init?: RequestInit) {
    const response = await fetch(url, init);
    const payload = (await response.json().catch(() => null)) as ApiResponse<T> | { error?: string } | null;
    if (!response.ok || !payload || !("data" in payload)) throw new Error((payload && "msg" in payload && payload.msg) || (payload && "error" in payload && payload.error) || "模块请求失败");
    return payload.data;
}
