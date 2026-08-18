"use client";

import { Button, Popover, Select } from "antd";
import { AudioLines, ChevronDown, ImageIcon, Lightbulb, Maximize2, Sparkles, Video } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { audioFormatLabel, audioFormatOptions, audioVoiceLabel, audioVoiceOptions } from "@/lib/audio-generation";
import type { CreativeGenerationPreferences } from "@/lib/creative-runtime-contract";
import { cn } from "@/lib/utils";

import { creativeComposerPopoverOverflow, creativeComposerPopoverPanelMaxHeight, type CreativeComposerPopoverPlacement } from "./creative-composer-popover";
import { creativeComposerToolButtonClass } from "./creative-composer-styles";
import { PositiveNumberField, SuggestedPositiveIntegerField, SwitchPreference, VideoQualityField } from "./creative-generation-preference-fields";

export type MediaCapability = "image" | "video" | "audio";

export type CreativeGenerationPreferencePatch = {
    size?: string;
    quality?: string;
    count?: number;
    seconds?: number;
    generateAudio?: boolean;
    watermark?: boolean;
    referenceMode?: NonNullable<CreativeGenerationPreferences["video"]>["referenceMode"];
    firstFrameAssetId?: string;
    lastFrameAssetId?: string;
    voice?: string;
    format?: string;
    speed?: number;
};

const imageRatios = [
    { value: "auto", label: "智能", width: 18, height: 18 },
    { value: "1:1", label: "1:1", width: 18, height: 18 },
    { value: "16:9", label: "16:9", width: 24, height: 14 },
    { value: "4:3", label: "4:3", width: 21, height: 16 },
    { value: "3:2", label: "3:2", width: 23, height: 15 },
    { value: "2:3", label: "2:3", width: 15, height: 23 },
    { value: "3:4", label: "3:4", width: 16, height: 21 },
    { value: "9:16", label: "9:16", width: 14, height: 24 },
    { value: "2048x2048", label: "1:1（2K）", width: 18, height: 18 },
    { value: "2048x1152", label: "16:9（2K）", width: 24, height: 14 },
    { value: "1152x2048", label: "9:16（2K）", width: 14, height: 24 },
    { value: "3840x2160", label: "16:9（4K）", width: 24, height: 14 },
    { value: "2160x3840", label: "9:16（4K）", width: 14, height: 24 },
] as const;

const videoRatios = [
    { value: "auto", label: "智能", width: 18, height: 18 },
    { value: "21:9", label: "21:9", width: 26, height: 11 },
    { value: "16:9", label: "16:9", width: 24, height: 14 },
    { value: "4:3", label: "4:3", width: 21, height: 16 },
    { value: "1:1", label: "1:1", width: 18, height: 18 },
    { value: "3:4", label: "3:4", width: 16, height: 21 },
    { value: "9:16", label: "9:16", width: 14, height: 24 },
] as const;

const imageQualityOptions = [
    { value: "auto", label: "智能画质", shortLabel: "智能" },
    { value: "high", label: "高画质", shortLabel: "高" },
    { value: "medium", label: "中画质", shortLabel: "中" },
    { value: "low", label: "低画质", shortLabel: "低" },
] as const;

const videoQualityOptions = [
    { value: "auto", label: "智能清晰度", shortLabel: "智能" },
    { value: "480", label: "480P", shortLabel: "480P" },
    { value: "720", label: "720P", shortLabel: "720P" },
    { value: "1080", label: "1080P", shortLabel: "1080P" },
] as const;

const videoDurationOptions = [
    { value: 5, label: "5 秒" },
    { value: 10, label: "10 秒" },
] as const;

const generationCountOptions = [
    { value: 1, label: "1 份" },
    { value: 2, label: "2 份" },
    { value: 3, label: "3 份" },
    { value: 4, label: "4 份" },
] as const;

const videoReferenceModeOptions = [
    { value: "reference", label: "智能参考" },
    { value: "first_frame", label: "首帧" },
    { value: "first_last", label: "首尾帧" },
] as const;

export function CreativeGenerationPreferences({
    capability,
    capabilities = [capability],
    preferences,
    triggerLabel,
    triggerIcon,
    triggerAriaLabel,
    triggerClassName,
    triggerLabelClassName,
    panelClassName,
    placement = "topLeft",
    autoAdjustOverflow,
    fixedSizeLabel,
    compact = false,
    showCount = true,
    videoReferenceContent,
    onOpenChange,
    onCapabilityChange,
    onChange,
}: {
    capability: MediaCapability;
    capabilities?: readonly MediaCapability[];
    preferences: CreativeGenerationPreferences;
    triggerLabel?: string;
    triggerIcon?: ReactNode;
    triggerAriaLabel?: string;
    triggerClassName?: string | ((open: boolean) => string);
    triggerLabelClassName?: string;
    panelClassName?: string;
    placement?: CreativeComposerPopoverPlacement;
    autoAdjustOverflow?: boolean;
    fixedSizeLabel?: string;
    compact?: boolean;
    showCount?: boolean;
    videoReferenceContent?: ReactNode;
    onOpenChange?: (open: boolean) => void;
    onCapabilityChange?: (capability: MediaCapability) => void;
    onChange: (patch: CreativeGenerationPreferencePatch) => void;
}) {
    const [open, setOpen] = useState(false);
    const [panelMaxHeight, setPanelMaxHeight] = useState<number>();
    const triggerRef = useRef<HTMLButtonElement>(null);
    const availableCapabilities = capabilities.length ? capabilities : [capability];
    const activeCapability = availableCapabilities.includes(capability) ? capability : availableCapabilities[0];
    const summary = triggerLabel || generationPreferenceSummary(activeCapability, preferences);
    const maximumPanelHeight = compact ? 440 : 520;

    const measurePanelHeight = useCallback(() => {
        const trigger = triggerRef.current;
        if (!trigger) return;
        const visualViewport = window.visualViewport;
        const viewportTop = visualViewport?.offsetTop || 0;
        const viewportBottom = viewportTop + (visualViewport?.height || window.innerHeight);
        setPanelMaxHeight(creativeComposerPopoverPanelMaxHeight(placement, trigger.getBoundingClientRect(), { top: viewportTop, bottom: viewportBottom }, maximumPanelHeight));
    }, [maximumPanelHeight, placement]);

    useEffect(() => {
        if (!open) return;
        const visualViewport = window.visualViewport;
        window.addEventListener("resize", measurePanelHeight);
        visualViewport?.addEventListener("resize", measurePanelHeight);
        return () => {
            window.removeEventListener("resize", measurePanelHeight);
            visualViewport?.removeEventListener("resize", measurePanelHeight);
        };
    }, [measurePanelHeight, open]);

    return (
        <Popover
            trigger="click"
            placement={placement}
            autoAdjustOverflow={autoAdjustOverflow ?? creativeComposerPopoverOverflow(placement)}
            arrow={false}
            open={open}
            onOpenChange={(nextOpen) => {
                if (nextOpen) measurePanelHeight();
                setOpen(nextOpen);
                onOpenChange?.(nextOpen);
            }}
            styles={{ container: { padding: compact ? 6 : 8, borderRadius: compact ? 14 : 16 } }}
            content={
                <div
                    data-canvas-no-drag
                    data-creative-generation-preferences
                    className={cn("hide-scrollbar min-w-0 max-w-[calc(100vw-32px)] overflow-x-hidden overflow-y-auto overscroll-contain", compact ? "w-[316px]" : "w-[360px]", panelClassName)}
                    style={{ maxHeight: panelMaxHeight === undefined ? `min(${maximumPanelHeight}px, calc(100dvh - 96px))` : panelMaxHeight }}
                    onClick={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.stopPropagation()}
                    onWheel={(event) => event.stopPropagation()}
                    onContextMenu={(event) => event.stopPropagation()}
                >
                    {availableCapabilities.length > 1 ? (
                        <div
                            className={cn(
                                compact ? "mb-1.5 grid gap-1 rounded-lg bg-[#f1f3f5] p-0.5 dark:bg-[#252a31]" : "mb-2 grid gap-1 rounded-lg bg-[#f1f3f5] p-0.5 dark:bg-[#252a31]",
                                availableCapabilities.length === 2 ? "grid-cols-2" : "grid-cols-3",
                            )}
                        >
                            {availableCapabilities.map((item) => (
                                <button
                                    key={item}
                                    type="button"
                                    className={cn(
                                        "inline-flex items-center justify-center gap-1.5 rounded-[7px] text-[11px] font-medium transition",
                                        compact ? "h-7" : "h-8",
                                        activeCapability === item
                                            ? "bg-white text-[#20242a] shadow-sm dark:bg-[#343b44] dark:text-white"
                                            : "text-[#7b8591] hover:bg-white/60 hover:text-[#20242a] dark:text-[#8f99a5] dark:hover:bg-[#30363e] dark:hover:text-white",
                                    )}
                                    onClick={() => onCapabilityChange?.(item)}
                                    aria-pressed={activeCapability === item}
                                >
                                    <CreativeModeIcon mode={item} />
                                    {mediaCapabilityLabel(item)}
                                </button>
                            ))}
                        </div>
                    ) : null}
                    <PreferencePanel capability={activeCapability} preferences={preferences} fixedSizeLabel={fixedSizeLabel} compact={compact} showCount={showCount} videoReferenceContent={videoReferenceContent} onChange={onChange} />
                </div>
            }
        >
            <Button
                ref={triggerRef}
                type="text"
                className={typeof triggerClassName === "function" ? triggerClassName(open) : triggerClassName || creativeComposerToolButtonClass(open)}
                icon={triggerIcon || <PreferenceSummaryIcon capability={activeCapability} preferences={preferences} />}
                aria-label={triggerAriaLabel || `生成参数：${summary}`}
                aria-haspopup="menu"
                aria-expanded={open}
            >
                <span className={cn("max-w-[132px] truncate text-xs font-medium sm:max-w-[176px]", triggerLabelClassName)}>{summary}</span>
                <ChevronDown className="size-3.5 shrink-0" />
            </Button>
        </Popover>
    );
}

function PreferencePanel({
    capability,
    preferences,
    fixedSizeLabel,
    compact,
    showCount,
    videoReferenceContent,
    onChange,
}: {
    capability: MediaCapability;
    preferences: CreativeGenerationPreferences;
    fixedSizeLabel?: string;
    compact: boolean;
    showCount: boolean;
    videoReferenceContent?: ReactNode;
    onChange: (patch: CreativeGenerationPreferencePatch) => void;
}) {
    const ratios = capability === "image" ? imageRatios : videoRatios;
    const selectedSize = capability === "image" ? preferences.image?.size || "auto" : preferences.video?.size || "auto";
    const selectedQuality = capability === "image" ? preferences.image?.quality || "auto" : preferences.video?.quality || "auto";
    const selectedCount = capability === "image" ? preferences.image?.count || 1 : preferences.video?.count || 1;
    const [customEditorOpen, setCustomEditorOpen] = useState(Boolean(parseCustomDimensions(selectedSize)) && !isPresetMediaSize(capability, selectedSize));
    const [section, setSection] = useState<"canvas" | "output">("canvas");

    useEffect(() => {
        setCustomEditorOpen(Boolean(parseCustomDimensions(selectedSize)) && !isPresetMediaSize(capability, selectedSize));
    }, [capability, selectedSize]);

    useEffect(() => {
        setSection("canvas");
    }, [capability]);

    if (capability === "audio") {
        return (
            <div className="grid grid-cols-2 gap-1.5">
                <PreferenceSelect label="音色" ariaLabel="选择音色" value={preferences.audio?.voice || "alloy"} options={audioVoiceOptions} onChange={(voice) => onChange({ voice })} />
                <PreferenceSelect label="格式" ariaLabel="选择音频格式" value={preferences.audio?.format || "mp3"} options={audioFormatOptions} onChange={(format) => onChange({ format })} />
                <PositiveNumberField className="col-span-2" label="语速" ariaLabel="输入音频语速" value={preferences.audio?.speed || 1} suffix="x" onChange={(speed) => onChange({ speed })} />
            </div>
        );
    }

    return (
        <div className={cn("grid min-w-0", compact ? "gap-2" : "gap-2.5")}>
            <div className={cn("grid grid-cols-2 gap-1 bg-[#f1f3f5] dark:bg-[#252a31]", compact ? "rounded-lg p-0.5" : "rounded-xl p-1")} role="tablist" aria-label="生成参数分组">
                <button
                    type="button"
                    role="tab"
                    aria-selected={section === "canvas"}
                    className={cn(
                        compact ? "h-7 rounded-[7px] text-[11px] font-medium transition" : "h-8 rounded-lg text-[11px] font-medium transition",
                        section === "canvas" ? "bg-white text-[#20242a] shadow-sm dark:bg-[#343b44] dark:text-white" : "text-[#7b8591] hover:text-[#20242a] dark:text-[#8f99a5] dark:hover:text-white",
                    )}
                    onClick={() => setSection("canvas")}
                >
                    画面
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={section === "output"}
                    className={cn(
                        compact ? "h-7 rounded-[7px] text-[11px] font-medium transition" : "h-8 rounded-lg text-[11px] font-medium transition",
                        section === "output" ? "bg-white text-[#20242a] shadow-sm dark:bg-[#343b44] dark:text-white" : "text-[#7b8591] hover:text-[#20242a] dark:text-[#8f99a5] dark:hover:text-white",
                    )}
                    onClick={() => setSection("output")}
                >
                    输出
                </button>
            </div>

            {section === "canvas" ? (
                <div className={cn("grid min-w-0", compact ? "gap-2" : "gap-2.5")}>
                    {capability === "video" && videoReferenceContent ? (
                        videoReferenceContent
                    ) : capability === "video" ? (
                        <CompactOptionGroup label="参考方式" ariaLabel="选择视频参考方式" value={preferences.video?.referenceMode || "reference"} options={videoReferenceModeOptions} columns={3} onChange={(referenceMode) => onChange({ referenceMode })} />
                    ) : null}
                    {fixedSizeLabel ? (
                        <div className="flex h-9 items-center justify-between rounded-lg bg-[#f5f6f7] px-3 text-[11px] dark:bg-[#24282e]">
                            <span className="font-medium text-[#7b8591] dark:text-[#98a2ae]">尺寸</span>
                            <span className="text-[#20242a] dark:text-white">{fixedSizeLabel}</span>
                        </div>
                    ) : (
                        <div className="grid min-w-0 gap-1.5">
                            <div className="flex items-center justify-between gap-3">
                                <p className="text-[11px] font-medium text-[#7b8591] dark:text-[#98a2ae]">比例</p>
                                <span className="text-[10px] text-[#a0a8b2] dark:text-[#707b88]">{selectedSize === "auto" ? "智能" : formatSizeLabel(selectedSize, capability)}</span>
                            </div>
                            <div className={cn("grid min-w-0 gap-1", capability === "image" ? "grid-cols-3" : "grid-cols-4")}>
                                {ratios.map((ratio) => (
                                    <button
                                        key={ratio.value}
                                        type="button"
                                        className={cn(
                                            "inline-flex min-w-0 items-center justify-center gap-1 rounded-lg px-1 text-[11px] transition",
                                            compact ? "h-8" : "h-9",
                                            selectedSize === ratio.value
                                                ? "bg-[#eaf1f5] font-medium text-[#315d78] dark:bg-[#2a3b46] dark:text-[#a8c8dc]"
                                                : "bg-[#f5f6f7] text-[#687481] hover:bg-[#edf0f2] hover:text-[#20242a] dark:bg-[#24282e] dark:text-[#a6afb9] dark:hover:bg-[#30363e] dark:hover:text-white",
                                        )}
                                        onClick={() => onChange({ size: ratio.value })}
                                        aria-label={`选择${capability === "image" ? "图片" : "视频"}比例 ${ratio.label}`}
                                        aria-pressed={selectedSize === ratio.value}
                                    >
                                        <span className="grid h-4 w-5 shrink-0 place-items-center">
                                            {ratio.value === "auto" ? <Sparkles className="size-3.5" /> : <span className="rounded-[2px] border-[1.5px] border-current" style={{ width: ratio.width * 0.64, height: ratio.height * 0.64 }} />}
                                        </span>
                                        <span>{ratio.label}</span>
                                    </button>
                                ))}
                            </div>
                            <button
                                type="button"
                                className={cn(
                                    "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-dashed px-2 text-[11px] transition",
                                    customEditorOpen || (parseCustomDimensions(selectedSize) && !isPresetMediaSize(capability, selectedSize))
                                        ? "border-[#9bbdce] bg-[#f2f8fb] font-medium text-[#315d78] dark:border-[#557f96] dark:bg-[#20333d] dark:text-[#a8c8dc]"
                                        : "border-[#d8dde2] text-[#687481] hover:border-[#b8c3cc] hover:bg-[#f7f8f9] hover:text-[#20242a] dark:border-[#414953] dark:text-[#a6afb9] dark:hover:bg-[#24282e] dark:hover:text-white",
                                )}
                                onClick={() => setCustomEditorOpen(true)}
                                aria-label={`打开${capability === "image" ? "图片" : "视频"}自定义像素尺寸`}
                                aria-pressed={customEditorOpen || (Boolean(parseCustomDimensions(selectedSize)) && !isPresetMediaSize(capability, selectedSize))}
                            >
                                <Maximize2 className="size-3.5" />
                                自定义像素尺寸
                            </button>
                            {customEditorOpen ? <CustomMediaSizeEditor capability={capability} size={selectedSize} onChange={onChange} /> : null}
                        </div>
                    )}
                </div>
            ) : (
                <div className="grid gap-2.5">
                    {capability === "video" ? (
                        <VideoQualityField value={selectedQuality} options={videoQualityOptions} onChange={(quality) => onChange({ quality })} />
                    ) : (
                        <CompactOptionGroup label="画质" ariaLabel="选择图片画质" value={selectedQuality} options={imageQualityOptions} onChange={(quality) => onChange({ quality })} />
                    )}
                    {showCount ? <GenerationCountGroup key={capability} capability={capability} value={selectedCount} onChange={(count) => onChange({ count })} /> : null}
                    {capability === "video" ? (
                        <>
                            <SuggestedPositiveIntegerField label="时长" ariaLabel="输入视频时长" value={preferences.video?.seconds || 5} suffix="秒" options={videoDurationOptions} onChange={(seconds) => onChange({ seconds })} />
                            <div className="grid grid-cols-2 gap-1.5 rounded-xl border border-[#e3e8ec] bg-[#fafbfc] p-2 dark:border-[#343b44] dark:bg-[#1f242a]">
                                <SwitchPreference label="生成声音" checked={preferences.video?.generateAudio ?? true} onChange={(generateAudio) => onChange({ generateAudio })} />
                                <SwitchPreference label="添加水印" checked={preferences.video?.watermark ?? false} onChange={(watermark) => onChange({ watermark })} />
                            </div>
                        </>
                    ) : null}
                </div>
            )}
        </div>
    );
}

function CustomMediaSizeEditor({ capability, size, onChange }: { capability: Extract<MediaCapability, "image" | "video">; size: string; onChange: (patch: CreativeGenerationPreferencePatch) => void }) {
    const dimensions = parseCustomDimensions(size);
    const [width, setWidth] = useState(dimensions?.[0] || "");
    const [height, setHeight] = useState(dimensions?.[1] || "");
    const [error, setError] = useState("");

    useEffect(() => {
        const next = parseCustomDimensions(size);
        setWidth(next?.[0] || "");
        setHeight(next?.[1] || "");
        setError("");
    }, [size]);

    const updateSize = (nextWidth: string, nextHeight: string) => {
        const normalizedWidth = normalizeDimension(nextWidth);
        const normalizedHeight = normalizeDimension(nextHeight);
        setError(nextWidth && nextHeight && (!normalizedWidth || !normalizedHeight) ? "宽和高必须是正整数" : "");
        if (normalizedWidth && normalizedHeight) onChange({ size: `${normalizedWidth}x${normalizedHeight}` });
    };
    const changeWidth = (value: string) => {
        setWidth(value);
        updateSize(value, height);
    };
    const changeHeight = (value: string) => {
        setHeight(value);
        updateSize(width, value);
    };
    return (
        <div className="grid min-w-0 max-w-full gap-1.5 rounded-xl border border-[#e3e8ec] bg-[#fafbfc] p-2 dark:border-[#343b44] dark:bg-[#1f242a]">
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1.5">
                <DimensionInput ariaLabel={`自定义${capability === "image" ? "图片" : "视频"}宽度`} placeholder="宽" value={width} onChange={changeWidth} />
                <span className="shrink-0 text-xs text-[#9aa4ae]">×</span>
                <DimensionInput ariaLabel={`自定义${capability === "image" ? "图片" : "视频"}高度`} placeholder="高" value={height} onChange={changeHeight} />
            </div>
            {error ? <p className="text-[10px] text-[#b85c5c] dark:text-[#e39a9a]">{error}</p> : null}
        </div>
    );
}

function GenerationCountGroup({ capability, value, onChange }: { capability: Extract<MediaCapability, "image" | "video">; value: number; onChange: (value: number) => void }) {
    const customSelected = value > generationCountOptions.length;
    const [draft, setDraft] = useState(customSelected ? String(value) : "");
    const [error, setError] = useState("");
    const lastEmittedValueRef = useRef(value);

    useEffect(() => {
        if (value !== lastEmittedValueRef.current) setDraft(value > generationCountOptions.length ? String(value) : "");
        setError("");
        lastEmittedValueRef.current = value;
    }, [value]);

    const changeDraft = (next: string) => {
        const normalized = next.replace(/[^0-9]/g, "");
        const count = normalizeGenerationCount(normalized);
        setDraft(count && count <= generationCountOptions.length ? "" : normalized);
        setError(normalized && !count ? "请输入正整数" : "");
        if (count) {
            lastEmittedValueRef.current = count;
            onChange(count);
        }
    };

    return (
        <div className="grid gap-1.5">
            <p className="text-[11px] font-medium text-[#7b8591] dark:text-[#98a2ae]">数量</p>
            <div className="grid grid-cols-5 gap-1" role="group" aria-label={`选择${capability === "image" ? "图片" : "视频"}生成数量`}>
                {generationCountOptions.map((option) => (
                    <button
                        key={option.value}
                        type="button"
                        className={cn(
                            "h-8 min-w-0 rounded-lg px-1 text-[11px] transition",
                            value === option.value
                                ? "bg-[#eaf1f5] font-medium text-[#315d78] dark:bg-[#2a3b46] dark:text-[#a8c8dc]"
                                : "bg-[#f5f6f7] text-[#687481] hover:bg-[#edf0f2] hover:text-[#20242a] dark:bg-[#24282e] dark:text-[#a6afb9] dark:hover:bg-[#30363e] dark:hover:text-white",
                        )}
                        onClick={() => {
                            setDraft("");
                            setError("");
                            lastEmittedValueRef.current = option.value;
                            onChange(option.value);
                        }}
                        aria-label={`选择${capability === "image" ? "图片" : "视频"}生成数量 ${option.label}`}
                        aria-pressed={value === option.value}
                    >
                        {option.label}
                    </button>
                ))}
                <label
                    className={cn(
                        "relative h-8 min-w-0 rounded-lg text-[11px] transition",
                        customSelected
                            ? "bg-[#eaf1f5] font-medium text-[#315d78] dark:bg-[#2a3b46] dark:text-[#a8c8dc]"
                            : "bg-[#f5f6f7] text-[#687481] focus-within:bg-[#f5f8fa] focus-within:text-[#315d78] focus-within:ring-1 focus-within:ring-[#9bbdce] focus-within:ring-inset hover:bg-[#edf0f2] dark:bg-[#24282e] dark:text-[#a6afb9] dark:focus-within:bg-[#222d34] dark:focus-within:text-[#a8c8dc] dark:focus-within:ring-[#557f96] dark:hover:bg-[#30363e]",
                    )}
                    title="输入正整数，修改后立即生效"
                >
                    <input
                        aria-label="自定义生成数量"
                        inputMode="numeric"
                        type="text"
                        value={draft}
                        onChange={(event) => changeDraft(event.target.value)}
                        placeholder="自定义"
                        className="size-full min-w-0 bg-transparent px-1 text-center text-[11px] font-medium outline-none placeholder:font-normal placeholder:text-current"
                    />
                    {draft ? <span className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 text-[9px] opacity-70">份</span> : null}
                </label>
            </div>
            {error ? <p className="text-[10px] text-[#b85c5c] dark:text-[#e39a9a]">{error}</p> : null}
        </div>
    );
}

function DimensionInput({ ariaLabel, placeholder, value, onChange }: { ariaLabel: string; placeholder: string; value: string; onChange: (value: string) => void }) {
    return (
        <input
            aria-label={ariaLabel}
            inputMode="numeric"
            type="text"
            value={value}
            placeholder={placeholder}
            onChange={(event) => onChange(event.target.value.replace(/[^0-9]/g, ""))}
            className="h-8 min-w-0 flex-1 rounded-lg border border-[#dce2e7] bg-white px-2 text-center text-xs text-[#20242a] outline-none transition placeholder:text-[#aeb6be] focus:border-[#7da6ba] focus:ring-2 focus:ring-[#7da6ba]/15 dark:border-[#3e4650] dark:bg-[#181b20] dark:text-[#f3f5f7] dark:placeholder:text-[#697480]"
        />
    );
}

export function normalizeGenerationCount(value: string | number) {
    const normalized = String(value).trim();
    if (!/^\d+$/.test(normalized)) return 0;
    const count = Number(normalized);
    return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

function CompactOptionGroup<T extends string | number>({
    label,
    ariaLabel,
    value,
    options,
    columns = 4,
    onChange,
}: {
    label: string;
    ariaLabel: string;
    value: T;
    options: readonly { value: T; label: string; shortLabel?: string }[];
    columns?: 2 | 3 | 4;
    onChange: (value: T) => void;
}) {
    return (
        <div className="grid gap-1.5">
            <p className="text-[11px] font-medium text-[#7b8591] dark:text-[#98a2ae]">{label}</p>
            <div className={cn("grid gap-1", columns === 2 ? "grid-cols-2" : columns === 3 ? "grid-cols-3" : "grid-cols-4")} role="group" aria-label={ariaLabel}>
                {options.map((option) => (
                    <button
                        key={option.value}
                        type="button"
                        className={cn(
                            "h-8 min-w-0 rounded-lg px-1 text-[11px] transition",
                            value === option.value
                                ? "bg-[#eaf1f5] font-medium text-[#315d78] dark:bg-[#2a3b46] dark:text-[#a8c8dc]"
                                : "bg-[#f5f6f7] text-[#687481] hover:bg-[#edf0f2] hover:text-[#20242a] dark:bg-[#24282e] dark:text-[#a6afb9] dark:hover:bg-[#30363e] dark:hover:text-white",
                        )}
                        onClick={() => onChange(option.value)}
                        aria-label={`${ariaLabel} ${option.label}`}
                        aria-pressed={value === option.value}
                    >
                        {option.shortLabel || option.label}
                    </button>
                ))}
            </div>
        </div>
    );
}

function PreferenceSelect<T extends string | number>({ label, ariaLabel, value, options, onChange }: { label: string; ariaLabel: string; value: T; options: readonly { value: T; label: string }[]; onChange: (value: T) => void }) {
    return (
        <label className="grid min-w-0 gap-0.5 rounded-lg bg-[#f5f6f7] px-2 py-1 text-[10px] text-[#8b949f] dark:bg-[#24282e] dark:text-[#7f8996]">
            {label}
            <Select size="small" variant="borderless" className="w-full" value={value} options={[...options]} onChange={onChange} aria-label={ariaLabel} />
        </label>
    );
}

function PreferenceSummaryIcon({ capability, preferences }: { capability: MediaCapability; preferences: CreativeGenerationPreferences }) {
    if (capability === "audio") return <AudioLines className="size-4" />;
    const size = capability === "image" ? preferences.image?.size : preferences.video?.size;
    const ratio = (capability === "image" ? imageRatios : videoRatios).find((item) => item.value === size);
    const custom = ratio ? null : parseCustomDimensions(size);
    if (custom) {
        return (
            <span className="grid size-4 place-items-center" aria-hidden="true">
                <span className="rounded-[2px] border-[1.5px] border-current" style={{ width: Math.max(8, Math.min(14, (Number(custom[0]) / Number(custom[1])) * 10)), height: Math.max(7, Math.min(14, (Number(custom[1]) / Number(custom[0])) * 10)) }} />
            </span>
        );
    }
    if (!ratio || ratio.value === "auto") return <Sparkles className="size-4" />;
    return (
        <span className="grid size-4 place-items-center" aria-hidden="true">
            <span className="rounded-[2px] border-[1.5px] border-current" style={{ width: Math.max(8, ratio.width * 0.55), height: Math.max(7, ratio.height * 0.55) }} />
        </span>
    );
}

export function generationPreferenceSummary(capability: MediaCapability, preferences: CreativeGenerationPreferences) {
    if (capability === "audio") return `${audioVoiceLabel(preferences.audio?.voice || "alloy")} · ${audioFormatLabel(preferences.audio?.format || "mp3")} · ${preferences.audio?.speed || 1}x`;
    const size = capability === "image" ? preferences.image?.size || "auto" : preferences.video?.size || "auto";
    const quality = capability === "image" ? preferences.image?.quality || "auto" : preferences.video?.quality || "auto";
    const count = capability === "image" ? preferences.image?.count || 1 : preferences.video?.count || 1;
    const countLabel = count > 1 ? ` · ${count}${capability === "image" ? "张" : "条"}` : "";
    const sizeLabel = size === "auto" ? "智能比例" : formatSizeLabel(size, capability);
    const qualityLabel = capability === "image" ? imageQualityOptions.find((item) => item.value === quality)?.label || quality : videoQualityLabel(quality);
    const referenceLabel = capability === "video" ? videoReferenceModeOptions.find((item) => item.value === (preferences.video?.referenceMode || "reference"))?.label : undefined;
    if (capability === "image") return size === "auto" && quality === "auto" ? `智能参数${countLabel}` : `${sizeLabel} · ${qualityLabel}${countLabel}`;
    const parameterLabel = size === "auto" && quality === "auto" ? "智能参数" : `${sizeLabel} · ${qualityLabel}`;
    const audioLabel = (preferences.video?.generateAudio ?? true) ? "有声" : "无声";
    const watermarkLabel = (preferences.video?.watermark ?? false) ? "带水印" : "无水印";
    return `${parameterLabel} · ${preferences.video?.seconds || 5}秒 · ${audioLabel} · ${watermarkLabel}${referenceLabel && referenceLabel !== "智能参考" ? ` · ${referenceLabel}` : ""}${countLabel}`;
}

function videoQualityLabel(value: string) {
    const preset = videoQualityOptions.find((item) => item.value === value)?.label;
    if (preset) return preset;
    return /^\d+$/.test(value) ? `${value}P` : value;
}

function parseCustomDimensions(value?: string) {
    const match = typeof value === "string" ? value.trim().match(/^(\d+)x(\d+)$/i) : null;
    if (!match || !normalizeDimension(match[1]) || !normalizeDimension(match[2])) return null;
    return [match[1], match[2]] as const;
}

function normalizeDimension(value: string) {
    const normalized = value.trim();
    if (!/^\d+$/.test(normalized)) return "";
    const parsed = Number(normalized);
    return Number.isSafeInteger(parsed) && parsed > 0 ? String(parsed) : "";
}

function isPresetMediaSize(capability: MediaCapability, value: string) {
    if (capability === "audio") return false;
    return (capability === "image" ? imageRatios : videoRatios).some((item) => item.value === value);
}

function formatSizeLabel(value: string, capability: Extract<MediaCapability, "image" | "video">) {
    const preset = (capability === "image" ? imageRatios : videoRatios).find((item) => item.value === value);
    if (preset) return preset.label;
    const dimensions = parseCustomDimensions(value);
    return dimensions ? `${dimensions[0]}×${dimensions[1]}` : value;
}

export function mediaCapabilityLabel(capability: MediaCapability) {
    return capability === "image" ? "图片" : capability === "video" ? "视频" : "音频";
}

export function CreativeModeIcon({ mode }: { mode: "agent" | MediaCapability }) {
    if (mode === "image") return <ImageIcon className="size-4" />;
    if (mode === "video") return <Video className="size-4" />;
    if (mode === "audio") return <AudioLines className="size-4" />;
    return <Lightbulb className="size-4" />;
}

export const creativeModeOptions = [
    { value: "agent", label: "Agent 模式", description: "自动理解需求并匹配能力" },
    { value: "image", label: "图片生成", description: "生成或编辑图片" },
    { value: "video", label: "视频生成", description: "文生视频或图生视频" },
    { value: "audio", label: "音频生成", description: "配音、旁白和音频" },
] as const;
