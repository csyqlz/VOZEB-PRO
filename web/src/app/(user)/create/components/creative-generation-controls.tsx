"use client";

import { Button, Popover } from "antd";
import { Check, Orbit } from "lucide-react";
import { useState } from "react";

import type { CreativeGenerationMode, CreativeGenerationPreferences } from "@/lib/creative-runtime-contract";
import { cn } from "@/lib/utils";

import { creativeComposerPopoverOverflow, type CreativeComposerPopoverPlacement } from "@/components/creative-composer-popover";
import { creativeComposerToolButtonClass } from "@/components/creative-composer-styles";
import { CreativeGenerationPreferences as GenerationPreferencesControl, mediaCapabilityLabel, type MediaCapability } from "@/components/creative-generation-preferences";
import { creativeSelectedModelProfile, type CreativeModelCapabilityOption } from "@/lib/creative-model-capabilities";

export type CreativeModelOption = CreativeModelCapabilityOption;

export function CreativeGenerationControls({
    models,
    selectedModels,
    smartPlanning,
    creationMode,
    generationPreferences,
    placement,
    onToggleModel,
    onClearModels,
    onToggleSmartPlanning,
    onCapabilityChange,
    onChangeGenerationPreference,
}: {
    models: CreativeModelOption[];
    selectedModels: CreativeModelOption[];
    smartPlanning: boolean;
    creationMode: "agent" | CreativeGenerationMode;
    generationPreferences: CreativeGenerationPreferences;
    placement: CreativeComposerPopoverPlacement;
    onToggleModel: (model: CreativeModelOption) => void;
    onClearModels: () => void;
    onToggleSmartPlanning: () => void;
    onCapabilityChange: (capability: MediaCapability) => void;
    onChangeGenerationPreference: (capability: MediaCapability, patch: Record<string, string | number | boolean>) => void;
}) {
    const [modelPickerOpen, setModelPickerOpen] = useState(false);
    const [preferredCapability, setPreferredCapability] = useState<MediaCapability>("image");
    const modelCapabilities = creationMode === "agent" ? (["image", "video", "audio"] as const).filter((capability) => models.some((model) => model.capability === capability)) : [creationMode];
    const activeCapability = creationMode === "agent" ? (modelCapabilities.includes(preferredCapability) ? preferredCapability : selectedModels[0]?.capability || modelCapabilities[0] || "image") : creationMode;
    const preferenceCapabilities = creationMode === "agent" ? (modelCapabilities.length ? modelCapabilities : [activeCapability]) : [creationMode];
    const capabilityProfile = creativeSelectedModelProfile(selectedModels, activeCapability);
    const modelSummary = selectedModels.length === 0 ? (smartPlanning ? "智能模型" : "选择模型") : selectedModels.length === 1 ? selectedModels[0].name : `${selectedModels[0].name} +${selectedModels.length - 1}`;

    return (
        <>
            <Popover
                trigger="click"
                placement={placement}
                autoAdjustOverflow={creativeComposerPopoverOverflow(placement)}
                arrow={false}
                open={modelPickerOpen}
                onOpenChange={setModelPickerOpen}
                content={
                    <div className="hide-scrollbar max-h-[calc(100vh-96px)] w-[calc(100vw-40px)] max-w-[360px] overflow-y-auto py-1">
                        <div className="flex items-center justify-between gap-3 px-1 pb-3">
                            <div className="min-w-0">
                                <p className="text-sm font-semibold text-[#20242a] dark:text-[#f3f5f7]">选择模型</p>
                                <p className="mt-0.5 truncate text-[11px] text-[#8b949f] dark:text-[#7f8996]">{selectedModels.length ? `已选择 ${selectedModels.length} 个，最多 6 个` : smartPlanning ? "默认由智能规划自动匹配" : "请选择至少一个模型"}</p>
                            </div>
                            <button
                                type="button"
                                role="switch"
                                aria-checked={smartPlanning}
                                aria-label={smartPlanning ? "关闭自动智能规划" : "开启自动智能规划"}
                                className={cn(
                                    "flex shrink-0 items-center gap-2 rounded-lg px-1.5 py-1 text-xs font-medium transition-colors",
                                    smartPlanning ? "bg-[#edf4f9] text-[#315f7d] dark:bg-[#6f9fbd]/12 dark:text-[#8eb8d1]" : "text-[#7f8995] hover:bg-[#f2f4f6] dark:text-[#8b95a1] dark:hover:bg-[#292f37]",
                                )}
                                onClick={onToggleSmartPlanning}
                            >
                                <span>{smartPlanning ? "智能" : "手动"}</span>
                                <span
                                    className={cn(
                                        "relative h-5 w-9 rounded-full border transition-colors",
                                        smartPlanning ? "border-[#4f7f9d] bg-[#4f7f9d] dark:border-[#78a8c5] dark:bg-[#78a8c5]" : "border-[#cbd2da] bg-[#dfe3e8] dark:border-[#505966] dark:bg-[#3a414a]",
                                    )}
                                >
                                    <span className={cn("absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow-sm transition-transform dark:bg-[#20242a]", smartPlanning && "translate-x-4")} />
                                </span>
                            </button>
                        </div>
                        {modelCapabilities.length > 1 ? (
                            <div className={cn("mb-2 grid gap-1 rounded-xl bg-[#eef1f4] p-1 dark:bg-[#252a31]", modelCapabilities.length === 2 ? "grid-cols-2" : "grid-cols-3")}>
                                {modelCapabilities.map((capability) => {
                                    const count = models.filter((model) => model.capability === capability).length;
                                    return (
                                        <button
                                            key={capability}
                                            type="button"
                                            className={cn(
                                                "h-8 rounded-lg text-xs font-medium transition",
                                                activeCapability === capability ? "bg-white text-[#20242a] shadow-sm dark:bg-[#343b44] dark:text-white" : "text-[#7b8591] hover:text-[#20242a] dark:text-[#8f99a5] dark:hover:text-white",
                                            )}
                                            onClick={() => setPreferredCapability(capability)}
                                            aria-pressed={activeCapability === capability}
                                        >
                                            {mediaCapabilityLabel(capability)} · {count}
                                        </button>
                                    );
                                })}
                            </div>
                        ) : null}
                        <div className="hide-scrollbar max-h-64 space-y-1 overflow-y-auto overscroll-contain">
                            {!models.some((model) => model.capability === activeCapability) ? (
                                <p className="px-2 py-5 text-center text-xs leading-5 text-[#8b949f] dark:text-[#7f8996]">
                                    {smartPlanning ? `未配置可用的${mediaCapabilityLabel(activeCapability)}模型；本轮会先用文本模型生成提示词方案` : `当前未配置可用的${mediaCapabilityLabel(activeCapability)}模型`}
                                </p>
                            ) : null}
                            {models
                                .filter((model) => model.capability === activeCapability)
                                .map((model) => {
                                    const selected = selectedModels.some((item) => item.id === model.id);
                                    return (
                                        <button
                                            key={model.id}
                                            type="button"
                                            className={cn(
                                                "flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition",
                                                selected ? "bg-[#eef1f4] text-[#20242a] dark:bg-[#292f37] dark:text-white" : "text-[#4d5662] hover:bg-[#f4f6f8] dark:text-[#c2c9d1] dark:hover:bg-[#242930]",
                                            )}
                                            onClick={() => onToggleModel(model)}
                                        >
                                            <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-white text-[#465365] shadow-sm dark:bg-[#343b44] dark:text-[#e6eaf0]">
                                                <ModelPlatformIcon model={model} />
                                            </span>
                                            <span className="min-w-0 flex-1">
                                                <span className="block truncate text-xs font-medium">{model.name}</span>
                                                <span className="mt-0.5 block text-[11px] leading-4 text-[#8b949f] dark:text-[#7f8996]">{mediaCapabilityLabel(model.capability)}模型 · 可与其他模型同时生成</span>
                                            </span>
                                            <span
                                                className={cn(
                                                    "mt-1 grid size-4 shrink-0 place-items-center rounded border",
                                                    selected ? "border-[#20242a] bg-[#20242a] text-white dark:border-white dark:bg-white dark:text-[#20242a]" : "border-[#cbd2da] text-transparent dark:border-[#505966]",
                                                )}
                                            >
                                                <Check className="size-3" />
                                            </span>
                                        </button>
                                    );
                                })}
                        </div>
                        {!smartPlanning && selectedModels.length ? (
                            <button
                                type="button"
                                className="mt-2 w-full rounded-lg px-2 py-2 text-xs font-medium text-[#6d7784] transition hover:bg-[#f3f5f7] hover:text-[#20242a] dark:text-[#98a2ae] dark:hover:bg-[#252a31] dark:hover:text-white"
                                onClick={onClearModels}
                            >
                                清除选择并恢复智能规划
                            </button>
                        ) : null}
                    </div>
                }
            >
                <Button type="text" className={creativeComposerToolButtonClass(modelPickerOpen)} icon={<Orbit className="size-4" />} aria-label={`生成模型：${modelSummary}`} aria-haspopup="menu" aria-expanded={modelPickerOpen}>
                    <span className="max-w-[126px] truncate text-xs font-medium sm:max-w-[172px]">{modelSummary}</span>
                </Button>
            </Popover>
            <GenerationPreferencesControl
                capability={activeCapability}
                capabilities={preferenceCapabilities}
                preferences={generationPreferences}
                capabilityProfile={capabilityProfile}
                triggerLabel={creationMode === "agent" ? "生成参数" : undefined}
                placement={placement}
                onCapabilityChange={(capability) => {
                    setPreferredCapability(capability);
                    onCapabilityChange(capability);
                }}
                onChange={(patch) => onChangeGenerationPreference(activeCapability, patch as Record<string, string | number | boolean>)}
            />
        </>
    );
}

function ModelPlatformIcon({ model }: { model: CreativeModelOption }) {
    const identity = `${model.id} ${model.name}`.toLowerCase();
    if (/gemini|veo|imagen/.test(identity))
        return (
            <BrandIcon path="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" />
        );
    if (/seedance|doubao|bytedance/.test(identity))
        return <BrandIcon path="M19.8772 1.4685L24 2.5326v18.9426l-4.1228 1.0563V1.4685zm-13.3481 9.428l4.115 1.0641v8.9786l-4.115 1.0642v-11.107zM0 2.572l4.115 1.0642v16.7354L0 21.428V2.572zm17.4553 5.6205v11.107l-4.1228-1.0642V9.2568l4.1228-1.0642z" />;
    if (/wan|qwen|tongyi/.test(identity))
        return (
            <BrandIcon path="M3.996 4.517h5.291L8.01 6.324 4.153 7.506a1.668 1.668 0 0 0-1.165 1.601v5.786a1.668 1.668 0 0 0 1.165 1.6l3.857 1.183 1.277 1.807H3.996A3.996 3.996 0 0 1 0 15.487V8.513a3.996 3.996 0 0 1 3.996-3.996m16.008 0h-5.291l1.277 1.807 3.857 1.182c.715.227 1.17.889 1.165 1.601v5.786a1.668 1.668 0 0 1-1.165 1.6l-3.857 1.183-1.277 1.807h5.291A3.996 3.996 0 0 0 24 15.487V8.513a3.996 3.996 0 0 0-3.996-3.996m-4.007 8.345H8.002v-1.804h7.995Z" />
        );
    if (/kling|kuaishou/.test(identity))
        return (
            <BrandIcon path="M18.315 12.264c2.33 0 4.218 1.88 4.218 4.2V19.8c0 2.32-1.888 4.2-4.218 4.2h-6.202a4.218 4.218 0 0 1-4.023-2.938l-3.676 1.833a2.04 2.04 0 0 1-2.731-.903 2.015 2.015 0 0 1-.216-.907v-5.94a2.03 2.03 0 0 1 2.035-2.024 2.044 2.044 0 0 1 .919.218l3.673 1.85a4.218 4.218 0 0 1 4.02-2.925zm-.062 2.162h-6.078c-1.153 0-2.09.921-2.108 2.065v3.247c0 1.148.925 2.081 2.073 2.1h6.113c1.153 0 2.09-.922 2.109-2.065v-3.247a2.104 2.104 0 0 0-2.074-2.1zM4.18 15.72a.554.554 0 0 0-.555.542v3.734a.556.556 0 0 0 .798.496l.01-.004 3.463-1.756V17.51l-3.467-1.73a.557.557 0 0 0-.249-.06zM9.28 0a5.667 5.667 0 0 1 4.98 2.965 4.921 4.921 0 0 1 3.36-1.317c2.714 0 4.913 2.177 4.913 4.863 0 2.686-2.2 4.863-4.912 4.863a4.921 4.921 0 0 1-3.996-2.034 5.651 5.651 0 0 1-4.345 2.034c-3.131 0-5.67-2.546-5.67-5.687C3.61 2.546 6.149 0 9.28 0Zm8.34 3.926c-1.441 0-2.61 1.157-2.61 2.585s1.169 2.585 2.61 2.585c1.443 0 2.612-1.157 2.612-2.585s-1.169-2.585-2.611-2.585zM9.28 2.287a3.395 3.395 0 0 0-3.39 3.4c0 1.877 1.518 3.4 3.39 3.4a3.395 3.395 0 0 0 3.39-3.4c0-1.878-1.518-3.4-3.39-3.4z" />
        );
    return <Orbit className="size-3.5" />;
}

function BrandIcon({ path }: { path: string }) {
    return (
        <svg viewBox="0 0 24 24" className="size-3.5 fill-current" aria-hidden="true">
            <path d={path} />
        </svg>
    );
}
