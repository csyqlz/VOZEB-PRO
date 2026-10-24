"use client";

import { App, Input, Modal } from "antd";
import { useEffect, useState } from "react";
import type { AdminGenerationTask } from "@/lib/admin-generation-operations";
import { getTaskPricingReview, submitTaskPricingReview, type PricingTaskReview, type PricingTaskReviewInput } from "@/services/api/pricing-task-review";
import { generationOperationThemeClasses as theme } from "./generation-operations-theme";

export function PricingTaskReviewModal({ task, onClose, onComplete }: { task: AdminGenerationTask; onClose(): void; onComplete(): Promise<void> }) {
    const { message } = App.useApp();
    const [view, setView] = useState<PricingTaskReview>();
    const [error, setError] = useState("");
    const [action, setAction] = useState<PricingTaskReviewInput["action"]>("resume_billing");
    const [evidence, setEvidence] = useState("");
    const [response, setResponse] = useState("");
    const [cacheWrite5mTokens, setCacheWrite5mTokens] = useState("");
    const [cacheWrite1hTokens, setCacheWrite1hTokens] = useState("");
    const [busy, setBusy] = useState(false);
    const [opened, setOpened] = useState(false);
    const canProvideResult = !view || !("canProvideResult" in view) || view.canProvideResult;
    const canConfirmNoCharge = !view || !("canConfirmNoCharge" in view) || view.canConfirmNoCharge;
    const usesCacheWriteTtl = view && "usesCacheWriteTtl" in view && view.usesCacheWriteTtl;
    const supplyCacheWriteTtl = action === "provide_metered_result" && view && "canSupplyCacheWriteTtl" in view && view.canSupplyCacheWriteTtl;
    const needsResponse = action === "correct_metered_result" || (action === "provide_metered_result" && !supplyCacheWriteTtl);
    useEffect(() => {
        const controller = new AbortController();
        void getTaskPricingReview(task.type, task.id, controller.signal)
            .then((data) => {
                if (!controller.signal.aborted) {
                    setView(data);
                    if ("knownCacheWrite5mTokens" in data) setCacheWrite5mTokens(data.knownCacheWrite5mTokens || "");
                    if ("knownCacheWrite1hTokens" in data) setCacheWrite1hTokens(data.knownCacheWrite1hTokens || "");
                }
            })
            .catch((error: unknown) => {
                if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "账务读取失败");
            });
        return () => controller.abort();
    }, [task.id, task.type]);
    const submit = async () => {
        if (!view || busy || !opened) return;
        setBusy(true);
        try {
            const result = await submitTaskPricingReview(
                task.type,
                task.id,
                action === "resume_billing"
                    ? { action, attemptNo: view.attemptNo }
                    : action !== "provide_metered_result" && action !== "correct_metered_result"
                      ? { action, attemptNo: view.attemptNo, evidence }
                      : { action, attemptNo: view.attemptNo, evidence, response, ...(usesCacheWriteTtl ? { ...(cacheWrite5mTokens ? { cacheWrite5mTokens } : {}), ...(cacheWrite1hTokens ? { cacheWrite1hTokens } : {}) } : {}) },
            );
            if (result.executionPhase === "completed") {
                message.success("原任务账务已处理完成");
                onClose();
            } else {
                message.info("原账务仍待核对，已保留预留和处理依据");
                setAction("resume_billing");
                setView(await getTaskPricingReview(task.type, task.id));
            }
            await onComplete();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "账务核对失败");
        } finally {
            setBusy(false);
        }
    };
    return (
        <Modal
            open
            afterOpenChange={setOpened}
            title="核对按量账务"
            centered
            width="min(600px, calc(100vw - 24px))"
            destroyOnHidden
            confirmLoading={busy}
            onCancel={() => !busy && onClose()}
            onOk={() => void submit()}
            okText={action === "stop_preparation" ? "撤销准备并退回" : action === "confirm_no_charge" ? "确认未计费并退回" : "确认并恢复"}
            okButtonProps={{
                danger: action === "confirm_no_charge",
                className: action === "confirm_no_charge" ? undefined : theme.primaryButton,
                disabled:
                    !opened ||
                    !view ||
                    (action === "resume_billing" && !view.canResumeBilling) ||
                    (action !== "resume_billing" && (!evidence.trim() || (needsResponse && !response.trim()) || (supplyCacheWriteTtl && (!cacheWrite5mTokens || !cacheWrite1hTokens)))),
            }}
            cancelButtonProps={{ className: theme.secondaryButton }}
        >
            <div className="min-w-0 space-y-4 pt-2">
                <div className={theme.reviewPanel}>
                    {task.type === "audio"
                        ? "音频补录须包含原请求的完整音频与计量；已有音频的字节、格式及候选位置不能替换。更正须保留原矛盾用量，确认未计费须附供应商证明且没有原响应。审核按原价格处理，不会重新生成。"
                        : task.type === "video"
                          ? "视频补录必须对应原创建任务，包含完整终态用量和原视频地址；缺少原创建确认时不能补猜身份。矛盾用量更正须保留原任务、计费范围及结果，确认未计费须附供应商证明。不会重新生成。"
                          : task.type === "image"
                            ? "图片补录须包含供应商原请求的完整结果 URL，并按原价目和数量上界核对；确认未计费须附明确证明。原响应和审核依据均保留，不会重新生成。"
                            : "仅处理原请求的账务，不会再次调用模型。补录须基于已保存的原响应或供应商完整响应；确认未计费必须附明确证明，不能用超时、取消或失败描述代替。"}
                </div>
                {error ? (
                    <p role="alert">{error}</p>
                ) : !view ? (
                    <p role="status">正在读取原账务…</p>
                ) : (
                    <>
                        <div className="space-y-1 break-all text-xs text-zinc-600 dark:text-zinc-300">
                            <p>
                                模型 {view.model} · 第 {view.attemptNo} 次尝试 · 预留 {view.heldPoints ?? "尚未确认"} 积分
                            </p>
                            <p>
                                {view.pending ? "原账务仍待处理" : "原账务已处理"} · {view.hasSavedResponse ? "已有响应凭据" : "尚无完整响应凭据"}
                                {view.reviewed ? " · 已保存人工核对依据" : ""}
                            </p>
                            <p>
                                官方价版本 {view.officialVersionId || "未确认"} · 售价版本 {view.salesVersionId || "未确认"}
                            </p>
                        </div>
                        {view.canStopPreparation ? <p className="text-sm">尚无上游提交许可。撤销准备会阻止原执行器继续预留或提交，退回已预留积分，并结束本次尝试。</p> : null}
                        {view.invalidUsage ? <p className="text-sm">原用量矛盾：{view.invalidUsage}。更正需供应商明确凭据，原响应和公开结果将保留；型号、计费范围及原请求上界仍须一致。</p> : null}
                        <div className={`grid gap-2 ${view.canStopPreparation || view.canCorrectUsage || !view.canReviewSubmission || !canProvideResult ? "grid-cols-2" : "grid-cols-3"}`}>
                            {(
                                [
                                    { value: "resume_billing", label: "恢复已有凭据" },
                                    ...(view.canStopPreparation
                                        ? ([{ value: "stop_preparation", label: "撤销未提交准备" }] as const)
                                        : view.canReviewSubmission
                                          ? ([
                                                { value: "provide_metered_result", label: "canSupplyCacheWriteTtl" in view && view.canSupplyCacheWriteTtl ? "补齐分档" : "补录完整响应" },
                                                { value: "confirm_no_charge", label: "确认未计费" },
                                            ] as const)
                                          : []),
                                    ...(view.canCorrectUsage ? ([{ value: "correct_metered_result", label: "更正矛盾用量" }] as const) : []),
                                ] as const
                            )
                                .filter((item) => (item.value !== "provide_metered_result" || canProvideResult) && (item.value !== "confirm_no_charge" || canConfirmNoCharge))
                                .map((item) => (
                                    <button
                                        key={item.value}
                                        type="button"
                                        disabled={!opened || busy || (item.value === "resume_billing" && !view.canResumeBilling) || (item.value !== "resume_billing" && (view.reviewed || !view.pending))}
                                        className={`min-h-10 rounded-lg border px-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm ${action === item.value ? theme.selectedAction : theme.idleAction}`}
                                        onClick={() => setAction(item.value)}
                                    >
                                        {item.label}
                                    </button>
                                ))}
                        </div>
                        {needsResponse ? (
                            <label className="block space-y-2 text-sm">
                                供应商完整响应 JSON
                                <Input.TextArea aria-label="供应商完整响应 JSON" className={theme.textarea} value={response} onChange={(event) => setResponse(event.target.value)} autoSize={{ minRows: 4, maxRows: 8 }} />
                            </label>
                        ) : null}
                        {(needsResponse || supplyCacheWriteTtl) && usesCacheWriteTtl ? (
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                <label className="block space-y-2 text-sm">
                                    5 分钟缓存写入 Token
                                    <Input aria-label="5 分钟缓存写入 Token" className={theme.textarea} value={cacheWrite5mTokens} onChange={(event) => setCacheWrite5mTokens(event.target.value)} inputMode="numeric" />
                                </label>
                                <label className="block space-y-2 text-sm">
                                    1 小时缓存写入 Token
                                    <Input aria-label="1 小时缓存写入 Token" className={theme.textarea} value={cacheWrite1hTokens} onChange={(event) => setCacheWrite1hTokens(event.target.value)} inputMode="numeric" />
                                </label>
                            </div>
                        ) : null}
                        {supplyCacheWriteTtl ? <p className="text-xs text-zinc-600 dark:text-zinc-300">原公开响应已保存；按供应商账单或响应头填入两档数量，无需再次粘贴完整响应。</p> : null}
                        {action !== "resume_billing" ? (
                            <label className="block space-y-2 text-sm">
                                核对依据
                                <Input.TextArea
                                    aria-label="核对依据"
                                    className={theme.textarea}
                                    value={evidence}
                                    onChange={(event) => setEvidence(event.target.value)}
                                    autoSize={{ minRows: 2, maxRows: 4 }}
                                    placeholder={action === "stop_preparation" ? "填写排障记录与撤销原因；不要填写密钥或内部提示词" : "填写供应商账单、工单或未计费证明的编号和核对结论；不要填写密钥或内部提示词"}
                                />
                            </label>
                        ) : null}
                    </>
                )}
            </div>
        </Modal>
    );
}
