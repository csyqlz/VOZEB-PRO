"use client";

import { App, Button, Drawer, Empty, Input, Segmented, Skeleton, Switch, Tag } from "antd";
import { Boxes, CheckCircle2, FileCog, Power, RefreshCw, Search, ShieldCheck, Sparkles, Zap } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { Panel } from "@/components/admin/admin-panel";
import type { VozebCmsModuleId, VozebCmsModuleView } from "@/lib/vozeb-cms/module-contract";
import { listAdminVozebCmsModules, updateAdminVozebCmsModule } from "@/services/api/vozeb-cms-modules";

type ModulePresentation = {
    category: string;
    outcome: string;
    surfaces: string[];
    disabledImpact: string;
};

const MODULE_PRESENTATION: Record<VozebCmsModuleId, ModulePresentation> = {
    create: {
        category: "创作入口",
        outcome: "接收自然语言需求，并统一调度文本、图片、视频与音频创作。",
        surfaces: ["统一创作台", "Agent 规划", "多媒体任务"],
        disabledImpact: "用户将无法进入统一创作台，也不能发起新的 Agent 创作。",
    },
    canvas: {
        category: "创作工作区",
        outcome: "用节点组织素材、生成任务和项目内容，适合非线性创作。",
        surfaces: ["Canvas 项目", "节点编辑", "项目保存"],
        disabledImpact: "Canvas 入口与项目编辑将停止开放，已有项目数据仍会保留。",
    },
    drama: {
        category: "生产系统",
        outcome: "以项目和单集组织剧本、资产、分镜、生成、审核与交付。",
        surfaces: ["短剧项目", "单集生产", "自动化流程"],
        disabledImpact: "用户将无法进入短剧项目或启动新的短剧生产流程。",
    },
    image: {
        category: "生成能力",
        outcome: "通过统一创作台提供图片生成、编辑和结果入库能力。",
        surfaces: ["图片创作", "图片任务", "图片资产"],
        disabledImpact: "所有新图片生成请求会被拒绝，历史结果仍可查看。",
    },
    video: {
        category: "生成能力",
        outcome: "通过统一创作台提供视频生成、状态恢复和结果入库能力。",
        surfaces: ["视频创作", "视频任务", "视频资产"],
        disabledImpact: "所有新视频生成请求会被拒绝，运行中任务仍可恢复和取消。",
    },
};

export function AdminModulesSection() {
    const { message, modal } = App.useApp();
    const [modules, setModules] = useState<VozebCmsModuleView[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [savingId, setSavingId] = useState<string>();
    const [query, setQuery] = useState("");
    const [status, setStatus] = useState<"all" | "enabled" | "disabled">("all");
    const [diagnosticModule, setDiagnosticModule] = useState<VozebCmsModuleView>();

    const load = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            setModules(await listAdminVozebCmsModules());
        } catch (nextError) {
            setError(nextError instanceof Error ? nextError.message : "模块列表加载失败");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const changeState = (module: VozebCmsModuleView, enabled: boolean) => {
        const presentation = MODULE_PRESENTATION[module.id];
        modal.confirm({
            title: enabled ? `启用${module.name}` : `停用${module.name}`,
            content: enabled ? "启用后，用户入口、页面、服务端接口和 Agent 能力将同步开放。" : presentation.disabledImpact,
            okText: enabled ? "确认启用" : "确认停用",
            cancelText: "取消",
            okButtonProps: enabled ? undefined : { danger: true },
            onOk: async () => {
                setSavingId(module.id);
                try {
                    const result = await updateAdminVozebCmsModule({ moduleId: module.id, enabled, baseRevision: module.revision, mutationId: crypto.randomUUID() });
                    setModules(result.modules);
                    setDiagnosticModule((current) => result.modules.find((item) => item.id === current?.id));
                    message.success(enabled ? "模块已启用" : "模块已停用");
                } catch (nextError) {
                    message.error(nextError instanceof Error ? nextError.message : "模块状态更新失败");
                    await load();
                } finally {
                    setSavingId(undefined);
                }
            },
        });
    };

    const enabledCount = modules.filter((module) => module.enabled).length;
    const capabilityCount = modules.reduce((total, module) => total + module.capabilities.length, 0);
    const moduleName = new Map(modules.map((module) => [module.id, module.name]));
    const normalizedQuery = query.trim().toLowerCase();
    const filteredModules = modules.filter((module) => {
        if (status === "enabled" && !module.enabled) return false;
        if (status === "disabled" && module.enabled) return false;
        if (!normalizedQuery) return true;
        const presentation = MODULE_PRESENTATION[module.id];
        return [module.id, module.name, module.description, presentation.category, presentation.outcome, ...presentation.surfaces].some((value) => value.toLowerCase().includes(normalizedQuery));
    });

    if (loading && !modules.length)
        return (
            <Panel variant="page">
                <div className="admin-panel-surface rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
                    <Skeleton active paragraph={{ rows: 8 }} />
                </div>
            </Panel>
        );
    if (error && !modules.length) {
        return (
            <Panel variant="page">
                <div className="admin-panel-surface rounded-lg border border-zinc-200 bg-white py-12 dark:border-zinc-800 dark:bg-zinc-950">
                    <Empty description={error} image={Empty.PRESENTED_IMAGE_SIMPLE}>
                        <Button icon={<RefreshCw className="size-4" />} onClick={() => void load()}>
                            重新加载
                        </Button>
                    </Empty>
                </div>
            </Panel>
        );
    }

    return (
        <Panel variant="page">
            <section className="min-w-0 space-y-4" aria-label="模块中心">
                <div className="admin-panel-surface overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
                    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 lg:flex-row lg:items-center lg:justify-between lg:px-5">
                        <div className="flex min-w-0 items-center gap-3">
                            <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-zinc-950 text-white dark:bg-zinc-100 dark:text-zinc-950">
                                <Boxes className="size-[19px]" />
                            </span>
                            <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                    <h2 className="text-base font-semibold text-zinc-950 dark:text-zinc-100">系统功能</h2>
                                    <Tag bordered={false} color="blue">
                                        官方模块
                                    </Tag>
                                </div>
                                <p className="mt-0.5 text-xs leading-5 text-zinc-500 dark:text-zinc-400">控制用户真正能使用的创作功能；一次停用同步作用于入口、页面、接口和 Agent。</p>
                            </div>
                        </div>
                        <div className="grid shrink-0 grid-cols-3 divide-x divide-zinc-200 overflow-hidden rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                            <SummaryMetric label="运行中" value={enabledCount} />
                            <SummaryMetric label="已停用" value={modules.length - enabledCount} />
                            <SummaryMetric label="注册能力" value={capabilityCount} />
                        </div>
                    </div>
                    <div className="grid min-w-0 gap-2 border-t border-zinc-100 bg-zinc-50/70 px-4 py-3 md:grid-cols-[minmax(0,1fr)_auto] xl:grid-cols-[minmax(220px,288px)_minmax(0,1fr)_auto] xl:items-center dark:border-zinc-900 dark:bg-zinc-900/35">
                        <Input
                            className="min-w-0 md:col-start-1 md:row-start-1"
                            allowClear
                            prefix={<Search className="size-3.5 text-zinc-400" />}
                            value={query}
                            placeholder="搜索功能、页面或能力"
                            aria-label="搜索模块"
                            onChange={(event) => setQuery(event.target.value)}
                        />
                        <div className="min-w-0 overflow-x-auto md:col-span-2 md:row-start-2 xl:col-span-1 xl:col-start-2 xl:row-start-1">
                            <div className="w-max min-w-full">
                                <Segmented
                                    className="w-full"
                                    value={status}
                                    onChange={setStatus}
                                    options={[
                                        { label: `全部 ${modules.length}`, value: "all" },
                                        { label: `运行中 ${enabledCount}`, value: "enabled" },
                                        { label: `已停用 ${modules.length - enabledCount}`, value: "disabled" },
                                    ]}
                                />
                            </div>
                        </div>
                        <Button className="w-full md:col-start-2 md:row-start-1 md:w-auto xl:col-start-3" icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void load()}>
                            刷新状态
                        </Button>
                    </div>
                </div>

                {filteredModules.length ? (
                    <div data-testid="admin-module-list" className="admin-panel-surface min-w-0 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
                        <div className="hidden min-h-10 grid-cols-[minmax(250px,1.45fr)_minmax(170px,1fr)_76px_minmax(100px,.7fr)_88px_132px] items-center gap-3 border-b border-zinc-200 bg-zinc-50/80 px-4 text-[11px] font-medium text-zinc-500 xl:grid dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-400">
                            <span>功能模块</span>
                            <span>业务范围</span>
                            <span>版本</span>
                            <span>依赖</span>
                            <span>状态</span>
                            <span className="text-right">操作</span>
                        </div>
                        {filteredModules.map((module) => {
                            const presentation = MODULE_PRESENTATION[module.id];
                            const dependencies = module.dependencies.map((id) => moduleName.get(id) || id);
                            return (
                                <article
                                    key={module.id}
                                    data-module-id={module.id}
                                    className="min-w-0 border-b border-zinc-100 px-4 py-4 last:border-b-0 xl:grid xl:min-h-[92px] xl:grid-cols-[minmax(250px,1.45fr)_minmax(170px,1fr)_76px_minmax(100px,.7fr)_88px_132px] xl:items-center xl:gap-3 xl:py-3 dark:border-zinc-900"
                                >
                                    <div className="flex min-w-0 items-start gap-3">
                                        <span
                                            className={`mt-0.5 grid size-8 shrink-0 place-items-center rounded-md ${module.enabled ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" : "bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400"}`}
                                        >
                                            {module.enabled ? <CheckCircle2 className="size-4" /> : <Power className="size-4" />}
                                        </span>
                                        <div className="min-w-0 flex-1">
                                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                                                <h2 className="truncate text-sm font-semibold text-zinc-950 dark:text-zinc-100">{module.name}</h2>
                                                <Tag bordered={false}>{presentation.category}</Tag>
                                            </div>
                                            <p className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-600 dark:text-zinc-300">{presentation.outcome}</p>
                                            <div className="mt-2 min-w-0 space-y-1 xl:hidden">
                                                <p className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">{presentation.surfaces.join(" · ")}</p>
                                                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                                                    <span>v{module.version}</span>
                                                    <span>依赖：{dependencies.length ? dependencies.join("、") : "无"}</span>
                                                    <Tag bordered={false} color={module.enabled ? "success" : "default"}>
                                                        {module.enabled ? "运行中" : "已停用"}
                                                    </Tag>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="hidden min-w-0 text-xs leading-5 text-zinc-600 xl:block dark:text-zinc-300">
                                        <p className="truncate">{presentation.surfaces.join(" · ")}</p>
                                        <p className="truncate text-[11px] text-zinc-400">
                                            {module.capabilities.length} 项能力 · {module.routes.length} 个路由规则
                                        </p>
                                    </div>
                                    <span className="hidden text-xs tabular-nums text-zinc-600 xl:block dark:text-zinc-300">v{module.version}</span>
                                    <span className="hidden truncate text-xs text-zinc-600 xl:block dark:text-zinc-300" title={dependencies.join("、") || "无依赖"}>
                                        {dependencies.join("、") || "无"}
                                    </span>
                                    <div className="hidden xl:block">
                                        <Tag bordered={false} color={module.enabled ? "success" : "default"}>
                                            {module.enabled ? "运行中" : "已停用"}
                                        </Tag>
                                    </div>
                                    <div className="mt-3 flex min-w-0 items-center justify-between gap-3 border-t border-zinc-100 pt-3 xl:mt-0 xl:justify-end xl:border-0 xl:pt-0 dark:border-zinc-900">
                                        <Switch aria-label={`${module.enabled ? "停用" : "启用"}${module.name}`} checked={module.enabled} loading={savingId === module.id} disabled={Boolean(savingId)} onChange={(checked) => changeState(module, checked)} />
                                        <Button type="text" size="small" icon={<FileCog className="size-3.5" />} onClick={() => setDiagnosticModule(module)}>
                                            诊断
                                        </Button>
                                    </div>
                                </article>
                            );
                        })}
                    </div>
                ) : (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有符合条件的业务功能" />
                )}

                <ModuleDiagnostics module={diagnosticModule} modules={modules} onClose={() => setDiagnosticModule(undefined)} />
            </section>
        </Panel>
    );
}

function SummaryMetric({ label, value }: { label: string; value: number }) {
    return (
        <div className="min-w-[78px] px-3 py-2 text-center">
            <div className="text-base font-semibold tabular-nums text-zinc-950 dark:text-zinc-100">{value}</div>
            <div className="text-[10px] text-zinc-500 dark:text-zinc-400">{label}</div>
        </div>
    );
}

function ModuleDiagnostics({ module, modules, onClose }: { module?: VozebCmsModuleView; modules: VozebCmsModuleView[]; onClose: () => void }) {
    const moduleName = new Map(modules.map((item) => [item.id, item.name]));
    const presentation = module ? MODULE_PRESENTATION[module.id] : undefined;
    return (
        <Drawer title={module ? `${module.name} · 模块诊断` : "模块诊断"} open={Boolean(module)} onClose={onClose} size={520} styles={{ wrapper: { maxWidth: "100vw" }, body: { padding: 16 } }}>
            {module ? (
                <div className="space-y-5">
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-200">
                        这里仅用于部署诊断和权限排查。路由、权限与能力由代码注册，不能在后台任意新增或删除。
                    </div>
                    <DiagnosticGroup
                        icon={<Sparkles className="size-4" />}
                        title="运行状态"
                        values={[module.enabled ? "已启用" : "已停用", `配置修订 ${module.revision}`, module.updatedAt ? `最近更新 ${new Date(module.updatedAt).toLocaleString("zh-CN")}` : "尚无人工变更"]}
                    />
                    <DiagnosticGroup icon={<Zap className="size-4" />} title="能力标识" values={module.capabilities} technical />
                    <DiagnosticGroup icon={<ShieldCheck className="size-4" />} title="权限标识" values={module.permissions} technical />
                    <DiagnosticGroup icon={<FileCog className="size-4" />} title="受控页面" values={module.routes} technical />
                    <DiagnosticGroup icon={<Boxes className="size-4" />} title="依赖关系" values={module.dependencies.length ? module.dependencies.map((id) => moduleName.get(id) || id) : ["无强制模块依赖"]} />
                    {presentation ? <DiagnosticGroup icon={<Power className="size-4" />} title="停用影响" values={[presentation.disabledImpact]} /> : null}
                </div>
            ) : null}
        </Drawer>
    );
}

function DiagnosticGroup({ icon, title, values, technical = false }: { icon: ReactNode; title: string; values: string[]; technical?: boolean }) {
    return (
        <section>
            <h3 className="flex items-center gap-2 text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                {icon}
                {title}
            </h3>
            <div className="mt-2 flex min-w-0 flex-wrap gap-1.5">
                {values.map((value) => (
                    <span key={value} className={`max-w-full break-all rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 text-[11px] text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 ${technical ? "font-mono" : ""}`}>
                        {value}
                    </span>
                ))}
            </div>
        </section>
    );
}
