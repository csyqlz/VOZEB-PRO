"use client";

import type { TableColumnsType } from "antd";
import { App, Button, Grid, Input, Modal, Pagination, Select, Table, Tag } from "antd";
import { Check, RefreshCw, Search, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { AdminUserIdentity } from "@/components/admin/admin-user-identity";
import type { AccountDeletionRequestStatus, AdminAccountDeletionRequest } from "@/lib/account-deletion-contract";
import { listAdminAccountDeletionRequests, reviewAdminAccountDeletionRequest } from "@/services/api/account-deletion";

import { Panel, PanelHeader } from "./admin-panel";

const PAGE_SIZE = 20;

export function AdminAccountDeletionSection({ active }: { active: boolean }) {
    const { message } = App.useApp();
    const screens = Grid.useBreakpoint();
    const [items, setItems] = useState<AdminAccountDeletionRequest[]>([]);
    const [loading, setLoading] = useState(false);
    const [page, setPage] = useState(1);
    const [total, setTotal] = useState(0);
    const [keyword, setKeyword] = useState("");
    const [status, setStatus] = useState<AccountDeletionRequestStatus | undefined>("pending");
    const [reviewing, setReviewing] = useState<{ request: AdminAccountDeletionRequest; status: "accepted" | "rejected" } | null>(null);
    const [reviewNote, setReviewNote] = useState("");
    const [saving, setSaving] = useState(false);

    const load = useCallback(
        async (targetPage = 1) => {
            setLoading(true);
            try {
                const result = await listAdminAccountDeletionRequests({ page: targetPage, pageSize: PAGE_SIZE, keyword, status });
                setItems(result.items);
                setTotal(result.total);
                setPage(result.page);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "注销申请加载失败");
            } finally {
                setLoading(false);
            }
        },
        [keyword, message, status],
    );

    useEffect(() => {
        if (active) void load(1);
    }, [active, load]);

    const submitReview = async () => {
        if (!reviewing || !reviewNote.trim()) return;
        setSaving(true);
        try {
            await reviewAdminAccountDeletionRequest(reviewing.request.id, { status: reviewing.status, reviewNote });
            message.success(reviewing.status === "accepted" ? "注销申请已受理" : "注销申请已拒绝");
            setReviewing(null);
            setReviewNote("");
            await load(page);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "注销申请处理失败");
        } finally {
            setSaving(false);
        }
    };

    const openReview = (request: AdminAccountDeletionRequest, nextStatus: "accepted" | "rejected") => {
        setReviewing({ request, status: nextStatus });
        setReviewNote("");
    };

    if (!active) return null;

    const columns: TableColumnsType<AdminAccountDeletionRequest> = [
        {
            title: "用户",
            key: "user",
            render: (_, item) => <AdminUserIdentity displayName={item.displayName} username={item.username} accountId={item.accountId} />,
        },
        { title: "状态", dataIndex: "status", width: 90, render: (value: AccountDeletionRequestStatus) => <Tag color={statusColor(value)}>{statusLabel(value)}</Tag> },
        { title: "申请时间", dataIndex: "requestedAt", width: 170, render: formatTime },
        {
            title: "说明",
            key: "note",
            render: (_, item) => <span className="line-clamp-2 max-w-md text-sm text-zinc-600 dark:text-zinc-300">{item.note || item.reviewNote || "无"}</span>,
        },
        {
            title: "操作",
            key: "actions",
            width: 172,
            render: (_, item) =>
                item.status === "pending" ? (
                    <div className="flex gap-2">
                        <Button size="small" type="primary" icon={<Check className="size-3.5" />} onClick={() => openReview(item, "accepted")}>
                            受理
                        </Button>
                        <Button size="small" danger icon={<X className="size-3.5" />} onClick={() => openReview(item, "rejected")}>
                            拒绝
                        </Button>
                    </div>
                ) : (
                    <span className="text-xs text-zinc-400">{item.reviewedByUsername ? `${item.reviewedByUsername} 已处理` : "已处理"}</span>
                ),
        },
    ];

    return (
        <Panel variant="page">
            <PanelHeader
                title="注销申请"
                description="受理仅代表进入线下注销处理，不会自动停用账号或删除订单、创作数据和媒体。"
                actions={
                    <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void load(page)}>
                        刷新
                    </Button>
                }
            />
            <section className="admin-panel-surface min-w-0 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
                <div className="grid gap-2 border-b border-zinc-200 bg-zinc-50/50 p-3 md:grid-cols-[minmax(260px,360px)_160px_auto] md:items-center md:justify-start sm:p-4 dark:border-zinc-800 dark:bg-zinc-900/20">
                    <div className="min-w-0">
                        <Input className="w-full" allowClear prefix={<Search className="size-4 text-zinc-400" />} placeholder="搜索用户名、昵称、邮箱或用户 ID" value={keyword} onChange={(event) => setKeyword(event.target.value)} onPressEnter={() => void load(1)} />
                    </div>
                    <div className="min-w-0">
                        <Select
                            className="w-full"
                            allowClear
                            placeholder="全部状态"
                            value={status}
                            options={[
                                { value: "pending", label: "待处理" },
                                { value: "accepted", label: "已受理" },
                                { value: "rejected", label: "已拒绝" },
                                { value: "withdrawn", label: "已撤回" },
                            ]}
                            onChange={(value) => setStatus(value)}
                        />
                    </div>
                    <Button type="primary" icon={<Search className="size-4" />} onClick={() => void load(1)}>
                        查询
                    </Button>
                </div>

            {screens.md ? (
                <Table rowKey="id" columns={columns} dataSource={items} loading={loading} pagination={{ current: page, pageSize: PAGE_SIZE, total, showSizeChanger: false, hideOnSinglePage: true, onChange: (nextPage) => void load(nextPage) }} />
            ) : (
                <div className="space-y-2 p-3">
                    {items.map((item) => (
                        <article key={item.id} className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
                            <div className="flex min-w-0 items-start justify-between gap-3">
                                <AdminUserIdentity displayName={item.displayName} username={item.username} accountId={item.accountId} className="min-w-0" />
                                <Tag color={statusColor(item.status)}>{statusLabel(item.status)}</Tag>
                            </div>
                            <div className="mt-3 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                                {formatTime(item.requestedAt)}
                                {item.note ? ` · ${item.note}` : ""}
                            </div>
                            {item.status === "pending" ? (
                                <div className="mt-3 flex gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
                                    <Button className="flex-1" type="primary" icon={<Check className="size-3.5" />} onClick={() => openReview(item, "accepted")}>
                                        受理
                                    </Button>
                                    <Button className="flex-1" danger icon={<X className="size-3.5" />} onClick={() => openReview(item, "rejected")}>
                                        拒绝
                                    </Button>
                                </div>
                            ) : null}
                        </article>
                    ))}
                    {!loading && !items.length ? <div className="py-10 text-center text-sm text-zinc-400">暂无注销申请</div> : null}
                    {total > PAGE_SIZE ? <Pagination size="small" current={page} pageSize={PAGE_SIZE} total={total} showSizeChanger={false} onChange={(nextPage) => void load(nextPage)} /> : null}
                </div>
            )}
            </section>

            <Modal
                title={reviewing?.status === "accepted" ? "受理注销申请" : "拒绝注销申请"}
                open={Boolean(reviewing)}
                okText={reviewing?.status === "accepted" ? "确认受理" : "确认拒绝"}
                cancelText="取消"
                okButtonProps={{ danger: reviewing?.status === "rejected", disabled: !reviewNote.trim() }}
                confirmLoading={saving}
                onOk={() => void submitReview()}
                onCancel={() => {
                    if (saving) return;
                    setReviewing(null);
                    setReviewNote("");
                }}
            >
                <div className="space-y-3 pt-2">
                    <div className="text-sm leading-6 text-zinc-600 dark:text-zinc-300">{reviewing?.status === "accepted" ? "受理后申请进入线下身份复核和数据保留核对，不会立即删除账号。" : "拒绝后用户可看到处理备注，并可重新提交申请。"}</div>
                    <label className="block space-y-2">
                        <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">处理备注</span>
                        <Input.TextArea value={reviewNote} maxLength={1000} rows={4} showCount placeholder="必填，说明后续处理方式或拒绝原因" onChange={(event) => setReviewNote(event.target.value)} />
                    </label>
                </div>
            </Modal>
        </Panel>
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
