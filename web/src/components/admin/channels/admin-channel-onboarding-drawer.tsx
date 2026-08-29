"use client";

import { useEffect, useMemo, useState } from "react";
import { App, Button, Drawer, Empty, Input, Select, Space, Switch, Tag } from "antd";
import { ArrowLeft, Check, CircleDollarSign, Info, Link2, PlugZap, RefreshCw, Save, WandSparkles } from "lucide-react";

import { AdminChannelProtocolSetup } from "@/components/admin/admin-channel-protocol-setup";
import { LabeledControl } from "@/components/admin/admin-settings-controls";
import { createSystemChannel } from "@/components/admin/admin-dashboard-elements";
import type { LogicalModelCapability, SystemChannelAuthMode, SystemChannelProtocol, SystemModelChannel } from "@/lib/auth/store";
import { applyChannelProtocol, channelConnectionReady, channelProtocolDefinition, channelProtocolOptions, channelRequiresApiKey, channelSupportsModelCatalog, protocolModelConfig, resolveChannelAuthMode } from "@/lib/channel-protocol-registry";
import { inferModelCapability, normalizeModelId } from "@/lib/model-capability";
import { capabilityLabel, channelModelCapability, synchronizeLogicalModelsWithChannels } from "@/lib/model-routing-config";

import { defaultModelField, removeChannelFromWorkspace, type ChannelWorkspaceSettings } from "./admin-channel-workspace-model";
import { GcpAgentPlatformFields } from "./gcp-agent-platform-fields";

type Props = {
    open: boolean;
    initialProtocol?: SystemChannelProtocol;
    settings: ChannelWorkspaceSettings;
    fetchingModelId: string;
    saving: boolean;
    onClose: () => void;
    onChange: (settings: ChannelWorkspaceSettings) => void;
    onFetchModels: (channel: SystemModelChannel) => Promise<void>;
    onPersist: (settings: ChannelWorkspaceSettings, successText: string) => Promise<boolean>;
};

const steps = [{ title: "选择协议" }, { title: "连接上游" }, { title: "添加模型" }, { title: "同步模型" }, { title: "确认启用" }];

export function AdminChannelOnboardingDrawer({ open, initialProtocol, settings, fetchingModelId, saving, onClose, onChange, onFetchModels, onPersist }: Props) {
    const { message, modal } = App.useApp();
    const [step, setStep] = useState(0);
    const [selectedProtocol, setSelectedProtocol] = useState<SystemChannelProtocol>("openai");
    const [draftId, setDraftId] = useState("");
    const [setAsDefault, setSetAsDefault] = useState(true);
    const channel = settings.systemChannels.find((item) => item.id === draftId);
    const modelsSynchronized = Boolean(
        channel?.models.length &&
        channel.models.every((upstreamModel) => settings.logicalModels.some((model) => model.bindings.some((binding) => binding.channelId === channel.id && normalizedUpstreamModel(binding.upstreamModel) === normalizedUpstreamModel(upstreamModel)))),
    );

    useEffect(() => {
        if (!open) return;
        setStep(0);
        setSelectedProtocol(initialProtocol || "openai");
        setDraftId("");
        setSetAsDefault(true);
    }, [initialProtocol, open]);

    const protocolOptions = useMemo(() => channelProtocolOptions().filter((item) => !["auto", "compatible"].includes(item.value)), []);
    const updateChannel = (patch: Partial<SystemModelChannel>) => {
        if (!draftId) return;
        onChange({ ...settings, systemChannels: settings.systemChannels.map((item) => (item.id === draftId ? { ...item, ...patch } : item)) });
    };
    const beginChannel = () => {
        const definition = channelProtocolDefinition(selectedProtocol);
        const next = applyChannelProtocol({ ...createSystemChannel(), name: `${definition.label} 渠道`, enabled: false }, selectedProtocol);
        onChange({ ...settings, systemChannels: [...settings.systemChannels, next] });
        setDraftId(next.id);
        setStep(1);
    };
    const returnToProtocols = () => {
        if (draftId) onChange(removeChannelFromWorkspace(settings, draftId));
        setDraftId("");
        setStep(0);
    };
    const cancel = () => {
        if (!draftId) return onClose();
        modal.confirm({
            title: "退出接入向导？",
            content: "当前尚未保存的渠道草稿将被移除。",
            okText: "退出并移除",
            cancelText: "继续配置",
            okButtonProps: { danger: true },
            onOk: () => {
                onChange(removeChannelFromWorkspace(settings, draftId));
                onClose();
            },
        });
    };
    const saveDraft = async () => {
        if (!channel) return;
        const next = { ...settings, systemChannels: settings.systemChannels.map((item) => (item.id === channel.id ? { ...item, enabled: false } : item)) };
        onChange(next);
        if (await onPersist(next, "渠道草稿已保存")) onClose();
    };
    const enableChannel = async () => {
        if (!channel || !channelConnectionReady(channel) || !modelsSynchronized) return;
        const next = { ...settings, systemChannels: settings.systemChannels.map((item) => (item.id === channel.id ? { ...item, enabled: true } : item)) };
        onChange(next);
        if (await onPersist(next, "渠道已启用")) onClose();
    };
    const synchronizeModels = () => {
        if (!channel?.models.length) return message.error("请先同步或填写上游模型目录");
        const logicalModels = synchronizeLogicalModelsWithChannels(settings.logicalModels, settings.systemChannels);
        const defaultModels = { ...settings.defaultModels };
        if (setAsDefault) {
            channel.models.forEach((upstreamModel) => {
                const capability = channelModelCapability(channel, upstreamModel);
                const field = defaultModelField(capability);
                if (defaultModels[field]) return;
                const logical = logicalModels.find((model) => model.bindings.some((binding) => binding.channelId === channel.id && binding.upstreamModel === upstreamModel));
                if (logical) defaultModels[field] = logical.id;
            });
        }
        onChange({ ...settings, logicalModels, defaultModels });
        message.success("已按上游模型名自动合并逻辑模型");
    };

    const renderStep = () => {
        if (step === 0) return <ProtocolSelection protocols={protocolOptions} selected={selectedProtocol} onSelect={setSelectedProtocol} />;
        if (!channel) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="渠道草稿不存在" />;
        if (step === 1) return <ConnectionStep channel={channel} onChange={updateChannel} />;
        if (step === 2) return <ModelStep channel={channel} fetching={fetchingModelId === channel.id} onChange={updateChannel} onFetch={() => void onFetchModels(channel)} />;
        if (step === 3) return <BindingStep channel={channel} logicalModels={settings.logicalModels} setAsDefault={setAsDefault} onSetAsDefault={setSetAsDefault} onSynchronize={synchronizeModels} />;
        return <ReviewStep channel={channel} settings={settings} />;
    };

    const nextDisabled = step === 1 ? !channel?.name.trim() || !channelConnectionReady(channel) : step === 2 ? !channel?.models.length : step === 3 ? !modelsSynchronized : false;

    return (
        <Drawer
            title="接入新渠道"
            size={736}
            styles={{ wrapper: { maxWidth: "100vw" } }}
            open={open}
            destroyOnHidden
            mask={{ closable: false }}
            onClose={cancel}
            footer={
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <Button onClick={step === 0 ? cancel : step === 1 ? returnToProtocols : () => setStep((current) => current - 1)} icon={step ? <ArrowLeft className="size-4" /> : undefined}>
                        {step ? "上一步" : "取消"}
                    </Button>
                    <Space wrap>
                        {step > 0 ? (
                            <Button loading={saving} icon={<Save className="size-4" />} onClick={() => void saveDraft()}>
                                保存草稿
                            </Button>
                        ) : null}
                        {step < steps.length - 1 ? (
                            <Button type="primary" disabled={nextDisabled} onClick={step === 0 ? beginChannel : () => setStep((current) => current + 1)}>
                                {step === 0 ? "开始配置" : "下一步"}
                            </Button>
                        ) : (
                            <Button type="primary" loading={saving} disabled={!channel || !channelConnectionReady(channel) || !modelsSynchronized} icon={<Check className="size-4" />} onClick={() => void enableChannel()}>
                                启用渠道
                            </Button>
                        )}
                    </Space>
                </div>
            }
        >
            <div className="mb-5 md:hidden">
                <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="text-xs font-medium text-stone-500 dark:text-stone-400">
                        步骤 {step + 1} / {steps.length}
                    </span>
                    <span className="text-sm font-semibold text-stone-950 dark:text-stone-100">{steps[step].title}</span>
                </div>
                <div className="grid grid-cols-5 gap-1" role="progressbar" aria-label={`接入进度：${steps[step].title}`} aria-valuemin={1} aria-valuemax={steps.length} aria-valuenow={step + 1}>
                    {steps.map((item, index) => (
                        <span key={item.title} className={`h-1 rounded-full ${index < step ? "bg-emerald-500 dark:bg-emerald-400" : index === step ? "bg-stone-950 dark:bg-stone-100" : "bg-stone-200 dark:bg-stone-700"}`} aria-hidden />
                    ))}
                </div>
            </div>
            <OnboardingProgress current={step} />
            {renderStep()}
        </Drawer>
    );
}

function OnboardingProgress({ current }: { current: number }) {
    return (
        <div className="mb-6 hidden md:block">
            <ol className="flex min-w-0 items-center" aria-label={`接入进度：${steps[current].title}`}>
                {steps.map((item, index) => {
                    const completed = index < current;
                    const active = index === current;
                    return (
                        <li key={item.title} className={`flex min-w-0 items-center ${index < steps.length - 1 ? "flex-1" : ""}`} aria-current={active ? "step" : undefined}>
                            <span className="flex shrink-0 items-center gap-2">
                                <span
                                    className={`inline-flex size-7 items-center justify-center rounded-full border text-xs font-semibold ${
                                        completed
                                            ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300"
                                            : active
                                              ? "border-stone-950 bg-stone-950 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-950"
                                              : "border-stone-200 bg-stone-100 text-stone-500 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-400"
                                    }`}
                                    aria-label={completed ? `${item.title}已完成` : active ? `${item.title}进行中` : `${item.title}未开始`}
                                >
                                    {completed ? (
                                        <span className="inline-flex size-5.5 items-center justify-center rounded-full bg-emerald-600 text-white shadow-sm shadow-emerald-600/20 dark:bg-emerald-400 dark:text-emerald-950">
                                            <Check className="size-3.5" aria-hidden />
                                        </span>
                                    ) : (
                                        index + 1
                                    )}
                                </span>
                                <span
                                    className={`whitespace-nowrap text-sm ${
                                        completed ? "font-semibold text-emerald-700 dark:text-emerald-300" : active ? "font-semibold text-stone-950 dark:text-stone-100" : "font-medium text-stone-400 dark:text-stone-500"
                                    }`}
                                >
                                    {item.title}
                                </span>
                            </span>
                            {index < steps.length - 1 ? <span className={`mx-2 h-px min-w-2 flex-1 ${completed ? "bg-emerald-300 dark:bg-emerald-700" : "bg-stone-300 dark:bg-stone-700"}`} aria-hidden /> : null}
                        </li>
                    );
                })}
            </ol>
        </div>
    );
}

function ProtocolSelection({ protocols, selected, onSelect }: { protocols: ReturnType<typeof channelProtocolOptions>; selected: SystemChannelProtocol; onSelect: (protocol: SystemChannelProtocol) => void }) {
    return (
        <div>
            <div className="mb-3 text-sm font-semibold text-stone-950 dark:text-stone-100">选择上游协议</div>
            <div className="grid gap-2 sm:grid-cols-2">
                {protocols.map((protocol) => {
                    const definition = channelProtocolDefinition(protocol.value);
                    const active = selected === protocol.value;
                    return (
                        <button
                            key={protocol.value}
                            type="button"
                            aria-pressed={active}
                            className={`min-w-0 rounded-md border p-3 text-left transition ${active ? "!border-stone-950 !bg-stone-50 !text-stone-950 ring-1 ring-inset ring-stone-950 dark:!border-stone-100 dark:!bg-stone-900 dark:!text-stone-100 dark:ring-stone-100" : "border-stone-200 bg-white text-stone-950 hover:border-stone-400 hover:bg-stone-50 dark:border-stone-800 dark:bg-stone-950 dark:text-stone-100 dark:hover:border-stone-600 dark:hover:bg-stone-900"}`}
                            onClick={() => onSelect(protocol.value)}
                        >
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-sm font-semibold">{protocol.label}</span>
                                {active ? <Check className="size-4 shrink-0" aria-hidden /> : protocol.value === "custom" ? <WandSparkles className="size-4 shrink-0" aria-hidden /> : <PlugZap className="size-4 shrink-0" aria-hidden />}
                            </div>
                            <div className={`mt-1 text-xs leading-5 ${active ? "text-stone-600 dark:text-stone-300" : "text-stone-500 dark:text-stone-400"}`}>{protocol.description}</div>
                            <div className="mt-2 flex flex-wrap gap-1">
                                {definition.capabilities.map((capability) => (
                                    <span
                                        key={capability}
                                        className={`rounded border px-1.5 py-0.5 text-[11px] ${active ? "border-stone-400 bg-white text-stone-800 dark:border-stone-600 dark:bg-stone-950 dark:text-stone-200" : "border-stone-200 text-stone-700 dark:border-stone-700 dark:text-stone-300"}`}
                                    >
                                        {capabilityLabel(capability)}
                                    </span>
                                ))}
                            </div>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

function ConnectionStep({ channel, onChange }: { channel: SystemModelChannel; onChange: (patch: Partial<SystemModelChannel>) => void }) {
    const custom = channel.advancedConfig?.protocol === "custom";
    const gcpAgentPlatform = channel.advancedConfig?.protocol === "gcp-agent-platform";
    const authMode = resolveChannelAuthMode(channel.advancedConfig);
    const requiresApiKey = channelRequiresApiKey(channel);
    const updateAuth = (patch: Partial<NonNullable<SystemModelChannel["advancedConfig"]>>) => onChange({ advancedConfig: { ...channel.advancedConfig!, ...patch } });
    return (
        <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
                <LabeledControl label="渠道名称">
                    <Input value={channel.name} placeholder="例如：生产主渠道" onChange={(event) => onChange({ name: event.target.value })} />
                </LabeledControl>
                {gcpAgentPlatform ? (
                    <GcpAgentPlatformFields channel={channel} onChange={onChange} />
                ) : (
                    <LabeledControl label="Base URL">
                        <Input value={channel.baseUrl} placeholder="https://api.example.com" onChange={(event) => onChange({ baseUrl: event.target.value })} />
                    </LabeledControl>
                )}
                {custom ? (
                    <LabeledControl label="鉴权方式">
                        <Select className="w-full" value={authMode} options={authModeOptions} onChange={(value: SystemChannelAuthMode) => updateAuth({ authMode: value, ...(value !== "custom-header" ? { authHeader: "", authPrefix: "" } : {}) })} />
                    </LabeledControl>
                ) : null}
                {custom && authMode === "custom-header" ? (
                    <>
                        <LabeledControl label="鉴权 Header">
                            <Input value={channel.advancedConfig?.authHeader} placeholder="例如 X-API-Key" onChange={(event) => updateAuth({ authHeader: event.target.value })} />
                        </LabeledControl>
                        <LabeledControl label="值前缀（可选）">
                            <Input value={channel.advancedConfig?.authPrefix} placeholder="例如 Token" onChange={(event) => updateAuth({ authPrefix: event.target.value })} />
                        </LabeledControl>
                    </>
                ) : null}
                {requiresApiKey ? (
                    <div className="sm:col-span-2">
                        <LabeledControl label="API Key">
                            <Input.Password value={channel.apiKey} autoComplete="off" placeholder="仅保存在服务端" onChange={(event) => onChange({ apiKey: event.target.value, clearApiKey: false })} />
                        </LabeledControl>
                    </div>
                ) : (
                    <div className="sm:col-span-2 border-y border-stone-200 py-3 text-sm text-stone-600 dark:border-stone-800 dark:text-stone-300">
                        {gcpAgentPlatform ? "ADC 由应用容器读取并自动刷新访问令牌。" : "当前协议无需 API Key，服务端不会发送鉴权请求头。"}
                    </div>
                )}
            </div>
            {custom ? <AdminChannelProtocolSetup channel={channel} protocolLocked onChange={onChange} /> : <ProtocolLockedSummary channel={channel} />}
        </div>
    );
}

const authModeOptions: Array<{ label: string; value: SystemChannelAuthMode }> = [
    { label: "无需鉴权", value: "none" },
    { label: "Bearer Token", value: "bearer" },
    { label: "X-API-Key", value: "x-api-key" },
    { label: "自定义 Header", value: "custom-header" },
];

function ProtocolLockedSummary({ channel }: { channel: SystemModelChannel }) {
    const definition = channelProtocolDefinition(channel.advancedConfig?.protocol || "auto");
    return (
        <div className="border-y border-stone-200 py-3 dark:border-stone-800">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                    <div className="text-sm font-semibold text-stone-950 dark:text-stone-100">{definition.label}</div>
                    <div className="mt-1 text-xs text-stone-500 dark:text-stone-400">内置协议参数由注册表固定，渠道只保存地址、凭据和模型。</div>
                </div>
                <Tag className="m-0 !border-stone-300 !bg-stone-50 !text-stone-700 dark:!border-stone-700 dark:!bg-stone-900 dark:!text-stone-200">{definition.strict ? "严格协议" : "兼容协议"}</Tag>
            </div>
        </div>
    );
}

function ModelStep({ channel, fetching, onChange, onFetch }: { channel: SystemModelChannel; fetching: boolean; onChange: (patch: Partial<SystemModelChannel>) => void; onFetch: () => void }) {
    const canSync = channelSupportsModelCatalog(channel);
    const definition = channelProtocolDefinition(channel.advancedConfig?.protocol || "auto");
    const hasDocumentedModels = Boolean(definition.builtInModels?.length);
    const manualCapabilityOptions = definition.capabilities.map((capability) => ({ label: capabilityLabel(capability), value: capability }));
    const updateModels = (models: string[]) => {
        const nextModels = models.map((model) => model.trim()).filter(Boolean);
        if (canSync) return onChange({ models: nextModels });
        const advanced = channel.advancedConfig!;
        const modelCapabilities = { ...(advanced.modelCapabilities || {}) };
        const modelConfigs = { ...(advanced.modelConfigs || {}) };
        for (const model of nextModels) {
            const key = normalizeModelId(model);
            const inferred = modelCapabilities[key] || inferModelCapability(model);
            const capability = definition.capabilities.includes(inferred) ? inferred : definition.capabilities[0];
            if (!capability) continue;
            modelCapabilities[key] = capability;
            const config = protocolModelConfig(advanced.protocol, capability);
            if (config) modelConfigs[key] = config;
        }
        onChange({ models: nextModels, advancedConfig: { ...advanced, modelCapabilities, modelConfigs } });
    };
    const updateCapability = (model: string, capability: LogicalModelCapability) => {
        const advanced = channel.advancedConfig!;
        const key = normalizeModelId(model);
        const config = protocolModelConfig(advanced.protocol, capability);
        onChange({
            advancedConfig: {
                ...advanced,
                modelCapabilities: { ...(advanced.modelCapabilities || {}), [key]: capability },
                modelConfigs: { ...(advanced.modelConfigs || {}), ...(config ? { [key]: config } : {}) },
            },
        });
    };
    return (
        <div>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 pb-3 dark:border-stone-800">
                <div>
                    <div className="text-sm font-semibold text-stone-950 dark:text-stone-100">上游模型</div>
                    <div className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                        {canSync ? "同步只会合并模型，不删除手工模型。" : hasDocumentedModels ? `已按官方文档预置 ${definition.builtInModels?.length} 个模型，无需目录同步。` : "当前协议没有公开模型目录，请填写上游提供的真实模型 ID。"}
                    </div>
                </div>
                {canSync ? (
                    <Button icon={<RefreshCw className="size-4" />} loading={fetching} onClick={onFetch}>
                        同步模型
                    </Button>
                ) : null}
            </div>
            {!canSync ? (
                <div className="mb-4 flex items-start gap-2 border-y border-stone-200 py-3 text-sm leading-6 text-stone-600 dark:border-stone-800 dark:text-stone-300">
                    <Info className="mt-1 size-4 shrink-0 text-stone-400" aria-hidden />
                    <span>
                        {hasDocumentedModels
                            ? "模型 ID 已按官方新版文档写入协议配置；系统不会请求旧版 /v1/models。"
                            : definition.id === "yumeng"
                              ? "昱梦新版只公开了 V2 任务接口。请从上游控制台或文档复制模型 ID，在下方输入后按 Enter；系统不会请求旧版 /v1/models。"
                              : "当前协议未配置模型目录。请从上游控制台或文档复制模型 ID，在下方输入后按 Enter。"}
                    </span>
                </div>
            ) : null}
            <LabeledControl label="模型 ID">
                <Select
                    mode="tags"
                    className="w-full"
                    maxTagCount="responsive"
                    tokenSeparators={[",", "，", "\n"]}
                    disabled={hasDocumentedModels}
                    value={channel.models}
                    placeholder={canSync ? "同步模型，或输入模型 ID 后按 Enter" : hasDocumentedModels ? "官方文档模型已预置" : "输入模型 ID 后按 Enter，可添加多个"}
                    onChange={updateModels}
                />
            </LabeledControl>
            <div className="mt-4 divide-y divide-stone-200 border-y border-stone-200 dark:divide-stone-800 dark:border-stone-800">
                {channel.models.map((model) => (
                    <div key={model} className="flex min-w-0 items-center justify-between gap-3 py-2.5">
                        <span className="min-w-0 truncate text-sm font-medium text-stone-900 dark:text-stone-100">{model}</span>
                        {canSync || hasDocumentedModels || manualCapabilityOptions.length <= 1 ? (
                            <Tag className="m-0">{capabilityLabel(channelModelCapability(channel, model))}</Tag>
                        ) : (
                            <div className="w-24 shrink-0">
                                <Select className="w-full" size="small" value={channelModelCapability(channel, model)} options={manualCapabilityOptions} onChange={(capability: LogicalModelCapability) => updateCapability(model, capability)} />
                            </div>
                        )}
                    </div>
                ))}
                {!channel.models.length ? <div className="py-8 text-center text-sm text-stone-500 dark:text-stone-400">{canSync ? "尚未获得模型" : "请先添加至少一个模型 ID"}</div> : null}
            </div>
        </div>
    );
}

function BindingStep({
    channel,
    logicalModels,
    setAsDefault,
    onSetAsDefault,
    onSynchronize,
}: {
    channel: SystemModelChannel;
    logicalModels: ChannelWorkspaceSettings["logicalModels"];
    setAsDefault: boolean;
    onSetAsDefault: (value: boolean) => void;
    onSynchronize: () => void;
}) {
    return (
        <div className="space-y-4">
            <ChannelInfoNote title="逻辑模型由渠道目录自动维护" description="同名上游模型会跨渠道合并；没有同名项时会按上游模型名建立独立逻辑模型，创建后可在逻辑模型页设置前端展示昵称。" />
            <div className="divide-y divide-stone-200 border-y border-stone-200 dark:divide-stone-800 dark:border-stone-800">
                {channel.models.map((upstreamModel) => {
                    const logical = logicalModels.find((model) => model.bindings.some((binding) => normalizedUpstreamModel(binding.upstreamModel) === normalizedUpstreamModel(upstreamModel)));
                    return (
                        <div key={upstreamModel} className="flex min-w-0 items-center justify-between gap-3 py-2.5 text-sm">
                            <div className="min-w-0">
                                <div className="truncate font-medium text-stone-950 dark:text-stone-100">{upstreamModel}</div>
                                <div className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">{capabilityLabel(channelModelCapability(channel, upstreamModel))}</div>
                            </div>
                            <Tag className="m-0 shrink-0">{logical?.name || displayUpstreamModel(upstreamModel)}</Tag>
                        </div>
                    );
                })}
            </div>
            <div className="flex min-h-10 items-center justify-between gap-3 border-b border-stone-200 pb-4 dark:border-stone-800">
                <span className="text-sm text-stone-700 dark:text-stone-300">为尚未配置的能力设置默认模型</span>
                <Switch checked={setAsDefault} onChange={onSetAsDefault} />
            </div>
            <Button type="primary" icon={<Link2 className="size-4" />} onClick={onSynchronize}>
                同步并自动合并
            </Button>
        </div>
    );
}

function normalizedUpstreamModel(value: string) {
    return displayUpstreamModel(value).toLowerCase();
}

function displayUpstreamModel(value: string) {
    return value.trim().replace(/^models\//i, "");
}

function ReviewStep({ channel, settings }: { channel: SystemModelChannel; settings: ChannelWorkspaceSettings }) {
    const bindings = settings.logicalModels.flatMap((model) => model.bindings.filter((binding) => binding.channelId === channel.id).map((binding) => ({ logical: model, binding })));
    return (
        <div className="space-y-5">
            <div className="grid gap-x-6 gap-y-4 border-y border-stone-200 py-4 sm:grid-cols-2 dark:border-stone-800">
                <ReviewValue label="渠道" value={channel.name} />
                <ReviewValue label="协议" value={channelProtocolDefinition(channel.advancedConfig?.protocol || "auto").label} />
                <ReviewValue label="Base URL" value={channel.baseUrl} />
                {channel.advancedConfig?.protocol === "gcp-agent-platform" ? <ReviewValue label="GCP 项目 / 区域" value={`${channel.advancedConfig.gcpProjectId || "未配置"} / ${channel.advancedConfig.gcpLocation || "global"}`} /> : null}
                <ReviewValue label="上游模型" value={`${channel.models.length} 个`} />
                <ReviewValue label="验证方式" value="用户工作台真实调用" />
                <ReviewValue label="逻辑绑定" value={`${bindings.length} 个`} />
            </div>
            <div>
                <div className="mb-2 text-sm font-semibold text-stone-950 dark:text-stone-100">模型绑定</div>
                <div className="divide-y divide-stone-200 border-y border-stone-200 dark:divide-stone-800 dark:border-stone-800">
                    {bindings.map(({ logical, binding }) => (
                        <div key={binding.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                            <span>{logical.name}</span>
                            <span className="min-w-0 truncate text-stone-500 dark:text-stone-400">{binding.upstreamModel}</span>
                        </div>
                    ))}
                </div>
            </div>
            <ChannelInfoNote title="启用后请在用户工作台验证" description="文本、图片、视频和音频能力以对应工作台的真实业务请求为准。" />
            <div className="flex items-start gap-2 text-xs leading-5 text-stone-500 dark:text-stone-400">
                <CircleDollarSign className="mt-0.5 size-4 shrink-0" />
                <span>用户积分仍按逻辑模型配置；上游模型名只用于真实请求。</span>
            </div>
        </div>
    );
}

function ReviewValue({ label, value }: { label: string; value: string }) {
    return (
        <div className="min-w-0">
            <div className="text-xs text-stone-500 dark:text-stone-400">{label}</div>
            <div className="mt-1 break-all text-sm font-medium text-stone-950 dark:text-stone-100">{value || "未设置"}</div>
        </div>
    );
}

function ChannelInfoNote({ title, description }: { title: string; description: string }) {
    return (
        <div className="flex items-start gap-3 border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-emerald-950 dark:border-emerald-800/70 dark:bg-emerald-950/25 dark:text-emerald-50">
            <Info className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
            <div className="min-w-0">
                <div className="text-sm font-semibold leading-6">{title}</div>
                <div className="mt-0.5 text-sm leading-6 text-stone-600 dark:text-stone-300">{description}</div>
            </div>
        </div>
    );
}
