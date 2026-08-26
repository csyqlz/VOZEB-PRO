"use client";

import { SlidersHorizontal } from "lucide-react";

import { CreativeGenerationPreferences, generationPreferenceSummary, type CreativeGenerationPreferencePatch } from "@/components/creative-generation-preferences";
import type { CreativeGenerationPreferences as GenerationPreferences } from "@/lib/creative-runtime-contract";
import type { AiConfig } from "@/stores/use-config-store";
import { useCreativeComposerPopoverPlacement, type CreativeComposerPopoverPlacement } from "@/components/creative-composer-popover";
import { canvasModelCapabilityProfile } from "../utils/canvas-model-capabilities";

type CanvasImageSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    onOpenChange?: (open: boolean) => void;
    buttonClassName?: string;
    placement?: CreativeComposerPopoverPlacement;
    fixedSizeLabel?: string;
};

export function CanvasImageSettingsPopover({ config, onConfigChange, onOpenChange, buttonClassName, placement = "topLeft", fixedSizeLabel }: CanvasImageSettingsPopoverProps) {
    const responsivePlacement = useCreativeComposerPopoverPlacement(placement);
    const preferences: GenerationPreferences = {
        mode: "image",
        image: {
            size: config.size || "auto",
            quality: imageQuality(config.quality),
            count: positiveInteger(config.count),
        },
    };
    const summary = canvasImagePreferenceSummary(preferences, fixedSizeLabel);
    const fullSummary = fixedSizeLabel ? `${fixedSizeLabel} · ${imageQualityLabel(preferences.image?.quality)} · ${preferences.image?.count || 1}张` : generationPreferenceSummary("image", preferences);

    return (
        <CreativeGenerationPreferences
            capability="image"
            preferences={preferences}
            capabilityProfile={canvasModelCapabilityProfile(config)}
            triggerLabel={summary}
            triggerAriaLabel={`图片设置：${fullSummary}`}
            triggerIcon={<SlidersHorizontal className="size-4" />}
            triggerClassName={buttonClassName}
            triggerLabelClassName="whitespace-nowrap text-left !overflow-visible !text-clip"
            placement={responsivePlacement}
            autoAdjustOverflow
            fixedSizeLabel={fixedSizeLabel}
            onOpenChange={onOpenChange}
            onChange={(patch) => applyImagePreferencePatch(patch, onConfigChange)}
        />
    );
}

export function canvasImagePreferenceSummary(preferences: GenerationPreferences, fixedSizeLabel?: string) {
    const image = preferences.image;
    const size = fixedSizeLabel || compactSizeLabel(image?.size);
    if (!fixedSizeLabel && /^\d+x\d+$/i.test(image?.size || "")) return size;
    const quality = ({ auto: "智能", high: "高", medium: "中", low: "低" } as Record<string, string>)[image?.quality || "auto"] || image?.quality || "智能";
    const count = image?.count || 1;
    return `${size} · ${quality}${count > 1 ? ` · ${count}张` : ""}`;
}

function applyImagePreferencePatch(patch: CreativeGenerationPreferencePatch, onChange: (key: keyof AiConfig, value: string) => void) {
    if (patch.size !== undefined) onChange("size", patch.size);
    if (patch.quality !== undefined) onChange("quality", patch.quality);
    if (patch.count !== undefined) onChange("count", String(patch.count));
}

function imageQuality(value?: string): NonNullable<GenerationPreferences["image"]>["quality"] {
    return value?.trim() || "auto";
}

function imageQualityLabel(value?: string) {
    return ({ auto: "智能画质", high: "高画质", medium: "中画质", low: "低画质" } as Record<string, string>)[value || "auto"] || value;
}

function positiveInteger(value: unknown) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function compactSizeLabel(value?: string) {
    return !value || value === "auto" ? "智能" : value.replace("x", "×");
}
