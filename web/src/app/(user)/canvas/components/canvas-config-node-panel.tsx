"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Check, ChevronDown, Image as ImageIcon, LoaderCircle, MessageSquare, Music2, Play, Settings2, Sparkles, Square, Video } from "lucide-react";
import { Button, Dropdown } from "antd";

import { ModelPicker } from "@/components/model-picker";
import { CreditSymbol, formatCreditAmount, requestCreditCost } from "@/constant/credits";
import { useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasAudioSettingsPopover } from "./canvas-audio-settings-popover";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { CanvasCameraControl } from "./canvas-camera-control";
import type { CanvasGenerationMode, CanvasNodeData, CanvasNodeMetadata } from "../types";
import type { CanvasResourceReference } from "../utils/canvas-resource-references";
import { buildCanvasNodeConfig, canvasAudioConfigPatch, canvasVideoConfigPatch, resolveCanvasGenerationModel } from "../utils/canvas-node-config";
import { canvasModelConfigPatch } from "../utils/canvas-model-capabilities";

type CanvasConfigNodePanelProps = {
    node: CanvasNodeData;
    isRunning: boolean;
    inputSummary: { textCount: number; imageCount: number; videoCount: number; audioCount: number };
    references: CanvasResourceReference[];
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    onGenerate: (nodeId: string) => void;
    onStop: (nodeId: string) => void;
    onComposerToggle: () => void;
};

export function CanvasConfigNodePanel({ node, isRunning, inputSummary, references, onConfigChange, onGenerate, onStop, onComposerToggle }: CanvasConfigNodePanelProps) {
    const [detailsOpen, setDetailsOpen] = useState(node.metadata?.configDetailsOpen === true);
    const [modeMenuOpen, setModeMenuOpen] = useState(false);
    const globalConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const mode = node.metadata?.generationMode || "image";
    const config = buildNodeConfig(globalConfig, node, mode);
    const count = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const credits = requestCreditCost({
        apiSource: config.apiSource,
        modelPointCosts: config.modelPointCosts,
        generationPointMultipliers: config.generationPointMultipliers,
        kind: mode,
        model: config.model,
        count: mode === "image" ? count : 1,
        quality: config.quality,
        videoQuality: config.vquality,
        videoSeconds: config.videoSeconds,
    });
    const inputTotal = inputSummary.textCount + inputSummary.imageCount + inputSummary.videoCount + inputSummary.audioCount;
    const hasAnyInput = Boolean(inputSummary.textCount || inputSummary.imageCount || inputSummary.videoCount || inputSummary.audioCount);
    const hasComposerContent = Boolean((node.metadata?.composerContent ?? node.metadata?.prompt ?? "").trim());
    const canGenerate = hasComposerContent || (mode === "audio" ? inputSummary.textCount > 0 : hasAnyInput);
    const modeLabel = generationModeLabel(mode);
    const setDetails = (nextOpen: boolean) => {
        setDetailsOpen(nextOpen);
        onConfigChange(node.id, { configDetailsOpen: nextOpen });
    };
    const selectMode = (nextMode: CanvasGenerationMode) => {
        const model = resolveCanvasGenerationModel(globalConfig, nextMode);
        const modelPatch = nextMode === "image" || nextMode === "video" ? canvasModelConfigPatch({ ...config, model }, model, nextMode) : { model };
        onConfigChange(node.id, { generationMode: nextMode, ...modelPatch });
        setModeMenuOpen(false);
    };

    useEffect(() => {
        setDetailsOpen(node.metadata?.configDetailsOpen === true);
    }, [node.id, node.metadata?.configDetailsOpen]);

    return (
        <div className="flex h-full w-full cursor-move flex-col px-3 pb-2.5 pt-3 text-sm" style={{ color: theme.node.text }} onWheel={(event) => event.stopPropagation()}>
            <div className="mb-1.5 flex min-h-7 items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2.5">
                    <span className="grid size-7 shrink-0 place-items-center rounded-lg" style={{ background: theme.toolbar.itemHover, color: theme.node.action }}>
                        <Sparkles className="size-3.5" />
                    </span>
                    <div className="min-w-0">
                        <div className="truncate text-[13px] font-semibold tracking-[0.01em]">生成配置</div>
                        <div className="mt-0.5 truncate text-[10px]" style={{ color: theme.node.faint }}>
                            {isRunning ? "正在处理当前输入" : canGenerate ? `${inputTotal ? `${inputTotal} 项` : "提示词"} · 就绪` : "连接素材或输入提示词"}
                        </div>
                    </div>
                </div>
                <div className="cursor-default" onMouseDown={(event) => event.stopPropagation()}>
                    <Dropdown
                        trigger={["click"]}
                        placement="bottomRight"
                        open={modeMenuOpen}
                        onOpenChange={setModeMenuOpen}
                        popupRender={() => (
                            <div
                                role="menu"
                                className="min-w-36 rounded-xl border p-1.5 shadow-[0_14px_34px_rgba(15,23,42,.16)]"
                                style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                                onPointerDown={(event) => event.stopPropagation()}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={(event) => event.stopPropagation()}
                            >
                                <div className="px-2 pb-1 pt-0.5 text-[10px] font-medium opacity-45">生成类型</div>
                                {GENERATION_MODES.map((item) => (
                                    <button
                                        key={item.value}
                                        type="button"
                                        role="menuitem"
                                        aria-label={item.label}
                                        className="flex h-9 w-full items-center justify-between rounded-lg px-2 text-left text-xs transition-colors hover:bg-black/[.05] dark:hover:bg-white/[.08]"
                                        style={{ color: item.value === mode ? theme.node.action : theme.node.text }}
                                        onClick={() => selectMode(item.value)}
                                    >
                                        <ModeLabel mode={item.value} label={item.label} />
                                        {item.value === mode ? <Check className="size-3.5" /> : null}
                                    </button>
                                ))}
                            </div>
                        )}
                    >
                        <Button
                            type="text"
                            size="small"
                            data-canvas-no-drag
                            className="!inline-flex !h-8 !items-center !rounded-lg !border !px-2.5 !shadow-none"
                            style={{ background: theme.toolbar.itemHover, borderColor: theme.node.stroke, color: theme.node.text }}
                            aria-label={`切换生成类型，当前${modeLabel}`}
                        >
                            <ModeLabel mode={mode} label={modeLabel} />
                            <ChevronDown className="ml-1 size-3.5 opacity-60" />
                        </Button>
                    </Dropdown>
                </div>
            </div>

            <div
                className={`mb-1.5 grid h-9 min-w-0 cursor-default items-stretch overflow-hidden rounded-xl border ${mode === "image" || mode === "video" || mode === "audio" ? "grid-cols-[minmax(0,1fr)_132px] divide-x" : "grid-cols-1"}`}
                style={{ background: theme.toolbar.itemHover, borderColor: theme.node.stroke }}
                onMouseDown={(event) => event.stopPropagation()}
            >
                <ModelPicker
                    className="canvas-compact-control !h-9 !rounded-none !border-0 !bg-transparent !shadow-none"
                    config={config}
                    value={config.model}
                    onChange={(model) => onConfigChange(node.id, mode === "image" || mode === "video" ? canvasModelConfigPatch(config, model, mode) : { model })}
                    capability={mode}
                    onMissingConfig={() => openConfigDialog(true)}
                    fullWidth
                />
                {mode === "video" ? (
                    <CanvasVideoSettingsPopover
                        config={config}
                        metadata={node.metadata}
                        references={references}
                        placement="topRight"
                        buttonClassName="canvas-compact-control !h-9 !w-full !justify-start !rounded-none !border-0 !bg-transparent !px-2.5 !shadow-none"
                        onConfigChange={(key, value) => onConfigChange(node.id, canvasVideoConfigPatch(key, value))}
                        onMetadataChange={(patch) => onConfigChange(node.id, patch)}
                    />
                ) : mode === "image" ? (
                    <CanvasImageSettingsPopover
                        config={config}
                        placement="topRight"
                        buttonClassName="canvas-compact-control !h-9 !w-full !justify-start !rounded-none !border-0 !bg-transparent !px-2.5 !shadow-none"
                        onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value })}
                    />
                ) : mode === "audio" ? (
                    <CanvasAudioSettingsPopover
                        config={config}
                        placement="topRight"
                        buttonClassName="canvas-compact-control !h-9 !w-full !justify-start !rounded-none !border-0 !bg-transparent !px-2.5 !shadow-none"
                        onConfigChange={(key, value) => onConfigChange(node.id, canvasAudioConfigPatch(key, value))}
                    />
                ) : null}
            </div>

            <div className="mb-1.5 min-w-0 cursor-default overflow-hidden rounded-xl border" style={{ background: theme.node.panel, borderColor: theme.node.stroke }} onMouseDown={(event) => event.stopPropagation()}>
                <div className="flex h-9 min-w-0 items-stretch">
                    <button
                        type="button"
                        className="inline-flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2.5 text-left transition-colors hover:bg-black/[.03] dark:hover:bg-white/[.05]"
                        aria-expanded={detailsOpen}
                        aria-controls={`canvas-config-details-${node.id}`}
                        aria-label={detailsOpen ? "收起输入与镜头" : "展开输入与镜头"}
                        onClick={() => setDetails(!detailsOpen)}
                    >
                        <span className="grid size-6 shrink-0 place-items-center rounded-md" style={{ background: theme.toolbar.itemHover, color: theme.node.muted }}>
                            <ImageIcon className="size-3.5" />
                        </span>
                        <span className="min-w-0 truncate text-xs font-medium">素材与镜头</span>
                        <span className="truncate text-[11px]" style={{ color: theme.node.faint }}>
                            {inputTotal ? `${inputTotal} 项已连接` : "等待连接"}
                        </span>
                        <ChevronDown className={`ml-auto size-3.5 shrink-0 opacity-55 transition-transform ${detailsOpen ? "rotate-180" : ""}`} />
                    </button>
                    <button
                        type="button"
                        data-canvas-no-drag
                        className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 border-l px-2.5 text-[11px] font-medium transition-colors hover:bg-black/[.03] dark:hover:bg-white/[.05]"
                        style={{ borderColor: theme.node.stroke, color: theme.node.muted }}
                        onClick={onComposerToggle}
                    >
                        <Settings2 className="size-3.5 opacity-70" />
                        <span className="hidden min-[360px]:inline">编辑提示词</span>
                    </button>
                </div>

                {detailsOpen ? (
                    <div id={`canvas-config-details-${node.id}`} data-canvas-config-details className="flex min-w-0 items-center gap-1 border-t px-1.5 py-1.5" style={{ borderColor: theme.node.stroke }}>
                        <div className="flex h-8 min-w-0 flex-1 items-center divide-x overflow-hidden" style={{ color: theme.node.muted }}>
                            <InputCount icon={<MessageSquare className="size-3" />} label="提示词" value={inputSummary.textCount} />
                            <InputCount icon={<ImageIcon className="size-3" />} label="参考图" value={inputSummary.imageCount} />
                            <InputCount icon={<Video className="size-3" />} label="参考视频" value={inputSummary.videoCount} />
                            <InputCount icon={<Music2 className="size-3" />} label="参考音频" value={inputSummary.audioCount} />
                        </div>
                        {mode === "image" || mode === "video" ? (
                            <div className="ml-1.5 min-w-0 w-[118px] shrink-0 border-l pl-1.5">
                                <CanvasCameraControl
                                    value={node.metadata?.cameraControl}
                                    onChange={(cameraControl) => onConfigChange(node.id, { cameraControl })}
                                    placement="topRight"
                                    buttonClassName="canvas-compact-control !h-8 !w-full !justify-start !rounded-lg !border-0 !bg-transparent !px-2 !shadow-none"
                                />
                            </div>
                        ) : null}
                    </div>
                ) : null}
            </div>

            <Button
                type="primary"
                className="canvas-generate-button mt-auto !h-9 !w-full !cursor-pointer !rounded-xl !border !text-[13px] !font-semibold"
                danger={isRunning}
                disabled={!isRunning && !canGenerate}
                style={
                    isRunning
                        ? { background: theme.node.danger, borderColor: theme.node.danger, color: theme.node.actionDangerText }
                        : canGenerate
                          ? { background: theme.node.action, borderColor: theme.node.action, color: theme.node.actionText }
                          : { background: theme.toolbar.itemHover, borderColor: theme.node.stroke, color: theme.node.muted }
                }
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => (isRunning ? onStop(node.id) : onGenerate(node.id))}
            >
                <span className="inline-flex items-center gap-1.5">
                    {isRunning ? (
                        <>
                            <LoaderCircle className="size-4 animate-spin" />
                            <Square className="size-3.5 fill-current" />
                            <span>停止</span>
                        </>
                    ) : (
                        <>
                            <span className="inline-flex items-center gap-1">
                                <CreditSymbol />
                                {formatCreditAmount(credits)}
                            </span>
                            <Play className="size-4" />
                            <span>开始生成</span>
                        </>
                    )}
                </span>
            </Button>
        </div>
    );
}

function InputCount({ icon, label, value }: { icon: ReactNode; label: string; value: number }) {
    return (
        <span className="inline-flex h-full min-w-0 flex-1 items-center justify-center gap-1 px-1 text-[11px]" title={`${label} ${value}`}>
            {icon}
            <span className="font-medium tabular-nums">{value}</span>
        </span>
    );
}

const GENERATION_MODES: Array<{ value: CanvasGenerationMode; label: string }> = [
    { value: "image", label: "生图" },
    { value: "text", label: "文本" },
    { value: "video", label: "视频" },
    { value: "audio", label: "音频" },
];

function ModeLabel({ mode, label }: { mode: CanvasGenerationMode; label: string }) {
    const icon = mode === "image" ? <ImageIcon className="size-3.5" /> : mode === "text" ? <MessageSquare className="size-3.5" /> : mode === "video" ? <Video className="size-3.5" /> : <Music2 className="size-3.5" />;
    return (
        <span className="inline-flex items-center gap-1.5">
            {icon}
            {label}
        </span>
    );
}

function generationModeLabel(mode: CanvasGenerationMode) {
    return GENERATION_MODES.find((item) => item.value === mode)?.label || "生图";
}

function buildNodeConfig(globalConfig: AiConfig, node: CanvasNodeData, mode: CanvasGenerationMode): AiConfig {
    const model = resolveCanvasGenerationModel(globalConfig, mode, node.metadata?.model);
    return buildCanvasNodeConfig(globalConfig, node, mode, model);
}
