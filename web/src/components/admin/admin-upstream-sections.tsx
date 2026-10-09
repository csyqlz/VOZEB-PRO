"use client";

import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import { AgentSkillCreateModal } from "@/components/admin/agent-skill-create-modal";
import { AdminChannelWorkspace } from "@/components/admin/channels/admin-channel-workspace";
import type { AgentSkill } from "@/lib/auth/store";
import { Alert, Button, Input, InputNumber, Select, Switch, Tag } from "antd";
import { Activity, ChevronDown, Plus, Save, Trash2 } from "lucide-react";
import { useState } from "react";

import type { AdminDashboardController } from "./use-admin-dashboard-controller";

export function AdminChannelsSection({ controller }: { controller: AdminDashboardController }) {
    const { settings, setSettings, settingsLoading, fetchingModelId, activeSection, agentReadiness, setAgentReadiness, saveSettings, deleteChannel, fetchModelsForChannel, fetchAllModels, message } = controller;
    const [diagnosing, setDiagnosing] = useState(false);
    if (activeSection !== "channels") return null;
    const runDiagnostics = async () => {
        if (diagnosing) return;
        setDiagnosing(true);
        try {
            const response = await fetch("/api/admin/agent-readiness", { method: "POST", cache: "no-store" });
            const payload = await response.json().catch(() => null);
            if (!response.ok || payload?.code !== 0) throw new Error(payload?.msg || "模型诊断失败");
            setAgentReadiness(payload.data);
            message.success(payload.msg || "模型诊断完成");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "模型诊断失败");
        } finally {
            setDiagnosing(false);
        }
    };
    return (
        <Panel>
            <PanelHeader
                title="模型渠道"
                description="管理上游渠道、协议、模型能力与站内逻辑模型路由。"
                actions={
                    <Button
                        type="primary"
                        aria-label="保存模型渠道配置"
                        title="保存模型渠道配置"
                        loading={settingsLoading}
                        icon={<Save className="size-4" />}
                        onClick={() => saveSettings((current) => ({ systemChannels: current.systemChannels, logicalModels: current.logicalModels, defaultModels: current.defaultModels }), "模型渠道配置已保存")}
                    >
                        保存更改
                    </Button>
                }
            />
            <div className="p-3 sm:p-5">
                <ModelDiagnosticsCard readiness={agentReadiness} loading={diagnosing} onRun={runDiagnostics} />
                <AdminChannelWorkspace
                    settings={{ systemChannels: settings.systemChannels, logicalModels: settings.logicalModels, defaultModels: settings.defaultModels }}
                    fetchingModelId={fetchingModelId}
                    saving={settingsLoading}
                    onChange={(next) => setSettings((current) => ({ ...current, ...next }))}
                    onDeleteChannel={deleteChannel}
                    onFetchModels={fetchModelsForChannel}
                    onFetchAll={fetchAllModels}
                    onPersist={(next, successText) => saveSettings(next, successText)}
                />
            </div>
        </Panel>
    );
}

function ModelDiagnosticsCard({ readiness, loading, onRun }: { readiness: AdminDashboardController["agentReadiness"]; loading: boolean; onRun: () => void }) {
    const probes = readiness?.diagnostics?.probes || [];
    const textProbe = probes.find((probe) => probe.capability === "text");
    return (
        <section className="mb-4 rounded-lg border border-stone-200 bg-stone-50/70 p-4 dark:border-stone-800 dark:bg-stone-900/40" data-testid="admin-model-diagnostics">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <div className="flex items-center gap-2 font-semibold">
                        <Activity className="size-4" />
                        模型诊断
                    </div>
                    <p className="mt-1 text-sm leading-6 text-stone-500 dark:text-stone-400">检查默认模型、渠道绑定、API Key 与基础生成参数；点击按钮会对默认文本模型发起一次极短实测。</p>
                </div>
                <Button icon={<Activity className="size-4" />} loading={loading} onClick={onRun}>
                    运行低成本诊断
                </Button>
            </div>
            {readiness ? (
                <div className="mt-4 space-y-3">
                    <Alert type={readiness.ready ? "success" : "warning"} showIcon message={readiness.diagnostics?.summary || (readiness.ready ? "模型配置已就绪" : "模型配置需要检查")} />
                    <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                        {readiness.capabilities.map((item) => (
                            <div key={item.type} className="rounded-md border border-stone-200 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-950">
                                <div className="flex items-center justify-between gap-2">
                                    <span className="font-medium">{{ text: "文本生成", image: "图片生成", video: "视频生成", audio: "音频生成" }[item.type]}</span>
                                    <Tag className="m-0" color={item.ready && item.configured !== false ? "success" : item.configured === false ? "default" : "warning"}>
                                        {item.ready && item.configured !== false ? "配置可用" : item.configured === false ? "未启用" : "需处理"}
                                    </Tag>
                                </div>
                                <div className="mt-1 truncate text-xs text-stone-500">{item.model || "未设置默认模型"}</div>
                                <div className="mt-1 truncate text-xs text-stone-500">{item.channelName || item.message}</div>
                                <div className="mt-2 space-y-1">
                                    {item.checks.slice(0, 4).map((check) => (
                                        <div key={check.key} className="flex items-start gap-1.5 text-xs leading-5 text-stone-500">
                                            <span className={check.status === "pass" ? "text-emerald-600" : check.status === "warn" ? "text-amber-600" : "text-red-600"}>{check.status === "pass" ? "✓" : check.status === "warn" ? "!" : "×"}</span>
                                            <span className="min-w-0 truncate" title={check.message}>
                                                {check.label}：{check.message}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                    {textProbe ? (
                        <div className="rounded-md border border-stone-200 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-950">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className="font-medium">文本模型实测</span>
                                <Tag className="m-0" color={textProbe.status === "pass" ? "success" : textProbe.status === "skip" ? "default" : "error"}>
                                    {textProbe.status === "pass" ? "通过" : textProbe.status === "skip" ? "跳过" : "失败"}
                                </Tag>
                            </div>
                            <div className="mt-1 text-xs leading-5 text-stone-500">
                                {textProbe.message}
                                {textProbe.channelName ? ` · ${textProbe.channelName}` : ""}
                                {textProbe.protocol ? ` · ${textProbe.protocol}` : ""}
                                {typeof textProbe.elapsedMs === "number" ? ` · ${textProbe.elapsedMs}ms` : ""}
                                {typeof textProbe.pointsCost === "number" ? ` · 约 ${textProbe.pointsCost} 积分` : ""}
                            </div>
                        </div>
                    ) : null}
                    {readiness.diagnostics?.blockingIssues?.length ? <Alert type="error" showIcon message="需要先修复" description={readiness.diagnostics.blockingIssues.join("；")} /> : null}
                    {readiness.diagnostics?.warnings?.length ? <Alert type="warning" showIcon message="建议优化" description={readiness.diagnostics.warnings.join("；")} /> : null}
                </div>
            ) : (
                <p className="mt-3 text-xs leading-5 text-stone-500">尚未加载诊断结果。保存模型渠道后可运行一次低成本诊断。</p>
            )}
        </section>
    );
}

export function AdminSkillsSection({ controller }: { controller: AdminDashboardController }) {
    const { settings, setSettings, settingsLoading, activeSection, agentReadiness, saveSettings } = controller;
    const [createModalOpen, setCreateModalOpen] = useState(false);
    if (activeSection !== "skills") return null;
    return (
        <Panel>
            <PanelHeader
                title="Agent Skills"
                description="管理 Agent 的专业能力、触发关键词、来源版本和执行规则。"
                actions={
                    <>
                        <Button icon={<Plus className="size-4" />} onClick={() => setCreateModalOpen(true)}>
                            新增 Skill
                        </Button>
                        <Button type="primary" loading={settingsLoading} icon={<Save className="size-4" />} onClick={() => saveSettings((current) => ({ agentSkills: current.agentSkills }), "Agent Skills 已保存")}>
                            保存
                        </Button>
                    </>
                }
            />
            {agentReadiness ? (
                <div className="mx-4 mt-4 rounded-lg border border-stone-200 bg-stone-50/70 p-4 dark:border-stone-800 dark:bg-stone-900/40 sm:mx-5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="font-semibold">Agent 执行就绪检查</div>
                        <Tag color={agentReadiness.ready ? "success" : "warning"}>{agentReadiness.ready ? "四类能力已就绪" : "需要补充模型配置"}</Tag>
                    </div>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                        {agentReadiness.capabilities.map((item) => (
                            <div key={item.type} className="rounded-md border border-stone-200 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-950">
                                <div className="flex items-center justify-between">
                                    <span className="font-medium">{{ text: "文本", image: "图片", video: "视频", audio: "音频" }[item.type]}</span>
                                    <span className={item.ready && item.configured !== false ? "text-emerald-600" : "text-amber-600"}>{item.ready && item.configured !== false ? "就绪" : item.configured === false ? "未启用" : "未就绪"}</span>
                                </div>
                                <div className="mt-1 truncate text-xs text-stone-500">{item.model || "未设置模型"}</div>
                                <div className="mt-1 text-xs text-stone-500">{item.message}</div>
                            </div>
                        ))}
                    </div>
                    <div className="mt-3 text-xs text-stone-500">
                        启用 Skills：生图 {agentReadiness.skills.image} · 视频 {agentReadiness.skills.video} · 画布 {agentReadiness.skills.canvas} · 短剧 {agentReadiness.skills.drama}
                    </div>
                </div>
            ) : null}
            <div className="columns-1 gap-4 p-3 sm:p-5 lg:columns-2">
                {settings.agentSkills.map((skill) => (
                    <section key={skill.id} className="mb-3 break-inside-avoid rounded-lg border border-stone-200 bg-stone-50/70 p-3 sm:mb-4 sm:p-4 dark:border-stone-800 dark:bg-stone-900/40">
                        <div className="flex items-center justify-between gap-3 sm:mb-3">
                            <div>
                                <div className="font-semibold">{skill.name}</div>
                                {skill.sourceUrl ? (
                                    <a href={skill.sourceUrl} target="_blank" rel="noreferrer" className="text-xs text-blue-600 dark:text-blue-400">
                                        {skill.sourceVersion || "GitHub"} · {skill.license || "来源"}
                                    </a>
                                ) : null}
                            </div>
                            <div className="flex items-center gap-2">
                                <Switch
                                    aria-label={`${skill.name}启用状态`}
                                    checked={skill.enabled}
                                    onChange={(enabled) => setSettings((current) => ({ ...current, agentSkills: current.agentSkills.map((item) => (item.id === skill.id ? { ...item, enabled } : item)) }))}
                                />
                                <Button
                                    type="text"
                                    danger
                                    icon={<Trash2 className="size-4" />}
                                    aria-label={`删除 Skill ${skill.name}`}
                                    title={`删除 Skill ${skill.name}`}
                                    onClick={() => setSettings((current) => ({ ...current, agentSkills: current.agentSkills.filter((item) => item.id !== skill.id) }))}
                                />
                            </div>
                        </div>
                        <details className="group">
                            <summary className="mt-2 flex cursor-pointer list-none items-center justify-between rounded-md border border-stone-200 bg-white px-3 py-2 text-xs font-medium text-stone-700 transition hover:bg-stone-50 sm:hidden dark:border-stone-700 dark:bg-stone-950 dark:text-stone-200 dark:hover:bg-stone-900">
                                编辑规则
                                <ChevronDown className="size-3.5 transition group-open:rotate-180" />
                            </summary>
                            <div className="mt-3 hidden group-open:block sm:mt-0 sm:!block">
                                <Input
                                    value={skill.name}
                                    placeholder="Skill 名称"
                                    onChange={(event) => setSettings((current) => ({ ...current, agentSkills: current.agentSkills.map((item) => (item.id === skill.id ? { ...item, name: event.target.value } : item)) }))}
                                />
                                <Input
                                    className="mt-3"
                                    value={skill.keywords.join("、")}
                                    placeholder="触发词"
                                    onChange={(event) =>
                                        setSettings((current) => ({
                                            ...current,
                                            agentSkills: current.agentSkills.map((item) =>
                                                item.id === skill.id
                                                    ? {
                                                          ...item,
                                                          keywords: event.target.value
                                                              .split(/[、,，]/)
                                                              .map((word) => word.trim())
                                                              .filter(Boolean),
                                                      }
                                                    : item,
                                            ),
                                        }))
                                    }
                                />
                                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                                    <Select
                                        mode="multiple"
                                        value={skill.workspaces || ["image"]}
                                        options={[
                                            { value: "image", label: "图片创作" },
                                            { value: "video", label: "视频创作" },
                                            { value: "canvas", label: "画布" },
                                            { value: "drama", label: "短剧项目" },
                                        ]}
                                        placeholder="适用工作区"
                                        onChange={(workspaces) =>
                                            setSettings((current) => ({ ...current, agentSkills: current.agentSkills.map((item) => (item.id === skill.id ? { ...item, workspaces: workspaces as NonNullable<AgentSkill["workspaces"]> } : item)) }))
                                        }
                                    />
                                    <Select
                                        value={skill.action || "generate"}
                                        options={[
                                            { value: "generate", label: "生成" },
                                            { value: "edit", label: "编辑" },
                                        ]}
                                        onChange={(action) => setSettings((current) => ({ ...current, agentSkills: current.agentSkills.map((item) => (item.id === skill.id ? { ...item, action } : item)) }))}
                                    />
                                </div>
                                <div className="mt-3 flex min-h-8 items-center justify-between rounded-md border border-stone-200 px-3 dark:border-stone-700">
                                    <span className="text-sm text-stone-600 dark:text-stone-300">必须上传参考素材</span>
                                    <Switch
                                        size="small"
                                        aria-label={`${skill.name}必须上传参考素材`}
                                        checked={Boolean(skill.requiresReference)}
                                        onChange={(requiresReference) => setSettings((current) => ({ ...current, agentSkills: current.agentSkills.map((item) => (item.id === skill.id ? { ...item, requiresReference } : item)) }))}
                                    />
                                </div>
                                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                                    <Input
                                        value={String(skill.defaultConfig?.size || "")}
                                        placeholder="默认比例，如 1:1"
                                        onChange={(event) =>
                                            setSettings((current) => ({ ...current, agentSkills: current.agentSkills.map((item) => (item.id === skill.id ? { ...item, defaultConfig: { ...item.defaultConfig, size: event.target.value } } : item)) }))
                                        }
                                    />
                                    <Input
                                        value={String(skill.defaultConfig?.quality || skill.defaultConfig?.vquality || "")}
                                        placeholder="默认质量，如 high / 1080"
                                        onChange={(event) => {
                                            const key = skill.workspaces?.includes("video") ? "vquality" : "quality";
                                            setSettings((current) => ({
                                                ...current,
                                                agentSkills: current.agentSkills.map((item) => (item.id === skill.id ? { ...item, defaultConfig: { ...item.defaultConfig, [key]: event.target.value } } : item)),
                                            }));
                                        }}
                                    />
                                    {(skill.workspaces || ["image"]).includes("image") ? (
                                        <InputNumber
                                            className="w-full"
                                            min={1}
                                            max={10}
                                            value={Number(skill.defaultConfig?.count || 1)}
                                            placeholder="默认数量"
                                            onChange={(value) =>
                                                setSettings((current) => ({ ...current, agentSkills: current.agentSkills.map((item) => (item.id === skill.id ? { ...item, defaultConfig: { ...item.defaultConfig, count: value || 1 } } : item)) }))
                                            }
                                        />
                                    ) : null}
                                    {(skill.workspaces || []).includes("video") ? (
                                        <InputNumber
                                            className="w-full"
                                            min={1}
                                            max={60}
                                            value={Number(skill.defaultConfig?.videoSeconds || 5)}
                                            placeholder="默认视频秒数"
                                            onChange={(value) =>
                                                setSettings((current) => ({
                                                    ...current,
                                                    agentSkills: current.agentSkills.map((item) => (item.id === skill.id ? { ...item, defaultConfig: { ...item.defaultConfig, videoSeconds: value || 5 } } : item)),
                                                }))
                                            }
                                        />
                                    ) : null}
                                </div>
                                <Input
                                    className="mt-3"
                                    value={skill.description}
                                    placeholder="用途说明"
                                    onChange={(event) => setSettings((current) => ({ ...current, agentSkills: current.agentSkills.map((item) => (item.id === skill.id ? { ...item, description: event.target.value } : item)) }))}
                                />
                                <Input.TextArea
                                    className="mt-3"
                                    autoSize={{ minRows: 6, maxRows: 14 }}
                                    value={skill.instructions}
                                    placeholder="执行规则"
                                    onChange={(event) => setSettings((current) => ({ ...current, agentSkills: current.agentSkills.map((item) => (item.id === skill.id ? { ...item, instructions: event.target.value } : item)) }))}
                                />
                            </div>
                        </details>
                    </section>
                ))}
            </div>
            <AgentSkillCreateModal
                open={createModalOpen}
                existingSkills={settings.agentSkills}
                onClose={() => setCreateModalOpen(false)}
                onCreate={async (skill) => {
                    const saved = await saveSettings((current) => ({ agentSkills: [...current.agentSkills, skill] }), "Agent Skill 已添加并保存");
                    if (saved) setCreateModalOpen(false);
                    return saved;
                }}
            />
        </Panel>
    );
}
