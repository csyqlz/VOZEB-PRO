"use client";

import { useState } from "react";
import { Button, Input, InputNumber, Segmented, Switch, Tag } from "antd";
import { Plus, Trash2 } from "lucide-react";

import { DEFAULT_MODEL_POINT_COST_KEY } from "@/constant/credits";
import type { AuthSettings } from "@/lib/auth/store";
import type { LogicalModelCapability, LogicalModelPricing } from "@/lib/auth/store";
import { configuredModelPointCostKeys } from "@/lib/model-point-cost";
import { billingUnitLabel, effectiveBillingUnit } from "@/lib/model-pricing";
import { LabeledControl } from "@/components/admin/admin-settings-controls";
import { toNumberOrOne, toNumberOrZero, uniqueList } from "@/components/admin/admin-values";

const imageQualityMultiplierOptions = [
    { key: "auto", label: "自动" },
    { key: "low", label: "低清" },
    { key: "medium", label: "中等" },
    { key: "high", label: "高清" },
];
const videoQualityMultiplierOptions = [
    { key: "480", label: "480p" },
    { key: "720", label: "720p" },
    { key: "1080", label: "1080p" },
];
const videoSecondsMultiplierOptions = [
    { key: "-1", label: "智能" },
    { key: "5", label: "5s" },
    { key: "10", label: "10s" },
];
const suggestedVideoSecondOptions = [6, 8, 20];
const legacyDefaultVideoSecondKeys = new Set(["12", "16"]);
const modelCapabilityOptions: Array<{ value: LogicalModelCapability; label: string }> = [
    { value: "text", label: "文本" },
    { value: "image", label: "图片" },
    { value: "video", label: "视频" },
    { value: "audio", label: "音频" },
];
export function QuotaRuleTable({
    settings,
    customModel,
    onCustomModelChange,
    onAddCustomModel,
    onFreeDailyPointsEnabledChange,
    onFreeDailyPointsChange,
    onModelPointCostChange,
    onModelPointCostDelete,
    onModelPricingChange,
    onGenerationPointMultiplierChange,
    onGenerationPointMultiplierDelete,
}: {
    settings: AuthSettings;
    customModel: string;
    onCustomModelChange: (value: string) => void;
    onAddCustomModel: () => void;
    onFreeDailyPointsEnabledChange: (enabled: boolean) => void;
    onFreeDailyPointsChange: (value: number | null) => void;
    onModelPointCostChange: (model: string, value: number | null) => void;
    onModelPointCostDelete: (model: string) => void;
    onModelPricingChange: (model: string, patch: Partial<LogicalModelPricing>) => void;
    onGenerationPointMultiplierChange: (group: keyof AuthSettings["generationPointMultipliers"], key: string, value: number | null) => void;
    onGenerationPointMultiplierDelete: (group: keyof AuthSettings["generationPointMultipliers"], key: string) => void;
}) {
    const [activeCapability, setActiveCapability] = useState<LogicalModelCapability>("text");
    const models = listPointCostModels(settings);
    const managedModelSet = new Set(settings.logicalModels.length ? settings.logicalModels.map((model) => model.id) : settings.systemChannels.flatMap((channel) => channel.models));
    const groupedModels = modelCapabilityOptions.map((option) => ({ ...option, models: models.filter((model) => resolvePointCostModelCapability(settings, model) === option.value) }));
    const visibleModels = groupedModels.find((group) => group.value === activeCapability)?.models || [];
    return (
        <div className="min-w-0">
            <section className="grid gap-3 border-b border-zinc-200 pb-4 sm:grid-cols-[minmax(0,1fr)_minmax(220px,320px)] sm:items-end sm:gap-6 sm:pb-5 dark:border-zinc-800">
                <div className="min-w-0">
                    <div className="text-sm font-semibold text-stone-950 dark:text-stone-100">免费用户每日余额</div>
                    <p className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">未购买套餐的用户每天自动获得人民币余额，仅当日有效；套餐每日赠送由商品配置决定，不受此开关影响。</p>
                </div>
                <div className="grid grid-cols-[auto_minmax(0,1fr)] items-end gap-3">
                    <div className="pb-1">
                        <div className="mb-1.5 text-xs font-medium text-stone-600 dark:text-stone-300">发放状态</div>
                        <Switch size="small" checked={settings.freeDailyPointsEnabled} checkedChildren="开启" unCheckedChildren="关闭" onChange={onFreeDailyPointsEnabledChange} />
                    </div>
                    <LabeledControl label="每日额度">
                        <InputNumber className="w-full" min={0} precision={8} prefix="¥" value={settings.freeDailyPoints} onChange={(value) => onFreeDailyPointsChange(toNumberOrZero(value))} />
                    </LabeledControl>
                </div>
            </section>
            <section className="border-b border-zinc-200 py-4 sm:py-5 dark:border-zinc-800">
                <div className="text-sm font-semibold text-stone-950 dark:text-stone-100">模型人民币价格</div>
                <div className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">所有模型统一使用人民币。图片按次、视频按次或按秒、文本按实际输入和输出 token 计费。成本价仅供管理人员核算，销售价用于用户余额扣费。</div>
                <div className="mt-3 grid gap-3 lg:grid-cols-[240px_minmax(0,1fr)] lg:items-end">
                    <LabeledControl label="其他模型每次默认销售价（元）">
                        <InputNumber
                            className="w-full"
                            min={0}
                            precision={8}
                            prefix="¥"
                            value={settings.modelPointCosts[DEFAULT_MODEL_POINT_COST_KEY] ?? 1}
                            onChange={(value) => onModelPointCostChange(DEFAULT_MODEL_POINT_COST_KEY, toNumberOrOne(value))}
                        />
                    </LabeledControl>
                    <LabeledControl label="添加模型价格档案">
                        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                            <Input value={customModel} placeholder="输入任意模型名，例如 grok-imagine-video" onChange={(event) => onCustomModelChange(event.target.value)} onPressEnter={onAddCustomModel} />
                            <Button icon={<Plus className="size-4" />} aria-label="添加模型" title="添加模型" onClick={onAddCustomModel}>
                                <span className="hidden sm:inline">添加模型</span>
                            </Button>
                        </div>
                    </LabeledControl>
                </div>
                <div className="mt-4 overflow-x-auto pb-1">
                    <Segmented
                        block
                        className="min-w-[360px]"
                        value={activeCapability}
                        options={groupedModels.map((group) => ({ value: group.value, label: `${group.label} ${group.models.length}` }))}
                        onChange={(value) => setActiveCapability(value as LogicalModelCapability)}
                    />
                </div>
                <div className="mt-3 text-[11px] text-stone-400 dark:text-stone-500">当前显示{modelCapabilityOptions.find((item) => item.value === activeCapability)?.label}模型；价格单位为人民币（CNY）。</div>
                <div className="mt-3 grid gap-x-5 gap-y-2 md:grid-cols-2">
                    <div className="hidden grid-cols-[minmax(0,1fr)_96px_96px_28px] items-center gap-2 px-1 text-[11px] font-medium text-stone-400 sm:grid sm:grid-cols-[minmax(0,1fr)_132px_132px_32px] md:col-span-2">
                        <span>模型</span>
                        <span>成本价（CNY）</span>
                        <span>销售价（CNY）</span>
                        <span />
                    </div>
                    {visibleModels.length ? (
                        visibleModels.map((model) => {
                            const logical = settings.logicalModels.find((item) => item.id.toLowerCase() === model.toLowerCase());
                            return (
                                <div
                                    key={model}
                                    className="grid min-w-0 grid-cols-[minmax(0,1fr)_96px_96px_28px] items-center gap-2 border-t border-zinc-100 py-2 first:border-t-0 md:[&:nth-child(2)]:border-t-0 dark:border-zinc-900 sm:grid-cols-[minmax(0,1fr)_132px_132px_32px]"
                                >
                                    <div className="min-w-0">
                                        <div className="flex min-w-0 items-center gap-2">
                                            <span className="block min-w-0 truncate text-sm text-stone-700 dark:text-stone-200" title={logical ? `${logical.name} (${logical.id})` : model}>
                                                {logical?.name || model}
                                            </span>
                                            <ModelCapabilityTag capability={activeCapability} />
                                            <Tag className="!m-0 shrink-0" color="gold">
                                                {billingUnitLabel(effectiveBillingUnit(activeCapability, logical?.bindings.find((binding) => binding.enabled !== false)?.capabilityProfile?.pricing?.billingUnit))}
                                            </Tag>
                                        </div>
                                        {logical && logical.name !== logical.id ? (
                                            <span className="mt-0.5 block truncate text-xs text-stone-400">ID: {logical.id}</span>
                                        ) : !managedModelSet.has(model) ? (
                                            <span className="mt-0.5 block text-xs text-stone-400">手动添加</span>
                                        ) : null}
                                    </div>
                                    <PriceEditor model={model} capability={activeCapability} settings={settings} onChange={onModelPricingChange} />
                                    <Button
                                        className="!h-7 !w-7 !min-w-7 !p-0"
                                        size="small"
                                        danger
                                        icon={<Trash2 className="size-3.5" />}
                                        aria-label="删除消耗配置"
                                        title="删除消耗配置"
                                        onClick={() => {
                                            const keys = configuredModelPointCostKeys(settings.modelPointCosts, model, settings.logicalModels);
                                            (keys.length ? keys : [model]).forEach(onModelPointCostDelete);
                                        }}
                                    />
                                </div>
                            );
                        })
                    ) : (
                        <div className="rounded-md border border-dashed border-stone-200 px-3 py-6 text-center text-sm text-stone-500 md:col-span-2 dark:border-stone-800">
                            当前没有{modelCapabilityOptions.find((item) => item.value === activeCapability)?.label}模型，请先在模型渠道中配置对应能力。
                        </div>
                    )}
                </div>
            </section>
            <section className="pt-4 sm:pt-5">
                <div className="text-sm font-semibold text-stone-950 dark:text-stone-100">生成参数倍率</div>
                <div className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">最终扣费 = 模型消耗 × 图片张数/视频任务 × 对应参数倍率。未命中的自定义参数按 1 倍计算。</div>
                <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(220px,0.8fr)_minmax(220px,0.8fr)_minmax(360px,1.4fr)]">
                    <MultiplierGroup title="图片清晰度" values={imageQualityMultiplierOptions} group="imageQuality" settings={settings.generationPointMultipliers.imageQuality} onChange={onGenerationPointMultiplierChange} />
                    <MultiplierGroup title="视频清晰度" values={videoQualityMultiplierOptions} group="videoQuality" settings={settings.generationPointMultipliers.videoQuality} onChange={onGenerationPointMultiplierChange} />
                    <VideoSecondsMultiplierGroup settings={settings.generationPointMultipliers.videoSeconds} onChange={onGenerationPointMultiplierChange} onDelete={onGenerationPointMultiplierDelete} />
                </div>
            </section>
        </div>
    );
}

export function listPointCostModels(settings: Pick<AuthSettings, "logicalModels" | "systemChannels" | "modelPointCosts">) {
    const logicalIds = settings.logicalModels.map((model) => model.id);
    const channelModels = uniqueList(settings.systemChannels.flatMap((channel) => channel.models));
    const bindingAliases = new Set(settings.logicalModels.flatMap((model) => model.bindings.map((binding) => binding.upstreamModel.toLowerCase())));
    const customModels = Object.keys(settings.modelPointCosts || {}).filter((model) => model !== DEFAULT_MODEL_POINT_COST_KEY && (!logicalIds.length || !bindingAliases.has(model.toLowerCase())));
    return uniqueList([...(logicalIds.length ? logicalIds : channelModels), ...customModels]);
}

export function resolvePointCostModelCapability(settings: Pick<AuthSettings, "logicalModels">, model: string): LogicalModelCapability {
    const normalized = model.trim().toLowerCase();
    const logical = settings.logicalModels.find((item) => item.id.toLowerCase() === normalized || item.bindings.some((binding) => binding.upstreamModel.trim().toLowerCase() === normalized));
    if (logical) return logical.capability;
    if (/(?:video|seedance|sora|veo|kling|wan|hailuo|runway|luma|vidu)/i.test(normalized)) return "video";
    if (/(?:image|imagen|dall|flux|midjourney|sdxl|stable[-_. ]?diffusion|seedream|recraft|ideogram)/i.test(normalized)) return "image";
    if (/(?:audio|tts|speech|whisper|voice|music)/i.test(normalized)) return "audio";
    return "text";
}

function ModelCapabilityTag({ capability }: { capability: LogicalModelCapability }) {
    const labels: Record<LogicalModelCapability, string> = { text: "文本", image: "图片", video: "视频", audio: "音频" };
    const colors: Record<LogicalModelCapability, string> = { text: "default", image: "blue", video: "green", audio: "gold" };
    return (
        <Tag className="!m-0 shrink-0" color={colors[capability]}>
            {labels[capability]}
        </Tag>
    );
}

function PriceEditor({ model, capability, settings, onChange }: { model: string; capability: LogicalModelCapability; settings: AuthSettings; onChange: (model: string, patch: Partial<LogicalModelPricing>) => void }) {
    const logical = settings.logicalModels.find((item) => item.id.toLowerCase() === model.toLowerCase() || item.bindings.some((binding) => binding.upstreamModel.toLowerCase() === model.toLowerCase()));
    const binding = logical?.bindings.find((item) => item.enabled !== false) || logical?.bindings[0];
    const existing = binding?.capabilityProfile?.pricing;
    const legacyCost = binding?.capabilityProfile?.unitCost ?? 0;
    const fallbackSale = settings.modelPointCosts[model] !== undefined ? Number(settings.modelPointCosts[model]) : legacyCost * 2;
    const isText = capability === "text";
    const cost = isText ? (existing?.inputCostPrice ?? binding?.capabilityProfile?.tokenPricing?.input ?? 0) : (existing?.costPrice ?? legacyCost);
    const sale = isText ? (existing?.inputSalePrice ?? cost * 2) : (existing?.salePrice ?? fallbackSale);
    const billingUnit = effectiveBillingUnit(capability, existing?.billingUnit);
    const unit = isText ? "元 / 1M 输入 token" : billingUnit === "per_second" ? "元 / 秒" : "元 / 次";
    return (
        <>
            <InputNumber
                className="w-full"
                min={0}
                precision={6}
                prefix="¥"
                title={`成本价（${unit}）`}
                value={cost}
                onChange={(value) => onChange(model, isText ? { billingUnit: "per_1m_tokens", inputCostPrice: Number(value) || 0 } : { billingUnit, costPrice: Number(value) || 0 })}
            />
            <InputNumber
                className="w-full"
                min={0}
                precision={6}
                prefix="¥"
                title={`销售价（${unit}）`}
                value={sale}
                onChange={(value) => onChange(model, isText ? { billingUnit: "per_1m_tokens", inputSalePrice: Number(value) || 0 } : { billingUnit, salePrice: Number(value) || 0 })}
            />
        </>
    );
}

function MultiplierGroup({
    title,
    values,
    group,
    settings,
    onChange,
}: {
    title: string;
    values: Array<{ key: string; label: string }>;
    group: keyof AuthSettings["generationPointMultipliers"];
    settings: Record<string, number>;
    onChange: (group: keyof AuthSettings["generationPointMultipliers"], key: string, value: number | null) => void;
}) {
    return (
        <div className="min-w-0 rounded-md border border-stone-200 bg-stone-50/70 p-3 dark:border-stone-800 dark:bg-stone-900/50">
            <div className="mb-3 text-xs font-semibold text-stone-600 dark:text-stone-300">{title}</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-[repeat(auto-fit,minmax(104px,1fr))]">
                {values.map((item) => (
                    <div key={item.key} className="min-w-0 rounded-md border border-stone-200 bg-white px-2 py-2 dark:border-stone-800 dark:bg-stone-950/70">
                        <div className="mb-1 truncate text-xs font-medium text-stone-600 dark:text-stone-300">{item.label}</div>
                        <InputNumber className="w-full" size="small" min={0} precision={2} value={settings[item.key] ?? 1} onChange={(value) => onChange(group, item.key, toNumberOrOne(value))} />
                    </div>
                ))}
            </div>
        </div>
    );
}

function VideoSecondsMultiplierGroup({
    settings,
    onChange,
    onDelete,
}: {
    settings: Record<string, number>;
    onChange: (group: keyof AuthSettings["generationPointMultipliers"], key: string, value: number | null) => void;
    onDelete: (group: keyof AuthSettings["generationPointMultipliers"], key: string) => void;
}) {
    const [customSeconds, setCustomSeconds] = useState<number | null>(null);
    const standardKeys = new Set(videoSecondsMultiplierOptions.map((item) => item.key));
    const customRows = Object.keys(settings || {})
        .filter((key) => !standardKeys.has(key))
        .filter((key) => !legacyDefaultVideoSecondKeys.has(key) || settings[key] !== 1)
        .filter((key) => {
            const value = Number(key);
            return Number.isFinite(value) && Number.isInteger(value) && value > 0;
        })
        .sort((a, b) => Number(a) - Number(b))
        .map((key) => ({ key, label: key + "s" }));
    const addCustomSeconds = () => {
        const seconds = Math.floor(Number(customSeconds));
        if (!Number.isFinite(seconds) || seconds <= 0) return;
        onChange("videoSeconds", String(seconds), settings[String(seconds)] ?? 1);
        setCustomSeconds(null);
    };

    return (
        <div className="min-w-0 rounded-md border border-stone-200 bg-stone-50/70 p-3 dark:border-stone-800 dark:bg-stone-900/50">
            <div className="mb-3 text-xs font-semibold text-stone-600 dark:text-stone-300">视频秒数</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-[repeat(auto-fit,minmax(96px,1fr))]">
                {videoSecondsMultiplierOptions.map((item) => (
                    <VideoSecondMultiplierCell key={item.key} label={item.label} value={settings[item.key] ?? 1} onChange={(value) => onChange("videoSeconds", item.key, value)} />
                ))}
                {customRows.map((item) => (
                    <VideoSecondMultiplierCell key={item.key} label={item.label} value={settings[item.key] ?? 1} onChange={(value) => onChange("videoSeconds", item.key, value)} onDelete={() => onDelete("videoSeconds", item.key)} />
                ))}
                <div className="col-span-full flex flex-wrap gap-1.5">
                    {suggestedVideoSecondOptions.map((seconds) => (
                        <Button key={seconds} size="small" onClick={() => onChange("videoSeconds", String(seconds), settings[String(seconds)] ?? 1)}>
                            {seconds}s
                        </Button>
                    ))}
                </div>
                <div className="col-span-full mt-1 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                    <InputNumber className="w-full" min={1} precision={0} placeholder="自定义秒数" value={customSeconds} onChange={setCustomSeconds} />
                    <Button size="small" icon={<Plus className="size-3.5" />} onClick={addCustomSeconds}>
                        添加
                    </Button>
                </div>
            </div>
        </div>
    );
}

function VideoSecondMultiplierCell({ label, value, onChange, onDelete }: { label: string; value: number; onChange: (value: number | null) => void; onDelete?: () => void }) {
    return (
        <div className="relative min-w-0 rounded-md border border-stone-200 bg-white px-2 py-2 dark:border-stone-800 dark:bg-stone-950/70">
            <div className="mb-1 truncate pr-6 text-xs font-medium text-stone-600 dark:text-stone-300">{label}</div>
            {onDelete ? <Button className="!absolute right-1 top-1 !h-5 !w-5 !min-w-5 !p-0" size="small" danger icon={<Trash2 className="size-3" />} aria-label="删除自定义秒数" title="删除自定义秒数" onClick={onDelete} /> : null}
            <InputNumber className="w-full" size="small" min={0} precision={2} value={value} onChange={(nextValue) => onChange(toNumberOrOne(nextValue))} />
        </div>
    );
}
