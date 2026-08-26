"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { App, Button, Form, Input, InputNumber, Modal, Pagination, Segmented, Select, Switch, Tag } from "antd";
import { RefreshCw, Save, Settings2, ShieldCheck, Sparkles, UserPlus } from "lucide-react";

import { AdminAccountId } from "@/components/admin/admin-user-identity";
import {
    getAdminReferralOverview,
    listAdminReferralCouponTemplates,
    listAdminReferralRelationships,
    listAdminReferralRewards,
    saveAdminReferralProgram,
    settleAdminReferralRewards,
    updateAdminReferralRelationship,
    type ReferralProgram,
    type ReferralRelationship,
    type ReferralReward,
    type ReferralRewardStatus,
    type ReferralRiskStatus,
} from "@/services/api/referrals";

const PAGE_SIZE = 20;

type Overview = Awaited<ReturnType<typeof getAdminReferralOverview>>;
type CouponTemplates = Awaited<ReturnType<typeof listAdminReferralCouponTemplates>>["templates"];
type ProgramForm = Omit<ReferralProgram, "minimumPaidCents"> & { minimumPaidYuan: number };

export function ReferralRewardsPanel() {
    const { message, modal } = App.useApp();
    const [form] = Form.useForm<ProgramForm>();
    const inviteeRewardType = Form.useWatch("inviteeRewardType", form);
    const [overview, setOverview] = useState<Overview | null>(null);
    const [relationships, setRelationships] = useState<ReferralRelationship[]>([]);
    const [rewards, setRewards] = useState<ReferralReward[]>([]);
    const [relationshipTotal, setRelationshipTotal] = useState(0);
    const [rewardTotal, setRewardTotal] = useState(0);
    const [relationshipPage, setRelationshipPage] = useState(1);
    const [rewardPage, setRewardPage] = useState(1);
    const [keyword, setKeyword] = useState("");
    const [submittedKeyword, setSubmittedKeyword] = useState("");
    const [riskStatus, setRiskStatus] = useState<ReferralRiskStatus | "">("");
    const [rewardStatus, setRewardStatus] = useState<ReferralRewardStatus | "">("");
    const [view, setView] = useState<"relationships" | "rewards">("relationships");
    const [loading, setLoading] = useState(true);
    const [listLoading, setListLoading] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const [settling, setSettling] = useState(false);
    const [couponTemplates, setCouponTemplates] = useState<CouponTemplates>([]);
    const [couponTemplateKeyword, setCouponTemplateKeyword] = useState("");
    const [couponTemplatesLoading, setCouponTemplatesLoading] = useState(false);
    const [couponTemplatesError, setCouponTemplatesError] = useState("");
    const couponTemplateRequestRef = useRef(0);

    const loadOverview = useCallback(async () => {
        const data = await getAdminReferralOverview();
        setOverview(data);
        return data;
    }, []);

    const loadRelationships = useCallback(async () => {
        setListLoading(true);
        try {
            const data = await listAdminReferralRelationships({ page: relationshipPage, pageSize: PAGE_SIZE, keyword: submittedKeyword || undefined, riskStatus: riskStatus || undefined });
            setRelationships(data.items);
            setRelationshipTotal(data.total);
        } finally {
            setListLoading(false);
        }
    }, [relationshipPage, riskStatus, submittedKeyword]);

    const loadRewards = useCallback(async () => {
        setListLoading(true);
        try {
            const data = await listAdminReferralRewards({ page: rewardPage, pageSize: PAGE_SIZE, status: rewardStatus || undefined });
            setRewards(data.items);
            setRewardTotal(data.total);
        } finally {
            setListLoading(false);
        }
    }, [rewardPage, rewardStatus]);

    const loadCouponTemplates = useCallback(
        async (keyword: string) => {
            const requestId = ++couponTemplateRequestRef.current;
            const selectedValue = form.getFieldValue("inviteeCouponTemplateId");
            setCouponTemplatesLoading(true);
            setCouponTemplatesError("");
            try {
                const data = await listAdminReferralCouponTemplates({
                    keyword: keyword.trim() || undefined,
                    selectedId: typeof selectedValue === "string" ? selectedValue : undefined,
                    pageSize: 20,
                });
                if (requestId === couponTemplateRequestRef.current) setCouponTemplates(data.templates);
            } catch (error) {
                if (requestId === couponTemplateRequestRef.current) setCouponTemplatesError(error instanceof Error ? error.message : "加载优惠券模板失败");
            } finally {
                if (requestId === couponTemplateRequestRef.current) setCouponTemplatesLoading(false);
            }
        },
        [form],
    );

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            await Promise.all([loadOverview(), view === "relationships" ? loadRelationships() : loadRewards()]);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载邀请奖励失败");
        } finally {
            setLoading(false);
        }
    }, [loadOverview, loadRelationships, loadRewards, message, view]);

    useEffect(() => {
        setLoading(true);
        void loadOverview()
            .catch((error) => message.error(error instanceof Error ? error.message : "加载邀请奖励失败"))
            .finally(() => setLoading(false));
    }, [loadOverview, message]);

    useEffect(() => {
        if (view !== "relationships") return;
        void loadRelationships().catch((error) => message.error(error instanceof Error ? error.message : "加载邀请关系列表失败"));
    }, [loadRelationships, message, view]);

    useEffect(() => {
        if (view !== "rewards") return;
        void loadRewards().catch((error) => message.error(error instanceof Error ? error.message : "加载奖励记录失败"));
    }, [loadRewards, message, view]);

    useEffect(() => {
        if (!settingsOpen || inviteeRewardType !== "coupon") return;
        const timer = window.setTimeout(() => void loadCouponTemplates(couponTemplateKeyword), 250);
        return () => {
            window.clearTimeout(timer);
            couponTemplateRequestRef.current += 1;
        };
    }, [couponTemplateKeyword, inviteeRewardType, loadCouponTemplates, settingsOpen]);

    const openSettings = () => {
        if (!overview) return;
        const program = overview.program;
        form.setFieldsValue({ ...program, minimumPaidYuan: program.minimumPaidCents / 100 });
        setCouponTemplateKeyword("");
        setCouponTemplatesError("");
        setSettingsOpen(true);
    };

    const closeSettings = () => {
        if (saving) return;
        setSettingsOpen(false);
        setCouponTemplateKeyword("");
        setCouponTemplatesError("");
    };

    const save = async (values: ProgramForm) => {
        setSaving(true);
        try {
            const data = await saveAdminReferralProgram({ ...values, minimumPaidCents: Math.round(Number(values.minimumPaidYuan || 0) * 100) });
            setOverview((current) => (current ? { ...current, program: data.program } : current));
            setSettingsOpen(false);
            message.success("邀请奖励规则已保存");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存邀请奖励失败");
        } finally {
            setSaving(false);
        }
    };

    const settle = async () => {
        setSettling(true);
        try {
            const result = await settleAdminReferralRewards();
            message.success(result.processed ? `已处理 ${result.processed} 组奖励，发放 ${result.settled} 条` : "没有到期奖励");
            await refresh();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "结算邀请奖励失败");
        } finally {
            setSettling(false);
        }
    };

    const changeRisk = (relationship: ReferralRelationship, next: ReferralRiskStatus) => {
        const action = next === "clear" ? "恢复" : next === "rejected" ? "拒绝" : "冻结";
        modal.confirm({
            title: `${action}这条邀请关系？`,
            content:
                next === "rejected"
                    ? "拒绝后，未结算奖励会终止，已发人民币余额和可安全撤销的优惠券会同步撤销；已锁定或已核销优惠券进入人工复核。"
                    : next === "clear"
                      ? "恢复后，到期的待结算奖励会在下一次结算任务中继续处理。"
                      : "冻结后，待结算奖励会暂停发放。",
            okText: action,
            okButtonProps: next === "rejected" ? { danger: true } : undefined,
            cancelText: "取消",
            onOk: async () => {
                await updateAdminReferralRelationship(relationship.id, { riskStatus: next, reason: `管理员${action}` });
                message.success(`邀请关系已${action}`);
                await Promise.all([loadOverview(), loadRelationships()]);
            },
        });
    };

    const stats = overview?.stats;
    const program = overview?.program;
    return (
        <section className="space-y-4">
            <header className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground sm:flex-row sm:items-start sm:justify-between sm:p-5">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-foreground">
                            <UserPlus className="size-4" />
                        </span>
                        <div>
                            <h2 className="text-lg font-semibold">邀请奖励</h2>
                            <p className="mt-1 text-sm text-muted-foreground">单层邀请、首单触发、冷静期结算、退款可撤销。</p>
                        </div>
                    </div>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void refresh()}>
                        刷新
                    </Button>
                    <Button icon={<Sparkles className="size-4" />} loading={settling} onClick={() => void settle()}>
                        立即结算
                    </Button>
                    <Button type="primary" icon={<Settings2 className="size-4" />} disabled={!overview} onClick={openSettings}>
                        配置规则
                    </Button>
                </div>
            </header>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
                <Metric label="邀请点击" value={stats?.clicks || 0} />
                <Metric label="成功注册" value={stats?.registrations || 0} />
                <Metric label="首单触发" value={stats?.qualified || 0} />
                <Metric label="待结算" value={stats?.pending || 0} />
                <Metric label="已发放" value={stats?.settled || 0} />
                <Metric label="风险复核" value={stats?.risky || 0} />
            </div>

            <div className="rounded-xl border border-border bg-card p-4 text-card-foreground sm:p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                        <div className="flex items-center gap-2">
                            <ShieldCheck className="size-4 text-muted-foreground" />
                            <h3 className="font-semibold">当前规则</h3>
                            <Tag color={program?.enabled ? "green" : "default"}>{program?.enabled ? "已启用" : "未启用"}</Tag>
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">启用前必须配置有效奖励；单一网络信号只会进入复核或冻结。</p>
                    </div>
                    <div className="grid grid-cols-2 gap-x-5 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
                        <RuleFact label="邀请人" value={`¥${program?.inviterPoints || 0} 余额`} />
                        <RuleFact label="新用户" value={program?.inviteeRewardType === "coupon" ? "优惠券" : `¥${program?.inviteePoints || 0} 余额`} />
                        <RuleFact label="最低实付" value={formatMoney(program?.minimumPaidCents || 0)} />
                        <RuleFact label="冷静期" value={`${program?.coolingOffDays || 0} 天`} />
                    </div>
                </div>
            </div>

            <div className="overflow-hidden rounded-xl border border-border bg-card text-card-foreground">
                <div className="flex flex-col gap-3 border-b border-border p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
                    <Segmented
                        value={view}
                        options={[
                            { label: "邀请关系", value: "relationships" },
                            { label: "奖励记录", value: "rewards" },
                        ]}
                        onChange={(value) => setView(value as typeof view)}
                    />
                    {view === "relationships" ? (
                        <div className="flex min-w-0 gap-2">
                            <div className="min-w-0 flex-1 sm:w-64 sm:flex-none">
                                <Input.Search
                                    className="w-full"
                                    allowClear
                                    value={keyword}
                                    placeholder="用户、用户 ID 或邀请码"
                                    onChange={(event) => setKeyword(event.target.value)}
                                    onSearch={(value) => {
                                        setRelationshipPage(1);
                                        setSubmittedKeyword(value.trim());
                                    }}
                                />
                            </div>
                            <div className="w-28 shrink-0">
                                <Select
                                    className="w-full"
                                    value={riskStatus}
                                    options={[{ value: "", label: "全部状态" }, ...(["clear", "review", "frozen", "rejected"] as const).map((value) => ({ value, label: riskLabel(value) }))]}
                                    onChange={(value) => {
                                        setRelationshipPage(1);
                                        setRiskStatus(value);
                                    }}
                                />
                            </div>
                        </div>
                    ) : (
                        <div className="w-32">
                            <Select
                                className="w-full"
                                value={rewardStatus}
                                options={[{ value: "", label: "全部状态" }, ...(["pending", "settled", "revoked", "rejected", "reversal_pending"] as const).map((value) => ({ value, label: rewardStatusLabel(value) }))]}
                                onChange={(value) => {
                                    setRewardPage(1);
                                    setRewardStatus(value);
                                }}
                            />
                        </div>
                    )}
                </div>

                <div className="divide-y divide-border">
                    {listLoading ? (
                        <div className="p-8 text-center text-sm text-muted-foreground">正在加载...</div>
                    ) : view === "relationships" ? (
                        relationships.length ? (
                            relationships.map((item) => <RelationshipRow key={item.id} item={item} onRiskChange={changeRisk} />)
                        ) : (
                            <Empty label="暂无邀请关系" />
                        )
                    ) : rewards.length ? (
                        rewards.map((item) => <RewardRow key={item.id} item={item} />)
                    ) : (
                        <Empty label="暂无奖励记录" />
                    )}
                </div>
                {view === "relationships" && relationshipTotal > PAGE_SIZE ? (
                    <Pagination className="p-3 sm:p-4" size="small" current={relationshipPage} pageSize={PAGE_SIZE} total={relationshipTotal} showSizeChanger={false} onChange={setRelationshipPage} />
                ) : null}
                {view === "rewards" && rewardTotal > PAGE_SIZE ? <Pagination className="p-3 sm:p-4" size="small" current={rewardPage} pageSize={PAGE_SIZE} total={rewardTotal} showSizeChanger={false} onChange={setRewardPage} /> : null}
            </div>

            <Modal
                title="配置邀请奖励"
                open={settingsOpen}
                width={720}
                centered
                destroyOnHidden
                onCancel={closeSettings}
                footer={[
                    <Button key="cancel" disabled={saving} onClick={closeSettings}>
                        取消
                    </Button>,
                    <Button key="save" type="primary" icon={<Save className="size-4" />} loading={saving} onClick={() => form.submit()}>
                        保存规则
                    </Button>,
                ]}
            >
                <Form form={form} layout="vertical" onFinish={(values) => void save(values)}>
                    <div className="grid gap-x-3 sm:grid-cols-2">
                        <Form.Item name="enabled" label="功能状态" valuePropName="checked">
                            <Switch checkedChildren="启用" unCheckedChildren="停用" />
                        </Form.Item>
                        <Form.Item name="autoFreezeRisk" label="异常自动冻结" valuePropName="checked">
                            <Switch checkedChildren="开启" unCheckedChildren="关闭" />
                        </Form.Item>
                        <Form.Item name="inviterPoints" label="邀请人奖励余额（元）" rules={[{ required: true, message: "请填写邀请人奖励" }]}>
                            <InputNumber className="w-full" min={0} max={1_000_000} precision={8} prefix="¥" />
                        </Form.Item>
                        <Form.Item name="inviteeRewardType" label="新用户奖励类型" rules={[{ required: true }]}>
                            <Select
                                options={[
                                    { value: "points", label: "永久人民币余额" },
                                    { value: "coupon", label: "优惠券" },
                                ]}
                            />
                        </Form.Item>
                        {inviteeRewardType === "coupon" ? (
                            <Form.Item name="inviteeCouponTemplateId" label="新用户优惠券" rules={[{ required: true, message: "请选择优惠券模板" }]}>
                                <Select
                                    showSearch
                                    allowClear
                                    filterOption={false}
                                    loading={couponTemplatesLoading}
                                    placeholder="搜索优惠券名称或券码"
                                    onSearch={setCouponTemplateKeyword}
                                    notFoundContent={
                                        couponTemplatesLoading ? (
                                            "正在加载优惠券模板..."
                                        ) : couponTemplatesError ? (
                                            <Button type="link" size="small" onMouseDown={(event) => event.preventDefault()} onClick={() => void loadCouponTemplates(couponTemplateKeyword)}>
                                                加载失败，点击重试
                                            </Button>
                                        ) : (
                                            "没有匹配的可用优惠券"
                                        )
                                    }
                                    options={couponTemplates.map((item) => ({ value: item.id, label: `${item.name} · ${item.code}${item.enabled ? "" : "（已停用）"}`, disabled: !item.enabled }))}
                                />
                            </Form.Item>
                        ) : (
                            <Form.Item name="inviteePoints" label="新用户奖励余额（元）" rules={[{ required: true, message: "请填写新用户奖励" }]}>
                                <InputNumber className="w-full" min={0} max={1_000_000} precision={8} prefix="¥" />
                            </Form.Item>
                        )}
                        <Form.Item name="minimumPaidYuan" label="首单最低实付">
                            <InputNumber className="w-full" min={0} max={1_000_000} precision={2} prefix="¥" />
                        </Form.Item>
                        <Form.Item name="coolingOffDays" label="冷静期（天）">
                            <InputNumber className="w-full" min={0} max={365} precision={0} />
                        </Form.Item>
                        <Form.Item name="inviterMonthlyLimit" label="单邀请人每月人数上限" extra="0 表示不限">
                            <InputNumber className="w-full" min={0} max={100_000} precision={0} />
                        </Form.Item>
                        <Form.Item name="campaignTotalLimit" label="活动累计人数上限" extra="0 表示不限">
                            <InputNumber className="w-full" min={0} max={10_000_000} precision={0} />
                        </Form.Item>
                    </div>
                </Form>
            </Modal>
        </section>
    );
}

function Metric({ label, value }: { label: string; value: number }) {
    return (
        <div className="rounded-xl border border-border bg-card p-3 text-card-foreground">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="mt-2 text-xl font-semibold tabular-nums">{value}</div>
        </div>
    );
}

function RuleFact({ label, value }: { label: string; value: string }) {
    return (
        <div>
            <span>{label}</span>
            <div className="mt-0.5 font-semibold text-foreground">{value}</div>
        </div>
    );
}

function RelationshipRow({ item, onRiskChange }: { item: ReferralRelationship; onRiskChange: (item: ReferralRelationship, next: ReferralRiskStatus) => void }) {
    const inviter = item.inviterDisplayName || item.inviterUsername || "用户信息不可用";
    const invitee = item.inviteeDisplayName || item.inviteeUsername || "用户信息不可用";
    return (
        <article className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
            <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{inviter}</span>
                    <AdminAccountId accountId={item.inviterAccountId} />
                    <span className="text-muted-foreground">邀请</span>
                    <span className="font-semibold">{invitee}</span>
                    <AdminAccountId accountId={item.inviteeAccountId} />
                    <Tag className="m-0" color={riskColor(item.riskStatus)}>
                        {riskLabel(item.riskStatus)}
                    </Tag>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                    邀请码 {item.code || "-"} · {formatTime(item.registeredAt)} · 来源 {item.attributionSource || "-"}
                </div>
            </div>
            <div className="flex shrink-0 gap-2">
                {item.riskStatus === "clear" ? (
                    <Button size="small" onClick={() => onRiskChange(item, "frozen")}>
                        冻结
                    </Button>
                ) : item.riskStatus !== "rejected" ? (
                    <Button size="small" type="primary" onClick={() => onRiskChange(item, "clear")}>
                        恢复
                    </Button>
                ) : null}
                {item.riskStatus !== "rejected" ? (
                    <Button size="small" danger onClick={() => onRiskChange(item, "rejected")}>
                        拒绝
                    </Button>
                ) : null}
            </div>
        </article>
    );
}

function RewardRow({ item }: { item: ReferralReward }) {
    const name = item.beneficiaryDisplayName || item.beneficiaryUsername || "用户信息不可用";
    return (
        <article className="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-4">
            <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{name}</span>
                    <AdminAccountId accountId={item.beneficiaryAccountId} />
                    <Tag className="m-0" color={rewardStatusColor(item.status)}>
                        {rewardStatusLabel(item.status)}
                    </Tag>
                    <Tag className="m-0">{item.beneficiaryRole === "inviter" ? "邀请人" : "新用户"}</Tag>
                </div>
                <div className="mt-1 truncate text-xs text-muted-foreground">
                    订单 {item.triggerOrderId} · {formatTime(item.createdAt)}
                    {item.reason ? ` · ${item.reason}` : ""}
                </div>
            </div>
            <div className="text-sm font-semibold">{item.rewardType === "coupon" ? "优惠券" : `¥${item.pointsAmount} 余额`}</div>
        </article>
    );
}

function Empty({ label }: { label: string }) {
    return <div className="p-8 text-center text-sm text-muted-foreground">{label}</div>;
}

function riskLabel(status: ReferralRiskStatus) {
    return status === "clear" ? "正常" : status === "review" ? "待复核" : status === "frozen" ? "已冻结" : "已拒绝";
}

function riskColor(status: ReferralRiskStatus) {
    return status === "clear" ? "green" : status === "review" ? "gold" : status === "frozen" ? "orange" : "red";
}

function rewardStatusLabel(status: ReferralRewardStatus) {
    return status === "pending" ? "待结算" : status === "settled" ? "已发放" : status === "revoked" ? "已撤销" : status === "reversal_pending" ? "撤销待复核" : "已拒绝";
}

function rewardStatusColor(status: ReferralRewardStatus) {
    return status === "settled" ? "green" : status === "pending" ? "gold" : status === "reversal_pending" ? "orange" : "red";
}

function formatMoney(cents: number) {
    return `¥${(Number(cents || 0) / 100).toFixed(2)}`;
}

function formatTime(value: string) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "-";
}
