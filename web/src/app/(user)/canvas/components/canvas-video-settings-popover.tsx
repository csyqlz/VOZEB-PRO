"use client";

import { SlidersHorizontal } from "lucide-react";

import { CreativeGenerationPreferences, generationPreferenceSummary, type CreativeGenerationPreferencePatch } from "@/components/creative-generation-preferences";
import { useCreativeComposerPopoverPlacement, type CreativeComposerPopoverPlacement } from "@/components/creative-composer-popover";
import { canvasThemes } from "@/lib/canvas-theme";
import type { CreativeGenerationPreferences as GenerationPreferences } from "@/lib/creative-runtime-contract";
import { boolConfig } from "@/lib/seedance-video";
import type { AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";

import type { CanvasNodeMetadata } from "../types";
import type { CanvasResourceReference } from "../utils/canvas-resource-references";
import { canvasVideoReferenceModeLabel, normalizeCanvasVideoReferenceMode } from "../utils/canvas-video-references";
import { canvasModelCapabilityProfile } from "../utils/canvas-model-capabilities";
import { CanvasVideoReferenceSettings } from "./canvas-video-reference-settings";

type CanvasVideoSettingsPopoverProps = {
    config: AiConfig;
    metadata?: CanvasNodeMetadata;
    references: CanvasResourceReference[];
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    onMetadataChange: (patch: Partial<CanvasNodeMetadata>) => void;
    buttonClassName?: string;
    placement?: CreativeComposerPopoverPlacement;
};

export function CanvasVideoSettingsPopover({ config, metadata, references, onConfigChange, onMetadataChange, buttonClassName, placement = "topLeft" }: CanvasVideoSettingsPopoverProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const responsivePlacement = useCreativeComposerPopoverPlacement(placement);
    const preferences: GenerationPreferences = {
        mode: "video",
        video: {
            size: config.size || "auto",
            quality: config.vquality || "auto",
            seconds: positiveInteger(config.videoSeconds, 5),
            generateAudio: boolConfig(config.videoGenerateAudio, true),
            watermark: boolConfig(config.videoWatermark, false),
            referenceMode: normalizeCanvasVideoReferenceMode(metadata?.videoReferenceMode),
        },
    };
    const summary = canvasVideoPreferenceSummary(preferences);
    const fullSummary = generationPreferenceSummary("video", preferences);
    const referenceLabel = canvasVideoReferenceModeLabel(metadata?.videoReferenceMode);

    return (
        <CreativeGenerationPreferences
            capability="video"
            preferences={preferences}
            capabilityProfile={canvasModelCapabilityProfile(config)}
            triggerLabel={summary}
            triggerAriaLabel={`视频设置：${referenceLabel} · ${fullSummary}`}
            triggerIcon={<SlidersHorizontal className="size-4" />}
            triggerClassName={buttonClassName}
            triggerLabelClassName="whitespace-nowrap text-left !overflow-visible !text-clip"
            placement={responsivePlacement}
            autoAdjustOverflow
            showCount={false}
            videoReferenceContent={<CanvasVideoReferenceSettings metadata={metadata} references={references} theme={theme} compact onChange={onMetadataChange} />}
            onChange={(patch) => applyVideoPreferencePatch(patch, onConfigChange)}
        />
    );
}

export function canvasVideoPreferenceSummary(preferences: GenerationPreferences) {
    const video = preferences.video;
    const size = !video?.size || video.size === "auto" ? "智能" : video.size.replace("x", "×");
    if (/^\d+x\d+$/i.test(video?.size || "")) return size;
    const quality = !video?.quality || video.quality === "auto" ? "智能" : `${video.quality.replace(/p$/i, "")}P`;
    return `${size} · ${quality}`;
}

function applyVideoPreferencePatch(patch: CreativeGenerationPreferencePatch, onChange: (key: keyof AiConfig, value: string) => void) {
    if (patch.size !== undefined) onChange("size", patch.size);
    if (patch.quality !== undefined) onChange("vquality", patch.quality);
    if (patch.seconds !== undefined) onChange("videoSeconds", String(patch.seconds));
    if (patch.generateAudio !== undefined) onChange("videoGenerateAudio", String(patch.generateAudio));
    if (patch.watermark !== undefined) onChange("videoWatermark", String(patch.watermark));
}

function positiveInteger(value: unknown, fallback: number) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
