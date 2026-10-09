"use client";

import { Button, Popover, Tooltip } from "antd";
import { Boxes, Check, FileAudio, FileVideo, ImageIcon, Lightbulb, Orbit, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { ModelIcon } from "@/components/model-picker";
import type { AgentSkillSummary } from "@/services/api/agent-skills";
import { cn } from "@/lib/utils";
import { CREATIVE_RUN_MODEL_LIMIT } from "@/lib/creative-runtime-contract";
import type { CreativeModelCapabilityOption } from "@/lib/creative-model-capabilities";

export type CreativeAgentModelOption = CreativeModelCapabilityOption;
export type CreativeAgentControlTheme = { panel: string; border: string; text: string; muted: string; activeBackground: string; activeText: string };
export const creativeAgentModelCapabilities = ["image", "video", "audio"] as const;

export function CreativeAgentSkillCard({ skill, onRemove, theme, className }: { skill: AgentSkillSummary; onRemove: () => void; theme?: CreativeAgentControlTheme; className?: string }) {
    return (
        <div className={cn("flex px-1 pt-0.5", className)}>
            <span
                className={cn("flex h-8 max-w-full items-center gap-2 rounded-lg border px-2.5 text-xs font-medium", !theme && "border-amber-200/80 bg-amber-50/70 text-stone-700 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-stone-100")}
                style={theme ? { background: theme.activeBackground, borderColor: theme.border, color: theme.text } : undefined}
            >
                <span className="grid size-5 shrink-0 place-items-center rounded-md bg-amber-200/45 text-amber-800 dark:bg-amber-300/10 dark:text-amber-300">
                    <Sparkles className="size-3" />
                </span>
                <span className="truncate">Skill · {skill.name}</span>
                <button
                    type="button"
                    className="grid size-5 shrink-0 place-items-center rounded text-stone-500 transition hover:bg-black/5 hover:text-stone-950 dark:text-stone-400 dark:hover:bg-white/10 dark:hover:text-white"
                    style={theme ? { color: theme.muted } : undefined}
                    onClick={onRemove}
                    aria-label={`移除 Skill ${skill.name}`}
                >
                    <X className="size-3" />
                </button>
            </span>
        </div>
    );
}

export function CreativeAgentControls({
    skills,
    skillsLoading,
    selectedSkill,
    models,
    selectedModels,
    smartPlanning,
    onSelectSkill,
    onToggleModel,
    onClearModels,
    onSmartPlanningChange,
    theme,
    compact = false,
    className,
    middle,
    modelPickerRequest = 0,
    defaultModelCapability = "image",
    modelCapabilities,
}: {
    skills: AgentSkillSummary[];
    skillsLoading?: boolean;
    selectedSkill?: AgentSkillSummary;
    models: CreativeAgentModelOption[];
    selectedModels: CreativeAgentModelOption[];
    smartPlanning: boolean;
    onSelectSkill: (skill: AgentSkillSummary) => void;
    onToggleModel: (model: CreativeAgentModelOption) => void;
    onClearModels: () => void;
    onSmartPlanningChange: (enabled: boolean) => void;
    theme?: CreativeAgentControlTheme;
    compact?: boolean;
    className?: string;
    middle?: ReactNode;
    modelPickerRequest?: number;
    defaultModelCapability?: CreativeAgentModelOption["capability"];
    modelCapabilities?: readonly CreativeAgentModelOption["capability"][];
}) {
    const [skillOpen, setSkillOpen] = useState(false);
    const [modelOpen, setModelOpen] = useState(false);
    const [capability, setCapability] = useState<CreativeAgentModelOption["capability"]>(defaultModelCapability);
    const modelsByCapability = useMemo(() => groupCreativeAgentModels(models), [models]);
    const visibleCapabilities = resolveCreativeAgentModelCapabilities(modelCapabilities);
    const preferredCapability = visibleCapabilities.includes(defaultModelCapability) ? defaultModelCapability : visibleCapabilities[0];
    const activeCapability = visibleCapabilities.includes(capability) ? capability : preferredCapability;
    const visibleModels = modelsByCapability[activeCapability];

    useEffect(() => {
        if (modelPickerRequest <= 0) return;
        setCapability(preferredCapability);
        setModelOpen(true);
    }, [modelPickerRequest, preferredCapability]);

    const skillContent = (
        <div className="w-[calc(100vw-48px)] max-w-[320px] p-1 sm:w-80">
            <div className="px-2 pb-2 pt-1">
                <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">选择创作 Skill</p>
                <p className="mt-0.5 text-[11px] text-stone-500 dark:text-stone-400">Skill 作为执行能力提交，不会改写输入内容。</p>
            </div>
            <div className="thin-scrollbar max-h-60 space-y-1 overflow-y-auto">
                {skills.map((skill) => {
                    const active = selectedSkill?.id === skill.id;
                    return (
                        <button
                            key={skill.id}
                            type="button"
                            className={cn(
                                "flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition",
                                active ? "bg-stone-100 text-stone-950 dark:bg-stone-800 dark:text-white" : "text-stone-600 hover:bg-stone-50 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-stone-800/70 dark:hover:text-white",
                            )}
                            onClick={() => {
                                onSelectSkill(skill);
                                setSkillOpen(false);
                            }}
                        >
                            <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300">
                                <Sparkles className="size-3.5" />
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className="block truncate text-xs font-medium">{skill.name}</span>
                                <span className="mt-0.5 line-clamp-2 block text-[11px] leading-4 text-stone-500 dark:text-stone-400">{skill.description}</span>
                            </span>
                            {active ? <Check className="mt-1 size-3.5 shrink-0" /> : null}
                        </button>
                    );
                })}
                {skillsLoading ? <p className="px-2 py-5 text-center text-xs text-stone-500 dark:text-stone-400">正在加载 Skill...</p> : null}
                {!skillsLoading && !skills.length ? <p className="px-2 py-5 text-center text-xs text-stone-500 dark:text-stone-400">暂无可用 Skill</p> : null}
            </div>
        </div>
    );
    const modelContent = (
        <div className={cn("w-[calc(100vw-48px)]", compact ? "max-w-[280px]" : "max-w-[330px] p-1 sm:w-[340px]")} data-creative-agent-model-picker={compact ? "compact" : "default"}>
            <div className={cn("flex items-center justify-between", compact ? "gap-2 px-1 pb-1.5" : "gap-3 px-2 pb-2 pt-1")}>
                <div className="min-w-0">
                    <p className={cn("font-semibold text-stone-900 dark:text-stone-100", compact ? "text-[13px] leading-5" : "text-sm")}>选择生成模型</p>
                    <p className={cn("truncate text-stone-500 dark:text-stone-400", compact ? "text-[10px] leading-4" : "mt-0.5 text-[11px]")}>
                        {selectedModels.length ? `已选择 ${selectedModels.length} 个，最多 ${CREATIVE_RUN_MODEL_LIMIT} 个` : smartPlanning ? "默认由智能规划自动匹配" : "手动模式需要选择生成模型"}
                    </p>
                </div>
                <button
                    type="button"
                    role="switch"
                    aria-checked={smartPlanning}
                    aria-label={smartPlanning ? "关闭智能规划" : "开启智能规划"}
                    className={cn(
                        "flex shrink-0 items-center rounded-lg text-xs font-medium transition",
                        compact ? "gap-1.5 px-1 py-0.5" : "gap-2 px-1.5 py-1",
                        smartPlanning ? "bg-sky-50 text-sky-700 dark:bg-sky-400/10 dark:text-sky-300" : "text-stone-500 hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-800",
                    )}
                    onClick={() => onSmartPlanningChange(!smartPlanning)}
                >
                    <span>{smartPlanning ? (compact ? "开启" : "已开启") : compact ? "关闭" : "已关闭"}</span>
                    <span
                        className={cn(
                            "relative rounded-full border transition",
                            compact ? "h-[18px] w-8" : "h-5 w-9",
                            smartPlanning ? "border-sky-600 bg-sky-600 dark:border-sky-400 dark:bg-sky-400" : "border-stone-300 bg-stone-200 dark:border-stone-600 dark:bg-stone-700",
                        )}
                    >
                        <span className={cn("absolute left-0.5 top-0.5 rounded-full bg-white shadow-sm transition-transform dark:bg-stone-950", compact ? "size-3.5" : "size-4", smartPlanning && (compact ? "translate-x-3.5" : "translate-x-4"))} />
                    </span>
                </button>
            </div>
            {selectedModels.length ? (
                <div className={cn("flex items-center justify-between border-y border-stone-200/80 text-xs dark:border-stone-700", compact ? "mb-1.5 px-1 py-1.5" : "mb-2 px-2 py-2")}>
                    <span className="text-stone-500 dark:text-stone-400">手动模型会关闭智能规划</span>
                    <button type="button" className="font-medium text-stone-600 hover:text-stone-950 dark:text-stone-300 dark:hover:text-white" onClick={onClearModels}>
                        清空并恢复智能规划
                    </button>
                </div>
            ) : null}
            {visibleCapabilities.length > 1 ? (
                <div
                    className={cn("grid gap-1 bg-stone-100 p-1 dark:bg-stone-800", compact ? "mb-1.5 rounded-md" : "mb-2 rounded-lg")}
                    style={{ gridTemplateColumns: `repeat(${visibleCapabilities.length}, minmax(0, 1fr))` }}
                    role="tablist"
                    aria-label="模型能力分类"
                >
                    {visibleCapabilities.map((item) => {
                        const Icon = item === "image" ? ImageIcon : item === "video" ? FileVideo : FileAudio;
                        const count = modelsByCapability[item].length;
                        return (
                            <button
                                key={item}
                                type="button"
                                role="tab"
                                aria-selected={activeCapability === item}
                                className={cn(
                                    "flex min-w-0 items-center justify-center gap-1 rounded-md px-1.5 text-xs font-medium transition",
                                    compact ? "h-7" : "h-8",
                                    activeCapability === item ? "bg-white text-stone-950 shadow-sm dark:bg-stone-700 dark:text-white" : "text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-white",
                                )}
                                onClick={() => setCapability(item)}
                            >
                                <Icon className="size-3.5 shrink-0" />
                                <span className="truncate">{capabilityLabel(item)}</span>
                                {count ? <span className="shrink-0">· {count}</span> : null}
                            </button>
                        );
                    })}
                </div>
            ) : null}
            <div className={cn("thin-scrollbar space-y-1 overflow-y-auto", compact ? "max-h-40" : "max-h-52")}>
                {visibleModels.map((model) => {
                    const selected = selectedModels.some((item) => item.id === model.id);
                    return (
                        <button
                            key={model.id}
                            type="button"
                            className={cn(
                                "flex w-full items-center gap-2 text-left text-xs transition",
                                compact ? "min-h-8 rounded-md px-2 py-1.5" : "rounded-lg px-2.5 py-2",
                                selected ? "bg-stone-100 text-stone-950 dark:bg-stone-800 dark:text-white" : "text-stone-600 hover:bg-stone-50 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-stone-800/70 dark:hover:text-white",
                            )}
                            onClick={() => onToggleModel(model)}
                        >
                            <ModelIcon model={`${model.id} ${model.name}`} />
                            <span className="min-w-0 flex-1 truncate font-medium">{model.name}</span>
                            <span
                                className={cn("grid size-4 shrink-0 place-items-center rounded border", selected ? "border-stone-900 bg-stone-900 text-white dark:border-white dark:bg-white dark:text-stone-950" : "border-stone-300 dark:border-stone-600")}
                            >
                                {selected ? <Check className="size-3" /> : null}
                            </span>
                        </button>
                    );
                })}
                {!visibleModels.length ? (
                    <p className={cn("px-2 text-center text-xs leading-5 text-stone-500 dark:text-stone-400", compact ? "py-3" : "py-5")}>
                        {smartPlanning ? `未配置可用的${capabilityLabel(activeCapability)}模型；本轮会先用文本模型生成提示词方案` : `当前未配置可用的${capabilityLabel(activeCapability)}模型`}
                    </p>
                ) : null}
            </div>
        </div>
    );
    const mutedStyle = theme ? { color: theme.muted } : undefined;
    const activeStyle = theme ? { background: theme.activeBackground, color: theme.activeText } : undefined;

    return (
        <div className={cn(compact ? "flex w-full min-w-0 items-center gap-1" : "flex min-w-0 items-center gap-1.5", className)} data-creative-agent-controls={compact ? "compact" : "default"}>
            <Popover trigger="click" placement="topLeft" open={skillOpen} onOpenChange={setSkillOpen} content={skillContent}>
                <Button
                    type="text"
                    className={cn("!shrink-0 !gap-1.5", compact ? "!h-9 !w-9 !min-w-9 !rounded-lg !p-0" : "!h-8 !min-w-8 !px-2", selectedSkill && !theme && "!bg-amber-50 !text-amber-800 dark:!bg-amber-400/10 dark:!text-amber-300")}
                    style={selectedSkill ? activeStyle : mutedStyle}
                    icon={<Boxes className="size-4" />}
                    aria-label={selectedSkill ? `当前 Skill：${selectedSkill.name}` : "选择创作 Skill"}
                >
                    {compact ? null : <span className="text-xs">Skill</span>}
                </Button>
            </Popover>
            <Tooltip title={smartPlanning ? "智能规划：已开启" : "智能规划：已关闭"}>
                <Button
                    type="text"
                    className={cn(
                        "!shrink-0 !gap-1.5",
                        compact ? "!h-9 !w-9 !min-w-9 !rounded-lg !p-0" : "!h-8 !min-w-8 !px-2",
                        smartPlanning && !theme ? "!bg-sky-50 !text-sky-700 dark:!bg-sky-400/10 dark:!text-sky-300" : !theme ? "!text-stone-500 dark:!text-stone-400" : undefined,
                    )}
                    style={smartPlanning ? activeStyle : mutedStyle}
                    icon={<Lightbulb className={cn("size-4", smartPlanning && "fill-current")} />}
                    onClick={() => {
                        onSmartPlanningChange(!smartPlanning);
                        if (smartPlanning) setModelOpen(true);
                    }}
                    aria-label={smartPlanning ? "智能规划已开启，点击关闭" : "智能规划已关闭，点击开启"}
                    aria-pressed={smartPlanning}
                >
                    {compact ? null : <span className="text-xs">智能</span>}
                </Button>
            </Tooltip>
            <Popover trigger="click" placement="top" open={modelOpen} onOpenChange={setModelOpen} content={modelContent} styles={compact ? { container: { padding: 8, borderRadius: 12 } } : undefined}>
                <Tooltip title={selectedModels.length ? `已选择 ${selectedModels.length} 个模型` : "选择生成模型"}>
                    <Button
                        type="text"
                        shape="circle"
                        className={cn("relative !shrink-0 !p-0", compact ? "!h-9 !w-9 !min-w-9 !rounded-lg" : "!h-8 !w-8 !min-w-8", selectedModels.length && !theme && "!bg-stone-100 !text-stone-950 dark:!bg-stone-800 dark:!text-white")}
                        style={selectedModels.length ? activeStyle : mutedStyle}
                        icon={<Orbit className="size-4" />}
                        aria-label={selectedModels.length ? `已选择 ${selectedModels.length} 个模型` : "选择生成模型"}
                    >
                        {selectedModels.length ? (
                            <span className="absolute right-0 top-0 grid size-3.5 place-items-center rounded-full bg-stone-900 text-[8px] font-semibold text-white dark:bg-white dark:text-stone-950">{selectedModels.length}</span>
                        ) : null}
                    </Button>
                </Tooltip>
            </Popover>
            {middle ? <div className={cn("min-w-0", compact && "pl-1")}>{middle}</div> : null}
        </div>
    );
}

function capabilityLabel(capability: CreativeAgentModelOption["capability"]) {
    return capability === "image" ? "图片" : capability === "video" ? "视频" : "音频";
}

export function groupCreativeAgentModels(models: CreativeAgentModelOption[]) {
    return {
        image: models.filter((model) => model.capability === "image"),
        video: models.filter((model) => model.capability === "video"),
        audio: models.filter((model) => model.capability === "audio"),
    };
}

export function resolveCreativeAgentModelCapabilities(capabilities?: readonly CreativeAgentModelOption["capability"][]) {
    if (!capabilities?.length) return [...creativeAgentModelCapabilities];
    const requested = new Set(capabilities);
    const resolved = creativeAgentModelCapabilities.filter((capability) => requested.has(capability));
    return resolved.length ? resolved : [...creativeAgentModelCapabilities];
}
