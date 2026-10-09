"use client";

import { App, Button, Empty, Form, Input, Modal, Progress, Select, Space, Table, Tabs, Tag } from "antd";
import { Activity, BarChart3, CheckCircle2, CircleX, RefreshCw, ShieldCheck, UserPlus, UsersRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Metric, Panel, PanelHeader } from "@/components/admin/admin-panel";
import type { TeamOverviewSummary, TenantContext, TenantMemberItem, TenantMembershipStatus } from "@/lib/tenant";
import { canManageTenantMember } from "@/lib/tenant-permissions";
import { createTeamMember, getTeamOverview, listTeamAuditLogs, listTeamMembers, updateTeamMember, type TenantAuditItem } from "@/services/api/team";

const PAGE_SIZE = 20;
const roleLabels = { owner: "所有者", admin: "管理员", member: "成员" } as const;

export function TeamConsole({ initialTenant, currentUserId }: { initialTenant: TenantContext; currentUserId: string }) {
    const { message } = App.useApp();
    const [overview, setOverview] = useState<TeamOverviewSummary>();
    const [members, setMembers] = useState<TenantMemberItem[]>([]);
    const [audits, setAudits] = useState<TenantAuditItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [memberTotal, setMemberTotal] = useState(0);
    const [memberPage, setMemberPage] = useState(1);
    const [memberKeyword, setMemberKeyword] = useState("");
    const [memberStatus, setMemberStatus] = useState<TenantMembershipStatus>();
    const [auditTotal, setAuditTotal] = useState(0);
    const [auditPage, setAuditPage] = useState(1);
    const [createOpen, setCreateOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const [form] = Form.useForm();
    const createRoleOptions =
        initialTenant.role === "owner"
            ? [
                  { value: "member", label: "成员" },
                  { value: "admin", label: "管理员" },
              ]
            : [{ value: "member", label: "成员" }];

    const loadOverview = useCallback(async () => setOverview((await getTeamOverview()).overview), []);
    const loadMembers = useCallback(async () => {
        const result = await listTeamMembers({ page: memberPage, pageSize: PAGE_SIZE, keyword: memberKeyword, status: memberStatus });
        setMembers(result.items);
        setMemberTotal(result.total);
    }, [memberKeyword, memberPage, memberStatus]);
    const loadAudits = useCallback(async () => {
        const result = await listTeamAuditLogs({ page: auditPage, pageSize: PAGE_SIZE });
        setAudits(result.items);
        setAuditTotal(result.total);
    }, [auditPage]);
    const loadAll = useCallback(async () => {
        setLoading(true);
        try {
            await Promise.all([loadOverview(), loadMembers(), loadAudits()]);
        } catch (error) {
            void message.error(error instanceof Error ? error.message : "团队数据加载失败");
        } finally {
            setLoading(false);
        }
    }, [loadAudits, loadMembers, loadOverview, message]);

    useEffect(() => void loadAll(), [loadAll]);

    async function createMember(values: { username: string; displayName?: string; email?: string; password: string; role: "admin" | "member" }) {
        setSaving(true);
        try {
            await createTeamMember(values);
            setCreateOpen(false);
            form.resetFields();
            await Promise.all([loadMembers(), loadOverview(), loadAudits()]);
            void message.success("成员创建成功");
        } catch (error) {
            void message.error(error instanceof Error ? error.message : "创建成员失败");
        } finally {
            setSaving(false);
        }
    }

    async function updateMember(item: TenantMemberItem, patch: { role?: "admin" | "member"; status?: TenantMembershipStatus }) {
        setSaving(true);
        try {
            await updateTeamMember(item.userId, patch);
            await Promise.all([loadMembers(), loadOverview(), loadAudits()]);
            void message.success("成员已更新");
        } catch (error) {
            void message.error(error instanceof Error ? error.message : "更新成员失败");
        } finally {
            setSaving(false);
        }
    }

    const memberColumns = useMemo(
        () => [
            {
                title: "成员",
                key: "member",
                render: (_: unknown, item: TenantMemberItem) => (
                    <div>
                        <div className="font-medium">{item.displayName || item.username}</div>
                        <div className="text-xs text-zinc-400">
                            @{item.username} · {item.accountId}
                        </div>
                    </div>
                ),
            },
            {
                title: "角色",
                dataIndex: "role",
                width: 130,
                render: (_: unknown, item: TenantMemberItem) =>
                    item.role === "owner" ? (
                        <Tag color="gold">所有者</Tag>
                    ) : (
                        <Select
                            aria-label={`修改 ${item.username} 的角色`}
                            disabled={saving || item.userId === currentUserId || !canManageTenantMember(initialTenant.role, item.role)}
                            value={item.role}
                            className="w-24"
                            options={[
                                { value: "admin", label: "管理员" },
                                { value: "member", label: "成员" },
                            ]}
                            onChange={(role) => void updateMember(item, { role })}
                        />
                    ),
            },
            {
                title: "状态",
                key: "status",
                width: 120,
                render: (_: unknown, item: TenantMemberItem) => <Tag color={item.status === "active" && item.userStatus === "active" ? "green" : "default"}>{item.status === "active" && item.userStatus === "active" ? "可用" : "已禁用"}</Tag>,
            },
            {
                title: "操作",
                key: "actions",
                width: 120,
                render: (_: unknown, item: TenantMemberItem) =>
                    item.userId === currentUserId || !canManageTenantMember(initialTenant.role, item.role) ? null : (
                        <Button danger={item.status === "active"} disabled={saving} onClick={() => void updateMember(item, { status: item.status === "active" ? "disabled" : "active" })}>
                            {item.status === "active" ? "禁用" : "启用"}
                        </Button>
                    ),
            },
        ],
        [currentUserId, initialTenant.role, saving],
    );

    const overviewPanel = overview ? (
        <div className="space-y-4">
            <div className="grid overflow-hidden rounded-lg border border-zinc-200 sm:grid-cols-2 xl:grid-cols-4 dark:border-zinc-800">
                <Metric label="活跃成员" value={overview.activeMembers} detail={`共 ${overview.memberTotal} 个成员关系`} icon={<UsersRound />} tone="blue" />
                <Metric label="近 7 日调用" value={overview.totalCalls} detail={`${overview.timezone} 自然日`} icon={<Activity />} tone="cyan" />
                <Metric label="成功率" value={overview.successRate === null ? "—" : `${overview.successRate}%`} detail={`${overview.successCalls} 成功 / ${overview.failedCalls} 失败`} icon={<CheckCircle2 />} tone="emerald" />
                <Metric label="活跃创作者" value={overview.activeCreators} detail="当前可用且产生调用" icon={<BarChart3 />} tone="amber" />
            </div>
            <div className="grid gap-4 xl:grid-cols-2">
                <Panel>
                    <PanelHeader title="每日调用" description="最近 7 个自然日的租户调用趋势。" />
                    <div className="space-y-3 p-4">
                        {overview.daily.map((item) => (
                            <div key={item.key} className="grid grid-cols-[74px_minmax(0,1fr)_42px] items-center gap-3 text-xs">
                                <span>{item.key.slice(5)}</span>
                                <Progress percent={overview.totalCalls ? Math.round((item.value / Math.max(...overview.daily.map((day) => day.value), 1)) * 100) : 0} showInfo={false} size="small" />
                                <span className="text-right tabular-nums">{item.value}</span>
                            </div>
                        ))}
                    </div>
                </Panel>
                <Panel>
                    <PanelHeader title="调用分布" description="按模型汇总，不展示成员私有内容。" />
                    <div className="space-y-3 p-4">
                        {overview.models.length ? (
                            overview.models.map((item) => (
                                <div key={item.key} className="flex items-center justify-between gap-3 text-sm">
                                    <span className="truncate">{item.key}</span>
                                    <Tag>{item.value}</Tag>
                                </div>
                            ))
                        ) : (
                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无调用" />
                        )}
                    </div>
                </Panel>
            </div>
        </div>
    ) : (
        <Empty description={loading ? "正在加载看板" : "暂无看板数据"} />
    );

    return (
        <main className="mx-auto w-full max-w-[1500px] space-y-5 p-3 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <div className="text-xs text-zinc-500">团队控制台</div>
                    <h1 className="mt-1 text-xl font-semibold text-zinc-950 dark:text-zinc-100">{initialTenant.tenantName}</h1>
                    <p className="mt-1 text-sm text-zinc-500">当前角色：{roleLabels[initialTenant.role]}</p>
                </div>
                <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void loadAll()}>
                    刷新
                </Button>
            </div>
            <Tabs
                items={[
                    { key: "overview", label: "看板", children: overviewPanel },
                    {
                        key: "members",
                        label: "成员",
                        children: (
                            <Panel>
                                <PanelHeader
                                    title="成员管理"
                                    description="成员内容保持私有；这里只管理身份、角色和可用状态。"
                                    actions={
                                        <Button type="primary" icon={<UserPlus className="size-4" />} onClick={() => setCreateOpen(true)}>
                                            创建成员
                                        </Button>
                                    }
                                />
                                <div className="grid gap-3 border-b border-zinc-200 p-4 sm:grid-cols-[minmax(0,1fr)_180px] dark:border-zinc-800">
                                    <Input.Search
                                        allowClear
                                        placeholder="搜索用户名、昵称或邮箱"
                                        value={memberKeyword}
                                        onChange={(event) => {
                                            setMemberKeyword(event.target.value);
                                            setMemberPage(1);
                                        }}
                                    />
                                    <Select
                                        allowClear
                                        placeholder="全部状态"
                                        value={memberStatus}
                                        options={[
                                            { value: "active", label: "可用" },
                                            { value: "disabled", label: "已禁用" },
                                        ]}
                                        onChange={(value) => {
                                            setMemberStatus(value);
                                            setMemberPage(1);
                                        }}
                                    />
                                </div>
                                <Table
                                    rowKey="userId"
                                    columns={memberColumns}
                                    dataSource={members}
                                    loading={loading}
                                    pagination={{ current: memberPage, pageSize: PAGE_SIZE, total: memberTotal, showSizeChanger: false, onChange: setMemberPage }}
                                    scroll={{ x: 680 }}
                                />
                            </Panel>
                        ),
                    },
                    {
                        key: "audit",
                        label: "审计",
                        children: (
                            <Panel>
                                <PanelHeader title="租户审计" description="仅展示当前租户的高风险管理操作。" />
                                <Table
                                    rowKey="id"
                                    dataSource={audits}
                                    loading={loading}
                                    columns={[
                                        { title: "动作", dataIndex: "action" },
                                        { title: "操作者", dataIndex: "actorUsername", render: (value) => value || "系统" },
                                        { title: "目标", dataIndex: "targetLabel", render: (value) => value || "—" },
                                        {
                                            title: "结果",
                                            dataIndex: "status",
                                            render: (value) =>
                                                value === "success" ? (
                                                    <Tag color="green" icon={<CheckCircle2 />}>
                                                        成功
                                                    </Tag>
                                                ) : (
                                                    <Tag color="red" icon={<CircleX />}>
                                                        失败
                                                    </Tag>
                                                ),
                                        },
                                        { title: "时间", dataIndex: "createdAt", render: (value) => new Date(value).toLocaleString("zh-CN") },
                                    ]}
                                    pagination={{ current: auditPage, pageSize: PAGE_SIZE, total: auditTotal, showSizeChanger: false, onChange: setAuditPage }}
                                    scroll={{ x: 720 }}
                                />
                            </Panel>
                        ),
                    },
                ]}
            />
            <Modal title="创建成员" open={createOpen} okText="创建" cancelText="取消" confirmLoading={saving} onOk={() => form.submit()} onCancel={() => setCreateOpen(false)}>
                <Form form={form} layout="vertical" initialValues={{ role: "member" }} onFinish={createMember} requiredMark={false}>
                    <div className="grid gap-x-3 sm:grid-cols-2">
                        <Form.Item name="username" label="用户名" rules={[{ required: true }, { min: 3 }, { max: 32 }]}>
                            <Input />
                        </Form.Item>
                        <Form.Item name="displayName" label="昵称">
                            <Input />
                        </Form.Item>
                    </div>
                    <Form.Item name="email" label="邮箱">
                        <Input type="email" />
                    </Form.Item>
                    <Form.Item name="role" label="租户角色" rules={[{ required: true }]}>
                        <Select options={createRoleOptions} />
                    </Form.Item>
                    <Form.Item name="password" label="初始密码" extra="请通过安全渠道交付，成员可登录后自行修改。" rules={[{ required: true, min: 8, message: "至少 8 个字符" }]}>
                        <Input.Password autoComplete="new-password" />
                    </Form.Item>
                </Form>
            </Modal>
        </main>
    );
}
