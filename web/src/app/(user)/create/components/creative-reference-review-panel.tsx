"use client";

import { Alert, Button, Checkbox, Radio } from "antd";
import { useRef, useState } from "react";
import type { CreativeReferenceRecovery, CreativeReferenceReview, EcommerceReferencePurpose } from "@/lib/creative-runtime-contract";
import { imagePreviewUrl } from "@/lib/media-image-url";

const purposeLabels: Record<EcommerceReferencePurpose, string> = { edit_target: "修改这张图", product_identity: "保留商品身份", style: "参考风格", lighting: "参考光线", composition: "参考构图" };

export function CreativeReferenceReviewPanel({ runId, review, onRecover }: { runId: string; review: CreativeReferenceReview; onRecover: (runId: string, recovery: CreativeReferenceRecovery) => Promise<void> }) {
    const [target, setTarget] = useState(() => review.assets.find((asset) => asset.purposes.includes("edit_target") && asset.allowedPurposes.includes("edit_target"))?.assetId || review.inheritedEditTarget?.assetId);
    const [purposes, setPurposes] = useState<Record<string, EcommerceReferencePurpose[]>>(() =>
        Object.fromEntries(review.assets.map((asset) => [asset.assetId, asset.purposes.filter((purpose) => purpose !== "edit_target" && asset.allowedPurposes.includes(purpose))])),
    );
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const pending = useRef(false);
    const bindings = review.assets.map((asset) => ({ assetId: asset.assetId, assetVersion: asset.assetVersion, purposes: [...(target === asset.assetId ? ["edit_target" as const] : []), ...(purposes[asset.assetId] || [])] }));
    const canConfirm = Boolean(target) && bindings.every((binding) => binding.purposes.length > 0);
    const recover = async () => {
        if (pending.current || (review.kind === "confirm_purposes" && !canConfirm)) return;
        pending.current = true;
        setLoading(true);
        setError("");
        try {
            await onRecover(runId, review.kind === "confirm_purposes" ? { reviewId: review.reviewId, action: "confirm_purposes", decisionVersion: "ecommerce-reference-decision.v1", bindings } : { reviewId: review.reviewId, action: review.kind });
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : "参考复核未完成，请重试。");
        } finally {
            pending.current = false;
            setLoading(false);
        }
    };
    return (
        <div className="mt-3 min-w-0 space-y-3" data-testid="creative-reference-review" data-review-id={review.reviewId}>
            <Radio.Group value={target} onChange={(event) => setTarget(event.target.value)} disabled={loading} className="!block !w-full">
                <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                    {review.kind === "confirm_purposes" && review.inheritedEditTarget ? (
                        <div className="min-w-0 rounded-xl border border-stone-200 p-3 dark:border-stone-700" data-testid="creative-reference-review-inherited-target">
                            <img src={imagePreviewUrl(review.inheritedEditTarget.previewUrl, 320)} alt="当前图片" className="mb-2 h-28 w-full rounded-lg bg-stone-100 object-contain dark:bg-stone-800" />
                            <Radio value={review.inheritedEditTarget.assetId}>继续修改当前图片</Radio>
                        </div>
                    ) : null}
                    {review.assets.map((asset) => (
                        <div key={asset.assetId} className="min-w-0 rounded-xl border border-stone-200 p-3 dark:border-stone-700" data-testid="creative-reference-review-asset">
                            {/* Public review URLs are owned application paths. */}
                            <img src={imagePreviewUrl(asset.previewUrl, 320)} alt={asset.alias} className="mb-2 h-28 w-full rounded-lg bg-stone-100 object-contain dark:bg-stone-800" />
                            <p className="mb-2 text-sm font-medium">{asset.alias}</p>
                            {review.kind === "confirm_purposes" ? (
                                <div className="space-y-2">
                                    {asset.allowedPurposes.includes("edit_target") ? <Radio value={asset.assetId}>{purposeLabels.edit_target}</Radio> : null}
                                    <div role="group" aria-label={`${asset.alias}的参考用途`} className="flex flex-col items-start gap-2">
                                        {asset.allowedPurposes
                                            .filter((purpose) => purpose !== "edit_target")
                                            .map((purpose) => (
                                                <Checkbox
                                                    key={purpose}
                                                    value={purpose}
                                                    checked={(purposes[asset.assetId] || []).includes(purpose)}
                                                    disabled={loading}
                                                    onChange={(event) => {
                                                        const checked = event.target.checked;
                                                        setPurposes((current) => ({
                                                            ...current,
                                                            [asset.assetId]: asset.allowedPurposes.filter((value) => value !== "edit_target" && (value === purpose ? checked : (current[asset.assetId] || []).includes(value))),
                                                        }));
                                                    }}
                                                >
                                                    {purposeLabels[purpose]}
                                                </Checkbox>
                                            ))}
                                    </div>
                                </div>
                            ) : null}
                        </div>
                    ))}
                </div>
            </Radio.Group>
            {error ? <Alert type="error" showIcon title={error} /> : null}
            <Button type="primary" loading={loading} disabled={loading || (review.kind === "confirm_purposes" && !canConfirm)} onClick={() => void recover()}>
                {review.kind === "confirm_purposes" ? "确认用途并继续" : review.kind === "retry_source" ? "重试并继续" : "重新分析"}
            </Button>
        </div>
    );
}
