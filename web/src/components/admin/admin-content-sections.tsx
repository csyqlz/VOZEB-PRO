"use client";

import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import { LabeledControl, SectionTitle } from "@/components/admin/admin-settings-controls";
import { Button, Checkbox, DatePicker, Input, Modal, Pagination, Popconfirm, Space, Switch, Table, Tag } from "antd";
import dayjs from "dayjs";
import { Database, ExternalLink, Plus, RefreshCw, Save, Search, Trash2 } from "lucide-react";

import { imagePreviewUrl } from "@/lib/media-image-url";

import type { AdminDashboardController } from "./use-admin-dashboard-controller";
import { PROMPT_PAGE_SIZE } from "./use-admin-dashboard-controller";
import { ANNOUNCEMENT_PAGE_SIZE } from "./use-admin-dashboard-data-actions";

export function AdminAnnouncementsSection({ controller }: { controller: AdminDashboardController }) {
    const {
        announcements,
        announcementPage,
        announcementTotal,
        announcementsLoading,
        announcementSaving,
        announcementModalOpen,
        announcementDraft,
        setAnnouncementDraft,
        activeSection,
        loadAnnouncements,
        saveAnnouncementDraft,
        openAnnouncementModal,
        closeAnnouncementModal,
        updateAnnouncementById,
        deleteAnnouncementById,
    } = controller;
    if (activeSection !== "announcements") return null;
    return (
        <Panel variant="page">
            <PanelHeader
                title="公告通知"
                description="发布站内公告，并设置首页弹窗或登录后弹窗触达。"
                actions={
                    <div className="flex w-full flex-wrap justify-end gap-2 sm:w-auto">
                        <Button type="primary" icon={<Plus className="size-4" />} onClick={openAnnouncementModal}>
                            发布公告
                        </Button>
                        <Button icon={<ExternalLink className="size-4" />} href="/announcements" target="_blank">
                            前台公告
                        </Button>
                        <Button icon={<RefreshCw className="size-4" />} loading={announcementsLoading} onClick={() => void loadAnnouncements()}>
                            刷新
                        </Button>
                    </div>
                }
            />
            <div className="space-y-5 p-4 sm:p-5">
                <section className="rounded-lg border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-950">
                    <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <SectionTitle icon={<Database className="size-4" />} title="公告记录" />
                        <Tag className="m-0 w-fit">共 {announcementTotal} 条</Tag>
                    </div>
                    <div className="grid gap-3">
                        {announcements.map((announcement) => (
                            <div key={announcement.id} className="rounded-lg border border-stone-200 bg-stone-50/70 p-4 dark:border-stone-800 dark:bg-stone-900/40">
                                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                                    <div className="min-w-0">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <h3 className="text-base font-semibold text-stone-950 dark:text-stone-100">{announcement.title}</h3>
                                            <Tag color={announcement.enabled ? "green" : "default"} className="m-0">
                                                {announcement.enabled ? "展示中" : "已停用"}
                                            </Tag>
                                            {announcement.popupHome ? <Tag className="m-0">首页弹窗</Tag> : null}
                                            {announcement.popupAfterLogin ? <Tag className="m-0">登录弹窗</Tag> : null}
                                        </div>
                                        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-stone-600 dark:text-stone-300">{announcement.content}</p>
                                        <div className="mt-2 text-xs text-stone-500 dark:text-stone-400">{new Date(announcement.createdAt).toLocaleString("zh-CN")}</div>
                                    </div>
                                    <Space wrap className="shrink-0 lg:justify-end">
                                        <Button size="small" href={`/announcements#${announcement.id}`} target="_blank" icon={<ExternalLink className="size-3.5" />}>
                                            查看
                                        </Button>
                                        <Switch checked={announcement.enabled} checkedChildren="展示" unCheckedChildren="停用" onChange={(enabled) => void updateAnnouncementById(announcement, { enabled })} />
                                        <Switch checked={announcement.popupHome} checkedChildren="首页" unCheckedChildren="首页" onChange={(popupHome) => void updateAnnouncementById(announcement, { popupHome })} />
                                        <Switch checked={announcement.popupAfterLogin} checkedChildren="登录" unCheckedChildren="登录" onChange={(popupAfterLogin) => void updateAnnouncementById(announcement, { popupAfterLogin })} />
                                        <Popconfirm title="删除这条公告？" okText="删除" cancelText="取消" onConfirm={() => void deleteAnnouncementById(announcement.id)}>
                                            <Button danger icon={<Trash2 className="size-4" />}>
                                                删除
                                            </Button>
                                        </Popconfirm>
                                    </Space>
                                </div>
                            </div>
                        ))}
                        {!announcements.length && !announcementsLoading ? (
                            <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-stone-200 px-3 py-10 text-center text-sm text-stone-500 dark:border-stone-800">
                                <span>暂无公告。</span>
                                <Button type="primary" icon={<Plus className="size-4" />} onClick={openAnnouncementModal}>
                                    发布第一条公告
                                </Button>
                            </div>
                        ) : null}
                    </div>
                    {announcementTotal > ANNOUNCEMENT_PAGE_SIZE ? (
                        <Pagination className="mt-4 justify-end" current={announcementPage} pageSize={ANNOUNCEMENT_PAGE_SIZE} total={announcementTotal} showSizeChanger={false} onChange={(page) => void loadAnnouncements(page)} />
                    ) : null}
                </section>
            </div>
            <Modal
                title="发布公告"
                open={announcementModalOpen}
                width={760}
                centered
                destroyOnHidden
                onCancel={closeAnnouncementModal}
                styles={{ body: { maxHeight: "min(68dvh, 640px)", overflowY: "auto", paddingTop: 8 } }}
                footer={[
                    <Button key="cancel" onClick={closeAnnouncementModal} disabled={announcementSaving}>
                        取消
                    </Button>,
                    <Button key="save" type="primary" loading={announcementSaving} icon={<Save className="size-4" />} onClick={() => void saveAnnouncementDraft()}>
                        发布公告
                    </Button>,
                ]}
            >
                <div className="mb-4 rounded-2xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm leading-6 text-stone-500 dark:border-stone-800 dark:bg-stone-900/50 dark:text-stone-400">
                    公告发布后会进入公告记录；勾选首页弹窗或登录后弹窗后，用户会在对应场景看到提醒。
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                    <div className="sm:col-span-2">
                        <LabeledControl label="标题">
                            <Input value={announcementDraft.title} maxLength={80} placeholder="例如：维护通知" onChange={(event) => setAnnouncementDraft((current) => ({ ...current, title: event.target.value }))} />
                        </LabeledControl>
                    </div>
                    <LabeledControl label="开始时间">
                        <DatePicker
                            className="w-full"
                            classNames={{ popup: { root: "admin-date-picker-dropdown" } }}
                            showTime
                            allowClear
                            value={announcementDraft.startsAt ? dayjs(announcementDraft.startsAt) : null}
                            onChange={(value) => setAnnouncementDraft((current) => ({ ...current, startsAt: value?.toISOString() || undefined }))}
                        />
                    </LabeledControl>
                    <LabeledControl label="结束时间">
                        <DatePicker
                            className="w-full"
                            classNames={{ popup: { root: "admin-date-picker-dropdown" } }}
                            showTime
                            allowClear
                            value={announcementDraft.endsAt ? dayjs(announcementDraft.endsAt) : null}
                            onChange={(value) => setAnnouncementDraft((current) => ({ ...current, endsAt: value?.toISOString() || undefined }))}
                        />
                    </LabeledControl>
                    <div className="sm:col-span-2">
                        <LabeledControl label="公告内容">
                            <Input.TextArea value={announcementDraft.content} rows={5} maxLength={3000} placeholder="写入公告正文，支持换行。" onChange={(event) => setAnnouncementDraft((current) => ({ ...current, content: event.target.value }))} />
                        </LabeledControl>
                    </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-3">
                    <Checkbox checked={announcementDraft.enabled !== false} onChange={(event) => setAnnouncementDraft((current) => ({ ...current, enabled: event.target.checked }))}>
                        启用展示
                    </Checkbox>
                    <Checkbox checked={announcementDraft.popupHome === true} onChange={(event) => setAnnouncementDraft((current) => ({ ...current, popupHome: event.target.checked }))}>
                        首页弹窗
                    </Checkbox>
                    <Checkbox checked={announcementDraft.popupAfterLogin === true} onChange={(event) => setAnnouncementDraft((current) => ({ ...current, popupAfterLogin: event.target.checked }))}>
                        登录后弹窗
                    </Checkbox>
                </div>
            </Modal>
        </Panel>
    );
}

export function AdminPromptsSection({ controller }: { controller: AdminDashboardController }) {
    const {
        prompts,
        promptListTotal,
        promptsLoading,
        deletingPromptId,
        promptSearch,
        setPromptSearch,
        promptPage,
        setPromptPage,
        selectedPromptIds,
        setSelectedPromptIds,
        bulkDeletingPrompts,
        activeSection,
        selectedPrompts,
        promptListStart,
        promptListEnd,
        deletePrompt,
        bulkDeletePrompts,
        openPromptModal,
        promptColumns,
    } = controller;
    if (activeSection !== "prompts") return null;
    return (
        <Panel variant="page">
            <PanelHeader
                title="提示词运营"
                description="维护用户端提示词库展示的公共提示词，沉淀可复用的内容资产。"
                actions={
                    <Button type="primary" icon={<Plus className="size-4" />} onClick={openPromptModal}>
                        添加提示词
                    </Button>
                }
            />
            <div className="space-y-6 p-4 sm:p-6">
                <section className="admin-prompt-table rounded-xl">
                    <div className="admin-prompt-table-header flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
                        <div className="min-w-0">
                            <h3 className="text-base font-semibold text-stone-950 dark:text-stone-100">提示词列表</h3>
                            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">已收录的公共提示词会同步展示到用户端提示词库。</p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                            <span className="rounded-md bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-600 dark:bg-white/10 dark:text-stone-300">{promptListTotal ? `${promptListStart}-${promptListEnd} / ${promptListTotal} 条` : "0 条"}</span>
                            <Button size="small" icon={<Plus className="size-3.5" />} onClick={openPromptModal}>
                                添加
                            </Button>
                        </div>
                    </div>
                    <div className="flex flex-col gap-3 border-t border-stone-200/70 px-4 py-4 dark:border-white/10 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                        <div className="w-full min-w-0 sm:w-96">
                            <Input
                                className="w-full"
                                prefix={<Search className="size-4 text-stone-400" />}
                                allowClear
                                placeholder="搜索标题、分类、标签或提示词内容"
                                value={promptSearch}
                                onChange={(event) => {
                                    setPromptSearch(event.target.value);
                                    setPromptPage(1);
                                }}
                            />
                        </div>
                        <div className="flex w-full items-center justify-between gap-2 sm:w-auto sm:justify-end">
                            <span className="text-xs text-stone-500 dark:text-stone-400">已选 {selectedPrompts.length} 条</span>
                            <Popconfirm title="批量删除选中提示词？" description="会从公共提示词库中移除，用户端将不再显示这些提示词。" okText="删除" cancelText="取消" onConfirm={() => void bulkDeletePrompts()}>
                                <Button danger disabled={!selectedPrompts.length} loading={bulkDeletingPrompts} icon={<Trash2 className="size-4" />}>
                                    批量删除
                                </Button>
                            </Popconfirm>
                        </div>
                    </div>
                    <div className="space-y-3 px-4 pb-4 md:hidden">
                        {prompts.map((prompt) => (
                            <div key={prompt.id} className="rounded-lg border border-stone-200 bg-white p-3 dark:border-stone-800 dark:bg-stone-950">
                                <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-3">
                                    <Checkbox checked={selectedPromptIds.includes(prompt.id)} onChange={(event) => setSelectedPromptIds((ids) => (event.target.checked ? Array.from(new Set([...ids, prompt.id])) : ids.filter((id) => id !== prompt.id)))} />
                                    <div className="min-w-0">
                                        <div className="flex min-w-0 gap-3">
                                            {prompt.coverUrl ? (
                                                <img
                                                    src={imagePreviewUrl(prompt.coverUrl, 480)}
                                                    alt={prompt.title}
                                                    className="h-16 w-24 shrink-0 rounded-md border border-stone-200 object-cover dark:border-stone-800"
                                                    loading="lazy"
                                                    referrerPolicy="no-referrer"
                                                />
                                            ) : (
                                                <div className="h-16 w-24 shrink-0 rounded-md border border-stone-200 bg-stone-100 dark:border-stone-800 dark:bg-stone-900" />
                                            )}
                                            <div className="min-w-0">
                                                <div className="truncate text-sm font-semibold text-stone-950 dark:text-stone-100">{prompt.title}</div>
                                                <div className="mt-1 line-clamp-2 text-xs leading-5 text-stone-500 dark:text-stone-400">{prompt.prompt}</div>
                                            </div>
                                        </div>
                                        <div className="mt-3 flex min-w-0 flex-wrap gap-1">
                                            {prompt.category ? (
                                                <Tag className="m-0 max-w-full truncate text-[11px]" color="blue">
                                                    {prompt.category}
                                                </Tag>
                                            ) : null}
                                            {prompt.tags.map((tag) => (
                                                <Tag key={tag} className="m-0 max-w-full truncate text-[11px]">
                                                    {tag}
                                                </Tag>
                                            ))}
                                        </div>
                                        <div className="mt-3 flex justify-end">
                                            <Popconfirm title="删除公共提示词？" okText="删除" cancelText="取消" onConfirm={() => deletePrompt(prompt.id)}>
                                                <Button size="small" danger loading={deletingPromptId === prompt.id} icon={<Trash2 className="size-3.5" />}>
                                                    删除
                                                </Button>
                                            </Popconfirm>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ))}
                        {!prompts.length && !promptsLoading ? (
                            <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-stone-300 py-12 text-center text-sm text-stone-500 dark:border-stone-700">
                                <span>暂无提示词</span>
                                <Button type="primary" icon={<Plus className="size-4" />} onClick={openPromptModal}>
                                    添加第一条提示词
                                </Button>
                            </div>
                        ) : null}
                        {promptListTotal > PROMPT_PAGE_SIZE ? <Pagination className="pt-1" current={promptPage} pageSize={PROMPT_PAGE_SIZE} total={promptListTotal} showSizeChanger={false} size="small" onChange={(page) => setPromptPage(page)} /> : null}
                    </div>
                    <div className="hidden md:block">
                        <Table
                            rowKey="id"
                            columns={promptColumns}
                            dataSource={prompts}
                            loading={promptsLoading}
                            pagination={{
                                current: promptPage,
                                pageSize: PROMPT_PAGE_SIZE,
                                total: promptListTotal,
                                showSizeChanger: false,
                                showTotal: (total, range) => `${range[0]}-${range[1]} / ${total} 条`,
                                onChange: (page) => setPromptPage(page),
                            }}
                            size="middle"
                            scroll={{ x: 760 }}
                            rowSelection={{
                                selectedRowKeys: selectedPromptIds,
                                onChange: (keys) => setSelectedPromptIds(keys.map(String)),
                            }}
                        />
                    </div>
                </section>
            </div>
        </Panel>
    );
}
