"use client";

import { App, Button, Checkbox, Form, Image, Input, Modal, Popconfirm, Select, Switch, Table, Tag, Tooltip } from "antd";
import type { TableColumnsType } from "antd";
import { Cloud, DatabaseBackup, Download, Eraser, Eye, File, FileAudio, Film, RefreshCw, Save, Search, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AdminMediaTypeTabs } from "@/components/admin/admin-media-type-tabs";
import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import { AdminAccountId, AdminUserSearchSelect } from "@/components/admin/admin-user-identity";
import { imagePreviewUrl } from "@/lib/media-image-url";
import { managedMediaTypeLabel, mediaSourceGroupOptions, mediaSourceLabel } from "@/lib/media-management-contract";
import type { ExternalStorageFile, ExternalStorageFilesPayload, ObjectStorageMigrationResult, ObjectStorageSettings, ObjectStorageSettingsUpdate } from "@/lib/object-storage-contract";
import { cleanupExternalStoragePreviews, deleteExternalStorageFiles, getExternalStorageFiles, getObjectStorageSettings, migrateLocalMedia, saveObjectStorageSettings, testObjectStorageSettings } from "@/services/api/object-storage";

const PAGE_SIZE = 30;

export function AdminExternalStorage() {
    const { message } = App.useApp();
    const [form] = Form.useForm<ObjectStorageSettingsUpdate>();
    const enabled = Form.useWatch("enabled", form);
    const [settings, setSettings] = useState<ObjectStorageSettings>();
    const [files, setFiles] = useState<ExternalStorageFilesPayload>();
    const [loadingSettings, setLoadingSettings] = useState(true);
    const [loadingFiles, setLoadingFiles] = useState(false);
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [syncResult, setSyncResult] = useState<ObjectStorageMigrationResult>();
    const [cleaningPreviews, setCleaningPreviews] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
    const [preview, setPreview] = useState<ExternalStorageFile>();
    const [prefix, setPrefix] = useState("");
    const [prefixInput, setPrefixInput] = useState("");
    const [type, setType] = useState("");
    const [source, setSource] = useState("");
    const [ownerUserId, setOwnerUserId] = useState("");
    const [cursor, setCursor] = useState("");
    const [cursorHistory, setCursorHistory] = useState<string[]>([]);

    const loadFiles = useCallback(
        async (targetCursor: string, targetPrefix: string, targetType: string, targetSource: string, targetOwnerUserId: string) => {
            setLoadingFiles(true);
            try {
                setFiles(await getExternalStorageFiles({ prefix: targetPrefix, cursor: targetCursor, limit: PAGE_SIZE, type: targetType, source: targetSource, ownerUserId: targetOwnerUserId }));
                setSelectedKeys([]);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "外部存储文件加载失败");
            } finally {
                setLoadingFiles(false);
            }
        },
        [message],
    );

    useEffect(() => {
        let active = true;
        void getObjectStorageSettings()
            .then((value) => {
                if (!active) return;
                setSettings(value);
                form.setFieldsValue({
                    enabled: value.enabled,
                    endpoint: value.endpoint,
                    region: value.region,
                    bucket: value.bucket,
                    prefix: value.prefix,
                    forcePathStyle: value.forcePathStyle,
                    accessKeyId: "",
                    secretAccessKey: "",
                });
            })
            .catch((error) => message.error(error instanceof Error ? error.message : "外部存储配置加载失败"))
            .finally(() => active && setLoadingSettings(false));
        return () => {
            active = false;
        };
    }, [form, message]);

    useEffect(() => {
        if (settings?.bucket) void loadFiles(cursor, prefix, type, source, ownerUserId);
        else setFiles(undefined);
    }, [cursor, loadFiles, ownerUserId, prefix, settings?.bucket, settings?.updatedAt, source, type]);

    const save = async (values: ObjectStorageSettingsUpdate) => {
        setSaving(true);
        try {
            const next = await saveObjectStorageSettings(values);
            setSettings(next);
            form.setFieldsValue({ accessKeyId: "", secretAccessKey: "" });
            message.success("外部存储配置已保存");
            setCursor("");
            setCursorHistory([]);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "外部存储配置保存失败");
        } finally {
            setSaving(false);
        }
    };

    const testConnection = async () => {
        setTesting(true);
        try {
            await testObjectStorageSettings();
            message.success("外部存储列表、写入和删除权限正常");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "外部存储连接失败");
        } finally {
            setTesting(false);
        }
    };

    const migrate = async () => {
        setSyncing(true);
        const total: ObjectStorageMigrationResult = { migrated: 0, skipped: 0, failed: 0, remaining: 0, errors: [] };
        try {
            for (;;) {
                const result = await migrateLocalMedia(PAGE_SIZE);
                total.migrated += result.migrated;
                total.skipped = Math.max(total.skipped, result.skipped);
                total.failed += result.failed;
                total.remaining = result.remaining;
                total.errors.push(...result.errors);
                setSyncResult({ ...total, errors: [...total.errors] });
                if (!result.remaining || !result.migrated) break;
            }
            if (total.failed) message.warning(`已迁移 ${total.migrated} 个文件，${total.failed} 个失败并保留在本地`);
            else message.success(`已迁移 ${total.migrated} 个本地文件`);
            if (cursor) {
                setCursor("");
                setCursorHistory([]);
            } else {
                await loadFiles("", prefix, type, source, ownerUserId);
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : "本地媒体迁移失败");
        } finally {
            setSyncing(false);
        }
    };

    const remove = useCallback(
        async (keys: string[]) => {
            setDeleting(true);
            try {
                const result = await deleteExternalStorageFiles(keys);
                if (result.blocked.length) message.warning(`${result.blocked.length} 个对象仍被业务记录引用，已保留`);
                else message.success(`已删除 ${result.deleted} 个对象`);
                await loadFiles(cursor, prefix, type, source, ownerUserId);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "外部存储对象删除失败");
            } finally {
                setDeleting(false);
            }
        },
        [cursor, loadFiles, message, ownerUserId, prefix, source, type],
    );

    const cleanupPreviews = async () => {
        setCleaningPreviews(true);
        try {
            const result = await cleanupExternalStoragePreviews();
            if (result.deleted) message.success(`已清理 ${result.deleted} 个异常预览，释放 ${formatBytes(result.reclaimedBytes)}`);
            else message.success("未发现异常预览文件");
            await loadFiles(cursor, prefix, type, source, ownerUserId);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "异常预览文件清理失败");
        } finally {
            setCleaningPreviews(false);
        }
    };

    const columns = useMemo<TableColumnsType<ExternalStorageFile>>(
        () => [
            {
                title: "对象",
                render: (_, file) => (
                    <div className="flex min-w-0 items-center gap-3">
                        <MediaThumbnail file={file} onPreview={setPreview} />
                        <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100" title={file.originalName || file.name}>
                                {file.originalName || file.name}
                            </div>
                            <div className="mt-1 truncate text-xs text-zinc-500">
                                {managedMediaTypeLabel(file.type)} · {file.key}
                            </div>
                        </div>
                    </div>
                ),
            },
            { title: "大小", width: 110, render: (_, file) => formatBytes(file.bytes) },
            {
                title: "登记",
                width: 150,
                render: (_, file) => (
                    <div className="space-y-1 text-xs">
                        <Tag color={file.storageKey ? "green" : "default"}>{file.storageKey ? "业务媒体" : file.variant ? "预览变体" : "独立对象"}</Tag>
                        {file.referenceCount ? <div className="text-zinc-500">引用 {file.referenceCount}</div> : null}
                    </div>
                ),
            },
            {
                title: "用户 / 来源",
                width: 180,
                render: (_, file) => (
                    <div className="text-xs text-zinc-500">
                        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className="truncate text-zinc-800 dark:text-zinc-200">{file.ownerDisplayName || file.ownerUsername || (file.ownerUserId ? "用户信息不可用" : "未登记")}</span>
                            <AdminAccountId accountId={file.ownerAccountId} className="shrink-0" />
                        </div>
                        <div className="mt-1 truncate">{mediaSourceLabel(file.source)}</div>
                    </div>
                ),
            },
            { title: "更新时间", width: 180, render: (_, file) => formatTime(file.lastModified) },
            {
                title: "操作",
                width: 128,
                align: "right",
                render: (_, file) => (
                    <div className="flex justify-end gap-1">
                        <Button type="text" shape="circle" aria-label="预览对象" icon={<Eye className="size-4" />} onClick={() => setPreview(file)} />
                        <Button type="text" shape="circle" aria-label="下载对象" icon={<Download className="size-4" />} href={file.downloadUrl} target="_blank" />
                        <Popconfirm title="删除这个外部存储对象？" description="仍被业务记录引用时会自动保留。" okText="删除" cancelText="取消" onConfirm={() => void remove([file.key])}>
                            <Button danger type="text" shape="circle" aria-label="删除对象" icon={<Trash2 className="size-4" />} />
                        </Popconfirm>
                    </div>
                ),
            },
        ],
        [remove],
    );

    const applyPrefixFilter = (value: string) => {
        const next = value.trim();
        const unchanged = next === prefix && !cursor;
        setPrefix(next);
        setCursor("");
        setCursorHistory([]);
        if (unchanged) void loadFiles("", next, type, source, ownerUserId);
    };

    return (
        <div className="grid gap-4 sm:gap-6">
            <Panel>
                <PanelHeader
                    title="外部存储配置"
                    description="启用后新媒体直接写入 S3 兼容存储；关闭后新媒体恢复写入本机。"
                    actions={
                        <>
                            <Tooltip title="检测读写权限">
                                <Button aria-label="检测外部存储读写权限" className="!w-8 !px-0 sm:!w-auto sm:!px-3" icon={<ShieldCheck className="size-4" />} loading={testing} disabled={!settings?.bucket} onClick={() => void testConnection()}>
                                    <span className="hidden sm:inline">检测连接</span>
                                </Button>
                            </Tooltip>
                            <Tooltip title="保存配置">
                                <Button type="primary" aria-label="保存外部存储配置" className="!w-8 !px-0 sm:!w-auto sm:!px-3" icon={<Save className="size-4" />} loading={saving} onClick={() => form.submit()}>
                                    <span className="hidden sm:inline">保存</span>
                                </Button>
                            </Tooltip>
                        </>
                    }
                />
                <Form<ObjectStorageSettingsUpdate> form={form} layout="vertical" requiredMark={false} disabled={loadingSettings} onFinish={save}>
                    <div className="px-4 py-5 sm:px-5 sm:py-6">
                        <div className="max-w-[1080px]">
                            <div className="mb-5 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-2 border-b border-zinc-200 pb-4 dark:border-zinc-800">
                                <Cloud className={enabled ? "size-4 text-emerald-600 dark:text-emerald-400" : "size-4 text-zinc-400"} />
                                <span className="text-xs text-zinc-500 dark:text-zinc-400">写入位置</span>
                                <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{enabled ? "外部存储" : "本机存储"}</span>
                                <Form.Item name="enabled" valuePropName="checked" className="!mb-0">
                                    <Switch size="small" aria-label="切换外部存储" />
                                </Form.Item>
                                <span className="text-xs text-zinc-400 dark:text-zinc-500">仅影响新文件</span>
                            </div>

                            <div className="grid gap-x-4 md:grid-cols-2 xl:grid-cols-6">
                                <Form.Item label="Endpoint" name="endpoint" className="!mb-5 xl:col-span-2" extra="AWS S3 可留空；其他服务填写 S3 Endpoint。">
                                    <Input placeholder="https://s3.example.com" />
                                </Form.Item>
                                <Form.Item label="Region" name="region" className="!mb-5 xl:col-span-2" rules={[{ required: true, message: "请输入 Region" }]}>
                                    <Input placeholder="us-east-1 / auto" />
                                </Form.Item>
                                <Form.Item label="Bucket" name="bucket" className="!mb-5 xl:col-span-2" rules={[{ required: enabled, message: "请输入 Bucket" }]}>
                                    <Input placeholder="media-bucket" />
                                </Form.Item>
                                <Form.Item label="对象路径前缀" name="prefix" className="!mb-5 xl:col-span-3" rules={[{ required: true, message: "请输入路径前缀" }]}>
                                    <Input placeholder="vozeb-pro" />
                                </Form.Item>
                                <Form.Item label="Path-style 模式" name="forcePathStyle" valuePropName="checked" className="!mb-5 xl:col-span-3">
                                    <Switch size="small" aria-label="切换 Path-style 模式" />
                                </Form.Item>
                                <Form.Item label="Access Key" name="accessKeyId" className="!mb-0 xl:col-span-3" extra={settings?.hasAccessKeyId ? "已安全保存；留空不会修改。" : undefined}>
                                    <Input.Password autoComplete="new-password" placeholder={settings?.hasAccessKeyId ? "已配置" : "Access Key ID"} />
                                </Form.Item>
                                <Form.Item label="Secret Key" name="secretAccessKey" className="!mb-0 xl:col-span-3" extra={settings?.hasSecretAccessKey ? "已安全保存；留空不会修改。" : undefined}>
                                    <Input.Password autoComplete="new-password" placeholder={settings?.hasSecretAccessKey ? "已配置" : "Secret Access Key"} />
                                </Form.Item>
                            </div>
                        </div>
                    </div>
                </Form>
            </Panel>

            <Panel>
                <PanelHeader
                    title="外部存储文件"
                    description={files ? `${files.bucket} / ${files.prefix}` : "保存配置后可查看和管理对象。"}
                    actions={
                        <>
                            <Popconfirm title="把已有本地媒体迁移到外部存储？" description="每个文件上传并登记成功后才会删除本地源文件。" okText="开始迁移" cancelText="取消" onConfirm={() => void migrate()}>
                                <Tooltip title="迁移本地媒体">
                                    <Button aria-label="迁移本地媒体" className="!w-8 !px-0 sm:!w-auto sm:!px-3" icon={<DatabaseBackup className="size-4" />} loading={syncing} disabled={!settings?.enabled}>
                                        <span className="hidden sm:inline">迁移本地媒体</span>
                                    </Button>
                                </Tooltip>
                            </Popconfirm>
                            <Popconfirm title="清理历史异常预览？" description="只删除递归生成的嵌套 WebP；原文件和正常首层预览都会保留。" okText="开始清理" cancelText="取消" onConfirm={() => void cleanupPreviews()}>
                                <Tooltip title="清理异常预览">
                                    <Button aria-label="清理异常预览" className="!w-8 !px-0 sm:!w-auto sm:!px-3" icon={<Eraser className="size-4" />} loading={cleaningPreviews} disabled={!settings?.bucket || deleting || syncing}>
                                        <span className="hidden sm:inline">清理异常预览</span>
                                    </Button>
                                </Tooltip>
                            </Popconfirm>
                            <Tooltip title="刷新">
                                <Button
                                    aria-label="刷新外部存储文件"
                                    className="!w-8 !px-0 sm:!w-auto sm:!px-3"
                                    icon={<RefreshCw className="size-4" />}
                                    loading={loadingFiles}
                                    disabled={!settings?.bucket}
                                    onClick={() => void loadFiles(cursor, prefix, type, source, ownerUserId)}
                                >
                                    <span className="hidden sm:inline">刷新</span>
                                </Button>
                            </Tooltip>
                            <Popconfirm title={`删除选中的 ${selectedKeys.length} 个对象？`} description="仍被业务记录引用的对象会自动保留。" okText="批量删除" cancelText="取消" onConfirm={() => void remove(selectedKeys)}>
                                <Tooltip title="批量删除">
                                    <Button danger aria-label="批量删除外部存储文件" className="!w-8 !px-0 sm:!w-auto sm:!px-3" icon={<Trash2 className="size-4" />} disabled={!selectedKeys.length} loading={deleting}>
                                        <span className="hidden sm:inline">批量删除</span>
                                    </Button>
                                </Tooltip>
                            </Popconfirm>
                        </>
                    }
                />
                <div className="p-4 sm:p-5">
                    {syncResult ? (
                        <div className="mb-4 grid grid-cols-2 overflow-hidden rounded-md border border-zinc-200 text-center sm:grid-cols-4 dark:border-zinc-800">
                            <StatusMetric label="已迁移" value={syncResult.migrated} />
                            <StatusMetric label="失败" value={syncResult.failed} />
                            <StatusMetric label="跳过" value={syncResult.skipped} />
                            <StatusMetric label="剩余" value={syncResult.remaining} />
                        </div>
                    ) : null}
                    {syncResult?.errors.length ? (
                        <div role="alert" className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3.5 py-3 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
                            <div className="text-sm font-medium">迁移失败详情（本地源文件已保留）</div>
                            <div className="mt-2 max-h-40 space-y-2 overflow-y-auto text-xs">
                                {syncResult.errors.map((error, index) => (
                                    <div key={`${error.storageKey}-${index}`} className="grid gap-0.5 sm:grid-cols-[minmax(180px,0.8fr)_minmax(0,1.2fr)] sm:gap-3">
                                        <span className="break-all font-mono text-[11px] opacity-75">{error.storageKey}</span>
                                        <span>{error.message}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ) : null}
                    <div>
                        <AdminMediaTypeTabs
                            value={type}
                            disabled={!settings?.bucket}
                            onChange={(value) => {
                                setCursor("");
                                setCursorHistory([]);
                                setType(value);
                            }}
                        />
                        <div className="grid max-w-[1180px] grid-cols-[minmax(0,1fr)_40px] gap-3 xl:grid-cols-[minmax(260px,1fr)_40px_190px_220px]">
                            <Input
                                value={prefixInput}
                                allowClear
                                placeholder="按对象路径前缀筛选"
                                disabled={!settings?.bucket}
                                onChange={(event) => {
                                    const next = event.target.value;
                                    setPrefixInput(next);
                                    if (!next && prefix) applyPrefixFilter("");
                                }}
                                onPressEnter={(event) => applyPrefixFilter(event.currentTarget.value)}
                            />
                            <Tooltip title="筛选">
                                <Button aria-label="筛选外部存储文件" className="!w-10 !px-0" icon={<Search className="size-4" />} disabled={!settings?.bucket} onClick={() => applyPrefixFilter(prefixInput)} />
                            </Tooltip>
                            <div className="col-span-2 min-w-0 xl:col-span-1">
                                <Select
                                    className="w-full"
                                    value={source}
                                    disabled={!settings?.bucket}
                                    options={mediaSourceGroupOptions.map((option) => ({ ...option }))}
                                    onChange={(value) => {
                                        setCursor("");
                                        setCursorHistory([]);
                                        setSource(value);
                                    }}
                                />
                            </div>
                            <div className="col-span-2 min-w-0 xl:col-span-1">
                                <AdminUserSearchSelect
                                    value={ownerUserId || undefined}
                                    placeholder="按用户或 ID 筛选"
                                    onChange={(value) => {
                                        setCursor("");
                                        setCursorHistory([]);
                                        setOwnerUserId(value || "");
                                    }}
                                />
                            </div>
                        </div>
                    </div>

                    <div className="mt-4 hidden overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800 md:block">
                        <Table
                            rowKey="key"
                            size="middle"
                            loading={loadingFiles}
                            columns={columns}
                            dataSource={files?.items || []}
                            pagination={false}
                            rowSelection={{ selectedRowKeys: selectedKeys, onChange: (keys) => setSelectedKeys(keys.map(String)) }}
                        />
                    </div>
                    <div className="mt-4 space-y-2 md:hidden">
                        <Checkbox
                            checked={Boolean(files?.items.length) && files!.items.every((file) => selectedKeys.includes(file.key))}
                            indeterminate={Boolean(files?.items.some((file) => selectedKeys.includes(file.key))) && !files?.items.every((file) => selectedKeys.includes(file.key))}
                            onChange={(event) => setSelectedKeys(event.target.checked ? (files?.items || []).map((file) => file.key) : [])}
                        >
                            选择本页
                        </Checkbox>
                        {(files?.items || []).map((file) => (
                            <div key={file.key} className="flex min-w-0 items-center gap-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
                                <Checkbox
                                    checked={selectedKeys.includes(file.key)}
                                    aria-label="选择外部存储对象"
                                    onChange={(event) => setSelectedKeys((current) => (event.target.checked ? [...current, file.key] : current.filter((key) => key !== file.key)))}
                                />
                                <MediaThumbnail file={file} onPreview={setPreview} />
                                <div className="min-w-0 flex-1">
                                    <div className="truncate text-sm font-medium">{file.originalName || file.name}</div>
                                    <div className="mt-1 text-xs text-zinc-500">
                                        {managedMediaTypeLabel(file.type)} · {formatBytes(file.bytes)} · {file.storageKey ? `引用 ${file.referenceCount}` : file.variant ? "预览变体" : "独立对象"}
                                    </div>
                                    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-500">
                                        <span className="truncate">{file.ownerDisplayName || file.ownerUsername || (file.ownerUserId ? "用户信息不可用" : "未登记")}</span>
                                        <AdminAccountId accountId={file.ownerAccountId} className="shrink-0" />
                                        <span className="truncate">{mediaSourceLabel(file.source)}</span>
                                    </div>
                                    <div className="mt-1 truncate font-mono text-[11px] text-zinc-500">{file.key}</div>
                                </div>
                                <div className="flex shrink-0 flex-col gap-0.5">
                                    <Button type="text" shape="circle" aria-label="下载对象" icon={<Download className="size-4" />} href={file.downloadUrl} target="_blank" />
                                    <Popconfirm title="删除这个外部存储对象？" description="仍被业务记录引用时会自动保留。" okText="删除" cancelText="取消" onConfirm={() => void remove([file.key])}>
                                        <Button danger type="text" shape="circle" aria-label="删除对象" icon={<Trash2 className="size-4" />} />
                                    </Popconfirm>
                                </div>
                            </div>
                        ))}
                        {!loadingFiles && !files?.items.length ? <div className="py-10 text-center text-sm text-zinc-500">暂无外部存储对象</div> : null}
                    </div>
                    <div className="mt-4 flex items-center justify-end gap-2">
                        <Button
                            disabled={!cursorHistory.length || loadingFiles}
                            onClick={() => {
                                const previous = cursorHistory.at(-1) || "";
                                setCursorHistory((history) => history.slice(0, -1));
                                setCursor(previous);
                            }}
                        >
                            上一页
                        </Button>
                        <Button
                            disabled={!files?.nextCursor || loadingFiles}
                            onClick={() => {
                                const next = files?.nextCursor || "";
                                setCursorHistory((current) => [...current, cursor]);
                                setCursor(next);
                            }}
                        >
                            下一页
                        </Button>
                    </div>
                </div>
            </Panel>

            <Modal
                title={preview?.originalName || preview?.name || "对象预览"}
                open={Boolean(preview)}
                footer={
                    preview ? (
                        <Button icon={<Download className="size-4" />} href={preview.downloadUrl} target="_blank">
                            下载原文件
                        </Button>
                    ) : null
                }
                width={860}
                centered
                destroyOnHidden
                onCancel={() => setPreview(undefined)}
            >
                {preview ? <MediaViewer file={preview} /> : null}
            </Modal>
        </div>
    );
}

function MediaThumbnail({ file, onPreview }: { file: ExternalStorageFile; onPreview: (file: ExternalStorageFile) => void }) {
    return (
        <button
            type="button"
            className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-md border border-zinc-200 bg-zinc-50 text-zinc-500 transition hover:border-zinc-400 hover:text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600 dark:hover:text-white"
            aria-label="预览外部存储对象"
            onClick={() => onPreview(file)}
        >
            {file.type === "image" ? (
                <Image preview={false} src={imagePreviewUrl(file.previewUrl, 256)} alt="" width={48} height={48} className="size-12 object-cover" />
            ) : file.type === "video" ? (
                <Film className="size-5" />
            ) : file.type === "audio" ? (
                <FileAudio className="size-5" />
            ) : (
                <File className="size-5" />
            )}
        </button>
    );
}

function MediaViewer({ file }: { file: ExternalStorageFile }) {
    if (file.type === "image") return <Image src={imagePreviewUrl(file.previewUrl, 1920)} alt={file.originalName || file.name} className="max-h-[70dvh] w-full object-contain" />;
    if (file.type === "video") return <video src={file.previewUrl} controls className="max-h-[70dvh] w-full rounded-md bg-black" />;
    if (file.type === "audio") return <audio src={file.previewUrl} controls className="w-full" />;
    return <div className="py-12 text-center text-sm text-zinc-500">此对象不支持在线预览</div>;
}

function StatusMetric({ label, value }: { label: string; value: number }) {
    return (
        <div className="border-zinc-200 p-3 odd:border-r nth-[-n+2]:border-b sm:nth-[-n+2]:border-b-0 sm:[&:not(:last-child)]:border-r dark:border-zinc-800">
            <div className="text-xs text-zinc-500">{label}</div>
            <div className="mt-1 text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{value}</div>
        </div>
    );
}

function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatTime(value?: string) {
    if (!value) return "-";
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "-";
}
