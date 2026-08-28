"use client";

import { App, Button, Input, Modal, Segmented, Select } from "antd";
import { ImagePlus, Link2 } from "lucide-react";
import { nanoid } from "nanoid";
import { useState } from "react";

import { AgentMediaPreview } from "@/components/agent/agent-media-preview";
import type { CreativeAsset } from "@/lib/creative-runtime-contract";
import type { DramaAssetReference, DramaEpisode, DramaProject } from "@/lib/drama-project-contract";
import { useDramaStore } from "../stores/use-drama-store";

type VisualAssetKind = "characters" | "scenes" | "props" | "clues";

const visualAssetKinds: Array<{ value: VisualAssetKind; label: string; placeholder: string }> = [
    { value: "characters", label: "角色", placeholder: "女主角" },
    { value: "scenes", label: "场景", placeholder: "医院走廊" },
    { value: "props", label: "道具", placeholder: "旧手机" },
    { value: "clues", label: "线索", placeholder: "染血的手帕" },
];

function emptyAssetProfile() {
    return { visualIdentity: "", styling: "", colorPalette: "", consistencyRules: "" };
}

export function DramaAgentAssets({ assets, project, episode }: { assets: CreativeAsset[]; project: DramaProject; episode: DramaEpisode }) {
    const { message } = App.useApp();
    const updateShot = useDramaStore((state) => state.updateShot);
    const updateAsset = useDramaStore((state) => state.updateAsset);
    const addCharacter = useDramaStore((state) => state.addCharacter);
    const addScene = useDramaStore((state) => state.addScene);
    const addProp = useDramaStore((state) => state.addProp);
    const addClue = useDramaStore((state) => state.addClue);
    const [referenceAsset, setReferenceAsset] = useState<CreativeAsset>();
    const [visualAsset, setVisualAsset] = useState<CreativeAsset>();
    const [shotId, setShotId] = useState(episode.shots[0]?.id || "");
    const [frameKind, setFrameKind] = useState<"start" | "end">("start");
    const [visualKind, setVisualKind] = useState<VisualAssetKind>("characters");
    const [visualAssetId, setVisualAssetId] = useState("");
    const [newVisualAssetName, setNewVisualAssetName] = useState("");
    const applyReference = () => {
        const shot = episode.shots.find((item) => item.id === shotId);
        const url = referenceAsset?.serverUrl || referenceAsset?.remoteUrl || "";
        if (!shot || !url) return;
        updateShot(project.id, episode.id, shot.id, {
            ...(frameKind === "start"
                ? {
                      storyboardStatus: "success" as const,
                      storyboardTaskId: undefined,
                      storyboardError: undefined,
                      storyboardImageUrl: url,
                      storyboardImageStorageKey: referenceAsset?.storageKey,
                      storyboardImageWidth: referenceAsset?.width,
                      storyboardImageHeight: referenceAsset?.height,
                  }
                : {
                      storyboardFrameMode: "first_last" as const,
                      storyboardEndStatus: "success" as const,
                      storyboardEndTaskId: undefined,
                      storyboardEndError: undefined,
                      storyboardEndImageUrl: url,
                      storyboardEndImageStorageKey: referenceAsset?.storageKey,
                      storyboardEndImageWidth: referenceAsset?.width,
                      storyboardEndImageHeight: referenceAsset?.height,
                  }),
        });
        setReferenceAsset(undefined);
        message.success(`已引用为${shot.title}的${frameKind === "start" ? "起始帧" : "结束帧"}`);
    };

    const applyVisualAsset = () => {
        const sourceAsset = visualAsset;
        const url = sourceAsset?.serverUrl || sourceAsset?.remoteUrl || "";
        if (!sourceAsset || !url) return;
        const reference: DramaAssetReference = {
            id: `reference-${nanoid()}`,
            url,
            storageKey: sourceAsset.storageKey,
            source: "generated",
            label: sourceAsset.title || "Agent 生成图",
            width: sourceAsset.width,
            height: sourceAsset.height,
            createdAt: new Date().toISOString(),
        };
        const selected = project[visualKind].find((item) => item.id === visualAssetId);
        const name = newVisualAssetName.trim() || sourceAsset.title.trim() || `${visualKind === "characters" ? "角色" : visualKind === "scenes" ? "场景" : visualKind === "props" ? "道具" : "线索"}参考`;
        if (selected) {
            const references = [...(selected.references || []), reference];
            updateAsset(project.id, visualKind, selected.id, { references, primaryReferenceId: reference.id, referenceImageUrl: reference.url, referenceStorageKey: reference.storageKey });
            message.success(`已加入${selected.name}的视觉参考图`);
        } else if (visualKind === "characters") {
            addCharacter(project.id, { name, description: "来自项目 Agent 的视觉参考", profile: emptyAssetProfile(), references: [reference], primaryReferenceId: reference.id, referenceImageUrl: reference.url, referenceStorageKey: reference.storageKey });
            message.success(`已创建角色“${name}”并加入参考图`);
        } else if (visualKind === "scenes") {
            addScene(project.id, { name, description: "来自项目 Agent 的视觉参考", profile: emptyAssetProfile(), references: [reference], primaryReferenceId: reference.id, referenceImageUrl: reference.url, referenceStorageKey: reference.storageKey });
            message.success(`已创建场景“${name}”并加入参考图`);
        } else if (visualKind === "props") {
            addProp(project.id, { name, description: "来自项目 Agent 的视觉参考", profile: emptyAssetProfile(), references: [reference], primaryReferenceId: reference.id, referenceImageUrl: reference.url, referenceStorageKey: reference.storageKey });
            message.success(`已创建道具“${name}”并加入参考图`);
        } else {
            addClue(project.id, {
                name,
                description: "来自项目 Agent 的视觉参考",
                payoff: "",
                profile: emptyAssetProfile(),
                references: [reference],
                primaryReferenceId: reference.id,
                referenceImageUrl: reference.url,
                referenceStorageKey: reference.storageKey,
            });
            message.success(`已创建线索“${name}”并加入参考图`);
        }
        setVisualAsset(undefined);
        setVisualAssetId("");
        setNewVisualAssetName("");
    };

    return (
        <>
            <div className="mt-3 grid gap-2">
                {assets
                    .filter((asset) => asset.type !== "text")
                    .map((asset) => {
                        const url = asset.serverUrl || asset.remoteUrl || "";
                        if (!url) return null;
                        return (
                            <div key={asset.id} className="min-w-0">
                                <AgentMediaPreview type={asset.type} url={url} title={asset.title || "Agent 生成媒体"} className={asset.type === "image" ? "max-h-64 rounded-md" : asset.type === "video" ? "aspect-video rounded-md" : undefined} />
                                {asset.type === "image" ? (
                                    <div className="mt-2 flex min-w-0 items-center rounded-lg border border-border/70 bg-muted/30 p-1">
                                        <Button
                                            type="text"
                                            className="!h-7 !min-w-0 !flex-1 !justify-center !px-2 !text-xs !text-foreground hover:!bg-background/80"
                                            size="small"
                                            icon={<Link2 className="size-3.5" />}
                                            disabled={!episode.shots.length}
                                            onClick={() => setReferenceAsset(asset)}
                                        >
                                            引用到分镜
                                        </Button>
                                        <span className="h-4 w-px shrink-0 bg-border" />
                                        <Button
                                            type="text"
                                            className="!h-7 !min-w-0 !flex-1 !justify-center !px-2 !text-xs !text-foreground hover:!bg-background/80"
                                            size="small"
                                            icon={<ImagePlus className="size-3.5" />}
                                            onClick={() => setVisualAsset(asset)}
                                        >
                                            加入视觉资产
                                        </Button>
                                    </div>
                                ) : null}
                            </div>
                        );
                    })}
            </div>
            <Modal title="引用图片到分镜" open={Boolean(referenceAsset)} width={420} centered destroyOnHidden okText="确认引用" cancelText="取消" okButtonProps={{ disabled: !shotId }} onCancel={() => setReferenceAsset(undefined)} onOk={applyReference}>
                <div className="grid gap-4 pt-2">
                    <label className="grid gap-1.5 text-sm">
                        <span className="font-medium">目标镜头</span>
                        <Select
                            value={shotId || undefined}
                            placeholder="选择要引用的镜头"
                            optionFilterProp="label"
                            options={episode.shots.map((shot) => ({ value: shot.id, label: `${String(shot.order).padStart(2, "0")} · ${shot.title}` }))}
                            onChange={setShotId}
                        />
                    </label>
                    <label className="grid gap-1.5 text-sm">
                        <span className="font-medium">引用位置</span>
                        <Segmented
                            block
                            value={frameKind}
                            options={[
                                { label: "起始帧", value: "start" },
                                { label: "结束帧", value: "end" },
                            ]}
                            onChange={(value) => setFrameKind(value as "start" | "end")}
                        />
                    </label>
                    <p className="text-xs leading-5 text-muted-foreground">引用后会替换该位置现有图片；如镜头已有视频，需要重新生成以应用新画面。</p>
                </div>
            </Modal>
            <Modal
                title="加入视觉资产"
                open={Boolean(visualAsset)}
                width={460}
                centered
                destroyOnHidden
                okText="保存到视觉资产"
                cancelText="取消"
                okButtonProps={{ disabled: !visualAsset || (!visualAssetId && !newVisualAssetName.trim()) }}
                onCancel={() => {
                    setVisualAsset(undefined);
                    setVisualAssetId("");
                    setNewVisualAssetName("");
                }}
                onOk={applyVisualAsset}
            >
                <div className="grid gap-4 pt-2">
                    <p className="text-sm leading-6 text-muted-foreground">这张 Agent 图片会直接保存为角色、场景、道具或线索的参考图，不需要下载后重新上传。</p>
                    <label className="grid gap-1.5 text-sm">
                        <span className="font-medium">资产类型</span>
                        <Segmented
                            block
                            value={visualKind}
                            options={visualAssetKinds.map((item) => ({ label: item.label, value: item.value }))}
                            onChange={(value) => {
                                setVisualKind(value as VisualAssetKind);
                                setVisualAssetId("");
                            }}
                        />
                    </label>
                    <label className="grid gap-1.5 text-sm">
                        <span className="font-medium">加入已有资产</span>
                        <Select
                            allowClear
                            value={visualAssetId || undefined}
                            placeholder="选择已有角色、场景、道具或线索"
                            options={project[visualKind].map((item) => ({ value: item.id, label: item.name }))}
                            onChange={(value) => {
                                setVisualAssetId(value || "");
                                if (value) setNewVisualAssetName("");
                            }}
                        />
                    </label>
                    <label className="grid gap-1.5 text-sm">
                        <span className="font-medium">或新建资产名称</span>
                        <Input
                            value={newVisualAssetName}
                            onChange={(event) => {
                                setNewVisualAssetName(event.target.value);
                                if (event.target.value.trim()) setVisualAssetId("");
                            }}
                            placeholder={`例如：${visualAssetKinds.find((item) => item.value === visualKind)?.placeholder || "关键资产"}`}
                        />
                    </label>
                </div>
            </Modal>
        </>
    );
}
