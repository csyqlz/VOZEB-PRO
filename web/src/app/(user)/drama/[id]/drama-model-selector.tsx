"use client";

import { Button, Popover } from "antd";
import { Check, Orbit } from "lucide-react";
import { useState } from "react";

import { ModelIcon, publicModelLabel } from "@/components/model-picker";
import { cn } from "@/lib/utils";
import { selectableModelsByCapability, type AiConfig, type ModelCapability } from "@/stores/use-config-store";

type DramaModelSelectorProps = {
    config: AiConfig;
    imageValue?: string;
    videoValue?: string;
    imagePlaceholder: string;
    videoPlaceholder: string;
    defaultCapability?: Extract<ModelCapability, "image" | "video">;
    className?: string;
    onImageChange: (model: string) => void;
    onVideoChange: (model: string) => void;
    onClearImage?: () => void;
    onClearVideo?: () => void;
    onMissingConfig: (capability: Extract<ModelCapability, "image" | "video">) => void;
};

export function DramaModelSelector({ config, imageValue, videoValue, imagePlaceholder, videoPlaceholder, defaultCapability = "video", className, onImageChange, onVideoChange, onClearImage, onClearVideo, onMissingConfig }: DramaModelSelectorProps) {
    const [capability, setCapability] = useState<Extract<ModelCapability, "image" | "video">>(defaultCapability);
    const [open, setOpen] = useState(false);
    const [manualMode, setManualMode] = useState<Record<"image" | "video", boolean>>({ image: false, video: false });
    const image = capability === "image";
    const selectedValue = image ? imageValue : videoValue;
    const configuredModels = selectableModelsByCapability(config, capability);
    const current = selectedValue && configuredModels.includes(selectedValue) ? selectedValue : "";
    const smartPlanning = !current && !manualMode[capability];
    const modelSummary = current ? publicModelLabel(config, current) : smartPlanning ? "智能模型" : "选择模型";
    const capabilityLabel = image ? "图片" : "视频";

    const toggleSmartPlanning = () => {
        if (smartPlanning) {
            setManualMode((value) => ({ ...value, [capability]: true }));
            return;
        }
        if (image) onClearImage?.();
        else onClearVideo?.();
        setManualMode((value) => ({ ...value, [capability]: false }));
    };

    return (
        <div className={cn("min-w-0", className)} data-drama-model-selector>
            <Popover
                trigger="click"
                placement="bottomRight"
                arrow={false}
                open={open}
                onOpenChange={setOpen}
                styles={{ container: { padding: 0, borderRadius: 16, overflow: "hidden" } }}
                content={
                    <div className="hide-scrollbar max-h-[calc(100dvh-80px)] w-[min(360px,calc(100vw-32px))] overflow-y-auto p-3" data-drama-model-popover>
                        <div className="flex items-center justify-between gap-3 px-1 pb-3">
                            <div className="min-w-0">
                                <p className="text-sm font-semibold text-foreground">选择模型</p>
                                <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{current ? `已选择 ${publicModelLabel(config, current)}` : smartPlanning ? "默认由智能规划自动匹配" : `请选择可用的${capabilityLabel}模型`}</p>
                            </div>
                            <button
                                type="button"
                                role="switch"
                                aria-checked={smartPlanning}
                                aria-label={smartPlanning ? "关闭自动智能规划" : "开启自动智能规划"}
                                className={cn(
                                    "flex shrink-0 items-center gap-2 rounded-lg px-1.5 py-1 text-xs font-medium transition-colors",
                                    smartPlanning ? "bg-[#edf4f9] text-[#315f7d] dark:bg-[#6f9fbd]/12 dark:text-[#8eb8d1]" : "text-muted-foreground hover:bg-muted",
                                )}
                                onClick={toggleSmartPlanning}
                            >
                                <span>{smartPlanning ? "智能" : "手动"}</span>
                                <span className={cn("relative h-5 w-9 rounded-full border transition-colors", smartPlanning ? "border-[#4f7f9d] bg-[#4f7f9d] dark:border-[#78a8c5] dark:bg-[#78a8c5]" : "border-border bg-muted")}>
                                    <span className={cn("absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow-sm transition-transform dark:bg-[#20242a]", smartPlanning && "translate-x-4")} />
                                </span>
                            </button>
                        </div>
                        <div className="mb-2 grid grid-cols-2 gap-1 rounded-xl bg-muted p-1" role="group" aria-label="模型分类">
                            {(["image", "video"] as const).map((item) => {
                                const itemModels = selectableModelsByCapability(config, item);
                                const active = capability === item;
                                return (
                                    <button
                                        key={item}
                                        type="button"
                                        className={cn("h-8 rounded-lg text-xs font-medium transition", active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
                                        aria-pressed={active}
                                        onClick={() => setCapability(item)}
                                    >
                                        {item === "image" ? "图片" : "视频"} · {itemModels.length}
                                    </button>
                                );
                            })}
                        </div>
                        <div className="hide-scrollbar max-h-64 space-y-1 overflow-y-auto overscroll-contain">
                            {!configuredModels.length ? <p className="px-2 py-6 text-center text-xs text-muted-foreground">{image ? imagePlaceholder : videoPlaceholder}</p> : null}
                            {configuredModels.map((model) => {
                                const selected = current === model;
                                return (
                                    <button
                                        key={model}
                                        type="button"
                                        className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition", selected ? "bg-muted text-foreground" : "text-foreground/75 hover:bg-muted/70")}
                                        onClick={() => {
                                            if (image) onImageChange(model);
                                            else onVideoChange(model);
                                            setManualMode((value) => ({ ...value, [capability]: true }));
                                            setOpen(false);
                                        }}
                                    >
                                        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-background text-muted-foreground shadow-sm">
                                            <ModelIcon model={model} />
                                        </span>
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-xs font-medium">{publicModelLabel(config, model)}</span>
                                            <span className="mt-0.5 block text-[11px] text-muted-foreground">{capabilityLabel}模型</span>
                                        </span>
                                        <span className={cn("grid size-4 shrink-0 place-items-center rounded-full border", selected ? "border-foreground bg-foreground text-background" : "border-border text-transparent")}>
                                            <Check className="size-3" />
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                        {!configuredModels.length ? (
                            <button type="button" className="mt-2 w-full rounded-lg px-2 py-2 text-xs text-muted-foreground hover:bg-muted" onClick={() => onMissingConfig(capability)}>
                                检查模型配置
                            </button>
                        ) : null}
                    </div>
                }
            >
                <Button
                    type="text"
                    className={cn(
                        "!h-9 !min-w-0 !max-w-full !rounded-full !border !px-3 !shadow-none transition-colors",
                        open ? "!border-[#b7c9d6] !bg-[#edf4f9] !text-[#315f7d] dark:!border-[#60798a] dark:!bg-[#6f9fbd]/12 dark:!text-[#9bc0d7]" : "!border-border/80 !bg-background !text-foreground hover:!border-foreground/30 hover:!bg-muted/50",
                    )}
                    icon={<Orbit className="size-4 shrink-0" />}
                    aria-label={`${capabilityLabel}模型：${modelSummary}`}
                    aria-haspopup="menu"
                    aria-expanded={open}
                >
                    <span className="max-w-[10rem] truncate text-xs font-medium sm:max-w-[13rem]">{modelSummary}</span>
                </Button>
            </Popover>
        </div>
    );
}
