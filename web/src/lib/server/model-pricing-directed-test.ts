import { hasAdminPermission } from "@/lib/admin-permissions";
import type { PublicUser } from "@/lib/auth/store";
import { auditActorFromRequest, safeRecordAuditLog } from "./audit-log-store";

const HEADER = "x-vozeb-pro-pricing-test-binding";

export function selectDirectedPricingBinding<T extends { channelId?: string; model: string }>(request: Request, user: PublicUser, configs: T[]) {
    const key = request.headers.get(HEADER)?.trim();
    if (!key) return { directed: false as const, configs };
    if (!hasAdminPermission(user, "billing.manage")) return { directed: true as const, configs: [] as T[], error: "只有财务管理员可以定向验收渠道", status: 403 };
    const selected = configs.filter((config) => `${config.channelId}/${config.model}` === key);
    if (selected.length !== 1) return { directed: true as const, configs: [] as T[], error: "定向验收绑定不属于当前逻辑模型或当前操作", status: 400 };
    return { directed: true as const, configs: selected, key };
}

export async function auditDirectedPricingTask(request: Request, user: PublicUser, bindingKey: string | undefined, capability: string, taskId: string) {
    if (!bindingKey) return;
    await safeRecordAuditLog({
        action: "admin.model-pricing.directed-test",
        actor: auditActorFromRequest(request, user),
        target: { type: "generation_task", id: taskId },
        metadata: { capability, bindingKey },
    });
}
