"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { Button, Empty, Input, Popconfirm, Select, Space, Switch, Table, Tabs, Tag } from "antd";
import type { TableColumnsType } from "antd";
import { Blocks, GitBranch, Plus, RefreshCw, Route, Search, Settings2, Trash2 } from "lucide-react";

import { AdminLogicalModelManager } from "@/components/admin/admin-logical-model-manager";
import { AdminEcommerceModelRoleManager } from "@/components/admin/admin-ecommerce-model-role-manager";
import { EMPTY_ECOMMERCE_MODEL_ROLES } from "@/lib/ecommerce-model-role-config";
import type { SystemChannelProtocol, SystemModelChannel } from "@/lib/auth/store";
import { channelProtocolDefinitions, channelSupportsModelCatalog } from "@/lib/channel-protocol-registry";
import { capabilityLabel, isLogicalModelResolvable } from "@/lib/model-routing-config";

import { AdminChannelDetailDrawer } from "./admin-channel-detail-drawer";
import { AdminChannelOnboardingDrawer } from "./admin-channel-onboarding-drawer";
import { ChannelStatusBadge } from "./admin-channel-status-badge";
import { channelBindingCount, channelCapabilityLabels, channelProtocolLabel, channelSearchText, channelWorkspaceStatus, updateChannelInWorkspace, type ChannelWorkspaceSettings, type ChannelWorkspaceStatus } from "./admin-channel-workspace-model";

type Props = {
    settings: ChannelWorkspaceSettings;
    fetchingModelId: string;
    saving: boolean;
    onChange: (settings: ChannelWorkspaceSettings) => void;
    onDeleteChannel: (channelId: string) => Promise<boolean>;
    onFetchModels: (channel: SystemModelChannel) => Promise<void>;
    onFetchAll: () => Promise<void>;
    onPersist: (settings: ChannelWorkspaceSettings, successText: string) => Promise<boolean>;
};

export function AdminChannelWorkspace({ settings, fetchingModelId, saving, onChange, onDeleteChannel, onFetchModels, onFetchAll, onPersist }: Props) {
    const [activeTab, setActiveTab] = useState("channels");
    const [query, setQuery] = useState("");
    const [statusFilter, setStatusFilter] = useState<ChannelWorkspaceStatus | "all">("all");
    const [protocolFilter, setProtocolFilter] = useState<SystemChannelProtocol | "all">("all");
    const [wizardOpen, setWizardOpen] = useState(false);
    const [wizardProtocol, setWizardProtocol] = useState<SystemChannelProtocol | undefined>();
    const [detailId, setDetailId] = useState("");
    const deferredQuery = useDeferredValue(query.trim().toLowerCase());
    const selectedChannel = settings.systemChannels.find((channel) => channel.id === detailId);
    const visibleChannels = useMemo(
        () =>
            settings.systemChannels.filter((channel) => {
                const status = channelWorkspaceStatus(channel);
                return (!deferredQuery || channelSearchText(channel).includes(deferredQuery)) && (statusFilter === "all" || status === statusFilter) && (protocolFilter === "all" || (channel.advancedConfig?.protocol || "auto") === protocolFilter);
            }),
        [deferredQuery, protocolFilter, settings.systemChannels, statusFilter],
    );
    const enabledChannels = settings.systemChannels.filter((channel) => channel.enabled).length;
    const synchronizedChannels = settings.systemChannels.filter((channel) => channel.models.length).length;
    const protocolCount = new Set(settings.systemChannels.map((channel) => channel.advancedConfig?.protocol || "auto")).size;
    const readyDefaults = (["text", "image", "video", "audio"] as const).filter((capability) => {
        const key = capability === "text" ? "textModel" : capability === "image" ? "imageModel" : capability === "video" ? "videoModel" : "audioModel";
        return isLogicalModelResolvable(settings.logicalModels, settings.systemChannels, capability, settings.defaultModels[key]);
    }).length;
    const openWizard = (protocol?: SystemChannelProtocol) => {
        setWizardProtocol(protocol);
        setWizardOpen(true);
    };
    const updateChannel = (id: string, patch: Partial<SystemModelChannel>) => onChange(updateChannelInWorkspace(settings, id, patch));
    const columns: TableColumnsType<SystemModelChannel> = [
        {
            title: "渠道",
            key: "channel",
            render: (_, channel) => (
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="max-w-[240px] truncate font-medium text-stone-950 dark:text-stone-100">{channel.name || "未命名渠道"}</span>
                        <ChannelStatusTag channel={channel} />
                    </div>
                    <div className="mt-1 max-w-[320px] truncate text-xs text-stone-500 dark:text-stone-400">{channel.baseUrl || "未配置 Base URL"}</div>
                </div>
            ),
        },
        { title: "协议", key: "protocol", width: 190, render: (_, channel) => <span className="text-sm">{channelProtocolLabel(channel)}</span> },
        { title: "模型", key: "models", width: 90, align: "center", render: (_, channel) => channel.models.length },
        { title: "能力", key: "capabilities", width: 170, render: (_, channel) => <span className="text-xs text-stone-600 dark:text-stone-300">{channelCapabilityLabels(channel).join("、") || "待识别"}</span> },
        { title: "绑定", key: "bindings", width: 80, align: "center", render: (_, channel) => channelBindingCount(channel.id, settings) },
        {
            title: "启用",
            key: "enabled",
            width: 80,
            align: "center",
            render: (_, channel) => <Switch size="small" checked={channel.enabled} aria-label={`${channel.name}启用状态`} onChange={(enabled) => updateChannel(channel.id, { enabled })} />,
        },
        {
            title: "操作",
            key: "actions",
            width: 220,
            render: (_, channel) => (
                <Space size={4}>
                    <Button size="small" onClick={() => setDetailId(channel.id)}>
                        查看
                    </Button>
                    {channelSupportsModelCatalog(channel) ? (
                        <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={fetchingModelId === channel.id} aria-label={`同步 ${channel.name} 模型`} title="同步模型" onClick={() => void onFetchModels(channel)} />
                    ) : null}
                    <Popconfirm title="删除这个渠道？" description="关联逻辑模型绑定和失效默认值会同步清理。" okText="删除" cancelText="取消" onConfirm={() => onDeleteChannel(channel.id)}>
                        <Button size="small" danger icon={<Trash2 className="size-3.5" />} aria-label={`删除 ${channel.name}`} title="删除渠道" />
                    </Popconfirm>
                </Space>
            ),
        },
    ];

    return (
        <div>
            <ChannelMetrics enabled={enabledChannels} total={settings.systemChannels.length} synchronized={synchronizedChannels} protocols={protocolCount} readyDefaults={readyDefaults} />
            <Tabs
                className="max-sm:[&_.ant-tabs-nav-list]:w-full max-sm:[&_.ant-tabs-tab]:!m-0 max-sm:[&_.ant-tabs-tab]:min-w-0 max-sm:[&_.ant-tabs-tab]:flex-1 max-sm:[&_.ant-tabs-tab]:justify-center max-sm:[&_.ant-tabs-tab]:!px-1"
                activeKey={activeTab}
                onChange={setActiveTab}
                tabBarExtraContent={
                    <div className="hidden sm:flex sm:items-center sm:gap-2">
                        <Button icon={<RefreshCw className="size-4" />} loading={fetchingModelId === "all"} onClick={() => void onFetchAll()}>
                            同步全部模型
                        </Button>
                        <Button type="primary" icon={<Plus className="size-4" />} onClick={() => openWizard()}>
                            接入新渠道
                        </Button>
                    </div>
                }
                items={[
                    {
                        key: "channels",
                        label: <TabLabel icon={<Settings2 className="size-4" />} text="渠道管理" />,
                        children: (
                            <ChannelList
                                channels={visibleChannels}
                                allChannels={settings.systemChannels}
                                columns={columns}
                                query={query}
                                statusFilter={statusFilter}
                                protocolFilter={protocolFilter}
                                fetchingModelId={fetchingModelId}
                                settings={settings}
                                onQuery={setQuery}
                                onStatus={setStatusFilter}
                                onProtocol={setProtocolFilter}
                                onOpen={setDetailId}
                                onCreate={() => openWizard()}
                                onFetchAll={() => void onFetchAll()}
                                onFetch={(channel) => void onFetchModels(channel)}
                            />
                        ),
                    },
                    { key: "protocols", label: <TabLabel icon={<Blocks className="size-4" />} text="协议中心" />, children: <ProtocolCenter settings={settings} onCreate={openWizard} onOpenChannel={setDetailId} /> },
                    {
                        key: "logical",
                        label: <TabLabel icon={<Route className="size-4" />} text="逻辑模型" />,
                        children: <AdminLogicalModelManager channels={settings.systemChannels} logicalModels={settings.logicalModels} defaultModels={settings.defaultModels} onChange={(routing) => onChange({ ...settings, ...routing })} />,
                    },
                    {
                        key: "ecommerce",
                        label: <TabLabel icon={<GitBranch className="size-4" />} text="电商流程" />,
                        children: (
                            <AdminEcommerceModelRoleManager
                                logicalModels={settings.logicalModels}
                                roles={settings.ecommerceModelRoles || EMPTY_ECOMMERCE_MODEL_ROLES}
                                enabled={settings.ecommerceGenerationEnabled === true}
                                onEnabledChange={(ecommerceGenerationEnabled) => onChange({ ...settings, ecommerceGenerationEnabled })}
                                visualQualityEnabled={settings.ecommerceVisualQualityCheckEnabled === true}
                                onVisualQualityEnabledChange={(ecommerceVisualQualityCheckEnabled) => onChange({ ...settings, ecommerceVisualQualityCheckEnabled })}
                                onChange={(ecommerceModelRoles) => onChange({ ...settings, ecommerceModelRoles })}
                            />
                        ),
                    },
                ]}
            />
            <div className="mt-3 flex gap-2 sm:hidden">
                <Button className="min-w-0 flex-1" icon={<RefreshCw className="size-4" />} loading={fetchingModelId === "all"} onClick={() => void onFetchAll()}>
                    同步模型
                </Button>
                <Button className="min-w-0 flex-1" type="primary" icon={<Plus className="size-4" />} onClick={() => openWizard()}>
                    接入渠道
                </Button>
            </div>
            <AdminChannelOnboardingDrawer
                open={wizardOpen}
                initialProtocol={wizardProtocol}
                settings={settings}
                fetchingModelId={fetchingModelId}
                saving={saving}
                onClose={() => setWizardOpen(false)}
                onChange={onChange}
                onFetchModels={onFetchModels}
                onPersist={onPersist}
            />
            <AdminChannelDetailDrawer
                open={Boolean(selectedChannel)}
                channel={selectedChannel}
                settings={settings}
                fetching={fetchingModelId === selectedChannel?.id}
                onClose={() => setDetailId("")}
                onChange={(patch) => selectedChannel && updateChannel(selectedChannel.id, patch)}
                onDelete={async () => Boolean(selectedChannel && (await onDeleteChannel(selectedChannel.id)))}
                onFetchModels={() => selectedChannel && void onFetchModels(selectedChannel)}
            />
        </div>
    );
}

function ChannelMetrics({ enabled, total, synchronized, protocols, readyDefaults }: { enabled: number; total: number; synchronized: number; protocols: number; readyDefaults: number }) {
    const metrics = [
        { label: "启用渠道", value: `${enabled}/${total}` },
        { label: "已同步模型", value: String(synchronized) },
        { label: "使用协议", value: String(protocols) },
        { label: "默认能力", value: `${readyDefaults}/4` },
    ];
    return (
        <div className="grid grid-cols-2 border-b border-stone-200 sm:grid-cols-4 dark:border-stone-800">
            {metrics.map((metric, index) => (
                <div key={metric.label} className={`px-2 py-3 sm:px-4 ${index % 2 ? "border-l" : ""} ${index > 1 ? "border-t sm:border-t-0" : ""} sm:border-l dark:border-stone-800`}>
                    <div className="text-xs text-stone-500 dark:text-stone-400">{metric.label}</div>
                    <div className="mt-1 text-lg font-semibold text-stone-950 dark:text-stone-100">{metric.value}</div>
                </div>
            ))}
        </div>
    );
}

function ChannelList({
    channels,
    allChannels,
    columns,
    query,
    statusFilter,
    protocolFilter,
    fetchingModelId,
    settings,
    onQuery,
    onStatus,
    onProtocol,
    onOpen,
    onCreate,
    onFetchAll,
    onFetch,
}: {
    channels: SystemModelChannel[];
    allChannels: SystemModelChannel[];
    columns: TableColumnsType<SystemModelChannel>;
    query: string;
    statusFilter: ChannelWorkspaceStatus | "all";
    protocolFilter: SystemChannelProtocol | "all";
    fetchingModelId: string;
    settings: ChannelWorkspaceSettings;
    onQuery: (value: string) => void;
    onStatus: (value: ChannelWorkspaceStatus | "all") => void;
    onProtocol: (value: SystemChannelProtocol | "all") => void;
    onOpen: (id: string) => void;
    onCreate: () => void;
    onFetchAll: () => void;
    onFetch: (channel: SystemModelChannel) => void;
}) {
    return (
        <div>
            <div className="mb-3 flex min-w-0 flex-col gap-2 md:flex-row">
                <Input allowClear className="min-w-0 flex-1" prefix={<Search className="size-4 text-stone-400" />} value={query} placeholder="搜索渠道、地址、协议或模型" onChange={(event) => onQuery(event.target.value)} />
                <div className="grid grid-cols-2 gap-2 md:flex md:shrink-0">
                    <div className="min-w-0 md:w-32">
                        <Select
                            className="w-full"
                            value={statusFilter}
                            options={[
                                { label: "全部状态", value: "all" },
                                { label: "已启用", value: "enabled" },
                                { label: "草稿", value: "draft" },
                                { label: "已停用", value: "disabled" },
                            ]}
                            onChange={onStatus}
                        />
                    </div>
                    <div className="min-w-0 md:w-44">
                        <Select className="w-full" value={protocolFilter} options={[{ label: "全部协议", value: "all" }, ...channelProtocolDefinitions.map((definition) => ({ label: definition.label, value: definition.id }))]} onChange={onProtocol} />
                    </div>
                </div>
            </div>
            <div className="hidden md:block">
                <Table
                    rowKey="id"
                    size="small"
                    pagination={{ pageSize: 12, hideOnSinglePage: true }}
                    columns={columns}
                    dataSource={channels}
                    scroll={{ x: 1060 }}
                    locale={{ emptyText: <ChannelEmpty hasChannels={Boolean(allChannels.length)} onCreate={onCreate} /> }}
                />
            </div>
            <div className="space-y-2 md:hidden">
                {channels.map((channel) => (
                    <div key={channel.id} className="min-w-0 overflow-hidden rounded-md border border-stone-200 bg-white p-3 dark:border-stone-800 dark:bg-stone-950">
                        <div className="flex min-w-0 items-start justify-between gap-2">
                            <div className="min-w-0">
                                <div className="flex min-w-0 items-center gap-2">
                                    <span className="truncate text-sm font-semibold text-stone-950 dark:text-stone-100">{channel.name || "未命名渠道"}</span>
                                    <ChannelStatusTag channel={channel} />
                                </div>
                                <div className="mt-1 truncate text-xs text-stone-500 dark:text-stone-400">{channelProtocolLabel(channel)}</div>
                            </div>
                            <Switch size="small" checked={channel.enabled} disabled aria-label={`${channel.name}当前启用状态`} />
                        </div>
                        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
                            <span>{channel.models.length} 个模型</span>
                            <span>{channelCapabilityLabels(channel).join("、") || "能力待识别"}</span>
                            <span>{channelBindingCount(channel.id, settings)} 个绑定</span>
                        </div>
                        <div className="mt-3 flex items-center gap-2 border-t border-stone-100 pt-3 dark:border-stone-900">
                            <Button size="small" className="min-w-0 flex-1" onClick={() => onOpen(channel.id)}>
                                查看
                            </Button>
                            {channelSupportsModelCatalog(channel) ? (
                                <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={fetchingModelId === channel.id} aria-label={`同步 ${channel.name} 模型`} onClick={() => onFetch(channel)} />
                            ) : null}
                        </div>
                    </div>
                ))}
                {!channels.length ? <ChannelEmpty hasChannels={Boolean(allChannels.length)} onCreate={onCreate} /> : null}
            </div>
        </div>
    );
}

function ProtocolCenter({ settings, onCreate, onOpenChannel }: { settings: ChannelWorkspaceSettings; onCreate: (protocol?: SystemChannelProtocol) => void; onOpenChannel: (id: string) => void }) {
    const definitions = channelProtocolDefinitions.filter((definition) => !["auto", "compatible"].includes(definition.id));
    const customChannels = settings.systemChannels.filter((channel) => channel.advancedConfig?.protocol === "custom");
    return (
        <div className="space-y-6">
            <section>
                <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold text-stone-950 dark:text-stone-100">内置协议</div>
                    <Tag>{definitions.length} 个</Tag>
                </div>
                <div className="grid gap-2 lg:grid-cols-2">
                    {definitions.map((definition) => {
                        const used = settings.systemChannels.filter((channel) => channel.advancedConfig?.protocol === definition.id).length;
                        return (
                            <div key={definition.id} className="rounded-md border border-stone-200 bg-white p-3 dark:border-stone-800 dark:bg-stone-950">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="text-sm font-semibold text-stone-950 dark:text-stone-100">{definition.label}</span>
                                            <Tag className="m-0">内置</Tag>
                                            {definition.strict ? <Tag className="m-0 !border-stone-300 !bg-stone-50 !text-stone-700 dark:!border-stone-700 dark:!bg-stone-900 dark:!text-stone-200">严格</Tag> : null}
                                        </div>
                                        <div className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">{definition.description}</div>
                                    </div>
                                    <Button size="small" onClick={() => onCreate(definition.id)}>
                                        接入
                                    </Button>
                                </div>
                                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                                    {definition.capabilities.map((capability) => (
                                        <Tag key={capability}>{capabilityLabel(capability)}</Tag>
                                    ))}
                                    <span className="ml-auto text-xs text-stone-500 dark:text-stone-400">{used} 个渠道使用</span>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </section>
            <section>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div>
                        <div className="text-sm font-semibold text-stone-950 dark:text-stone-100">自定义协议草稿</div>
                        <div className="mt-1 text-xs text-stone-500 dark:text-stone-400">当前版本保存于具体渠道；完成 AdapterRevision 数据结构后再提供跨渠道发布与回滚。</div>
                    </div>
                    <Button icon={<Plus className="size-4" />} onClick={() => onCreate("custom")}>
                        创建自定义协议
                    </Button>
                </div>
                <div className="divide-y divide-stone-200 border-y border-stone-200 dark:divide-stone-800 dark:border-stone-800">
                    {customChannels.map((channel) => (
                        <div key={channel.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                            <div className="min-w-0">
                                <div className="truncate text-sm font-medium text-stone-950 dark:text-stone-100">{channel.name}</div>
                                <div className="mt-1 truncate text-xs text-stone-500 dark:text-stone-400">{channel.advancedConfig?.documentationUrl || channel.baseUrl || "未填写文档和地址"}</div>
                            </div>
                            <Space>
                                <Tag>{channel.enabled ? "渠道已启用" : "渠道级草稿"}</Tag>
                                <Button size="small" onClick={() => onOpenChannel(channel.id)}>
                                    继续配置
                                </Button>
                            </Space>
                        </div>
                    ))}
                    {!customChannels.length ? <div className="py-8 text-center text-sm text-stone-500 dark:text-stone-400">还没有自定义协议草稿</div> : null}
                </div>
            </section>
        </div>
    );
}

function ChannelStatusTag({ channel }: { channel: SystemModelChannel }) {
    const status = channelWorkspaceStatus(channel);
    return <ChannelStatusBadge status={status} />;
}

function ChannelEmpty({ hasChannels, onCreate }: { hasChannels: boolean; onCreate: () => void }) {
    return (
        <div className="py-10 text-center">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={hasChannels ? "没有匹配的渠道" : "还没有模型渠道"} />
            {!hasChannels ? (
                <Button type="primary" icon={<Plus className="size-4" />} onClick={onCreate}>
                    接入第一个渠道
                </Button>
            ) : null}
        </div>
    );
}

function TabLabel({ icon, text }: { icon: React.ReactNode; text: string }) {
    return (
        <span className="inline-flex items-center whitespace-nowrap sm:gap-1.5">
            <span className="hidden sm:inline-flex" aria-hidden>
                {icon}
            </span>
            {text}
        </span>
    );
}
