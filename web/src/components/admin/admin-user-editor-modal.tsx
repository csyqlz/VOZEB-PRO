"use client";

import { Checkbox, Form, Input, InputNumber, Modal, Select } from "antd";

import type { AdminDashboardController } from "./use-admin-dashboard-controller";
import { ADMIN_PERMISSION_DEFINITIONS, ADMIN_PERMISSION_GROUPS, ADMIN_PERMISSION_PRESETS, adminPermissionSummary, hasAdminPermission, hasAllAdminPermissions, normalizeAdminPermissions } from "@/lib/admin-permissions";

export function AdminUserEditorModal({ controller }: { controller: AdminDashboardController }) {
    const { currentUser, userForm, editingUser, creatingUser, updatingUserId, closeUserEditor, saveUserEditor } = controller;
    const selectedRole = Form.useWatch("role", userForm) || editingUser?.role || "user";
    const canManageUsers = hasAdminPermission(currentUser, "users.manage");
    const canManageAdministrators = hasAdminPermission(currentUser, "administrators.manage");
    const canManageBilling = hasAdminPermission(currentUser, "billing.manage");
    const targetWithinScope = editingUser?.role !== "admin" || hasAllAdminPermissions(currentUser, editingUser.adminPermissions);
    const touchesAdministrator = selectedRole === "admin" || editingUser?.role === "admin";
    const canEditAccount = touchesAdministrator ? canManageAdministrators && targetWithinScope : canManageUsers;
    const ownPermissions = normalizeAdminPermissions(currentUser.adminPermissions);
    const allowedPresets = ADMIN_PERMISSION_PRESETS.filter((preset) => preset.permissions.every((permission) => ownPermissions.includes(permission)));
    const assignablePermissions = ADMIN_PERMISSION_DEFINITIONS.filter((permission) => ownPermissions.includes(permission.key));
    const selectedPermissions = normalizeAdminPermissions(Form.useWatch("adminPermissions", userForm));
    const assignablePermissionGroups = ADMIN_PERMISSION_GROUPS.map((group) => ({
        ...group,
        permissions: assignablePermissions.filter((permission) => permission.group === group.key),
    })).filter((group) => group.permissions.length > 0);
    const canUseRole = (role: "user" | "admin") => {
        if (creatingUser) return role === "admin" ? canManageAdministrators : canManageUsers;
        if (editingUser?.role === "admin") return canManageAdministrators && targetWithinScope;
        return role === "admin" ? canManageAdministrators : canManageUsers;
    };
    const roleOptions = [
        { value: "user", label: "普通用户", disabled: !canUseRole("user") },
        { value: "admin", label: "管理员", disabled: !canUseRole("admin") },
    ];

    const selectRole = (role: "user" | "admin") => {
        if (role !== "admin" || normalizeAdminPermissions(userForm.getFieldValue("adminPermissions")).length) return;
        userForm.setFieldsValue({
            adminPermissions: ownPermissions,
            permissionPreset: matchingPreset(ownPermissions),
        });
    };

    const selectPreset = (presetKey?: string) => {
        const preset = allowedPresets.find((item) => item.key === presetKey);
        if (preset) userForm.setFieldsValue({ adminPermissions: [...preset.permissions] });
    };

    const selectPermissions = (permissions: unknown[]) => {
        const normalized = normalizeAdminPermissions(permissions);
        userForm.setFieldsValue({ permissionPreset: matchingPreset(normalized) });
    };

    return (
        <Modal
            title={creatingUser ? "新增用户" : editingUser ? `用户管理：${editingUser.displayName}` : "用户管理"}
            open={creatingUser || Boolean(editingUser)}
            okText={creatingUser ? "新增" : "保存"}
            cancelText="取消"
            centered
            width="min(960px, calc(100vw - 24px))"
            confirmLoading={creatingUser ? updatingUserId === "__new__" : Boolean(editingUser && updatingUserId === editingUser.id)}
            onOk={() => userForm.submit()}
            onCancel={closeUserEditor}
            styles={{ container: { display: "flex", maxHeight: "calc(100dvh - 24px)", flexDirection: "column" }, body: { minHeight: 0, overflowY: "auto", paddingTop: 12 }, footer: { flexShrink: 0 } }}
        >
            <Form form={userForm} layout="vertical" requiredMark={false} onFinish={saveUserEditor}>
                <div className="grid gap-x-4 md:grid-cols-2">
                    <Form.Item label="账号" name="username" rules={[{ required: creatingUser, message: "请输入账号" }]}>
                        <Input disabled={!creatingUser || !canEditAccount} placeholder="支持中文、数字和字母" />
                    </Form.Item>
                    <Form.Item label="显示昵称" name="displayName" rules={[{ required: true, message: "请输入显示昵称" }]}>
                        <Input disabled={!canEditAccount} placeholder="显示在顶部账号菜单" />
                    </Form.Item>
                    <Form.Item label="绑定邮箱" name="email">
                        <Input disabled={!canEditAccount} placeholder="可留空" />
                    </Form.Item>
                    <Form.Item
                        label={creatingUser ? "登录密码" : "重置密码"}
                        name="password"
                        rules={[{ required: creatingUser, message: "请输入登录密码" }]}
                        extra={creatingUser ? "至少 8 位，创建后用户可自行修改。" : "留空则不修改密码；填写后该用户需要重新登录。"}
                    >
                        <Input.Password disabled={!canEditAccount} placeholder="至少 8 位" />
                    </Form.Item>
                </div>
                <div className="grid gap-x-4 md:grid-cols-3">
                    <Form.Item label="角色" name="role" rules={[{ required: true, message: "请选择角色" }]}>
                        <Select disabled={!roleOptions.some((option) => !option.disabled)} options={roleOptions} onChange={selectRole} />
                    </Form.Item>
                    <Form.Item label="账号状态" name="status" rules={[{ required: true, message: "请选择状态" }]}>
                        <Select
                            disabled={!canEditAccount || editingUser?.id === currentUser.id}
                            options={[
                                { value: "active", label: "可用" },
                                { value: "disabled", label: "禁用" },
                            ]}
                        />
                    </Form.Item>
                    <Form.Item label="永久人民币余额" name="pointsBalance" extra={editingUser ? "每日余额由系统自动结算" : undefined} rules={[{ required: true, message: "请输入人民币余额" }]}>
                        <InputNumber className="!w-full" disabled={!canManageBilling} min={0} precision={8} prefix="¥" />
                    </Form.Item>
                </div>
                {selectedRole === "admin" ? (
                    targetWithinScope ? (
                        <div className="border-t border-stone-200 pt-4 dark:border-stone-800">
                            <div className="grid gap-x-4 md:grid-cols-2">
                                <Form.Item label="职责预设" name="permissionPreset" extra="预设只包含当前账号可以授予的职责。">
                                    <Select allowClear disabled={!canEditAccount} placeholder="自定义职责" options={allowedPresets.map((preset) => ({ value: preset.key, label: preset.label, title: preset.description }))} onChange={selectPreset} />
                                </Form.Item>
                            </div>
                            <Form.Item label="职责权限" name="adminPermissions" rules={[{ type: "array", min: 1, message: "管理员至少需要一项职责权限" }]} extra="只能授予当前管理员自己拥有的权限。">
                                <Checkbox.Group className="!block w-full" disabled={!canEditAccount} onChange={selectPermissions} aria-label="职责权限">
                                    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2" data-admin-permission-grid>
                                        {assignablePermissionGroups.map((group) => {
                                            const selectedCount = group.permissions.filter((permission) => selectedPermissions.includes(permission.key)).length;
                                            return (
                                                <section key={group.key} className="min-w-0 self-start overflow-hidden rounded-md border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900/70" data-admin-permission-group={group.key}>
                                                    <div className="flex items-start justify-between gap-3 border-b border-stone-200 bg-stone-50/70 px-4 py-3 dark:border-stone-800 dark:bg-stone-950/30">
                                                        <div className="min-w-0">
                                                            <h4 className="text-sm font-semibold leading-5 text-stone-900 dark:text-stone-100">{group.label}</h4>
                                                            <p className="mt-0.5 text-xs leading-5 text-stone-500 dark:text-stone-400">{group.description}</p>
                                                        </div>
                                                        <span className="shrink-0 pt-0.5 text-xs leading-5 text-stone-500 tabular-nums dark:text-stone-400">
                                                            {selectedCount}/{group.permissions.length} 已选
                                                        </span>
                                                    </div>
                                                    <div className="divide-y divide-stone-200/80 dark:divide-stone-800">
                                                        {group.permissions.map((permission) => (
                                                            <div
                                                                key={permission.key}
                                                                className={`px-4 py-2.5 transition-colors ${canEditAccount ? "hover:bg-stone-50 focus-within:bg-stone-50 dark:hover:bg-stone-800/40 dark:focus-within:bg-stone-800/40" : "opacity-70"}`}
                                                                data-admin-permission-item
                                                            >
                                                                <Checkbox value={permission.key} className="!m-0 !flex !w-full min-w-0 items-start" classNames={{ icon: "mt-0.5", label: "min-w-0 flex-1" }}>
                                                                    <span className="grid min-w-0 grid-cols-[6rem_minmax(0,1fr)] items-baseline gap-x-3">
                                                                        <span className="text-[13px] font-medium leading-5 text-stone-800 dark:text-stone-200">{permission.label}</span>
                                                                        <span className="text-xs leading-5 text-stone-500 dark:text-stone-400">{permission.description}</span>
                                                                    </span>
                                                                </Checkbox>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </section>
                                            );
                                        })}
                                    </div>
                                </Checkbox.Group>
                            </Form.Item>
                        </div>
                    ) : (
                        <div className="border-t border-stone-200 py-4 text-sm text-stone-500 dark:border-stone-800 dark:text-stone-400">
                            该管理员的职责范围为“{adminPermissionSummary(editingUser?.adminPermissions)}”，超出当前账号权限，只能查看或调整人民币余额。
                        </div>
                    )
                ) : null}
            </Form>
        </Modal>
    );
}

function matchingPreset(permissions: unknown) {
    const normalized = normalizeAdminPermissions(permissions);
    return ADMIN_PERMISSION_PRESETS.find((preset) => normalizeAdminPermissions(preset.permissions).join() === normalized.join())?.key;
}
