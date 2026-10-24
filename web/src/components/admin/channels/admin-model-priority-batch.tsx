"use client";

import { App, Button, Checkbox, Drawer, Empty, Input, InputNumber, Segmented, Select, Tag } from "antd";
import { useMemo, useState } from "react";
import { Layers3 } from "lucide-react";

import type { LogicalModel, LogicalModelCapability, SystemModelChannel } from "@/lib/auth/store";
import type { OfficialPriceSource } from "@/lib/model-pricing";
import { getOfficialPriceSources } from "@/services/api/model-pricing";
import { commitModelPriorityBatch, previewModelPriorityBatch, type ModelPriorityRow } from "@/services/api/model-priorities";

const capabilities: Array<{ label: string; value: LogicalModelCapability }> = [
    { label: "文本", value: "text" },
    { label: "图片", value: "image" },
    { label: "视频", value: "video" },
    { label: "音频", value: "audio" },
];

export function AdminModelPriorityBatch({
    channels,
    models,
    onSaved,
    onGroupChange,
}: {
    channels: SystemModelChannel[];
    models: LogicalModel[];
    onSaved: (changes: Array<{ modelId: string; bindingId: string; newPriority: number }>) => void;
    onGroupChange: (modelIds: string[], manufacturer?: string, series?: string) => void;
}) {
    const { message } = App.useApp();
    const [open, setOpen] = useState(false);
    const [mode, setMode] = useState<"group" | "priority">("group");
    const [search, setSearch] = useState("");
    const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
    const [changeManufacturer, setChangeManufacturer] = useState(false);
    const [changeSeries, setChangeSeries] = useState(false);
    const [nextManufacturer, setNextManufacturer] = useState("");
    const [nextSeries, setNextSeries] = useState("");
    const [showAssigned, setShowAssigned] = useState(false);
    const [officialSources, setOfficialSources] = useState<OfficialPriceSource[]>([]);
    const [sourcesLoading, setSourcesLoading] = useState(false);
    const [channelIds, setChannelIds] = useState<string[]>([]);
    const [manufacturer, setManufacturer] = useState<string>();
    const [series, setSeries] = useState<string>();
    const [capability, setCapability] = useState<LogicalModelCapability>();
    const [priority, setPriority] = useState<number>(1);
    const [rows, setRows] = useState<ModelPriorityRow[]>([]);
    const [excluded, setExcluded] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [previewed, setPreviewed] = useState(false);
    const normalizedSearch = search.trim().toLowerCase();
    const groupEligible = (model: LogicalModel) => showAssigned || ((changeManufacturer || !changeSeries ? !model.manufacturer?.trim() : true) && (!changeSeries || !model.series?.trim()));
    const visibleModels = models.filter(
        (model) => groupEligible(model) && (!normalizedSearch || `${model.name} ${model.id} ${model.manufacturer || ""} ${model.series || ""} ${model.bindings.map((binding) => binding.upstreamModel).join(" ")}`.toLowerCase().includes(normalizedSearch)),
    );
    const visibleRows = rows.filter((row) => !normalizedSearch || `${row.modelName} ${row.modelId} ${row.upstreamModel} ${row.channelName} ${row.manufacturer} ${row.series}`.toLowerCase().includes(normalizedSearch));
    const selectableRows = visibleRows.filter((row) => row.enabled && row.modelEnabled && row.channelEnabled);
    const selectedModels = models.filter((model) => selectedModelIds.includes(model.id) && groupEligible(model));
    const canApplyGroup = selectedModels.length > 0 && (changeManufacturer || changeSeries) && (!changeManufacturer || officialSources.some((source) => source.manufacturer === nextManufacturer)) && (!changeSeries || Boolean(nextSeries.trim()));
    const manufacturers = useMemo(() => Array.from(new Set(models.map((model) => model.manufacturer).filter((value): value is string => Boolean(value)))).sort(), [models]);
    const seriesOptions = useMemo(
        () =>
            Array.from(
                new Set(
                    models
                        .filter((model) => !manufacturer || model.manufacturer === manufacturer)
                        .map((model) => model.series)
                        .filter((value): value is string => Boolean(value)),
                ),
            ).sort(),
        [manufacturer, models],
    );
    const invalidate = () => {
        setRows([]);
        setExcluded([]);
        setPreviewed(false);
    };
    const preview = async (nextExcluded = excluded) => {
        setBusy(true);
        try {
            const result = await previewModelPriorityBatch({ channelIds, manufacturer, series, capability, priority, excluded: nextExcluded });
            setRows(result.rows);
            setExcluded(nextExcluded);
            setPreviewed(true);
        } catch (error) {
            invalidate();
            message.error(error instanceof Error ? error.message : "预览失败");
        } finally {
            setBusy(false);
        }
    };
    const save = async () => {
        setBusy(true);
        try {
            const selected = rows.filter((row) => !row.excluded).map(({ modelId, bindingId, version }) => ({ modelId, bindingId, version }));
            const result = await commitModelPriorityBatch({ priority, selected, excluded: rows.filter((row) => row.excluded).map((row) => `${row.modelId}:${row.bindingId}`) });
            onSaved(result.changes);
            message.success(`已更新 ${result.changes.length} 个绑定`);
            setOpen(false);
            invalidate();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存失败，请重新预览");
            invalidate();
        } finally {
            setBusy(false);
        }
    };
    const applyGroup = () => {
        if (!canApplyGroup) return;
        onGroupChange(
            selectedModels.map((model) => model.id),
            changeManufacturer ? nextManufacturer.trim() : undefined,
            changeSeries ? nextSeries.trim() : undefined,
        );
        message.success(`已修改 ${selectedModels.length} 个模型的配置草稿，请点击页面顶部“保存更改”`);
        setOpen(false);
    };
    const openBatch = () => {
        setSearch("");
        setSelectedModelIds([]);
        setChangeManufacturer(false);
        setChangeSeries(false);
        setNextManufacturer("");
        setNextSeries("");
        setShowAssigned(false);
        setSourcesLoading(true);
        void getOfficialPriceSources()
            .then(setOfficialSources)
            .catch((error) => message.error(error instanceof Error ? error.message : "读取厂商目录失败"))
            .finally(() => setSourcesLoading(false));
        invalidate();
        setOpen(true);
    };

    return (
        <>
            <Button icon={<Layers3 className="size-4" />} onClick={openBatch}>
                批量设置
            </Button>
            <Drawer
                title="批量设置模型"
                width="min(760px, 100vw)"
                styles={{ wrapper: { maxWidth: "100vw" } }}
                open={open}
                destroyOnHidden
                onClose={() => setOpen(false)}
                extra={
                    mode === "group" ? (
                        <Button type="primary" disabled={!canApplyGroup} onClick={applyGroup}>
                            应用到配置草稿
                        </Button>
                    ) : (
                        <Button type="primary" loading={busy} disabled={!previewed || !rows.some((row) => !row.excluded)} onClick={() => void save()}>
                            提交选中项
                        </Button>
                    )
                }
            >
                <Segmented
                    className="mb-4"
                    aria-label="批量设置类型"
                    value={mode}
                    options={[
                        { label: "厂商/系列", value: "group" },
                        { label: "渠道优先级", value: "priority" },
                    ]}
                    onChange={(value) => {
                        setMode(value as "group" | "priority");
                        setSearch("");
                    }}
                />
                <Input allowClear aria-label="批量搜索模型" value={search} placeholder="搜索模型昵称、ID、厂商、系列或上游模型" onChange={(event) => setSearch(event.target.value)} className="mb-4" />
                {mode === "group" ? (
                    <div className="space-y-4">
                        <p className="text-sm text-stone-600 dark:text-stone-300">默认只显示所选字段尚未设置的模型。厂商从官网价格链接目录选择；应用后还需点击页面顶部“保存更改”。不同系列请分批设置。</p>
                        <Checkbox checked={showAssigned} onChange={(event) => setShowAssigned(event.target.checked)}>
                            显示已设置的模型（用于修正）
                        </Checkbox>
                        <div className="flex flex-wrap items-center gap-2">
                            <Button size="small" disabled={!visibleModels.length} onClick={() => setSelectedModelIds((current) => Array.from(new Set([...current, ...visibleModels.map((model) => model.id)])))}>
                                全选搜索结果（{visibleModels.length}）
                            </Button>
                            <Button
                                size="small"
                                disabled={!visibleModels.some((model) => selectedModelIds.includes(model.id))}
                                onClick={() => {
                                    const visible = new Set(visibleModels.map((model) => model.id));
                                    setSelectedModelIds((current) => current.filter((id) => !visible.has(id)));
                                }}
                            >
                                取消搜索结果选择
                            </Button>
                            <span className="text-xs text-stone-500">已选 {selectedModels.length} 个模型</span>
                        </div>
                        <div className="max-h-52 space-y-1 overflow-y-auto rounded-lg border border-stone-200 p-2 dark:border-stone-800">
                            {visibleModels.map((model) => (
                                <div key={model.id} data-testid={`bulk-model-${model.id}`}>
                                    <Checkbox checked={selectedModelIds.includes(model.id)} onChange={(event) => setSelectedModelIds((current) => (event.target.checked ? [...current, model.id] : current.filter((id) => id !== model.id)))}>
                                        {model.name} <span className="text-xs text-stone-500">({model.id})</span>
                                        {showAssigned && (
                                            <span className="ml-2 text-xs text-stone-500">
                                                {model.manufacturer || "厂商未设置"} / {model.series || "系列未设置"}
                                            </span>
                                        )}
                                    </Checkbox>
                                </div>
                            ))}
                            {!visibleModels.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前没有待补充的模型，可开启“显示已设置的模型”查看" />}
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <div className="space-y-2">
                                <Checkbox checked={changeManufacturer} onChange={(event) => setChangeManufacturer(event.target.checked)}>
                                    修改模型厂商
                                </Checkbox>
                                <Select
                                    aria-label="批量模型厂商"
                                    className="w-full"
                                    showSearch
                                    optionFilterProp="label"
                                    loading={sourcesLoading}
                                    disabled={!changeManufacturer || sourcesLoading}
                                    value={nextManufacturer || undefined}
                                    placeholder="选择官网价格链接中的厂商"
                                    options={officialSources.map((source) => ({ label: source.manufacturer, value: source.manufacturer }))}
                                    onChange={setNextManufacturer}
                                />
                            </div>
                            <div className="space-y-2">
                                <Checkbox checked={changeSeries} onChange={(event) => setChangeSeries(event.target.checked)}>
                                    修改模型系列
                                </Checkbox>
                                <Input aria-label="批量模型系列" maxLength={80} disabled={!changeSeries} value={nextSeries} placeholder="例如 DeepSeek V4" onChange={(event) => setNextSeries(event.target.value)} />
                            </div>
                        </div>
                        {selectedModels.length > 0 && (changeManufacturer || changeSeries) && (
                            <div className="space-y-2 rounded-lg border border-stone-200 p-3 text-xs dark:border-stone-800">
                                <b>变更预览</b>
                                <div className="max-h-52 space-y-2 overflow-y-auto">
                                    {selectedModels.map((model) => (
                                        <div key={model.id} className="break-words">
                                            <b>{model.name}</b>
                                            {changeManufacturer && (
                                                <span className="block">
                                                    厂商：{model.manufacturer || "未设置"} → {nextManufacturer.trim() || "待填写"}
                                                </span>
                                            )}
                                            {changeSeries && (
                                                <span className="block">
                                                    系列：{model.series || "未设置"} → {nextSeries.trim() || "待填写"}
                                                </span>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                ) : (
                    <>
                        <p className="mb-4 text-xs leading-5 text-stone-500 dark:text-stone-400">按已保存的渠道及管理员确认的厂商/系列分组筛选。此操作立即保存；分组如有未保存的编辑，请先返回模型渠道页保存。</p>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <label className="space-y-1 text-xs text-stone-600 dark:text-stone-300">
                                渠道 ID / 名称
                                <Select
                                    mode="multiple"
                                    aria-label="批量优先级渠道"
                                    className="w-full"
                                    value={channelIds}
                                    maxTagCount="responsive"
                                    placeholder="选择渠道"
                                    options={channels.map((channel) => ({ label: `${channel.name} (${channel.id})`, value: channel.id }))}
                                    onChange={(value) => {
                                        setChannelIds(value);
                                        invalidate();
                                    }}
                                />
                            </label>
                            <label className="space-y-1 text-xs text-stone-600 dark:text-stone-300">
                                目标优先级
                                <InputNumber
                                    aria-label="批量优先级目标值"
                                    className="!w-full"
                                    min={1}
                                    max={10000}
                                    precision={0}
                                    value={priority}
                                    onChange={(value) => {
                                        setPriority(Number(value) || 1);
                                        invalidate();
                                    }}
                                />
                            </label>
                            <label className="space-y-1 text-xs text-stone-600 dark:text-stone-300">
                                模型厂商
                                <Select
                                    allowClear
                                    aria-label="批量优先级模型厂商"
                                    className="w-full"
                                    value={manufacturer}
                                    placeholder="全部厂商"
                                    options={manufacturers.map((value) => ({ label: value, value }))}
                                    onChange={(value) => {
                                        setManufacturer(value);
                                        setSeries(undefined);
                                        invalidate();
                                    }}
                                />
                            </label>
                            <label className="space-y-1 text-xs text-stone-600 dark:text-stone-300">
                                模型系列
                                <Select
                                    allowClear
                                    aria-label="批量优先级模型系列"
                                    className="w-full"
                                    value={series}
                                    placeholder="全部系列"
                                    options={seriesOptions.map((value) => ({ label: value, value }))}
                                    onChange={(value) => {
                                        setSeries(value);
                                        invalidate();
                                    }}
                                />
                            </label>
                            <label className="space-y-1 text-xs text-stone-600 dark:text-stone-300">
                                能力
                                <Select
                                    allowClear
                                    aria-label="批量优先级能力"
                                    className="w-full"
                                    value={capability}
                                    placeholder="全部能力"
                                    options={capabilities}
                                    onChange={(value) => {
                                        setCapability(value);
                                        invalidate();
                                    }}
                                />
                            </label>
                        </div>
                        <Button className="mt-4" loading={busy} disabled={!channelIds.length} onClick={() => void preview([])}>
                            预览受影响绑定
                        </Button>
                        {previewed ? (
                            <p className="mt-4 text-xs text-stone-500 dark:text-stone-400">
                                共 {rows.length} 项；当前搜索 {visibleRows.length} 项；已选 {rows.filter((row) => !row.excluded).length} 项。排序按优先级、权重、绑定 ID；实时健康状态可能改变实际首选渠道。
                            </p>
                        ) : null}
                        {previewed && !rows.length ? <Empty className="mt-6" description="没有匹配的绑定；未确认分组时可不设厂商/系列，按模型逐项排除" /> : null}
                        {previewed && rows.length ? (
                            <div className="mt-3 flex flex-wrap gap-2">
                                <Button size="small" disabled={!selectableRows.length} onClick={() => void preview(excluded.filter((key) => !selectableRows.some((row) => key === `${row.modelId}:${row.bindingId}`)))}>
                                    全选搜索结果（{selectableRows.length}）
                                </Button>
                                <Button size="small" disabled={!selectableRows.some((row) => !row.excluded)} onClick={() => void preview(Array.from(new Set([...excluded, ...selectableRows.map((row) => `${row.modelId}:${row.bindingId}`)])))}>
                                    取消搜索结果选择
                                </Button>
                            </div>
                        ) : null}
                        <div className="mt-3 space-y-2">
                            {visibleRows.map((row) => {
                                const key = `${row.modelId}:${row.bindingId}`;
                                return (
                                    <div key={key} data-testid={`priority-row-${row.modelId}-${row.channelId}`} className="rounded-lg border border-stone-200 p-3 text-sm dark:border-stone-700">
                                        <Checkbox
                                            checked={!row.excluded}
                                            disabled={busy || !row.enabled || !row.modelEnabled || !row.channelEnabled}
                                            onChange={(event) => void preview(event.target.checked ? excluded.filter((item) => item !== key) : [...excluded, key])}
                                        >
                                            <span className="font-medium">{row.modelName}</span> <span className="text-xs text-stone-500">{row.modelId}</span>
                                        </Checkbox>
                                        <div className="mt-2 flex flex-wrap gap-1">
                                            <Tag>{row.channelName}</Tag>
                                            <Tag>{row.capability}</Tag>
                                            <Tag>
                                                {row.manufacturer || "未分组"} / {row.series || "未分组"}
                                            </Tag>
                                            <Tag color={row.enabled && row.modelEnabled && row.channelEnabled ? "green" : "default"}>{row.enabled && row.modelEnabled && row.channelEnabled ? "启用" : "停用"}</Tag>
                                        </div>
                                        <div className="mt-1 text-xs text-stone-600 dark:text-stone-300">
                                            优先级 {row.oldPriority} → {row.excluded ? row.oldPriority : row.newPriority} · 权重 {row.weight} · 上游 {row.upstreamModel}
                                        </div>
                                        <div className="mt-1 text-xs text-stone-500 dark:text-stone-400">当前顺序：{orderLabel(models, channels, row.modelId, row.before)}</div>
                                        <div className="mt-1 text-xs text-stone-500 dark:text-stone-400">修改后：{orderLabel(models, channels, row.modelId, row.after)}</div>
                                    </div>
                                );
                            })}
                        </div>
                    </>
                )}
            </Drawer>
        </>
    );
}

function orderLabel(models: LogicalModel[], channels: SystemModelChannel[], modelId: string, bindingIds: string[]) {
    const model = models.find((item) => item.id === modelId);
    return (
        bindingIds
            .map((id) => {
                const binding = model?.bindings.find((item) => item.id === id);
                return channels.find((channel) => channel.id === binding?.channelId)?.name || binding?.channelId || id;
            })
            .join(" → ") || "无可用绑定"
    );
}
