"use client";

import { useEffect, useState } from "react";
import { App, Button, Input, Modal, Popconfirm, Tag } from "antd";
import { RotateCcw, UserRoundX } from "lucide-react";

import type { AccountDeletionRequestStatus, AccountDeletionRequestView } from "@/lib/account-deletion-contract";
import { getOwnAccountDeletionRequest, submitOwnAccountDeletionRequest, withdrawOwnAccountDeletionRequest } from "@/services/api/account-deletion";

import { profileDangerButtonClass, profileSecondaryButtonClass } from "./profile-elements";

export function AccountDeletionPanel() {
    const { message } = App.useApp();
    const [request, setRequest] = useState<AccountDeletionRequestView | null>(null);
    const [loading, setLoading] = useState(true);
    const [modalOpen, setModalOpen] = useState(false);
    const [currentPassword, setCurrentPassword] = useState("");
    const [note, setNote] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [withdrawing, setWithdrawing] = useState(false);

    useEffect(() => {
        void loadRequest();
    }, []);

    const loadRequest = async () => {
        setLoading(true);
        try {
            setRequest(await getOwnAccountDeletionRequest());
        } catch (error) {
            message.error(error instanceof Error ? error.message : "注销申请状态加载失败");
        } finally {
            setLoading(false);
        }
    };

    const submitRequest = async () => {
        setSubmitting(true);
        try {
            const result = await submitOwnAccountDeletionRequest({ currentPassword, note });
            setRequest(result);
            setModalOpen(false);
            setCurrentPassword("");
            setNote("");
            message.success("注销申请已提交");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "注销申请提交失败");
        } finally {
            setSubmitting(false);
        }
    };

    const withdrawRequest = async () => {
        setWithdrawing(true);
        try {
            setRequest(await withdrawOwnAccountDeletionRequest());
            message.success("注销申请已撤回");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "注销申请撤回失败");
        } finally {
            setWithdrawing(false);
        }
    };

    const pending = request?.status === "pending";
    const accepted = request?.status === "accepted";

    return (
        <div className="border-t border-stone-200 pt-5 dark:border-stone-800">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-semibold text-stone-950 dark:text-white">账号注销</h3>
                        {request ? <Tag color={statusColor(request.status)}>{statusLabel(request.status)}</Tag> : null}
                    </div>
                    <p className="mt-1 max-w-xl text-sm leading-6 text-stone-500 dark:text-stone-400">提交后由平台人工核验。受理只代表进入注销处理，不会立即删除订单、支付记录或仍需保留的数据。</p>
                    {request ? (
                        <div className="mt-3 space-y-1 text-xs leading-5 text-stone-500 dark:text-stone-400">
                            <div>申请时间：{formatTime(request.requestedAt)}</div>
                            {request.reviewNote ? <div className="break-words">处理备注：{request.reviewNote}</div> : null}
                        </div>
                    ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                    {pending ? (
                        <Popconfirm title="撤回注销申请？" description="撤回后账号继续正常使用，之后仍可重新提交。" okText="撤回" cancelText="取消" onConfirm={() => void withdrawRequest()}>
                            <Button className={profileSecondaryButtonClass} loading={withdrawing} icon={<RotateCcw className="size-4" />}>
                                撤回申请
                            </Button>
                        </Popconfirm>
                    ) : (
                        <Button danger className={profileDangerButtonClass} disabled={loading || accepted} icon={<UserRoundX className="size-4" />} onClick={() => setModalOpen(true)}>
                            {accepted ? "已进入处理" : "申请注销"}
                        </Button>
                    )}
                </div>
            </div>

            <Modal
                title="申请注销账号"
                open={modalOpen}
                okText="提交申请"
                cancelText="取消"
                okButtonProps={{ danger: true, disabled: !currentPassword.trim() }}
                confirmLoading={submitting}
                mask={{ closable: !submitting }}
                keyboard={!submitting}
                onOk={() => void submitRequest()}
                onCancel={() => {
                    if (submitting) return;
                    setModalOpen(false);
                    setCurrentPassword("");
                    setNote("");
                }}
            >
                <div className="space-y-4 pt-2">
                    <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm leading-6 text-red-800 dark:border-red-950 dark:bg-red-950/35 dark:text-red-200">
                        平台会核对创作数据、媒体引用和订单保留要求。正式执行前可能需要进一步身份复核。
                    </div>
                    <label className="block space-y-2">
                        <span className="text-sm font-medium text-stone-700 dark:text-stone-200">当前密码</span>
                        <Input.Password value={currentPassword} autoComplete="current-password" placeholder="用于确认是本人操作" onChange={(event) => setCurrentPassword(event.target.value)} />
                    </label>
                    <label className="block space-y-2">
                        <span className="text-sm font-medium text-stone-700 dark:text-stone-200">补充说明（选填）</span>
                        <Input.TextArea value={note} maxLength={500} rows={3} showCount placeholder="可填写注销原因或需要平台注意的事项" onChange={(event) => setNote(event.target.value)} />
                    </label>
                </div>
            </Modal>
        </div>
    );
}

function statusLabel(status: AccountDeletionRequestStatus) {
    if (status === "pending") return "待处理";
    if (status === "accepted") return "已受理";
    if (status === "rejected") return "已拒绝";
    return "已撤回";
}

function statusColor(status: AccountDeletionRequestStatus) {
    if (status === "pending") return "gold";
    if (status === "accepted") return "blue";
    if (status === "rejected") return "red";
    return "default";
}

function formatTime(value: string) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "-";
}
