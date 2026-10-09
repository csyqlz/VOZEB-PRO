"use client";

import { App, Button, Form, Input, Modal, Space, Table, Tag } from "antd";
import { Building2, Pencil, Plus, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import { hasAdminPermission } from "@/lib/admin-permissions";
import type { PublicUser } from "@/lib/auth/store";
import type { TenantListItem } from "@/lib/tenant";
import { createAdminTenant, listAdminTenants, renameAdminTenant } from "@/services/api/admin-tenants";

const PAGE_SIZE = 20;

export function AdminTenantsSection({ currentUser }: { currentUser: PublicUser }) {
    const { message } = App.useApp();
    const [items, setItems] = useState<TenantListItem[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [keyword, setKeyword] = useState("");
    const [loading, setLoading] = useState(false);
    const [createOpen, setCreateOpen] = useState(false);
    const [renameTarget, setRenameTarget] = useState<TenantListItem>();
    const [saving, setSaving] = useState(false);
    const [createForm] = Form.useForm();
    const [renameForm] = Form.useForm();
    const canManage = hasAdminPermission(currentUser, "tenants.manage");

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const result = await listAdminTenants({ page, pageSize: PAGE_SIZE, keyword });
            setItems(result.items);
            setTotal(result.total);
        } catch (error) {
            void message.error(error instanceof Error ? error.message : "租户列表加载失败");
        } finally {
            setLoading(false);
        }
    }, [keyword, message, page]);

    useEffect(() => void load(), [load]);

    const columns = useMemo(
        () => [
            {
                title: "租户",
                key: "tenant",
                render: (_: unknown, item: TenantListItem) => (
                    <div>
                        <div className="font-medium text-zinc-950 dark:text-zinc-100">{item.name}</div>
                        <div className="mt-1 font-mono text-xs text-zinc-400">{item.slug}</div>
                    </div>
                ),
            },
            {
                title: "负责人",
                key: "owner",
                render: (_: unknown, item: TenantListItem) => (
                    <div>
                        <div>{item.ownerDisplayName || item.ownerUsername}</div>
                        <div className="text-xs text-zinc-400">@{item.ownerUsername}</div>
                    </div>
                ),
            },
            { title: "活跃成员", dataIndex: "activeMembers", width: 110, render: (value: number) => <Tag>{value}</Tag> },
            { title: "近 7 日调用", dataIndex: "recentCalls", width: 120, render: (value: number) => value.toLocaleString("zh-CN") },
            ...(canManage
                ? [
                      {
                          title: "操作",
                          key: "actions",
                          width: 90,
                          render: (_: unknown, item: TenantListItem) => (
                              <Button
                                  type="text"
                                  icon={<Pencil className="size-4" />}
                                  onClick={() => {
                                      setRenameTarget(item);
                                      renameForm.setFieldsValue({ name: item.name });
                                  }}
                              >
                                  改名
                              </Button>
                          ),
                      },
                  ]
                : []),
        ],
        [canManage, renameForm],
    );

    async function submitCreate(values: { name: string; slug: string; ownerUsername: string; ownerDisplayName?: string; ownerEmail?: string; ownerPassword: string }) {
        setSaving(true);
        try {
            await createAdminTenant({ name: values.name, slug: values.slug, owner: { username: values.ownerUsername, displayName: values.ownerDisplayName, email: values.ownerEmail, password: values.ownerPassword } });
            setCreateOpen(false);
            createForm.resetFields();
            setPage(1);
            await load();
            void message.success("租户创建成功");
        } catch (error) {
            void message.error(error instanceof Error ? error.message : "创建租户失败");
        } finally {
            setSaving(false);
        }
    }

    async function submitRename(values: { name: string }) {
        if (!renameTarget) return;
        setSaving(true);
        try {
            await renameAdminTenant(renameTarget.id, values.name);
            setRenameTarget(undefined);
            await load();
            void message.success("租户名称已更新");
        } catch (error) {
            void message.error(error instanceof Error ? error.message : "更新租户失败");
        } finally {
            setSaving(false);
        }
    }

    return (
        <Panel>
            <PanelHeader
                title="租户管理"
                description="创建租户与负责人，查看成员和近 7 日调用概况。租户管理员不会获得平台管理员权限。"
                actions={
                    canManage ? (
                        <Button type="primary" icon={<Plus className="size-4" />} onClick={() => setCreateOpen(true)}>
                            创建租户
                        </Button>
                    ) : undefined
                }
            />
            <div className="border-b border-zinc-200 p-4 dark:border-zinc-800">
                <Input
                    allowClear
                    prefix={<Search className="size-4 text-zinc-400" />}
                    placeholder="搜索租户名称、标识或负责人"
                    value={keyword}
                    onChange={(event) => {
                        setKeyword(event.target.value);
                        setPage(1);
                    }}
                />
            </div>
            <Table
                rowKey="id"
                columns={columns}
                dataSource={items}
                loading={loading}
                pagination={{ current: page, pageSize: PAGE_SIZE, total, showSizeChanger: false, onChange: setPage }}
                scroll={{ x: 720 }}
                locale={{
                    emptyText: (
                        <Space direction="vertical">
                            <Building2 className="mx-auto size-6 text-zinc-400" />
                            <span>暂无租户</span>
                        </Space>
                    ),
                }}
            />
            <Modal title="创建租户" open={createOpen} okText="创建" cancelText="取消" confirmLoading={saving} onOk={() => createForm.submit()} onCancel={() => setCreateOpen(false)}>
                <Form form={createForm} layout="vertical" onFinish={submitCreate} requiredMark={false}>
                    <Form.Item name="name" label="租户名称" rules={[{ required: true, message: "请输入租户名称" }, { max: 80 }]}>
                        <Input />
                    </Form.Item>
                    <Form.Item
                        name="slug"
                        label="租户标识"
                        rules={[
                            { required: true, message: "请输入租户标识" },
                            { pattern: /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/, message: "使用 3–64 位小写字母、数字或连字符" },
                        ]}
                    >
                        <Input placeholder="example-team" />
                    </Form.Item>
                    <div className="grid gap-x-3 sm:grid-cols-2">
                        <Form.Item name="ownerUsername" label="负责人用户名" rules={[{ required: true }]}>
                            <Input />
                        </Form.Item>
                        <Form.Item name="ownerDisplayName" label="负责人昵称">
                            <Input />
                        </Form.Item>
                    </div>
                    <Form.Item name="ownerEmail" label="负责人邮箱">
                        <Input type="email" />
                    </Form.Item>
                    <Form.Item name="ownerPassword" label="初始密码" extra="当前 MVP 由平台管理员通过安全渠道交付，成员登录后可在个人资料中修改。" rules={[{ required: true, min: 8, message: "至少 8 个字符" }]}>
                        <Input.Password autoComplete="new-password" />
                    </Form.Item>
                </Form>
            </Modal>
            <Modal title="修改租户名称" open={Boolean(renameTarget)} okText="保存" cancelText="取消" confirmLoading={saving} onOk={() => renameForm.submit()} onCancel={() => setRenameTarget(undefined)} destroyOnHidden>
                <Form form={renameForm} layout="vertical" onFinish={submitRename}>
                    <Form.Item name="name" label="租户名称" rules={[{ required: true }, { max: 80 }]}>
                        <Input />
                    </Form.Item>
                </Form>
            </Modal>
        </Panel>
    );
}
