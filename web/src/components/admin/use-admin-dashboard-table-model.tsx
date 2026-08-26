"use client";

import { formatAdminLogDuration, formatAdminLogTime, formatGenerationLogModel, generationKindLabel, GenerationLogAssetPreview, generationSourceLabel, generationStatusClass, generationStatusLabel } from "@/components/admin/admin-generation-log";
import { adminSections } from "@/components/admin/admin-section-nav";
import type { AdminSectionKey } from "@/components/admin/admin-sections";
import { toNumberOrZero } from "@/components/admin/admin-values";
import type { TableColumnsType } from "antd";
import { Button, Popconfirm, Space, Tag } from "antd";
import { Copy, Eye, SlidersHorizontal, Trash2 } from "lucide-react";
import type { ReactNode } from "react";

import { AdminAccountId, AdminUserIdentity } from "@/components/admin/admin-user-identity";
import { formatCreditAmount } from "@/constant/credits";
import type { AuthSettings, PublicCdkCode, PublicUser, PublicUserSummary, UserRole, UserStatus } from "@/lib/auth/store";
import { imagePreviewUrl } from "@/lib/media-image-url";
import type { AdminSetupSummary } from "@/lib/server/admin-setup-status";
import { classifyGenerationError, generationErrorCategoryLabel } from "@/lib/server/generation-errors";
import type { StoredGenerationLog } from "@/lib/server/generation-log-store";
import type { Prompt } from "@/services/api/prompts";
import { cdkStatusLabel, cdkStatusTone } from "./admin-dashboard-elements";

export type AdminDashboardProps = {
    initialUsers: PublicUser[];
    initialUserSummary: PublicUserSummary;
    initialSettings: AuthSettings;
    initialPromptCount: number;
    currentUser: PublicUser;
    initialSection?: AdminSectionKey;
    setupSummary?: AdminSetupSummary;
    headerActions?: ReactNode;
};
export type PromptFormValue = {
    title: string;
    prompt: string;
    category?: string;
    tags?: string;
    coverUrl?: string;
    preview?: string;
};

export const PROMPT_PAGE_SIZE = 20;
export const PROMPT_SEARCH_DEBOUNCE_MS = 300;
export const CDK_PAGE_SIZE = 20;
export const GENERATION_LOG_PAGE_SIZE = 20;

import { ADMIN_PERMISSION_PRESETS, adminPermissionSummary, hasAdminPermission, hasAllAdminPermissions, normalizeAdminPermissions } from "@/lib/admin-permissions";
import type { AdminDashboardDataActions } from "./use-admin-dashboard-data-actions";
import type { AdminDashboardSettingsActions } from "./use-admin-dashboard-settings-actions";
import type { AdminDashboardState, UserEditorValue } from "./use-admin-dashboard-state";

export function useAdminDashboardTableModel({ state, data, settingsActions }: { state: AdminDashboardState; data: AdminDashboardDataActions; settingsActions: AdminDashboardSettingsActions }) {
    const { currentUser, setupSummary, userForm, settings, updatingUserId, deletingPromptId, setViewingGenerationLog, setViewingCdkCode, editingUser, setEditingUser, creatingUser, setCreatingUser, activeSection } = state;
    const { updateUser, createUser, deleteUser, deletePrompt, deleteGenerationLogsByIds, deleteCdkById, copyCdkPlainCode } = data;
    const {} = settingsActions;
    const canManageUsers = hasAdminPermission(currentUser, "users.manage");
    const canManageAdministrators = hasAdminPermission(currentUser, "administrators.manage");
    const canManageBilling = hasAdminPermission(currentUser, "billing.manage");
    const canManageAdministratorRecord = (user: PublicUser) => canManageAdministrators && hasAllAdminPermissions(currentUser, user.adminPermissions);
    const canEditUserRecord = (user: PublicUser) => canManageBilling || (user.role === "admin" ? canManageAdministratorRecord(user) : canManageUsers || canManageAdministrators);
    const canDeleteUserRecord = (user: PublicUser) => user.id !== currentUser.id && (user.role === "admin" ? canManageAdministratorRecord(user) : canManageUsers);

    const openUserEditor = (user: PublicUser) => {
        setCreatingUser(false);
        setEditingUser(user);
        userForm.setFieldsValue({
            username: user.username,
            displayName: user.displayName,
            email: user.email || "",
            password: "",
            role: user.role,
            adminPermissions: user.adminPermissions,
            permissionPreset: ADMIN_PERMISSION_PRESETS.find((preset) => normalizeAdminPermissions(preset.permissions).join() === normalizeAdminPermissions(user.adminPermissions).join())?.key,
            status: user.status,
            pointsBalance: user.permanentPointsBalance,
        });
    };

    const openCreateUserEditor = () => {
        setEditingUser(null);
        setCreatingUser(true);
        const role = canManageUsers ? "user" : "admin";
        const adminPermissions = role === "admin" ? normalizeAdminPermissions(currentUser.adminPermissions) : [];
        userForm.setFieldsValue({
            username: "",
            displayName: "",
            email: "",
            password: "",
            role,
            adminPermissions,
            permissionPreset: ADMIN_PERMISSION_PRESETS.find((preset) => normalizeAdminPermissions(preset.permissions).join() === adminPermissions.join())?.key,
            status: "active",
            pointsBalance: 0,
        });
    };

    const closeUserEditor = () => {
        setEditingUser(null);
        setCreatingUser(false);
        userForm.resetFields();
    };

    const saveUserEditor = async (value: UserEditorValue) => {
        if (creatingUser) {
            const user = await createUser(value);
            if (user) closeUserEditor();
            return;
        }
        if (!editingUser) return;
        const touchesAdministrator = editingUser.role === "admin" || value.role === "admin";
        const targetWithinScope = editingUser.role !== "admin" || hasAllAdminPermissions(currentUser, editingUser.adminPermissions);
        const canEditAccount = touchesAdministrator ? canManageAdministrators && targetWithinScope : canManageUsers;
        const user = await updateUser(editingUser.id, {
            ...(canEditAccount
                ? {
                      displayName: value.displayName,
                      email: value.email || "",
                      password: value.password || undefined,
                      role: value.role,
                      adminPermissions: value.role === "admin" ? value.adminPermissions : [],
                      status: value.status,
                  }
                : {}),
            ...(canManageBilling ? { pointsBalance: toNumberOrZero(value.pointsBalance) } : {}),
        });
        if (user) closeUserEditor();
    };

    const userColumns: TableColumnsType<PublicUser> = [
        {
            title: "用户",
            dataIndex: "displayName",
            width: 230,
            render: (_, record) => (
                <div className="min-w-0">
                    <AdminUserIdentity displayName={record.displayName} username={record.username} avatarUrl={record.avatarUrl} />
                    <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 sm:hidden">
                        <AdminAccountId accountId={record.accountId} />
                        <span className="truncate text-xs text-zinc-400">{record.email || "未绑定邮箱"}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1 sm:hidden">
                        <Tag color={record.role === "admin" ? "blue" : "default"}>{record.role === "admin" ? "管理员" : "普通用户"}</Tag>
                        <Tag color={record.status === "active" ? "green" : "red"}>{record.status === "active" ? "可用" : "已禁用"}</Tag>
                        {record.role === "admin" ? <span className="self-center text-xs text-stone-500 dark:text-stone-400">{adminPermissionSummary(record.adminPermissions)}</span> : null}
                    </div>
                    <div className="mt-2 space-y-1 text-xs text-stone-500 sm:hidden dark:text-stone-400">
                        <div>
                            总计 <span className="font-semibold text-stone-950 dark:text-stone-100">{formatCreditAmount(record.pointsBalance)}</span> · 今日 {formatCreditAmount(record.dailyPointsBalance)} · 永久{" "}
                            {formatCreditAmount(record.permanentPointsBalance)}
                        </div>
                        <div>注册 {formatAdminLogTime(record.createdAt)}</div>
                        <div>活跃 {record.lastLoginAt ? formatAdminLogTime(record.lastLoginAt) : "从未登录"}</div>
                    </div>
                </div>
            ),
        },
        {
            title: "账号 ID",
            dataIndex: "accountId",
            width: 110,
            responsive: ["sm"],
            render: (accountId: string) => <AdminAccountId accountId={accountId} />,
        },
        {
            title: "邮箱",
            dataIndex: "email",
            width: 220,
            responsive: ["sm"],
            render: (email?: string) => <span className="block truncate text-sm text-zinc-600 dark:text-zinc-300">{email || "未绑定邮箱"}</span>,
        },
        {
            title: "角色",
            dataIndex: "role",
            width: 170,
            responsive: ["sm"],
            render: (role: UserRole, record) => (
                <div>
                    <Tag color={role === "admin" ? "blue" : "default"}>{role === "admin" ? "管理员" : "普通用户"}</Tag>
                    {role === "admin" ? <div className="mt-1.5 text-xs text-stone-500 dark:text-stone-400">{adminPermissionSummary(record.adminPermissions)}</div> : null}
                </div>
            ),
        },
        {
            title: "状态",
            dataIndex: "status",
            width: 120,
            responsive: ["sm"],
            render: (status: UserStatus) => <Tag color={status === "active" ? "green" : "red"}>{status === "active" ? "可用" : "已禁用"}</Tag>,
        },
        {
            title: "人民币余额",
            dataIndex: "pointsBalance",
            width: 170,
            responsive: ["sm"],
            render: (pointsBalance: number, record) => (
                <div className="text-xs text-stone-500 dark:text-stone-400">
                    <div className="font-semibold text-stone-950 dark:text-stone-100">总计 ¥{formatCreditAmount(pointsBalance)}</div>
                    <div className="mt-1">
                        今日 ¥{formatCreditAmount(record.dailyPointsBalance)} · 永久 ¥{formatCreditAmount(record.permanentPointsBalance)}
                    </div>
                </div>
            ),
        },
        {
            title: "时间",
            width: 210,
            responsive: ["sm"],
            render: (_, record) => (
                <div className="space-y-1 text-xs text-stone-500 dark:text-stone-400">
                    <div>
                        <span className="mr-2 text-stone-400 dark:text-stone-500">注册</span>
                        {formatAdminLogTime(record.createdAt)}
                    </div>
                    <div>
                        <span className="mr-2 text-stone-400 dark:text-stone-500">活跃</span>
                        {record.lastLoginAt ? formatAdminLogTime(record.lastLoginAt) : "从未登录"}
                    </div>
                </div>
            ),
        },
        {
            title: "操作",
            width: 150,
            render: (_, record) => {
                const canEdit = canEditUserRecord(record);
                const canDelete = canDeleteUserRecord(record);
                if (!canEdit && !canDelete) return <span className="text-xs text-stone-400">只读</span>;
                return (
                    <Space size={6}>
                        {canEdit ? (
                            <Button size="small" icon={<SlidersHorizontal className="size-3.5" />} loading={updatingUserId === record.id} onClick={() => openUserEditor(record)}>
                                管理
                            </Button>
                        ) : null}
                        {canDelete ? (
                            <Popconfirm title="删除该用户？" description="会同时清理该用户会话、余额、额度记录、生成日志和服务器副本。" okText="删除" cancelText="取消" onConfirm={() => void deleteUser(record.id)}>
                                <Button size="small" danger loading={updatingUserId === record.id} icon={<Trash2 className="size-3.5" />} aria-label={`删除用户 ${record.displayName}`} title={`删除用户 ${record.displayName}`} />
                            </Popconfirm>
                        ) : null}
                    </Space>
                );
            },
        },
    ];

    const promptColumns: TableColumnsType<Prompt> = [
        {
            title: "提示词",
            dataIndex: "title",
            render: (_, record) => (
                <div className="flex min-w-0 gap-3">
                    {record.coverUrl ? (
                        <img src={imagePreviewUrl(record.coverUrl, 480)} alt={record.title} className="h-14 w-20 shrink-0 rounded-md border border-stone-200 object-cover dark:border-stone-800" loading="lazy" referrerPolicy="no-referrer" />
                    ) : (
                        <div className="h-14 w-20 shrink-0 rounded-md border border-stone-200 bg-stone-100 dark:border-stone-800 dark:bg-stone-900" />
                    )}
                    <div className="min-w-0">
                        <div className="font-medium text-stone-950 dark:text-stone-100">{record.title}</div>
                        <div className="mt-1 line-clamp-2 text-xs leading-5 text-stone-500 dark:text-stone-400">{record.prompt}</div>
                        <div className="mt-2 flex flex-wrap gap-1">
                            {record.tags.map((tag) => (
                                <Tag key={tag} className="m-0 text-[11px]">
                                    {tag}
                                </Tag>
                            ))}
                        </div>
                    </div>
                </div>
            ),
        },
        { title: "分类", dataIndex: "category", width: 140 },
        {
            title: "操作",
            width: 90,
            render: (_, record) => (
                <Popconfirm title="删除公共提示词？" okText="删除" cancelText="取消" onConfirm={() => deletePrompt(record.id)}>
                    <Button size="small" danger loading={deletingPromptId === record.id} icon={<Trash2 className="size-3.5" />} aria-label={`删除提示词 ${record.title}`} title={`删除提示词 ${record.title}`} />
                </Popconfirm>
            ),
        },
    ];
    const generationLogColumns: TableColumnsType<StoredGenerationLog> = [
        {
            title: "时间",
            dataIndex: "createdAt",
            width: 170,
            render: (value) => <span className="text-sm text-stone-700 dark:text-stone-200">{formatAdminLogTime(String(value))}</span>,
        },
        {
            title: "类型",
            dataIndex: "kind",
            width: 92,
            render: (_, record) => (
                <Tag className="m-0" color={record.kind === "video" ? "purple" : "blue"}>
                    {generationKindLabel(record.kind)}
                </Tag>
            ),
        },
        {
            title: "用户",
            width: 200,
            render: (_, record) => <AdminUserIdentity displayName={record.displayName} username={record.username} accountId={record.accountId} fallback="用户信息不可用" />,
        },
        {
            title: "入口",
            dataIndex: "source",
            width: 120,
            render: (value) => <span className="text-sm text-stone-600 dark:text-stone-300">{generationSourceLabel(String(value))}</span>,
        },
        {
            title: "模型",
            dataIndex: "model",
            width: 160,
            render: (value) => <span className="line-clamp-1 text-sm text-stone-600 dark:text-stone-300">{formatGenerationLogModel(String(value || ""))}</span>,
        },
        {
            title: "耗时",
            dataIndex: "durationMs",
            width: 90,
            render: (value) => <span className="text-sm tabular-nums text-stone-700 dark:text-stone-200">{formatAdminLogDuration(Number(value) || 0)}</span>,
        },
        {
            title: "状态",
            dataIndex: "status",
            width: 92,
                render: (_, record) => <span className={generationStatusClass(record.status)}>{generationStatusLabel(record.status)}</span>,
        },
        {
            title: "失败原因",
            width: 150,
            render: (_, record) => (record.status === "failed" && record.error ? <Tag className="m-0" color="red">{generationErrorCategoryLabel(classifyGenerationError(record.error))}</Tag> : <span className="text-sm text-stone-400">-</span>),
        },
        {
            title: "结果",
            width: 100,
            render: (_, record) => <GenerationLogAssetPreview log={record} />,
        },
        {
            title: "提示词",
            dataIndex: "prompt",
            width: 360,
            render: (_, record) => (
                <div className="admin-generation-log-prompt-cell min-w-0">
                    <div className="truncate text-sm font-medium text-stone-900 dark:text-stone-100">{record.title}</div>
                    <div className="mt-1 line-clamp-2 text-xs leading-5 text-stone-500 dark:text-stone-400">{record.prompt || record.summary}</div>
                </div>
            ),
        },
        {
            title: "操作",
            width: 176,
            fixed: "right",
            render: (_, record) => (
                <div className="admin-generation-log-actions">
                    <Button size="small" type="text" icon={<Eye className="size-3.5" />} onClick={() => setViewingGenerationLog(record)}>
                        详情
                    </Button>
                    <Popconfirm title="删除这条生成日志？" okText="删除" cancelText="取消" onConfirm={() => void deleteGenerationLogsByIds([record.id])}>
                        <Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />}>
                            删除
                        </Button>
                    </Popconfirm>
                </div>
            ),
        },
    ];
    const cdkColumns: TableColumnsType<PublicCdkCode> = [
        {
            title: "CDK",
            dataIndex: "codePreview",
            width: 390,
            render: (_, code) => (
                <div className="min-w-0 space-y-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="min-w-0 max-w-full truncate font-mono text-sm font-semibold text-stone-950 dark:text-stone-100">{code.code || "CDK"}</span>
                        <Tag className="m-0" color={cdkStatusTone(code)}>
                            {cdkStatusLabel(code)}
                        </Tag>
                    </div>
                    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
                        <Button className="h-6 px-1.5 text-xs" size="small" type="text" icon={<Copy className="size-3.5" />} onClick={() => void copyCdkPlainCode(code)}>
                            复制
                        </Button>
                        {code.note ? <span className="min-w-0 max-w-full truncate">备注：{code.note}</span> : null}
                    </div>
                </div>
            ),
        },
        {
            title: "兑换规则",
            width: 190,
            render: (_, code) => (
                <div className="text-sm leading-6 text-stone-700 dark:text-stone-200">
                    <div>¥{formatCreditAmount(code.points)} 余额</div>
                    <div className="text-xs text-stone-500 dark:text-stone-400">
                        已兑 {code.redeemedCount}/{code.maxRedemptions}
                    </div>
                </div>
            ),
        },
        {
            title: "最近兑换",
            width: 260,
            render: (_, code) => {
                const latest = [...code.redemptions].sort((a, b) => Date.parse(b.redeemedAt) - Date.parse(a.redeemedAt))[0];
                if (!latest) return <span className="text-sm text-stone-500 dark:text-stone-400">暂无兑换</span>;
                return (
                    <div className="min-w-0 text-sm leading-6 text-stone-700 dark:text-stone-200">
                        <div className="truncate font-medium">
                            {latest.displayName}
                            <span className="ml-1 font-normal text-stone-500 dark:text-stone-400">@{latest.username}</span>
                        </div>
                        <AdminAccountId accountId={latest.accountId} />
                        <div className="text-xs text-stone-500 dark:text-stone-400">{new Date(latest.redeemedAt).toLocaleString("zh-CN")}</div>
                    </div>
                );
            },
        },
        {
            title: "有效期",
            width: 190,
            render: (_, code) => (
                <div className="text-sm text-stone-700 dark:text-stone-200">
                    {code.expiresAt ? (
                        <>
                            <div>{new Date(code.expiresAt).toLocaleString("zh-CN")}</div>
                            <div className="text-xs text-stone-500 dark:text-stone-400">创建 {new Date(code.createdAt).toLocaleDateString("zh-CN")}</div>
                        </>
                    ) : (
                        <>
                            <div>长期有效</div>
                            <div className="text-xs text-stone-500 dark:text-stone-400">创建 {new Date(code.createdAt).toLocaleDateString("zh-CN")}</div>
                        </>
                    )}
                </div>
            ),
        },
        {
            title: "操作",
            width: 200,
            fixed: "right",
            render: (_, code) => (
                <Space size={6} wrap>
                    <Button size="small" type="text" icon={<Eye className="size-3.5" />} onClick={() => setViewingCdkCode(code)}>
                        明细
                    </Button>
                    <Popconfirm title="删除这个 CDK？" description="删除后用户将不能再兑换这个密钥，已有余额流水不会被删除。" okText="删除" cancelText="取消" onConfirm={() => void deleteCdkById(code.id)}>
                        <Button size="small" danger icon={<Trash2 className="size-3.5" />}>
                            删除
                        </Button>
                    </Popconfirm>
                </Space>
            ),
        },
    ];
    const activeSectionInfo = adminSections.find((section) => section.key === activeSection) || adminSections[0];
    const nextSetupStep = setupSummary?.steps.find((step) => step.status !== "done") || setupSummary?.steps[setupSummary.steps.length - 1];
    return {
        openUserEditor,
        openCreateUserEditor,
        closeUserEditor,
        saveUserEditor,
        userColumns,
        promptColumns,
        generationLogColumns,
        cdkColumns,
        activeSectionInfo,
        nextSetupStep,
    };
}

export type AdminDashboardTableModel = ReturnType<typeof useAdminDashboardTableModel>;
