"use client";

import { App, Button, Checkbox, Drawer, Empty, Input, InputNumber, Select, Space, Switch, Tag } from "antd";
import { AlertTriangle, GitBranch, Pencil, RefreshCw, Route, Search } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";

import { LabeledControl, SectionTitle } from "@/components/admin/admin-settings-controls";
import type { LogicalModel, LogicalModelBinding, LogicalModelCapability, LogicalModelCapabilityProfile, LogicalModelPricing, SystemDefaultModels, SystemModelChannel } from "@/lib/auth/store";
import { billingUnitLabel, effectiveBillingUnit } from "@/lib/model-pricing";
import { capabilityLabel, isLogicalModelResolvable, normalizeDefaultModelsConfig, resolveLogicalModelConfig, synchronizeLogicalModelsWithChannels } from "@/lib/model-routing-config";

type Props = {
    channels: SystemModelChannel[];
    logicalModels: LogicalModel[];
    defaultModels: SystemDefaultModels;
    onChange: (value: { logicalModels: LogicalModel[]; defaultModels: SystemDefaultModels }) => void;
};

const capabilityOptions: Array<{ label: string; value: LogicalModelCapability }> = [
    { label: "文本", value: "text" },
    { label: "图片", value: "image" },
    { label: "视频", value: "video" },
    { label: "音频", value: "audio" },
];

const defaultFields: Array<{ capability: LogicalModelCapability; key: keyof SystemDefaultModels; label: string }> = [
    { capability: "text", key: "textModel", label: "默认文本模型" },
    { capability: "image", key: "imageModel", label: "默认图片模型" },
    { capability: "video", key: "videoModel", label: "默认视频模型" },
    { capability: "audio", key: "audioModel", label: "默认音频模型" },
];

export function AdminLogicalModelManager({ channels, logicalModels, defaultModels, onChange }: Props) {
    const { message } = App.useApp();
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [editingId, setEditingId] = useState("");
    const [draft, setDraft] = useState<LogicalModel | null>(null);
    const [query, setQuery] = useState("");
    const [capabilityFilter, setCapabilityFilter] = useState<LogicalModelCapability | "all">("all");
    const deferredQuery = useDeferredValue(query.trim().toLowerCase());
    const visibleModels = useMemo(
        () =>
            logicalModels.filter(
                (model) => (capabilityFilter === "all" || model.capability === capabilityFilter) && (!deferredQuery || `${model.id} ${model.name} ${model.bindings.map((binding) => binding.upstreamModel).join(" ")}`.toLowerCase().includes(deferredQuery)),
            ),
        [capabilityFilter, deferredQuery, logicalModels],
    );
    const availableDefaultFields = defaultFields.filter(({ capability }) => logicalModels.some((model) => model.capability === capability && isLogicalModelResolvable(logicalModels, channels, capability, model.id)));
    const availableCapabilityOptions = capabilityOptions.filter(({ value }) => availableDefaultFields.some(({ capability }) => capability === value));
    const readyCount = availableDefaultFields.filter(({ capability, key }) => isLogicalModelResolvable(logicalModels, channels, capability, defaultModels[key])).length;

    const openEdit = (model: LogicalModel) => {
        setEditingId(model.id);
        setDraft(cloneLogicalModel(model));
        setDrawerOpen(true);
    };

    const saveDraft = () => {
        if (!draft) return;
        const name = draft.name.trim();
        if (!name) {
            message.error("请填写前端展示昵称");
            return;
        }
        const nextModels = logicalModels.map((model) => (model.id === editingId ? cloneLogicalModel({ ...draft, name }) : model));
        onChange({ logicalModels: nextModels, defaultModels: normalizeDefaultModelsConfig(defaultModels, nextModels, channels) });
        setDrawerOpen(false);
        message.success("模型路由设置已更新，请保存渠道配置");
    };

    const syncChannelModels = () => {
        const nextModels = synchronizeLogicalModelsWithChannels(logicalModels, channels);
        if (JSON.stringify(nextModels) === JSON.stringify(logicalModels)) {
            message.info("逻辑模型已与渠道目录同步");
            return;
        }
        onChange({ logicalModels: nextModels, defaultModels: normalizeDefaultModelsConfig(defaultModels, nextModels, channels) });
        message.success(`已按上游模型名同步 ${nextModels.length} 个逻辑模型`);
    };

    const updateDefault = (key: keyof SystemDefaultModels, modelId: string) => onChange({ logicalModels, defaultModels: { ...defaultModels, [key]: modelId } });

    return (
        <section className="border-t border-stone-200 pt-5 dark:border-stone-800">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div>
                    <div className="flex flex-wrap items-center gap-2">
                        <SectionTitle icon={<Route className="size-4" />} title="逻辑模型路由" />
                        <Tag color={availableDefaultFields.length && readyCount === availableDefaultFields.length ? "green" : "orange"} className="m-0">
                            默认能力 {readyCount}/{availableDefaultFields.length} 可用
                        </Tag>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">逻辑模型由渠道模型目录自动生成；同名上游模型跨渠道合并，前端昵称可独立设置。</p>
                </div>
                <Button icon={<RefreshCw className="size-4" />} onClick={syncChannelModels}>
                    重新同步
                </Button>
            </div>

            <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
                <div className="min-w-0">
                    <div className="mb-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_160px]">
                        <Input allowClear value={query} prefix={<Search className="size-4 text-stone-400" />} placeholder="搜索模型昵称、ID 或上游模型" onChange={(event) => setQuery(event.target.value)} />
                        <Select value={capabilityFilter} options={[{ label: "全部能力", value: "all" }, ...availableCapabilityOptions]} onChange={(value) => setCapabilityFilter(value)} />
                    </div>
                    <div className="max-h-[680px] space-y-2 overflow-y-auto pr-1">
                        {visibleModels.map((model) => {
                            const resolved = resolveLogicalModelConfig(logicalModels, channels, model.capability, model.id);
                            const isDefault = Object.values(defaultModels).some((value) => value.toLowerCase() === model.id.toLowerCase());
                            const pricing = resolved?.binding.capabilityProfile?.pricing;
                            return (
                                <div key={model.id} className="flex min-w-0 flex-col gap-3 rounded-lg border border-stone-200 bg-white p-3 sm:flex-row sm:items-center sm:justify-between dark:border-stone-800 dark:bg-stone-950">
                                    <div className="min-w-0">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="truncate text-sm font-semibold text-stone-950 dark:text-stone-100">{model.name}</span>
                                            <Tag className="m-0">{capabilityLabel(model.capability)}</Tag>
                                            <Tag color={model.enabled ? "green" : "default"} className="m-0">
                                                {model.enabled ? "启用" : "停用"}
                                            </Tag>
                                            {isDefault ? (
                                                <Tag color="blue" className="m-0">
                                                    默认
                                                </Tag>
                                            ) : null}
                                        </div>
                                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
                                            <span>ID：{model.id}</span>
                                            <span>{model.bindings.length} 个同名渠道绑定</span>
                                            <span className={resolved ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}>{resolved ? `${resolved.channel.name} / ${resolved.binding.upstreamModel}` : "当前无可用渠道"}</span>
                                        </div>
                                        <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                                            {pricingSummary(model.capability, pricing).map((item) => (
                                                <Tag key={item} className="m-0" color={item.includes("销售") ? "blue" : "gold"}>
                                                    {item}
                                                </Tag>
                                            ))}
                                        </div>
                                    </div>
                                    <Button className="shrink-0" size="small" icon={<Pencil className="size-3.5" />} onClick={() => openEdit(model)}>
                                        路由设置
                                    </Button>
                                </div>
                            );
                        })}
                        {!visibleModels.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={logicalModels.length ? "没有匹配的逻辑模型" : "渠道尚未同步到模型目录"} /> : null}
                    </div>
                </div>

                <div className="rounded-lg border border-stone-200 bg-stone-50/70 p-4 dark:border-stone-800 dark:bg-stone-900/40">
                    <SectionTitle icon={<GitBranch className="size-4" />} title="默认模型" />
                    <div className="mt-4 space-y-4">
                        {availableDefaultFields.map(({ capability, key, label }) => {
                            const options = logicalModels.filter((model) => model.capability === capability && isLogicalModelResolvable(logicalModels, channels, capability, model.id)).map((model) => ({ label: model.name, value: model.id }));
                            const selected = logicalModels.find((model) => model.id === defaultModels[key]);
                            const resolved = selected ? resolveLogicalModelConfig(logicalModels, channels, capability, selected.id) : null;
                            return (
                                <LabeledControl key={key} label={label}>
                                    <Select
                                        className="w-full"
                                        allowClear
                                        showSearch
                                        optionFilterProp="label"
                                        value={defaultModels[key] || undefined}
                                        placeholder={`选择可用${capabilityLabel(capability)}模型`}
                                        options={options}
                                        status={defaultModels[key] && !resolved ? "error" : undefined}
                                        onChange={(value) => updateDefault(key, value || "")}
                                    />
                                    <div className={`mt-1 flex items-center gap-1 text-xs ${resolved ? "text-stone-500 dark:text-stone-400" : "text-amber-600 dark:text-amber-400"}`}>
                                        {!resolved ? <AlertTriangle className="size-3.5 shrink-0" /> : null}
                                        <span>{resolved ? `实际路由：${resolved.channel.name} / ${resolved.binding.upstreamModel}` : defaultModels[key] ? "当前默认模型不可解析" : "尚未设置默认模型"}</span>
                                    </div>
                                </LabeledControl>
                            );
                        })}
                    </div>
                </div>
            </div>

            <Drawer
                title="模型路由设置"
                size={760}
                styles={{ wrapper: { maxWidth: "100vw" } }}
                open={drawerOpen}
                destroyOnHidden
                onClose={() => setDrawerOpen(false)}
                extra={
                    <Space>
                        <Button onClick={() => setDrawerOpen(false)}>取消</Button>
                        <Button type="primary" disabled={!draft?.name.trim()} onClick={saveDraft}>
                            应用修改
                        </Button>
                    </Space>
                }
            >
                {draft ? (
                    <>
                        <div className="rounded-lg border border-stone-200 bg-stone-50/70 p-3 dark:border-stone-800 dark:bg-stone-900/40">
                            <div className="truncate text-xs text-stone-500 dark:text-stone-400">逻辑 ID：{draft.id}（由上游模型自动建立）</div>
                            <div className="mt-2 grid gap-3 sm:max-w-[456px] sm:grid-cols-[192px_144px_96px]">
                                <LabeledControl label="前端昵称">
                                    <Input
                                        className="!w-full"
                                        aria-label="前端展示昵称"
                                        maxLength={120}
                                        value={draft.name}
                                        placeholder={draft.bindings[0]?.upstreamModel || draft.id}
                                        onChange={(event) => setDraft((current) => (current ? { ...current, name: event.target.value } : current))}
                                    />
                                </LabeledControl>
                                <LabeledControl label="能力类型">
                                    <Select
                                        className="w-full"
                                        value={draft.capability}
                                        options={capabilityOptions}
                                        onChange={(capability) =>
                                            setDraft((current) =>
                                                current
                                                    ? {
                                                          ...current,
                                                          capability,
                                                          bindings: current.bindings.map((binding) => {
                                                              const pricing = binding.capabilityProfile?.pricing;
                                                              return pricing
                                                                  ? { ...binding, capabilityProfile: { ...binding.capabilityProfile, pricing: { ...pricing, billingUnit: effectiveBillingUnit(capability, pricing.billingUnit) } } }
                                                                  : binding;
                                                          }),
                                                      }
                                                    : current,
                                            )
                                        }
                                    />
                                </LabeledControl>
                                <LabeledControl label="模型状态">
                                    <div className="flex h-8 items-center">
                                        <Switch checkedChildren="启用" unCheckedChildren="停用" checked={draft.enabled} onChange={(enabled) => setDraft((current) => (current ? { ...current, enabled } : current))} />
                                    </div>
                                </LabeledControl>
                            </div>
                        </div>
                        <div className="mt-5">
                            <h3 className="text-sm font-semibold text-stone-950 dark:text-stone-100">同名渠道绑定</h3>
                            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">渠道与上游模型由目录自动同步；这里调整路由优先级、启停和能力档案。</p>
                            <div className="mt-3 space-y-3">
                                {draft.bindings.map((binding) => (
                                    <BindingEditor
                                        key={binding.id}
                                        binding={binding}
                                        capability={draft.capability}
                                        channels={channels}
                                        onChange={(patch) => setDraft((current) => (current ? { ...current, bindings: current.bindings.map((item) => (item.id === binding.id ? { ...item, ...patch } : item)) } : current))}
                                    />
                                ))}
                            </div>
                        </div>
                    </>
                ) : null}
            </Drawer>
        </section>
    );
}

function pricingSummary(capability: LogicalModelCapability, pricing: LogicalModelPricing | undefined) {
    if (capability === "text") {
        return [
            `输入成本 ¥${formatPrice(pricing?.inputCostPrice)} / 1M token`,
            `输入销售 ¥${formatPrice(pricing?.inputSalePrice)} / 1M token`,
            `输出成本 ¥${formatPrice(pricing?.outputCostPrice)} / 1M token`,
            `输出销售 ¥${formatPrice(pricing?.outputSalePrice)} / 1M token`,
        ];
    }
    const unit = effectiveBillingUnit(capability, pricing?.billingUnit) === "per_second" ? "秒" : "次";
    return [`成本 ¥${formatPrice(pricing?.costPrice)} / ${unit}`, `销售 ¥${formatPrice(pricing?.salePrice)} / ${unit}`];
}

function formatPrice(value: number | undefined) {
    return (Number.isFinite(value) ? Number(value) : 0).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function BindingEditor({ binding, capability, channels, onChange }: { binding: LogicalModelBinding; capability: LogicalModelCapability; channels: SystemModelChannel[]; onChange: (patch: Partial<LogicalModelBinding>) => void }) {
    const channel = channels.find((item) => item.id === binding.channelId);
    const profile = binding.capabilityProfile || {};
    const effectiveAsync = profile.supportsAsync ?? (capability === "image" || capability === "video");
    const timeoutSeconds = profile.timeoutMs ? Math.round(profile.timeoutMs / 1000) : undefined;
    const defaultTimeoutSeconds = capability === "image" ? 600 : capability === "text" ? 180 : 1800;
    const updateProfile = (patch: Partial<LogicalModelCapabilityProfile>) => onChange({ capabilityProfile: { ...profile, ...patch } });
    const updateList = (value: string) =>
        updateProfile({
            aspectRatios: value
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean),
        });
    const pricing = profile.pricing || { currency: "CNY" as const, billingUnit: effectiveBillingUnit(capability, undefined) };
    const unit = effectiveBillingUnit(capability, pricing.billingUnit);
    const updatePricing = (patch: Partial<LogicalModelPricing>) => updateProfile({ pricing: { ...pricing, ...patch, billingUnit: effectiveBillingUnit(capability, patch.billingUnit || pricing.billingUnit), currency: "CNY" } });
    return (
        <div className="rounded-lg border border-stone-200 bg-stone-50/70 p-3 dark:border-stone-800 dark:bg-stone-900/40">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_90px_90px_auto] sm:items-end">
                <LabeledControl label="渠道">
                    <div className="flex h-8 items-center truncate rounded-md border border-stone-200 bg-white px-3 text-sm text-stone-700 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-200">{channel?.name || "渠道已移除"}</div>
                </LabeledControl>
                <LabeledControl label="上游模型">
                    <div className="flex h-8 items-center truncate rounded-md border border-stone-200 bg-white px-3 text-sm text-stone-700 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-200">{binding.upstreamModel}</div>
                </LabeledControl>
                <LabeledControl label="优先级">
                    <InputNumber className="w-full" min={1} max={10000} precision={0} value={binding.priority} onChange={(priority) => onChange({ priority: Number(priority) || 1 })} />
                </LabeledControl>
                <LabeledControl label="权重">
                    <InputNumber className="w-full" min={1} max={10000} precision={0} value={binding.weight || 100} onChange={(weight) => onChange({ weight: Number(weight) || 100 })} />
                </LabeledControl>
                <div className="flex h-8 items-center">
                    <Switch size="small" checked={binding.enabled} aria-label={`${channel?.name || "渠道"}绑定启用状态`} onChange={(enabled) => onChange({ enabled })} />
                </div>
            </div>
            <div className="mt-3 rounded-md border border-stone-200/80 bg-white/70 p-3 dark:border-stone-800 dark:bg-stone-950/40">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div>
                        <div className="text-xs font-semibold text-stone-700 dark:text-stone-200">能力档案</div>
                        <div className="mt-1 text-[11px] text-stone-500 dark:text-stone-400">控制参考素材、任务能力和资源限制。</div>
                    </div>
                    <Tag className="m-0">{capabilityLabel(capability)}</Tag>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="flex flex-wrap items-center gap-3 text-xs text-stone-600 dark:text-stone-300 sm:col-span-2 lg:col-span-4">
                        <Checkbox checked={profile.supportsReferenceImage === true} onChange={(event) => updateProfile({ supportsReferenceImage: event.target.checked })}>
                            参考图片
                        </Checkbox>
                        <Checkbox checked={profile.supportsReferenceVideo === true} onChange={(event) => updateProfile({ supportsReferenceVideo: event.target.checked })}>
                            参考视频
                        </Checkbox>
                        <Checkbox checked={profile.supportsReferenceAudio === true} onChange={(event) => updateProfile({ supportsReferenceAudio: event.target.checked })}>
                            参考音频
                        </Checkbox>
                        <Checkbox checked={effectiveAsync} onChange={(event) => updateProfile({ supportsAsync: event.target.checked })}>
                            异步查询
                        </Checkbox>
                        <Checkbox checked={profile.supportsCancel === true} onChange={(event) => updateProfile({ supportsCancel: event.target.checked })}>
                            上游取消
                        </Checkbox>
                        <Checkbox checked={profile.supportsWebhook === true} onChange={(event) => updateProfile({ supportsWebhook: event.target.checked })}>
                            Webhook
                        </Checkbox>
                    </div>
                    <LabeledControl label="最大参考图数量">
                        <InputNumber className="w-full" min={0} max={16} precision={0} value={profile.maxReferenceImages} onChange={(value) => updateProfile({ maxReferenceImages: Number(value) || 0 })} />
                    </LabeledControl>
                    <LabeledControl label="最大批量数量">
                        <InputNumber className="w-full" min={1} max={100} precision={0} value={profile.maxBatchSize} onChange={(value) => updateProfile({ maxBatchSize: Number(value) || 1 })} />
                    </LabeledControl>
                    <LabeledControl label="最短时长（秒）">
                        <InputNumber className="w-full" min={0} max={3600} precision={0} value={profile.minDurationSeconds} onChange={(value) => updateProfile({ minDurationSeconds: Number(value) || 0 })} />
                    </LabeledControl>
                    <LabeledControl label="最长时长（秒）">
                        <InputNumber className="w-full" min={0} max={3600} precision={0} value={profile.maxDurationSeconds} onChange={(value) => updateProfile({ maxDurationSeconds: Number(value) || 0 })} />
                    </LabeledControl>
                    <LabeledControl label="支持比例（逗号分隔）">
                        <Input value={profile.aspectRatios?.join(", ") || ""} placeholder="1:1, 16:9, 9:16" onChange={(event) => updateList(event.target.value)} />
                    </LabeledControl>
                    <LabeledControl label="支持画质/清晰度">
                        <Input value={profile.resolutions?.join(", ") || ""} placeholder={capability === "image" ? "high, 1K, 2K, 4K" : "480, 720, 1080"} onChange={(event) => updateResolutions(event.target.value)} />
                    </LabeledControl>
                    <LabeledControl label="支持时长（秒）">
                        <Input value={profile.durationSeconds?.join(", ") || ""} placeholder="5, 8, 10" disabled={capability !== "video"} onChange={(event) => updateDurations(event.target.value)} />
                    </LabeledControl>
                    <LabeledControl label="请求超时（秒）">
                        <InputNumber
                            className="w-full"
                            min={5}
                            max={1800}
                            precision={0}
                            value={timeoutSeconds}
                            placeholder={`默认 ${defaultTimeoutSeconds} 秒`}
                            onChange={(value) => updateProfile({ timeoutMs: value ? Number(value) * 1000 : undefined })}
                        />
                    </LabeledControl>
                    <LabeledControl label="并发上限">
                        <InputNumber className="w-full" min={1} max={1000} precision={0} value={profile.concurrencyLimit} onChange={(value) => updateProfile({ concurrencyLimit: Number(value) || 1 })} />
                    </LabeledControl>
                    <LabeledControl label={`兼容成本（元/${unit === "per_1m_tokens" ? "1M token" : unit === "per_second" ? "秒" : "次"}）`}>
                        <InputNumber className="w-full" min={0} precision={4} value={profile.unitCost} onChange={(value) => updateProfile({ unitCost: Number(value) || 0 })} />
                    </LabeledControl>
                    <LabeledControl label="成本货币">
                        <Input value="CNY" disabled />
                    </LabeledControl>
                    {capability === "text" ? (
                        <LabeledControl label="计费单位">
                            <Input value={billingUnitLabel(unit)} disabled />
                        </LabeledControl>
                    ) : (
                        <LabeledControl label="计费单位">
                            <Select
                                className="w-full"
                                value={unit}
                                options={capability === "video" ? [{ label: "按次（每次调用）", value: "per_call" }, { label: "按秒（按实际视频时长）", value: "per_second" }] : [{ label: "按次（每次调用）", value: "per_call" }]}
                                onChange={(value) => updatePricing({ billingUnit: value })}
                            />
                        </LabeledControl>
                    )}
                    <LabeledControl label={capability === "text" ? "输入成本价（元/1M token）" : `成本价（元/${unit === "per_second" ? "秒" : "次"}）`}>
                        <InputNumber
                            className="w-full"
                            min={0}
                            precision={6}
                            value={capability === "text" ? pricing.inputCostPrice : pricing.costPrice}
                            onChange={(value) => updatePricing(capability === "text" ? { inputCostPrice: Number(value) || 0 } : { costPrice: Number(value) || 0 })}
                        />
                    </LabeledControl>
                    <LabeledControl label={capability === "text" ? "输入销售价（元/1M token）" : `销售价（元/${unit === "per_second" ? "秒" : "次"}）`}>
                        <InputNumber
                            className="w-full"
                            min={0}
                            precision={6}
                            value={capability === "text" ? pricing.inputSalePrice : pricing.salePrice}
                            onChange={(value) => updatePricing(capability === "text" ? { inputSalePrice: Number(value) || 0 } : { salePrice: Number(value) || 0 })}
                        />
                    </LabeledControl>
                    {capability === "text" ? (
                        <>
                            <LabeledControl label="输出成本价（元/1M token）">
                                <InputNumber className="w-full" min={0} precision={6} value={pricing.outputCostPrice} onChange={(value) => updatePricing({ billingUnit: "per_1m_tokens", outputCostPrice: Number(value) || 0 })} />
                            </LabeledControl>
                            <LabeledControl label="输出销售价（元/1M token）">
                                <InputNumber className="w-full" min={0} precision={6} value={pricing.outputSalePrice} onChange={(value) => updatePricing({ billingUnit: "per_1m_tokens", outputSalePrice: Number(value) || 0 })} />
                            </LabeledControl>
                        </>
                    ) : null}
                </div>
            </div>
        </div>
    );
}

function cloneLogicalModel(model: LogicalModel): LogicalModel {
    return { ...model, bindings: model.bindings.map((binding) => ({ ...binding, capabilityProfile: binding.capabilityProfile ? { ...binding.capabilityProfile } : undefined })) };
}
