import type { PricingTaskReviewInput, getPricingTaskReview } from "@/lib/server/model-pricing-task-review-service";
export type PricingTaskReview = Awaited<ReturnType<typeof getPricingTaskReview>>;
export type { PricingTaskReviewInput };

async function request<T>(type: string, id: string, body?: PricingTaskReviewInput, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`/api/admin/generation-operations/${encodeURIComponent(type)}/${encodeURIComponent(id)}/billing-review`, {
        method: body ? "POST" : "GET",
        cache: "no-store",
        signal,
        ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    const payload = (await response.json()) as { code: number; data: T; msg: string };
    if (!response.ok || payload.code !== 0) throw new Error(payload.msg || "账务核对失败");
    return payload.data;
}
export const getTaskPricingReview = (type: string, id: string, signal?: AbortSignal) => request<PricingTaskReview>(type, id, undefined, signal);
export const submitTaskPricingReview = (type: string, id: string, body: PricingTaskReviewInput) => request<{ executionPhase: "completed" | "needs_review" }>(type, id, body);
