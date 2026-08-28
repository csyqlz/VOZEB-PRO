"use client";

import { useRef, useState } from "react";
import { App, Button } from "antd";
import { saveAs } from "file-saver";
import { DatabaseBackup, Download, FileJson2, HardDrive, ShieldCheck, Upload } from "lucide-react";

import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import { ADMIN_BACKUP_MAX_BYTES, downloadAdminBackup, importAdminBackup } from "@/services/api/admin-backup";

const sectionLabels: Record<string, string> = {
    auth: "账号与系统业务设置",
    prompts: "公共提示词",
    generationLogs: "生成记录",
};

export function AdminDataBackup() {
    const { message, modal } = App.useApp();
    const inputRef = useRef<HTMLInputElement>(null);
    const [exporting, setExporting] = useState(false);
    const [importing, setImporting] = useState(false);
    const [lastImported, setLastImported] = useState<string[]>([]);

    const exportBackup = async () => {
        setExporting(true);
        try {
            const backup = await downloadAdminBackup();
            saveAs(backup.blob, backup.fileName);
            message.success("业务数据备份已导出");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "导出备份失败");
        } finally {
            setExporting(false);
        }
    };

    const selectBackup = (file?: File) => {
        if (inputRef.current) inputRef.current.value = "";
        if (!file) return;
        if (!file.name.toLowerCase().endsWith(".json")) {
            message.error("请选择 JSON 备份文件");
            return;
        }
        if (file.size > ADMIN_BACKUP_MAX_BYTES) {
            message.error("备份文件不能超过 30MB");
            return;
        }
        modal.confirm({
            title: "恢复业务数据？",
            content: `将从“${file.name}”恢复可识别的数据，并在服务器创建恢复前安全备份。当前敏感凭据不会被上传文件覆盖。`,
            okText: "确认恢复",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: async () => {
                setImporting(true);
                try {
                    const result = await importAdminBackup(file);
                    setLastImported(result.imported);
                    message.success("业务数据已恢复，请刷新后台确认最新状态");
                } catch (error) {
                    message.error(error instanceof Error ? error.message : "导入备份失败");
                    throw error;
                } finally {
                    setImporting(false);
                }
            },
        });
    };

    return (
        <>
            <Panel variant="page">
                <PanelHeader
                    title="数据备份"
                    description="导出和恢复脱敏业务数据；文件模式与 PostgreSQL 使用同一备份格式。"
                    actions={
                        <Button type="primary" icon={<Download className="size-4" />} loading={exporting} onClick={() => void exportBackup()}>
                            导出备份
                        </Button>
                    }
                />
                <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
                    <section className="grid gap-4 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                        <div className="flex min-w-0 gap-3">
                            <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
                                <FileJson2 className="size-5" />
                            </span>
                            <div className="min-w-0">
                                <h3 className="text-sm font-semibold text-zinc-950 dark:text-zinc-100">跨 Provider 业务备份</h3>
                                <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">包含账号权益与非敏感系统设置、公共提示词和生成记录。导出文件不包含登录凭据、渠道密钥、支付密钥或 OSS 凭据。</p>
                            </div>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                            <ShieldCheck className="size-4 text-emerald-600 dark:text-emerald-400" />
                            脱敏导出
                        </div>
                    </section>

                    <section className="grid gap-4 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                        <div className="flex min-w-0 gap-3">
                            <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
                                <DatabaseBackup className="size-5" />
                            </span>
                            <div className="min-w-0">
                                <h3 className="text-sm font-semibold text-zinc-950 dark:text-zinc-100">恢复业务数据</h3>
                                <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">导入前自动保留当前业务数据的安全副本。恢复不会替换当前服务器保存的敏感凭据，也不会修改媒体文件位置。</p>
                                {lastImported.length ? <p className="mt-2 text-xs font-medium text-emerald-700 dark:text-emerald-300">最近恢复：{lastImported.map((key) => sectionLabels[key] || key).join("、")}</p> : null}
                            </div>
                        </div>
                        <Button icon={<Upload className="size-4" />} loading={importing} onClick={() => inputRef.current?.click()}>
                            导入备份
                        </Button>
                        <input ref={inputRef} className="hidden" type="file" accept="application/json,.json" onChange={(event) => selectBackup(event.target.files?.[0])} />
                    </section>

                    <section className="grid gap-4 bg-zinc-50/70 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center dark:bg-zinc-900/35">
                        <div className="flex min-w-0 gap-3">
                            <HardDrive className="mt-0.5 size-5 shrink-0 text-zinc-500 dark:text-zinc-400" />
                            <div className="min-w-0">
                                <h3 className="text-sm font-semibold text-zinc-950 dark:text-zinc-100">完整数据库与媒体备份</h3>
                                <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">PostgreSQL 整库、支付流水、媒体原文件和对象存储应继续使用当前部署环境的数据库、服务器或云存储备份能力。</p>
                            </div>
                        </div>
                        <span className="text-xs text-zinc-500 dark:text-zinc-400">宝塔 / Docker / 云数据库分别管理</span>
                    </section>
                </div>
            </Panel>
        </>
    );
}
