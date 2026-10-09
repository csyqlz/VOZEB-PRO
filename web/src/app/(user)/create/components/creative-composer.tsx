"use client";

import { Button, Input, Popover, Tooltip } from "antd";
import type { TextAreaRef } from "antd/es/input/TextArea";
import { ArrowUp, AtSign, Boxes, Check, ChevronLeft, ChevronRight, FileAudio, FileVideo, ImageIcon, Plus, Sparkles, Square, WandSparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEventHandler, type PointerEventHandler, type RefObject, type WheelEvent } from "react";

import type { CreativeAsset, CreativeGenerationPreferences } from "@/lib/creative-runtime-contract";
import { creativeAssetReferenceAliases } from "@/lib/creative-asset-references";
import { clipboardImageFiles } from "@/lib/clipboard-image-files";
import { imagePreviewUrl } from "@/lib/media-image-url";
import { cn } from "@/lib/utils";

import { creativeComposerPopoverOverflow, useCreativeComposerPopoverPlacement } from "@/components/creative-composer-popover";
import { creativeComposerToolButtonClass } from "@/components/creative-composer-styles";
import {
    creativeAssetMentionAtCursor,
    creativeAssetMentionCandidates,
    creativeAssetMentionDeletionAtKey,
    creativeAssetMentionSegments,
    mergeCreativeAssetMentionSources,
    replaceCreativeAssetMention,
    type CreativeAssetMentionSegment,
} from "./creative-asset-mention";
import { CreativeAssetMentionPicker } from "./creative-asset-mention-picker";
import { CreativeGenerationControls, type CreativeModelOption } from "./creative-generation-controls";

type SkillOption = {
    id: string;
    name: string;
    description: string;
    action?: "generate" | "edit";
    workspaces?: Array<"image" | "video" | "canvas" | "drama">;
};
type SkillCategory = "all" | "image" | "video" | "canvas" | "drama" | "edit";

export function CreativeComposer({
    inputRef,
    value,
    busy,
    optimizing,
    onChange,
    onOptimize,
    onSubmit,
    onCancel,
    onAttachment,
    onPasteImages,
    attachments,
    referenceAssets,
    selectedAssetIds,
    skills,
    skillsLoading,
    selectedSkill,
    models,
    selectedModels,
    smartPlanning,
    generationPreferences,
    uploading,
    onRemoveAttachment,
    onReferenceAsset,
    onSelectSkill,
    onRemoveSkill,
    onToggleModel,
    onClearModels,
    onToggleSmartPlanning,
    onChangeGenerationPreference,
    centered = false,
    compact = false,
    onExpand,
}: {
    inputRef: RefObject<TextAreaRef | null>;
    value: string;
    busy: boolean;
    optimizing: boolean;
    onChange: (value: string) => void;
    onOptimize: () => void;
    onSubmit: () => void;
    onCancel: () => void;
    onAttachment: () => void;
    onPasteImages: (files: File[]) => void;
    attachments: CreativeAsset[];
    referenceAssets: CreativeAsset[];
    selectedAssetIds: string[];
    skills: SkillOption[];
    skillsLoading: boolean;
    selectedSkill?: SkillOption;
    models: CreativeModelOption[];
    selectedModels: CreativeModelOption[];
    smartPlanning: boolean;
    generationPreferences: CreativeGenerationPreferences;
    uploading: boolean;
    onRemoveAttachment: (id: string) => void;
    onReferenceAsset: (id: string) => void;
    onSelectSkill: (skill: SkillOption) => void;
    onRemoveSkill: () => void;
    onToggleModel: (model: CreativeModelOption) => void;
    onClearModels: () => void;
    onToggleSmartPlanning: () => void;
    onChangeGenerationPreference: (capability: CreativeModelOption["capability"], patch: Record<string, string | number | boolean>) => void;
    centered?: boolean;
    compact?: boolean;
    onExpand?: () => void;
}) {
    const [ready, setReady] = useState(false);
    const [skillPickerOpen, setSkillPickerOpen] = useState(false);
    const [mentionQuery, setMentionQuery] = useState<string | null>(null);
    const [skillCategory, setSkillCategory] = useState<SkillCategory>("all");
    const caretRef = useRef(0);
    const mentionHighlightRef = useRef<HTMLDivElement>(null);
    const { scrollRef: skillCategoryScrollRef, dragScrollProps: skillCategoryDragScrollProps } = useHorizontalMouseDragScroll<HTMLDivElement>();

    const skillCategories = skillCategoryOptions(skills);
    const visibleSkills = skills.filter((skill) => matchesSkillCategory(skill, skillCategory));
    const popoverPlacement = centered ? "bottomLeft" : "topLeft";
    const composerPopoverPlacement = useCreativeComposerPopoverPlacement(popoverPlacement);
    const referenceAliasAssets = useMemo(() => mergeCreativeAssetMentionSources(referenceAssets, attachments), [attachments, referenceAssets]);
    const mentionCandidates = useMemo(() => creativeAssetMentionCandidates(referenceAliasAssets, mentionQuery || ""), [mentionQuery, referenceAliasAssets]);
    const referenceAssetsById = useMemo(() => new Map(referenceAliasAssets.map((asset) => [asset.id, asset])), [referenceAliasAssets]);
    const referenceAliases = useMemo(() => creativeAssetReferenceAliases(referenceAliasAssets, selectedAssetIds), [referenceAliasAssets, selectedAssetIds]);
    const mentionSegments = useMemo(() => creativeAssetMentionSegments(value, referenceAliases), [referenceAliases, value]);
    const hasMentionReferences = mentionSegments.some((segment) => segment.referenced);
    const mediaAttachments = attachments.filter((asset) => asset.type === "image" && Boolean(asset.serverUrl || asset.remoteUrl));
    const inputMediaAttachments = mediaAttachments;
    const visibleAttachments = attachments;
    const otherAttachments = visibleAttachments.filter((asset) => !mediaAttachments.some((media) => media.id === asset.id));

    useEffect(() => setReady(true), []);

    useEffect(() => {
        if (!compact) return;
        setSkillPickerOpen(false);
        setMentionQuery(null);
    }, [compact]);

    const updateComposerValue = (next: string, cursor: number) => {
        caretRef.current = cursor;
        onChange(next);
        setMentionQuery(creativeAssetMentionAtCursor(next, cursor)?.query ?? null);
    };

    const updateMentionCursor = (next: string, cursor: number) => {
        caretRef.current = cursor;
        setMentionQuery(creativeAssetMentionAtCursor(next, cursor)?.query ?? null);
    };

    const focusComposerAt = (cursor: number) => {
        window.requestAnimationFrame(() => {
            const textarea = inputRef.current?.resizableTextArea?.textArea;
            inputRef.current?.focus();
            textarea?.setSelectionRange(cursor, cursor);
        });
    };

    const openAssetMention = () => {
        const textarea = inputRef.current?.resizableTextArea?.textArea;
        const currentValue = textarea?.value ?? value;
        const cursor = textarea?.selectionStart ?? currentValue.length;
        const next = `${currentValue.slice(0, cursor)}@${currentValue.slice(cursor)}`;
        updateComposerValue(next, cursor + 1);
        focusComposerAt(cursor + 1);
    };

    const selectMentionAsset = (asset: CreativeAsset) => {
        const nextAssetIds = selectedAssetIds.includes(asset.id) ? selectedAssetIds : [...selectedAssetIds, asset.id];
        const alias = creativeAssetReferenceAliases(referenceAliasAssets, nextAssetIds).get(asset.id);
        if (!alias) return;
        const currentValue = inputRef.current?.resizableTextArea?.textArea?.value ?? value;
        const result = replaceCreativeAssetMention(currentValue, caretRef.current, alias);
        onReferenceAsset(asset.id);
        updateComposerValue(result.value, result.cursor);
        setMentionQuery(null);
        focusComposerAt(result.cursor);
    };

    const composerInput = (compactMode: boolean) => (
        <Popover
            trigger={[]}
            placement={composerPopoverPlacement}
            autoAdjustOverflow={creativeComposerPopoverOverflow(composerPopoverPlacement)}
            arrow={false}
            open={mentionQuery !== null}
            onOpenChange={(open) => {
                if (!open) setMentionQuery(null);
            }}
            styles={{ container: { padding: 0, borderRadius: 16, overflow: "hidden" } }}
            content={<CreativeAssetMentionPicker assets={mentionCandidates} selectedAssetIds={selectedAssetIds} onSelect={selectMentionAsset} />}
        >
            <div className="relative min-w-0 flex-1">
                {hasMentionReferences ? <ComposerMentionPreview previewRef={mentionHighlightRef} segments={mentionSegments} assetsById={referenceAssetsById} /> : null}
                <Input.TextArea
                    ref={inputRef}
                    value={value}
                    maxLength={4000}
                    autoSize={compactMode ? { minRows: 1, maxRows: 1 } : { minRows: centered ? 4 : 2, maxRows: 8 }}
                    variant="borderless"
                    className={cn(
                        "creative-composer-input relative z-[1] min-w-0 !border-0 !bg-transparent !px-1 !py-1 !text-[15px] !leading-7 !shadow-none !outline-none sm:!px-2",
                        hasMentionReferences && "!text-transparent caret-[#20242a] dark:caret-[#f3f5f7]",
                    )}
                    placeholder={compactMode ? "描述图片需求" : "描述你想生成或修改的图片"}
                    onFocus={() => {
                        if (compactMode) onExpand?.();
                    }}
                    onBlur={(event) => {
                        const scrollTop = event.currentTarget.scrollTop;
                        window.requestAnimationFrame(() => {
                            if (mentionHighlightRef.current) mentionHighlightRef.current.style.transform = `translate3d(0, -${scrollTop}px, 0)`;
                        });
                    }}
                    onChange={(event) => updateComposerValue(event.target.value, event.target.selectionStart)}
                    onClick={(event) => updateMentionCursor(event.currentTarget.value, event.currentTarget.selectionStart)}
                    onScroll={(event) => {
                        if (mentionHighlightRef.current) mentionHighlightRef.current.style.transform = `translate3d(0, -${event.currentTarget.scrollTop}px, 0)`;
                    }}
                    onKeyUp={(event) => {
                        if (["ArrowUp", "ArrowDown", "Enter", "Escape"].includes(event.key)) return;
                        updateMentionCursor(event.currentTarget.value, event.currentTarget.selectionStart);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === "Backspace" || event.key === "Delete") {
                            const deletion = creativeAssetMentionDeletionAtKey(value, event.currentTarget.selectionStart, event.currentTarget.selectionEnd, event.key, referenceAliases);
                            if (deletion) {
                                event.preventDefault();
                                setMentionQuery(null);
                                onRemoveAttachment(deletion.assetId);
                                focusComposerAt(deletion.cursor);
                                return;
                            }
                        }
                        if (event.key === "Escape" && mentionQuery !== null) {
                            event.preventDefault();
                            setMentionQuery(null);
                        }
                    }}
                    onPaste={(event) => {
                        const files = clipboardImageFiles(event.clipboardData);
                        if (!files.length) return;
                        event.preventDefault();
                        onPasteImages(files);
                    }}
                    onPressEnter={(event) => {
                        if (mentionQuery !== null && mentionCandidates.length) {
                            event.preventDefault();
                            selectMentionAsset(mentionCandidates[0]);
                            return;
                        }
                        if (event.shiftKey) return;
                        event.preventDefault();
                        if (!busy) onSubmit();
                    }}
                />
            </div>
        </Popover>
    );

    return (
        <div className={cn("pointer-events-auto mx-auto w-full overflow-hidden", compact ? "max-w-[1036px] px-3 pb-3 sm:px-6 sm:pb-4" : centered ? "max-w-[1080px]" : "mb-3 max-w-[1120px] px-3 sm:mb-5 sm:px-6")}>
            <div
                data-ready={ready}
                data-compact={compact ? "true" : "false"}
                className={cn(
                    "creative-composer border border-[#e2e6ea] bg-white shadow-[0_10px_32px_rgba(32,36,42,0.06)] transition-[border-radius,padding,box-shadow] duration-200 dark:border-[#30363e] dark:bg-[#181b20] dark:shadow-black/24",
                    compact ? "h-[60px] min-h-[60px] max-h-[60px] rounded-[20px] p-2" : centered ? "rounded-[22px] p-3 sm:p-4" : "rounded-2xl p-2.5",
                )}
                onClick={compact ? onExpand : undefined}
            >
                {selectedSkill || otherAttachments.length ? (
                    <div className={cn("gap-2 overflow-hidden px-2 pb-1 pt-1", compact ? "hidden" : "flex")}>
                        {selectedSkill ? (
                            <span className="flex h-9 max-w-60 shrink-0 items-center gap-2 rounded-lg border border-[#d6dee8] bg-[#f1f4f8] px-2.5 text-xs font-medium text-[#344152] shadow-[0_2px_8px_rgba(38,49,65,0.07)] dark:border-[#3b4653] dark:bg-[#252b33] dark:text-[#edf1f5] dark:shadow-black/20">
                                <span className="grid size-5 shrink-0 place-items-center rounded-md bg-[#d3a44f]/16 text-[#95681d] dark:bg-[#e4bb70]/14 dark:text-[#e4bb70]">
                                    <Sparkles className="size-3.5" />
                                </span>
                                <span className="truncate">Skill · {selectedSkill.name}</span>
                                <button
                                    type="button"
                                    className="grid size-5 shrink-0 place-items-center rounded-md text-[#7c8795] transition hover:bg-[#dfe5ec] hover:text-[#263141] dark:text-[#aab3bf] dark:hover:bg-[#343c46] dark:hover:text-white"
                                    onClick={onRemoveSkill}
                                    aria-label={`移除 Skill ${selectedSkill.name}`}
                                    title="移除 Skill"
                                >
                                    <X className="size-3" />
                                </button>
                            </span>
                        ) : null}
                        {otherAttachments.map((asset) => {
                            const Icon = asset.type === "image" ? ImageIcon : asset.type === "video" ? FileVideo : FileAudio;
                            return (
                                <span key={asset.id} className="flex h-9 max-w-52 shrink-0 items-center gap-2 rounded-md border border-stone-200 bg-stone-50 px-2 text-xs text-stone-700 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-200">
                                    <Icon className="size-3.5 shrink-0" />
                                    <span className="truncate">{asset.title}</span>
                                    <button
                                        type="button"
                                        className="grid size-5 shrink-0 place-items-center rounded text-stone-400 hover:bg-stone-200 hover:text-stone-800 dark:hover:bg-stone-700 dark:hover:text-white"
                                        onClick={() => onRemoveAttachment(asset.id)}
                                        aria-label={`移除${asset.title}`}
                                    >
                                        <X className="size-3" />
                                    </button>
                                </span>
                            );
                        })}
                    </div>
                ) : null}
                <div data-testid="creative-composer-input-row" className={cn("flex min-w-0 items-center gap-2 sm:gap-3", compact ? "h-11 min-h-11 max-h-11" : centered ? "min-h-[112px] items-start" : "min-h-[64px] items-start")}>
                    <div className={cn("hide-scrollbar flex shrink-0 gap-1.5 overflow-x-auto", compact ? "max-w-[42%] items-center overflow-y-hidden pl-1" : "max-w-[46%] items-start px-1 pb-1 pt-1 sm:max-w-[320px]")}>
                        {inputMediaAttachments.map((asset) => {
                            return <ComposerMediaThumbnail key={asset.id} asset={asset} compact={compact} onRemove={onRemoveAttachment} />;
                        })}
                        <Tooltip title={mediaAttachments.length ? "继续添加参考图片" : "添加参考图片"}>
                            <Button
                                type="text"
                                className={cn(
                                    "mt-0.5 shrink-0 !border !border-[#e5e9ed] !bg-[#f5f7f8] !text-[#87919d] hover:!border-[#d4dae0] hover:!bg-[#eef1f3] hover:!text-[#38424e] dark:!border-[#343a42] dark:!bg-[#24282e] dark:!text-[#9ca6b2] dark:hover:!border-[#49515b] dark:hover:!bg-[#2c3239] dark:hover:!text-white",
                                    compact
                                        ? "!size-11 !min-w-11 !rounded-xl"
                                        : mediaAttachments.length
                                          ? "!size-10 !min-w-10 !rounded-lg sm:!size-12 sm:!min-w-12"
                                          : centered
                                            ? "!size-12 !min-w-12 !rounded-xl sm:!size-14 sm:!min-w-14"
                                            : "!size-11 !min-w-11 !rounded-xl",
                                )}
                                icon={<Plus className="size-5" />}
                                onClick={onAttachment}
                                loading={uploading}
                                aria-label={mediaAttachments.length ? "继续添加参考图片" : "添加参考图片"}
                            />
                        </Tooltip>
                    </div>
                    {composerInput(compact)}
                    {compact ? (
                        <div className="flex shrink-0 items-center gap-2">
                            <Tooltip title="引用当前对话资产">
                                <Button
                                    type="text"
                                    className="!size-11 !min-w-11 !rounded-xl !text-[#66717e] hover:!bg-[#f2f4f6] hover:!text-[#20242a] dark:!text-[#a3acb7] dark:hover:!bg-[#292f37] dark:hover:!text-white"
                                    icon={<AtSign className="size-4" />}
                                    onMouseDown={(event) => event.preventDefault()}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        openAssetMention();
                                    }}
                                    aria-label="引用当前对话资产"
                                />
                            </Tooltip>
                            <Tooltip title="优化提示词">
                                <Button
                                    type="text"
                                    className="!size-11 !min-w-11 !rounded-xl !text-[#66717e] hover:!bg-[#f2f4f6] hover:!text-[#20242a] disabled:!bg-transparent disabled:!text-[#b3bac4] dark:!text-[#a3acb7] dark:hover:!bg-[#292f37] dark:hover:!text-white"
                                    icon={<WandSparkles className="size-4" />}
                                    loading={optimizing}
                                    disabled={busy || !value.trim()}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        onOptimize();
                                    }}
                                    aria-label={optimizing ? "正在优化提示词" : "优化提示词"}
                                />
                            </Tooltip>
                            <Tooltip title={busy ? "停止生成" : "发送"}>
                                <Button
                                    type="primary"
                                    shape="circle"
                                    className="!size-11 !min-w-11 !border-0 !bg-[linear-gradient(135deg,#5968ff,#604dff)] !text-white !shadow-[0_6px_16px_rgba(89,104,255,0.22)] hover:!bg-[linear-gradient(135deg,#5261f3,#5846ee)] disabled:!bg-none disabled:!bg-[#e2e5e8] disabled:!text-[#aeb5bd] disabled:!shadow-none dark:disabled:!bg-[#30353c] dark:disabled:!text-[#68717d]"
                                    icon={busy ? <Square className="size-3.5 fill-current" /> : <ArrowUp className="size-4" />}
                                    disabled={!busy && !value.trim()}
                                    onClick={busy ? onCancel : onSubmit}
                                    aria-label={busy ? "停止生成" : "发送"}
                                />
                            </Tooltip>
                        </div>
                    ) : null}
                </div>
                <div className={cn("min-w-0 items-center gap-2 overflow-hidden px-0.5 pb-0.5 pt-2", compact ? "hidden" : "flex")}>
                    <div className="hide-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto sm:gap-2">
                        <CreativeGenerationControls
                            models={models}
                            selectedModels={selectedModels}
                            smartPlanning={smartPlanning}
                            generationPreferences={generationPreferences}
                            placement={composerPopoverPlacement}
                            onToggleModel={onToggleModel}
                            onClearModels={onClearModels}
                            onToggleSmartPlanning={onToggleSmartPlanning}
                            onChangeGenerationPreference={onChangeGenerationPreference}
                        />
                        <Tooltip title="引用当前对话资产">
                            <Button
                                type="text"
                                className={creativeComposerToolButtonClass(mentionQuery !== null)}
                                icon={<AtSign className="size-4" />}
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={openAssetMention}
                                aria-label="引用当前对话资产"
                            >
                                <span className="hidden text-xs font-medium sm:inline">引用</span>
                            </Button>
                        </Tooltip>
                        <Popover
                            trigger="click"
                            placement={composerPopoverPlacement}
                            autoAdjustOverflow={creativeComposerPopoverOverflow(composerPopoverPlacement)}
                            arrow={false}
                            open={skillPickerOpen}
                            onOpenChange={setSkillPickerOpen}
                            content={
                                <div className="w-[calc(100vw-56px)] max-w-[300px] py-1 sm:w-80 sm:max-w-none">
                                    <p className="px-2 pb-2 text-sm font-semibold text-[#20242a] dark:text-[#f3f5f7]">选择创作 Skill</p>
                                    {skillsLoading ? <p className="px-2 py-3 text-xs text-[#8b949f] dark:text-[#7f8996]">正在加载...</p> : null}
                                    {!skillsLoading && !skills.length ? <p className="px-2 py-3 text-xs text-[#8b949f] dark:text-[#7f8996]">暂无可用 Skill</p> : null}
                                    {skills.length ? (
                                        <div className="mb-2 grid grid-cols-[28px_minmax(0,1fr)_28px] items-center gap-1">
                                            <button
                                                type="button"
                                                className="grid size-7 place-items-center rounded-md text-[#7c8794] transition hover:bg-[#eef1f4] hover:text-[#20242a] disabled:cursor-default disabled:opacity-30 dark:text-[#929ca8] dark:hover:bg-[#292f37] dark:hover:text-white"
                                                onClick={() => skillCategoryScrollRef.current?.scrollBy({ left: -180, behavior: "smooth" })}
                                                aria-label="向左查看更多 Skill 分类"
                                            >
                                                <ChevronLeft className="size-4" />
                                            </button>
                                            <div
                                                ref={skillCategoryScrollRef}
                                                className="hide-scrollbar flex min-w-0 cursor-grab snap-x gap-1.5 overflow-x-auto overscroll-x-contain px-0.5 [touch-action:pan-x] active:cursor-grabbing"
                                                onWheel={scrollHorizontalCategories}
                                                {...skillCategoryDragScrollProps}
                                                role="tablist"
                                                aria-label="Skill 分类，可左右滑动查看更多"
                                            >
                                                {skillCategories.map((category) => (
                                                    <button
                                                        key={category.id}
                                                        type="button"
                                                        role="tab"
                                                        aria-selected={skillCategory === category.id}
                                                        className={cn(
                                                            "h-8 min-w-[72px] shrink-0 snap-start whitespace-nowrap rounded-lg border px-3 text-xs font-medium transition",
                                                            skillCategory === category.id
                                                                ? "border-[#c9d7e2] bg-[#edf3f7] text-[#315d78] dark:border-[#466175] dark:bg-[#273742] dark:text-[#a8c8dc]"
                                                                : "border-[#e0e4e8] bg-white text-[#66717e] hover:border-[#cbd2d9] hover:bg-[#f5f7f8] hover:text-[#20242a] dark:border-[#343a42] dark:bg-[#1d2127] dark:text-[#a3acb7] dark:hover:border-[#49515b] dark:hover:bg-[#292f37] dark:hover:text-white",
                                                        )}
                                                        onClick={() => setSkillCategory(category.id)}
                                                    >
                                                        {category.label} · {category.count}
                                                    </button>
                                                ))}
                                            </div>
                                            <button
                                                type="button"
                                                className="grid size-7 place-items-center rounded-md text-[#7c8794] transition hover:bg-[#eef1f4] hover:text-[#20242a] dark:text-[#929ca8] dark:hover:bg-[#292f37] dark:hover:text-white"
                                                onClick={() => skillCategoryScrollRef.current?.scrollBy({ left: 180, behavior: "smooth" })}
                                                aria-label="向右查看更多 Skill 分类"
                                            >
                                                <ChevronRight className="size-4" />
                                            </button>
                                        </div>
                                    ) : null}
                                    <div className="relative">
                                        <div className="hide-scrollbar max-h-[142px] space-y-1 overflow-y-auto overscroll-contain [scrollbar-width:none] sm:max-h-[154px] [&::-webkit-scrollbar]:hidden">
                                            {!skillsLoading && skills.length && !visibleSkills.length ? <p className="px-2 py-5 text-center text-xs text-[#8b949f] dark:text-[#7f8996]">当前分类暂无可用 Skill</p> : null}
                                            {visibleSkills.map((skill) => {
                                                const selected = selectedSkill?.id === skill.id;
                                                const visual = skillOptionVisual(skill);
                                                const Icon = visual.icon;
                                                return (
                                                    <button
                                                        key={skill.id}
                                                        type="button"
                                                        className={cn(
                                                            "flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition",
                                                            selected ? "bg-[#eef1f4] text-[#20242a] dark:bg-[#292f37] dark:text-white" : "text-[#4d5662] hover:bg-[#f4f6f8] dark:text-[#c2c9d1] dark:hover:bg-[#242930]",
                                                        )}
                                                        onClick={() => {
                                                            onSelectSkill(skill);
                                                            setSkillPickerOpen(false);
                                                        }}
                                                    >
                                                        <span className={cn("mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg", visual.surfaceClass)}>
                                                            <Icon className={cn("size-3.5", visual.iconClass)} />
                                                        </span>
                                                        <span className="min-w-0 flex-1">
                                                            <span className="block truncate text-xs font-medium">{skill.name}</span>
                                                            <span className="mt-0.5 line-clamp-2 block text-[11px] leading-4 text-[#8b949f] dark:text-[#7f8996]">{skill.description}</span>
                                                        </span>
                                                        {selected ? <Check className="mt-0.5 size-4 shrink-0" /> : null}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>
                                </div>
                            }
                        >
                            <Button type="text" className={creativeComposerToolButtonClass(skillPickerOpen)} icon={<Boxes className="size-4" />} aria-label="选择创作 Skill" aria-haspopup="menu" aria-expanded={skillPickerOpen}>
                                <span className="hidden text-xs font-medium sm:inline">使用 Skill</span>
                            </Button>
                        </Popover>
                        <Tooltip title="优化提示词">
                            <Button
                                type="text"
                                className={creativeComposerToolButtonClass(false)}
                                icon={<WandSparkles className="size-4" />}
                                loading={optimizing}
                                disabled={busy || !value.trim()}
                                onClick={onOptimize}
                                aria-label={optimizing ? "正在优化提示词" : "优化提示词"}
                            >
                                <span className="hidden text-xs font-medium sm:inline">优化</span>
                            </Button>
                        </Tooltip>
                    </div>
                    <Tooltip title={busy ? "停止生成" : "发送"}>
                        <Button
                            type="primary"
                            shape="circle"
                            className="shrink-0 !size-11 !min-w-11 !border-0 !bg-[#20242a] !text-white shadow-none hover:!bg-[#343b44] disabled:!bg-[#e2e5e8] disabled:!text-[#aeb5bd] dark:!bg-[#f1f3f5] dark:!text-[#20242a] dark:hover:!bg-white dark:disabled:!bg-[#30353c] dark:disabled:!text-[#68717d]"
                            icon={busy ? <Square className="size-3.5 fill-current" /> : <ArrowUp className="size-4" />}
                            disabled={!busy && !value.trim()}
                            onClick={busy ? onCancel : onSubmit}
                            aria-label={busy ? "停止生成" : "发送"}
                        />
                    </Tooltip>
                </div>
            </div>
        </div>
    );
}

function ComposerMentionPreview({ segments, assetsById, previewRef }: { segments: CreativeAssetMentionSegment[]; assetsById: ReadonlyMap<string, CreativeAsset>; previewRef: RefObject<HTMLDivElement | null> }) {
    return (
        <div
            ref={previewRef}
            data-testid="creative-composer-mention-preview"
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-0 overflow-hidden whitespace-pre-wrap break-words px-1 py-1 text-[15px] leading-7 tracking-normal text-[#2f3742] [font-family:inherit] sm:px-2 dark:text-[#e8ecf1]"
        >
            {segments.map((segment, index) => {
                const asset = segment.assetId ? assetsById.get(segment.assetId) : undefined;
                if (!segment.referenced || !asset) return <span key={`${index}-${segment.text}`}>{segment.text}</span>;
                const coverUrl = asset.type === "video" && typeof asset.metadata.coverUrl === "string" ? asset.metadata.coverUrl : undefined;
                const previewUrl = asset.type === "image" ? asset.serverUrl || asset.remoteUrl : coverUrl;
                const Icon = asset.type === "video" ? FileVideo : asset.type === "audio" ? FileAudio : asset.type === "image" ? ImageIcon : Sparkles;
                return (
                    <span key={`${asset.id}-${index}`} data-testid="creative-composer-reference-chip" data-asset-id={asset.id} title={asset.title} className="relative inline-block align-baseline font-normal text-transparent">
                        <span data-mention-token-width className="whitespace-pre">
                            {segment.text}
                        </span>
                        <span className="absolute inset-0 inline-flex min-w-0 items-center gap-0.5 overflow-hidden text-[#536273] dark:text-[#c8d0d9]">
                            {previewUrl ? <img src={imagePreviewUrl(previewUrl, 96)} alt="" className="size-4 shrink-0 rounded object-cover shadow-[0_1px_2px_rgba(32,36,42,0.16)]" /> : <Icon className="size-3.5 shrink-0" />}
                            <span data-mention-label className="min-w-0 truncate text-[13px] font-medium">
                                {segment.text.slice(1)}
                            </span>
                        </span>
                    </span>
                );
            })}
        </div>
    );
}

function ComposerMediaThumbnail({ asset, compact = false, onRemove }: { asset: CreativeAsset; compact?: boolean; onRemove: (id: string) => void }) {
    const previewUrl = asset.serverUrl || asset.remoteUrl || "";
    return (
        <div
            className={cn("relative shrink-0 border border-[#dfe4e8] bg-[#f4f6f8] shadow-[0_2px_8px_rgba(38,49,65,0.08)] dark:border-[#3b434d] dark:bg-[#242930] dark:shadow-black/20", compact ? "size-11 rounded-lg" : "size-12 rounded-lg")}
            aria-label={`已上传${asset.type === "image" ? "图片" : "视频"} ${asset.title}`}
            title={asset.title}
        >
            <div className="size-full overflow-hidden rounded-[7px]">
                {asset.type === "image" ? (
                    <img src={imagePreviewUrl(previewUrl, 320)} alt={asset.title} className="size-full object-cover" />
                ) : (
                    <video src={previewUrl} muted playsInline preload="metadata" aria-label={asset.title} className="size-full object-cover" />
                )}
            </div>
            <button
                type="button"
                className="group/remove absolute -right-1.5 -top-1.5 z-10 grid size-7 place-items-center rounded-full !border-0 !bg-transparent !p-0 !text-white shadow-none transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#28738e] focus-visible:ring-offset-1"
                onClick={(event) => {
                    event.stopPropagation();
                    onRemove(asset.id);
                }}
                aria-label={`移除${asset.title}`}
                title="删除素材"
            >
                <span
                    data-delete-indicator
                    aria-hidden="true"
                    className="grid size-[22px] place-items-center rounded-full border border-white/95 bg-[#66727f]/95 text-white shadow-[0_2px_7px_rgba(32,36,42,0.3)] transition-colors group-hover/remove:bg-[#bd5b68] group-focus-within/remove:bg-[#bd5b68] dark:bg-[#7d8995]/95 dark:group-hover/remove:bg-[#cf6873] dark:group-focus-within/remove:bg-[#cf6873]"
                >
                    <X className="size-3.5 stroke-[2.75]" />
                </span>
            </button>
        </div>
    );
}

function scrollHorizontalCategories(event: WheelEvent<HTMLDivElement>) {
    if (event.currentTarget.scrollWidth <= event.currentTarget.clientWidth || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
    event.preventDefault();
    event.currentTarget.scrollLeft += event.deltaY;
}

function useHorizontalMouseDragScroll<T extends HTMLElement>() {
    const scrollRef = useRef<T>(null);
    const dragRef = useRef({ pointerId: -1, startX: 0, startScrollLeft: 0, moved: false });
    const suppressClickRef = useRef(false);

    const onPointerDown: PointerEventHandler<T> = (event) => {
        if (event.pointerType !== "mouse" || event.button !== 0) return;
        dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startScrollLeft: event.currentTarget.scrollLeft, moved: false };
    };

    const onPointerMove: PointerEventHandler<T> = (event) => {
        const drag = dragRef.current;
        if (drag.pointerId !== event.pointerId) return;
        const distance = event.clientX - drag.startX;
        if (!drag.moved && Math.abs(distance) < 4) return;
        if (!drag.moved) {
            drag.moved = true;
            event.currentTarget.setPointerCapture(event.pointerId);
        }
        event.preventDefault();
        event.currentTarget.scrollLeft = drag.startScrollLeft - distance;
    };

    const finishDrag: PointerEventHandler<T> = (event) => {
        const drag = dragRef.current;
        if (drag.pointerId !== event.pointerId) return;
        if (drag.moved) {
            suppressClickRef.current = true;
            window.setTimeout(() => {
                suppressClickRef.current = false;
            }, 0);
        }
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        dragRef.current.pointerId = -1;
    };

    const onClickCapture: MouseEventHandler<T> = (event) => {
        if (!suppressClickRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        suppressClickRef.current = false;
    };

    return {
        scrollRef,
        dragScrollProps: { onPointerDown, onPointerMove, onPointerUp: finishDrag, onPointerCancel: finishDrag, onClickCapture },
    };
}

function skillCategoryOptions(skills: SkillOption[]) {
    const categories: Array<{ id: SkillCategory; label: string }> = [
        { id: "all", label: "全部" },
        { id: "image", label: "图片" },
        { id: "video", label: "视频" },
        { id: "canvas", label: "画布" },
        { id: "drama", label: "短剧" },
        { id: "edit", label: "编辑" },
    ];
    return categories.map((category) => ({ ...category, count: skills.filter((skill) => matchesSkillCategory(skill, category.id)).length })).filter((category) => category.id === "all" || category.count > 0);
}

function matchesSkillCategory(skill: SkillOption, category: SkillCategory) {
    if (category === "all") return true;
    if (category === "edit") return skill.action === "edit";
    return skill.workspaces?.includes(category) === true;
}

function skillOptionVisual(skill: SkillOption) {
    if (skill.action === "edit") return { icon: Sparkles, surfaceClass: "bg-violet-50 dark:bg-violet-400/10", iconClass: "text-violet-600 dark:text-violet-300" };
    if (skill.workspaces?.includes("video")) return { icon: FileVideo, surfaceClass: "bg-emerald-50 dark:bg-emerald-400/10", iconClass: "text-emerald-600 dark:text-emerald-300" };
    if (skill.workspaces?.includes("image")) return { icon: ImageIcon, surfaceClass: "bg-sky-50 dark:bg-sky-400/10", iconClass: "text-sky-600 dark:text-sky-300" };
    return { icon: Boxes, surfaceClass: "bg-slate-100 dark:bg-slate-400/10", iconClass: "text-slate-600 dark:text-slate-300" };
}
