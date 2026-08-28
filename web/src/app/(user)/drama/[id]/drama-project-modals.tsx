"use client";

import { Button, Empty, Input, Modal, Segmented, Spin, Tooltip } from "antd";
import { Save, Trash2 } from "lucide-react";

import { buildSubtitleCues, formatTimelineTime } from "../subtitle";
import type { DramaProjectVersion, DramaShot } from "../types";

export function DramaVersionModal({
    open,
    loading,
    deletingVersionId,
    versions,
    onClose,
    onSave,
    onRestore,
    onDelete,
}: {
    open: boolean;
    loading: boolean;
    deletingVersionId?: string;
    versions: DramaProjectVersion[];
    onClose: () => void;
    onSave: () => void;
    onRestore: (version: DramaProjectVersion) => void;
    onDelete: (version: DramaProjectVersion) => void;
}) {
    return (
        <Modal title="版本历史" open={open} onCancel={onClose} footer={<Button onClick={onClose}>关闭</Button>} width={640}>
            <div className="space-y-3 pt-3">
                <div className="flex flex-col items-stretch gap-2.5 border-b border-border pb-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                    <span>关键重生成前会自动保存当前项目快照。</span>
                    <Button icon={<Save className="size-4" />} onClick={onSave}>
                        保存当前版本
                    </Button>
                </div>
                {loading ? (
                    <div className="grid min-h-24 place-items-center sm:min-h-40">
                        <Spin />
                    </div>
                ) : versions.length ? (
                    versions.map((version) => (
                        <div key={version.id} className="flex flex-col items-stretch gap-3 rounded-lg border border-border bg-background p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:p-4">
                            <div className="min-w-0">
                                <div className="font-medium">版本 {version.version}</div>
                                <div className="mt-1 text-xs text-muted-foreground">
                                    {version.reason} · {new Date(version.createdAt).toLocaleString()}
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <Button className="!min-w-0 !flex-1 sm:!flex-none" disabled={deletingVersionId === version.id} onClick={() => onRestore(version)}>
                                    恢复
                                </Button>
                                <Tooltip title="删除版本">
                                    <Button
                                        danger
                                        type="text"
                                        shape="circle"
                                        className="!size-8 !min-w-8"
                                        aria-label={`删除版本 ${version.version}`}
                                        icon={<Trash2 className="size-4" />}
                                        loading={deletingVersionId === version.id}
                                        disabled={Boolean(deletingVersionId)}
                                        onClick={() => onDelete(version)}
                                    />
                                </Tooltip>
                            </div>
                        </div>
                    ))
                ) : (
                    <Empty className="!my-6 sm:!my-10" description="还没有版本快照" />
                )}
            </div>
        </Modal>
    );
}

export function DramaJianyingModal({
    open,
    path,
    version,
    exporting,
    onClose,
    onExport,
    onPathChange,
    onVersionChange,
}: {
    open: boolean;
    path: string;
    version: "5" | "6";
    exporting: boolean;
    onClose: () => void;
    onExport: () => void;
    onPathChange: (value: string) => void;
    onVersionChange: (value: "5" | "6") => void;
}) {
    return (
        <Modal title="导出剪映草稿" open={open} onCancel={onClose} onOk={onExport} okText="导出 ZIP" cancelText="取消" confirmLoading={exporting}>
            <div className="space-y-5 pt-3">
                <label className="block space-y-2">
                    <span className="text-sm font-medium">剪映草稿目录</span>
                    <Input value={path} onChange={(event) => onPathChange(event.target.value)} placeholder="C:\Users\你的用户名\AppData\Local\JianyingPro\User Data\Projects\com.lveditor.draft" />
                </label>
                <label className="block space-y-2">
                    <span className="text-sm font-medium">剪映版本</span>
                    <Segmented
                        block
                        value={version}
                        options={[
                            { label: "6.0+", value: "6" },
                            { label: "5.x", value: "5" },
                        ]}
                        onChange={(value) => onVersionChange(value as "5" | "6")}
                    />
                </label>
            </div>
        </Modal>
    );
}

export function DramaSubtitleModal({ open, shots, onClose }: { open: boolean; shots: DramaShot[]; onClose: () => void }) {
    return (
        <Modal title="字幕时间轴" open={open} footer={<Button onClick={onClose}>关闭</Button>} onCancel={onClose} width={720}>
            <div className="max-h-[60vh] space-y-3 overflow-y-auto pt-3">
                {buildSubtitleCues(shots).map((cue) => (
                    <div key={cue.index} className="grid gap-2 rounded-lg border border-border/80 bg-background/65 p-3 sm:grid-cols-[92px_minmax(0,1fr)] sm:gap-3 sm:rounded-2xl sm:p-4">
                        <div className="text-xs font-medium text-muted-foreground">
                            {formatTimelineTime(cue.startMs)}–{formatTimelineTime(cue.endMs)}
                        </div>
                        <div className="text-sm leading-6 text-foreground">{cue.text}</div>
                    </div>
                ))}
            </div>
        </Modal>
    );
}
