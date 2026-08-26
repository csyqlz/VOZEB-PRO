"use client";

import { SlidersHorizontal } from "lucide-react";

import { CreativeGenerationPreferences as GenerationPreferencesControl, type CreativeGenerationPreferencePatch, type MediaCapability } from "@/components/creative-generation-preferences";
import type { CreativeGenerationPreferences } from "@/lib/creative-runtime-contract";
import { creativeSelectedModelProfile, type CreativeModelCapabilityOption } from "@/lib/creative-model-capabilities";
import { cn } from "@/lib/utils";

type AgentMediaCapability = Extract<MediaCapability, "image" | "video">;

export function CompactAgentGenerationSettings({ preferences, models = [], onChange }: { preferences: CreativeGenerationPreferences; models?: readonly CreativeModelCapabilityOption[]; onChange: (preferences: CreativeGenerationPreferences) => void }) {
    const capability: AgentMediaCapability = preferences.mode === "video" ? "video" : "image";

    return (
        <GenerationPreferencesControl
            capability={capability}
            capabilities={["image", "video"]}
            preferences={preferences}
            capabilityProfile={creativeSelectedModelProfile(models, capability)}
            triggerLabel={compactAgentPreferenceSummary(capability, preferences)}
            triggerAriaLabel={`生成参数：${agentPreferenceSummary(capability, preferences)}`}
            triggerIcon={<SlidersHorizontal className="size-4" />}
            triggerLabelClassName="min-w-0 flex-1 whitespace-nowrap text-left !overflow-visible !text-clip"
            panelClassName="!w-[280px]"
            triggerClassName={(open) =>
                cn(
                    "!h-9 !w-full !min-w-0 !max-w-[116px] !justify-start !gap-1.5 !rounded-lg !border !border-[#dce3e8] !bg-[#f7f9fa] !px-2 !text-[#54616d] !shadow-none hover:!border-[#cbd5dc] hover:!bg-[#f1f4f6] hover:!text-[#20242a] dark:!border-[#3b444d] dark:!bg-[#242a30] dark:!text-[#b5bec7] dark:hover:!border-[#4b5661] dark:hover:!bg-[#30363e] dark:hover:!text-white",
                    open && "!bg-[#eaf1f5] !text-[#315d78] dark:!bg-[#2a3b46] dark:!text-[#a8c8dc]",
                )
            }
            placement="top"
            compact
            onCapabilityChange={(next) => onChange({ ...preferences, mode: next })}
            onChange={(patch) => onChange(updateAgentGenerationPreferences(preferences, capability, patch))}
        />
    );
}

export function compactAgentPreferenceSummary(capability: AgentMediaCapability, preferences: CreativeGenerationPreferences) {
    if (capability === "video") {
        const video = preferences.video;
        const size = video?.size && video.size !== "auto" ? video.size.replace("x", "×") : "智能";
        return isExactSize(video?.size) ? size : `${size} · ${video?.seconds || 5}秒`;
    }
    const image = preferences.image;
    const size = image?.size && image.size !== "auto" ? image.size.replace("x", "×") : "智能";
    return isExactSize(image?.size) ? size : `${size} · ${image?.count || 1}张`;
}

function agentPreferenceSummary(capability: AgentMediaCapability, preferences: CreativeGenerationPreferences) {
    if (capability === "video") {
        const video = preferences.video;
        const size = video?.size && video.size !== "auto" ? video.size.replace("x", "×") : "智能";
        const quality = video?.quality && video.quality !== "auto" ? `${video.quality.replace(/p$/i, "")}P` : "智能";
        return size === "智能" && quality === "智能" ? "智能参数" : `${size} · ${quality} · ${video?.seconds || 5}秒`;
    }
    const image = preferences.image;
    const size = image?.size && image.size !== "auto" ? image.size.replace("x", "×") : "智能";
    const quality = ({ high: "高", medium: "中", low: "低", auto: "智能" } as const)[image?.quality || "auto"];
    return size === "智能" && quality === "智能" && (image?.count || 1) === 1 ? "智能参数" : `${size} · ${quality}${(image?.count || 1) > 1 ? ` · ${image?.count}张` : ""}`;
}

export function updateAgentGenerationPreferences(preferences: CreativeGenerationPreferences, capability: AgentMediaCapability, patch: CreativeGenerationPreferencePatch): CreativeGenerationPreferences {
    if (capability === "image") {
        const image = { ...preferences.image };
        if (patch.size !== undefined) image.size = patch.size;
        if (patch.quality !== undefined) image.quality = patch.quality;
        if (patch.count !== undefined) image.count = patch.count;
        return { ...preferences, mode: "image", image };
    }
    const video = { ...preferences.video };
    if (patch.size !== undefined) video.size = patch.size;
    if (patch.quality !== undefined) video.quality = patch.quality;
    if (patch.count !== undefined) video.count = patch.count;
    if (patch.seconds !== undefined) video.seconds = patch.seconds;
    if (patch.generateAudio !== undefined) video.generateAudio = patch.generateAudio;
    if (patch.watermark !== undefined) video.watermark = patch.watermark;
    if (patch.referenceMode !== undefined) video.referenceMode = patch.referenceMode;
    return { ...preferences, mode: "video", video };
}

function isExactSize(value?: string) {
    return /^\d+x\d+$/i.test(value || "");
}
