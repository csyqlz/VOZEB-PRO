"use client";

import { Button, Select, Switch, Tag, Tooltip } from "antd";
import { ArrowDown, ArrowUp, GitBranch, Plus, Trash2 } from "lucide-react";

import { SectionTitle } from "@/components/admin/admin-settings-controls";
import type { EcommerceLogicalModelRole, EcommerceModelRoles, LogicalModel } from "@/lib/auth/store";
import { ECOMMERCE_MODEL_ROLE_DEFINITIONS } from "@/lib/ecommerce-model-role-config";
import { addEcommerceRoleModel, availableEcommerceRoleModels, moveEcommerceRoleModel, removeEcommerceRoleModel } from "./ecommerce-model-role-settings";

type Props = {
    logicalModels: LogicalModel[];
    roles: EcommerceModelRoles;
    enabled: boolean;
    onEnabledChange: (enabled: boolean) => void;
    visualQualityEnabled?: boolean;
    onVisualQualityEnabledChange?: (enabled: boolean) => void;
    onChange: (roles: EcommerceModelRoles) => void;
};

export function AdminEcommerceModelRoleManager({ logicalModels, roles, enabled, onEnabledChange, visualQualityEnabled = false, onVisualQualityEnabledChange, onChange }: Props) {
    const configured = ECOMMERCE_MODEL_ROLE_DEFINITIONS.filter(({ role }) => roles[role].length).length;
    const updateRole = (role: EcommerceLogicalModelRole, modelIds: string[]) => onChange({ ...roles, [role]: modelIds });

    return (
        <section className="border-t border-stone-200 pt-5 dark:border-stone-800">
            <div className="flex flex-wrap items-center gap-2">
                <SectionTitle icon={<GitBranch className="size-4" />} title="电商生成模型链路" />
                <Tag color={configured === ECOMMERCE_MODEL_ROLE_DEFINITIONS.length ? "green" : "blue"} className="m-0">
                    已配置 {configured}/{ECOMMERCE_MODEL_ROLE_DEFINITIONS.length}
                </Tag>
            </div>

            <div className="mt-4 flex items-center justify-between gap-4 rounded-md border border-stone-200 bg-stone-50 px-4 py-3 dark:border-stone-800 dark:bg-stone-900/40">
                <div>
                    <div className="text-sm font-semibold text-stone-950 dark:text-stone-100">启用电商生图编排</div>
                    <div className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">开启后，带图片参考的创作任务将进入视觉分析、编辑规划和图片生成流程。</div>
                </div>
                <Switch aria-label="启用电商生图编排" checked={enabled} onChange={onEnabledChange} />
            </div>

            <div className="mt-3 flex items-center justify-between gap-4 rounded-md border border-stone-200 px-4 py-3 dark:border-stone-800">
                <div>
                    <div className="text-sm font-semibold text-stone-950 dark:text-stone-100">启用可选视觉质检</div>
                    <div className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">默认关闭。开启后提供商品细节与场景建议，不会退回或隐藏已生成图片；图片保存、尺寸与选区保护仍会检查。</div>
                </div>
                <Switch aria-label="启用可选视觉质检" checked={visualQualityEnabled} onChange={onVisualQualityEnabledChange} />
            </div>

            <div className="mt-4 divide-y divide-stone-200 border-y border-stone-200 dark:divide-stone-800 dark:border-stone-800">
                {ECOMMERCE_MODEL_ROLE_DEFINITIONS.map(({ role, label, capability }) => {
                    const selectedIds = roles[role];
                    const available = availableEcommerceRoleModels(logicalModels, role);
                    const options = available.filter((model) => !selectedIds.includes(model.id)).map((model) => ({ label: model.name, value: model.id }));
                    const fallback = capability === "image" ? "使用系统默认图片模型" : "使用系统默认文本模型";
                    return (
                        <div key={role} className="grid gap-3 py-4 lg:grid-cols-[180px_minmax(0,1fr)_260px] lg:items-start">
                            <div>
                                <div className="text-sm font-semibold text-stone-950 dark:text-stone-100">{label}</div>
                                <Tag className="mt-1">{capability === "image" ? "图片" : "文本"}</Tag>
                            </div>
                            <div className="min-w-0 space-y-2">
                                {selectedIds.map((modelId, index) => {
                                    const model = logicalModels.find((item) => item.id === modelId);
                                    return (
                                        <div key={modelId} className="flex min-w-0 items-center gap-2 border-b border-stone-100 pb-2 last:border-b-0 dark:border-stone-900">
                                            <span className="w-6 shrink-0 text-center text-xs font-semibold text-stone-500">{index + 1}</span>
                                            <span className="min-w-0 flex-1 truncate text-sm">{model?.name || modelId}</span>
                                            {!model?.enabled ? <Tag color="warning">不可用</Tag> : null}
                                            <Tooltip title="上移优先级">
                                                <Button
                                                    type="text"
                                                    size="small"
                                                    aria-label={`${label}候选上移`}
                                                    disabled={index === 0}
                                                    icon={<ArrowUp className="size-4" />}
                                                    onClick={() => updateRole(role, moveEcommerceRoleModel(selectedIds, index, -1))}
                                                />
                                            </Tooltip>
                                            <Tooltip title="下移优先级">
                                                <Button
                                                    type="text"
                                                    size="small"
                                                    aria-label={`${label}候选下移`}
                                                    disabled={index === selectedIds.length - 1}
                                                    icon={<ArrowDown className="size-4" />}
                                                    onClick={() => updateRole(role, moveEcommerceRoleModel(selectedIds, index, 1))}
                                                />
                                            </Tooltip>
                                            <Tooltip title="移除候选模型">
                                                <Button type="text" danger size="small" aria-label={`${label}移除候选`} icon={<Trash2 className="size-4" />} onClick={() => updateRole(role, removeEcommerceRoleModel(selectedIds, modelId))} />
                                            </Tooltip>
                                        </div>
                                    );
                                })}
                                {!selectedIds.length ? <div className="py-1 text-sm text-stone-500 dark:text-stone-400">{fallback}</div> : null}
                            </div>
                            <Select
                                className="w-full"
                                allowClear
                                showSearch
                                value={undefined}
                                optionFilterProp="label"
                                placeholder="添加候选模型"
                                suffixIcon={<Plus className="size-4" />}
                                options={options}
                                notFoundContent="没有匹配能力的可用模型"
                                onChange={(modelId) => modelId && updateRole(role, addEcommerceRoleModel(selectedIds, modelId))}
                            />
                        </div>
                    );
                })}
            </div>
        </section>
    );
}
