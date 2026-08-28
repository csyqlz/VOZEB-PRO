"use client";

import { GenerationLogMobileCard } from "@/components/admin/admin-generation-log";
import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import { AdminUserSearchSelect } from "@/components/admin/admin-user-identity";
import { Button, DatePicker, Input, Popconfirm, Select, Table } from "antd";
import dayjs from "dayjs";
import { RefreshCw, Search, Trash2 } from "lucide-react";

import type { AdminDashboardController } from "./use-admin-dashboard-controller";
import { GENERATION_LOG_PAGE_SIZE } from "./use-admin-dashboard-controller";

export function AdminLogsSection({ controller }: { controller: AdminDashboardController }) {
    const {
        generationLogs,
        generationLogTotal,
        generationLogPage,
        setGenerationLogPage,
        generationLogSearch,
        setGenerationLogSearch,
        generationLogKind,
        setGenerationLogKind,
        generationLogSource,
        setGenerationLogSource,
        generationLogStatus,
        setGenerationLogStatus,
        generationLogUserId,
        setGenerationLogUserId,
        generationLogStart,
        setGenerationLogStart,
        generationLogEnd,
        setGenerationLogEnd,
        selectedGenerationLogIds,
        setSelectedGenerationLogIds,
        generationLogsLoading,
        bulkDeletingGenerationLogs,
        setViewingGenerationLog,
        activeSection,
        selectedGenerationLogs,
        loadGenerationLogs,
        deleteGenerationLogsByIds,
        resetGenerationLogFilters,
        generationLogColumns,
    } = controller;
    if (activeSection !== "logs") return null;
    return (
        <Panel variant="page">
            <div className="lg:hidden">
                <PanelHeader title="调用记录" description="查看用户通过创作 Agent、画布和短剧产生的生成任务、入口来源和调用状态。" />
            </div>
            <div className="p-3 sm:p-4">
                <section data-testid="admin-log-list-surface" className="admin-panel-surface min-w-0 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
                    <div data-testid="admin-log-filters" className="flex min-w-0 flex-wrap items-center gap-2 border-b border-zinc-200 bg-zinc-50/70 p-3 dark:border-zinc-800 dark:bg-zinc-900/40 sm:p-4">
                        <div className="w-full min-w-0 md:w-72 xl:w-80">
                            <Input
                                allowClear
                                className="w-full"
                                prefix={<Search className="size-4 text-stone-400" />}
                                placeholder="搜索日志"
                                value={generationLogSearch}
                                onChange={(event) => {
                                    setGenerationLogSearch(event.target.value);
                                    setGenerationLogPage(1);
                                }}
                            />
                        </div>
                        <div className="w-[calc(50%-0.25rem)] min-w-0 md:w-24">
                            <Select
                                allowClear
                                className="w-full"
                                placeholder="类型"
                                value={generationLogKind || undefined}
                                onChange={(value) => {
                                    setGenerationLogKind(value || "");
                                    setGenerationLogPage(1);
                                }}
                                options={[
                                    { label: "图片", value: "image" },
                                    { label: "视频", value: "video" },
                                ]}
                            />
                        </div>
                        <div className="w-[calc(50%-0.25rem)] min-w-0 md:w-28">
                            <Select
                                allowClear
                                className="w-full"
                                placeholder="入口"
                                value={generationLogSource || undefined}
                                onChange={(value) => {
                                    setGenerationLogSource(value || "");
                                    setGenerationLogPage(1);
                                }}
                                options={[
                                    { label: "画布", value: "canvas" },
                                    { label: "图片生成", value: "image-workbench" },
                                    { label: "视频生成", value: "video-workbench" },
                                ]}
                            />
                        </div>
                        <div className="w-[calc(50%-0.25rem)] min-w-0 md:w-24">
                            <Select
                                allowClear
                                className="w-full"
                                placeholder="状态"
                                value={generationLogStatus || undefined}
                                onChange={(value) => {
                                    setGenerationLogStatus(value || "");
                                    setGenerationLogPage(1);
                                }}
                                options={[
                                    { label: "成功", value: "success" },
                                    { label: "失败", value: "failed" },
                                    { label: "生成中", value: "pending" },
                                ]}
                            />
                        </div>
                        <div className="w-[calc(50%-0.25rem)] min-w-0 md:w-48">
                            <AdminUserSearchSelect
                                className="w-full"
                                placeholder="搜索用户或 ID"
                                value={generationLogUserId || undefined}
                                onChange={(value) => {
                                    setGenerationLogUserId(value || "");
                                    setGenerationLogPage(1);
                                }}
                            />
                        </div>
                        <div className="w-full min-w-0 md:w-[260px]">
                            <DatePicker.RangePicker
                                className="admin-log-date-range w-full min-w-0 max-w-full"
                                classNames={{ popup: { root: "admin-date-picker-dropdown" } }}
                                allowClear
                                format="YYYY-MM-DD"
                                placeholder={["开始日期", "结束日期"]}
                                separator="至"
                                value={generationLogStart || generationLogEnd ? [generationLogStart ? dayjs(generationLogStart) : null, generationLogEnd ? dayjs(generationLogEnd) : null] : null}
                                onChange={(dates) => {
                                    setGenerationLogStart(dates?.[0]?.format("YYYY-MM-DD") || "");
                                    setGenerationLogEnd(dates?.[1]?.format("YYYY-MM-DD") || "");
                                    setGenerationLogPage(1);
                                }}
                            />
                        </div>
                    </div>
                    <div className="flex flex-col gap-2 border-b border-zinc-200 px-3 py-2.5 dark:border-zinc-800 sm:flex-row sm:items-center sm:justify-between sm:px-4">
                        <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
                            <span>共 {generationLogTotal} 条</span>
                            <span>已选 {selectedGenerationLogs.length} 条</span>
                        </div>
                        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
                            <Button className="w-full sm:w-auto" icon={<RefreshCw className="size-4" />} loading={generationLogsLoading} onClick={() => void loadGenerationLogs()}>
                                刷新
                            </Button>
                            <Button className="w-full sm:w-auto" disabled={!generationLogs.length} onClick={() => setSelectedGenerationLogIds(generationLogs.map((log) => log.id))}>
                                本页全选
                            </Button>
                            <Button className="w-full sm:w-auto" onClick={resetGenerationLogFilters}>
                                清除筛选
                            </Button>
                            <Popconfirm title="删除选中的生成日志？" description="只删除后台日志和本地日志预览资源，不会删除用户账号或提示词库。" okText="删除" cancelText="取消" onConfirm={() => void deleteGenerationLogsByIds(selectedGenerationLogIds)}>
                                <Button className="w-full sm:w-auto" danger disabled={!selectedGenerationLogIds.length} loading={bulkDeletingGenerationLogs} icon={<Trash2 className="size-4" />}>
                                    删除所选
                                </Button>
                            </Popconfirm>
                        </div>
                    </div>
                    <div className="space-y-2 p-3 md:hidden">
                        {generationLogs.map((log) => (
                            <GenerationLogMobileCard
                                key={log.id}
                                log={log}
                                selected={selectedGenerationLogIds.includes(log.id)}
                                onSelectedChange={(checked) => setSelectedGenerationLogIds((ids) => (checked ? Array.from(new Set([...ids, log.id])) : ids.filter((id) => id !== log.id)))}
                                onView={() => setViewingGenerationLog(log)}
                                onDelete={() => void deleteGenerationLogsByIds([log.id])}
                            />
                        ))}
                        {!generationLogs.length && !generationLogsLoading ? <div className="rounded-lg border border-dashed border-stone-300 py-12 text-center text-sm text-stone-500 dark:border-stone-700">暂无生成日志</div> : null}
                    </div>
                    <div className="hidden min-w-0 md:block">
                        <Table
                            className="admin-generation-log-table"
                            rowKey="id"
                            columns={generationLogColumns}
                            dataSource={generationLogs}
                            loading={generationLogsLoading}
                            pagination={{
                                current: generationLogPage,
                                pageSize: GENERATION_LOG_PAGE_SIZE,
                                total: generationLogTotal,
                                showSizeChanger: false,
                                showTotal: (total, range) => `${range[0]}-${range[1]} / ${total} 条`,
                                onChange: (page) => setGenerationLogPage(page),
                            }}
                            rowSelection={{
                                selectedRowKeys: selectedGenerationLogIds,
                                onChange: (keys) => setSelectedGenerationLogIds(keys.map(String)),
                            }}
                            scroll={{ x: 1090 }}
                            size="small"
                            tableLayout="fixed"
                        />
                    </div>
                </section>
            </div>
        </Panel>
    );
}
