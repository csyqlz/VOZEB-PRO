"use client";

import { useState } from "react";
import { App, Button, Checkbox, Input, Popconfirm, Select, Switch, Tag, Tooltip } from "antd";
import { Eye, EyeOff, PlugZap, RefreshCw, Sparkles, Trash2 } from "lucide-react";

import { LabeledControl } from "@/components/admin/admin-settings-controls";
import { parseChannelExampleConfig } from "@/lib/channel-example-parser";
import { buildGlobalAiOpcSelection, GLOBAL_AIOPC_PRESETS, globalAiOpcPresetOptions, resolveGlobalAiOpcCatalogPresets, resolveGlobalAiOpcPresets } from "@/lib/globalaiopc-catalog";
import type { LogicalModelCapability, SystemChannelAdvancedConfig, SystemChannelModelConfig, SystemChannelProtocol, SystemModelChannel } from "@/lib/auth/store";
import { capabilityLabel, channelDetectedCapabilities, channelModelCapability } from "@/lib/model-routing-config";
import { normalizeModelId } from "@/lib/model-capability";
import { revealAdminChannelApiKey } from "@/services/api/admin-settings";
import { AdminChannelProtocolSetup } from "@/components/admin/admin-channel-protocol-setup";
import { applyModelProtocol, channelProtocolDefinition, channelProtocolOptions, channelRequiresApiKey, channelSupportsModelCatalog, emptyAdvancedConfig } from "@/lib/channel-protocol-registry";

const protocolOptions = channelProtocolOptions().map(({ value, label }) => ({ value, label }));
const ALL_GLOBAL_AIOPC_PRESETS = "__all_globalaiopc_presets__";
const IMAGE_TEMPLATE_VARIABLE_HELP = "图片动态变量：{{ratio}} / {{aspect_ratio}}、{{size}}、{{resolution}} / {{quality}}、{{width}} / {{height}}、{{n}} / {{count}} / {{num_images}} / {{batch_size}}";
const modelCapabilityOptions: Array<{ label: string; value: LogicalModelCapability }> = [
    { label: "文本", value: "text" },
    { label: "图片", value: "image" },
    { label: "视频", value: "video" },
    { label: "音频", value: "audio" },
];

export function createDefaultChannelAdvancedConfig(): SystemChannelAdvancedConfig {
    return emptyAdvancedConfig();
}

export function SystemChannelEditor({ channel, fetching, onChange, onDelete, onFetchModels }: { channel: SystemModelChannel; fetching: boolean; onChange: (patch: Partial<SystemModelChannel>) => void; onDelete: () => void; onFetchModels: () => void }) {
    const { message } = App.useApp();
    const [exampleText, setExampleText] = useState("");
    const [revealedApiKey, setRevealedApiKey] = useState("");
    const [apiKeyVisible, setApiKeyVisible] = useState(false);
    const [apiKeyLoading, setApiKeyLoading] = useState(false);
    const advanced = channel.advancedConfig || createDefaultChannelAdvancedConfig();
    const protocolDefinition = channelProtocolDefinition(advanced.protocol);
    const canSyncModels = channelSupportsModelCatalog(channel);
    const hasDocumentedModels = Boolean(protocolDefinition.builtInModels?.length);
    const capabilitySummary = channelCapabilitySummary(channel);
    const detectedCapabilities = channelDetectedCapabilities(channel);
    const selectedGlobalPresets = resolveGlobalAiOpcPresets(advanced);
    const multipleGlobalPresets = advanced.protocol === "globalaiopc" && selectedGlobalPresets.length > 1;
    const updateAdvanced = (patch: Partial<SystemChannelAdvancedConfig>) => onChange({ advancedConfig: { ...advanced, ...patch } });
    const applyGlobalAiOpcPresets = (values: string[]) => {
        const requested = values.includes(ALL_GLOBAL_AIOPC_PRESETS)
            ? (resolveGlobalAiOpcCatalogPresets(channel.baseUrl, { protocol: "auto" }).length ? resolveGlobalAiOpcCatalogPresets(channel.baseUrl, { protocol: "auto" }) : GLOBAL_AIOPC_PRESETS).map((preset) => preset.id)
            : values;
        const selection = buildGlobalAiOpcSelection(requested);
        if (!selection.presetIds.length) return updateAdvanced({ globalAiOpcPreset: undefined, globalAiOpcPresets: [] });
        const onlyPreset = selection.presetIds.length === 1;
        const preset = onlyPreset ? GLOBAL_AIOPC_PRESETS.find((item) => item.id === selection.presetIds[0]) : undefined;
        onChange({
            baseUrl: selection.baseUrl || channel.baseUrl,
            apiFormat: selection.apiFormat,
            models: selection.models,
            advancedConfig: {
                ...advanced,
                protocol: "globalaiopc",
                globalAiOpcPreset: onlyPreset ? selection.presetIds[0] : undefined,
                globalAiOpcPresets: selection.presetIds,
                textModel: selection.textModel,
                imageModel: selection.imageModel,
                videoModel: selection.videoModel,
                createPath: selection.createPath,
                queryPath: selection.queryPath,
                requestTemplate: "",
                resultField: preset?.capability === "image" ? "data[0].url / url / image_url" : preset?.capability === "video" ? "video_url / media_url / result_url / url" : "",
                statusField: preset?.capability === "text" ? "" : "status / state",
                durationRange: selection.durationRange,
                referenceRule: selection.supportsReferenceImage || selection.supportsReferenceVideo || selection.supportsReferenceAudio ? "参考素材使用可被上游访问的公网 URL；由服务器在提交前生成受控访问地址。" : "",
                supportsReferenceImage: selection.supportsReferenceImage,
                supportsReferenceVideo: selection.supportsReferenceVideo,
                supportsReferenceAudio: selection.supportsReferenceAudio,
            },
        });
    };
    const applyExampleConfig = () => {
        const parsed = parseChannelExampleConfig(exampleText, channel, advanced);
        if (!parsed) {
            message.error("请粘贴上游 cURL、请求 JSON 或返回示例");
            return;
        }
        onChange(parsed.patch);
        message.success(`已识别并填入：${parsed.summary.slice(0, 4).join("、")}`);
    };
    const hideApiKey = () => {
        setApiKeyVisible(false);
        setRevealedApiKey("");
    };
    const toggleApiKey = async () => {
        if (apiKeyVisible) {
            hideApiKey();
            return;
        }
        if (channel.apiKey) {
            setApiKeyVisible(true);
            return;
        }
        if (!channel.hasApiKey) return;

        setApiKeyLoading(true);
        try {
            setRevealedApiKey(await revealAdminChannelApiKey(channel.id));
            setApiKeyVisible(true);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取 API Key 失败");
        } finally {
            setApiKeyLoading(false);
        }
    };
    const clearApiKey = () => {
        hideApiKey();
        onChange({ apiKey: "", hasApiKey: false, clearApiKey: true });
    };
    const displayedApiKey = channel.apiKey || revealedApiKey;
    const requiresApiKey = channelRequiresApiKey(channel);
    return (
        <>
            <div className="rounded-lg border border-stone-200 bg-white p-3 shadow-sm shadow-stone-200/40 sm:p-4 dark:border-stone-800 dark:bg-stone-950 dark:shadow-black/20">
                <div className="flex items-start justify-between gap-2 sm:flex-col sm:gap-3 lg:flex-row lg:justify-between">
                    <div className="min-w-0 flex-1 sm:flex-initial">
                        <div className="flex flex-wrap items-center gap-2">
                            <div className="flex items-center gap-2 text-sm font-semibold text-stone-950 dark:text-stone-100">
                                <PlugZap className="size-4 text-stone-400" />
                                <span className="truncate">{channel.name || "未命名渠道"}</span>
                            </div>
                            <Tag color={channel.enabled ? "green" : "default"} className="m-0">
                                {channel.enabled ? "启用" : "停用"}
                            </Tag>
                            <Tag className="m-0">{channel.models.length} 个模型</Tag>
                            {capabilitySummary ? <Tag className="m-0">{capabilitySummary}</Tag> : null}
                        </div>
                        <div className="mt-1 truncate text-xs text-stone-500 dark:text-stone-400">{channel.baseUrl || "未填写 Base URL"}</div>
                        <div className="mt-1 text-xs text-stone-400 dark:text-stone-500">
                            {canSyncModels
                                ? requiresApiKey
                                    ? "填写名称、Base URL 和 API Key，再同步上游模型。"
                                    : "填写名称和 Base URL 后即可同步上游模型；当前协议无需 API Key。"
                                : hasDocumentedModels
                                  ? "填写连接信息后即可使用官方文档预置模型。"
                                  : "填写连接信息后手动添加上游模型 ID。"}
                        </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 sm:w-full sm:justify-start sm:gap-2 lg:w-auto lg:justify-end">
                        <Switch checkedChildren="启用" unCheckedChildren="停用" checked={channel.enabled} onChange={(enabled) => onChange({ enabled })} />
                        <Popconfirm title="删除这个接口渠道？" description="关联的逻辑模型绑定会同步移除；失去绑定的模型和默认值也会清理。" okText="删除" cancelText="取消" onConfirm={onDelete}>
                            <Button size="small" danger icon={<Trash2 className="size-3.5" />} aria-label="删除渠道" title="删除渠道" />
                        </Popconfirm>
                    </div>
                </div>
                <AdminChannelProtocolSetup channel={channel} onChange={onChange} />
                <div className="mt-3 grid gap-3 sm:mt-4 lg:grid-cols-[180px_minmax(0,1fr)_minmax(220px,0.8fr)]">
                    <LabeledControl label="渠道名称">
                        <Input value={channel.name} placeholder="青岩智影、123NHH、自建接口" onChange={(event) => onChange({ name: event.target.value })} />
                    </LabeledControl>
                    <LabeledControl label="Base URL">
                        <Input value={channel.baseUrl} placeholder="https://api.example.com/v1" onChange={(event) => onChange({ baseUrl: event.target.value })} />
                    </LabeledControl>
                    {requiresApiKey ? (
                        <LabeledControl label="API Key">
                            <div className="flex min-w-0 items-center gap-2">
                                <Input
                                    type={apiKeyVisible ? "text" : "password"}
                                    value={displayedApiKey}
                                    placeholder={channel.hasApiKey ? "已安全保存，留空不修改" : "sk-..."}
                                    autoComplete="off"
                                    spellCheck={false}
                                    onChange={(event) => {
                                        setRevealedApiKey(event.target.value);
                                        onChange({ apiKey: event.target.value, clearApiKey: false });
                                    }}
                                    suffix={
                                        <Tooltip title={apiKeyVisible ? "隐藏 API Key" : "查看 API Key"}>
                                            <Button
                                                type="text"
                                                size="small"
                                                loading={apiKeyLoading}
                                                disabled={!displayedApiKey && !channel.hasApiKey}
                                                icon={apiKeyVisible ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                                                aria-label={apiKeyVisible ? "隐藏 API Key" : "查看 API Key"}
                                                onClick={() => void toggleApiKey()}
                                            />
                                        </Tooltip>
                                    }
                                />
                                {channel.hasApiKey ? (
                                    <Popconfirm title="清除已保存的 API Key？" okText="清除" cancelText="取消" onConfirm={clearApiKey}>
                                        <Button size="small" danger className="shrink-0">
                                            清除
                                        </Button>
                                    </Popconfirm>
                                ) : null}
                            </div>
                        </LabeledControl>
                    ) : (
                        <LabeledControl label="鉴权">
                            <Input value="无需 API Key" disabled />
                        </LabeledControl>
                    )}
                </div>
                <details className="mt-3 rounded-lg border border-stone-200 bg-stone-50/70 dark:border-stone-800 dark:bg-stone-900/40">
                    <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-stone-800 dark:text-stone-100">高级设置</summary>
                    <div className="grid gap-3 border-t border-stone-200 p-3 md:grid-cols-2 dark:border-stone-800">
                        {protocolDefinition.advanced && advanced.protocol !== "custom" ? (
                            <div className="md:col-span-2 rounded-lg border border-dashed border-stone-300 bg-white/70 p-3 dark:border-stone-700 dark:bg-stone-950/50">
                                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                                    <div>
                                        <div className="text-sm font-semibold text-stone-800 dark:text-stone-100">上游示例识别</div>
                                        <div className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">粘贴文档里的 cURL、请求 JSON 或返回 JSON，系统会自动填入协议、模型、路径、模板、结果字段和参考素材规则；不会请求上游。</div>
                                    </div>
                                    <Button size="small" icon={<Sparkles className="size-3.5" />} onClick={applyExampleConfig}>
                                        识别示例并填入
                                    </Button>
                                </div>
                                <Input.TextArea
                                    className="mt-3"
                                    value={exampleText}
                                    rows={5}
                                    placeholder='例如：curl https://api.example.com/v1/images/edits ... -d {"model":"gpt-image-2","prompt":"...","image":"https://..."}'
                                    onChange={(event) => setExampleText(event.target.value)}
                                />
                            </div>
                        ) : null}
                        {advanced.protocol === "globalaiopc" ? (
                            <LabeledControl label="GlobalAiOpc 接口范围">
                                <Select
                                    allowClear
                                    className="w-full"
                                    mode="multiple"
                                    maxTagCount={1}
                                    maxTagPlaceholder={(omitted) => `另 ${omitted.length} 个接口`}
                                    placeholder="选择接口范围"
                                    value={selectedGlobalPresets.map((preset) => preset.id)}
                                    options={[
                                        { label: "快捷选择", options: [{ value: ALL_GLOBAL_AIOPC_PRESETS, label: "当前服务全部接口" }] },
                                        { label: "文本", options: globalAiOpcPresetOptions().filter((item) => item.capability === "text") },
                                        { label: "图片", options: globalAiOpcPresetOptions().filter((item) => item.capability === "image") },
                                        { label: "视频", options: globalAiOpcPresetOptions().filter((item) => item.capability === "video") },
                                    ]}
                                    onChange={applyGlobalAiOpcPresets}
                                />
                            </LabeledControl>
                        ) : null}
                        <LabeledControl label="模型目录路径">
                            <Select
                                disabled={!protocolDefinition.advanced}
                                className="w-full"
                                mode="tags"
                                maxTagCount="responsive"
                                value={advanced.modelCatalogPaths || []}
                                placeholder="默认 /v1/models；可填写多个非标准路径"
                                onChange={(modelCatalogPaths) => updateAdvanced({ modelCatalogPaths })}
                            />
                        </LabeledControl>
                        <LabeledControl label="模型列表">
                            <Select
                                disabled={Boolean(protocolDefinition.builtInModels?.length)}
                                className="w-full"
                                mode="tags"
                                maxTagCount="responsive"
                                tokenSeparators={[",", "，", "\n"]}
                                value={channel.models}
                                placeholder={canSyncModels ? "同步后自动填，也可输入模型 ID" : "输入模型 ID 后按 Enter，可添加多个"}
                                onChange={(models) => onChange({ models: models.map((model) => model.trim()).filter(Boolean) })}
                            />
                        </LabeledControl>
                        {detectedCapabilities.has("text") ? (
                            <>
                                <LabeledControl label="规划流式模式">
                                    <Select
                                        className="w-full"
                                        value={streamingMode(advanced.streaming)}
                                        options={[
                                            { label: "自动（Chat / Responses）", value: "auto" },
                                            { label: "启用已验证路径", value: "enabled" },
                                            { label: "关闭流式", value: "disabled" },
                                        ]}
                                        onChange={(value: "auto" | "enabled" | "disabled") =>
                                            updateAdvanced({
                                                streaming: value === "auto" ? undefined : { ...(advanced.streaming || {}), enabled: value === "enabled" },
                                            })
                                        }
                                    />
                                </LabeledControl>
                                <LabeledControl label="规划流式路径">
                                    <Input
                                        disabled={streamingMode(advanced.streaming) !== "enabled"}
                                        value={advanced.streaming?.path || ""}
                                        placeholder="例如 /models/:model:streamGenerateContent"
                                        onChange={(event) => updateAdvanced({ streaming: { ...(advanced.streaming || {}), enabled: true, path: event.target.value } })}
                                    />
                                </LabeledControl>
                                <LabeledControl label="流式格式">
                                    <Select
                                        className="w-full"
                                        disabled={streamingMode(advanced.streaming) !== "enabled"}
                                        value={advanced.streaming?.format || "sse"}
                                        options={[
                                            { label: "SSE", value: "sse" },
                                            { label: "NDJSON", value: "ndjson" },
                                        ]}
                                        onChange={(format: "sse" | "ndjson") => updateAdvanced({ streaming: { ...(advanced.streaming || {}), enabled: true, format } })}
                                    />
                                </LabeledControl>
                            </>
                        ) : null}
                        {detectedCapabilities.has("text") ? (
                            <LabeledControl label="文本模型">
                                <Input value={advanced.textModel} placeholder="检测后自动填" onChange={(event) => updateAdvanced({ textModel: event.target.value })} />
                            </LabeledControl>
                        ) : null}
                        {detectedCapabilities.has("image") ? (
                            <LabeledControl label="图片模型">
                                <Input value={advanced.imageModel} placeholder="检测后自动填" onChange={(event) => updateAdvanced({ imageModel: event.target.value })} />
                            </LabeledControl>
                        ) : null}
                        {detectedCapabilities.has("video") ? (
                            <LabeledControl label="视频模型">
                                <Input value={advanced.videoModel} placeholder="检测后自动填" onChange={(event) => updateAdvanced({ videoModel: event.target.value })} />
                            </LabeledControl>
                        ) : null}
                        <ModelRouteConfigEditor channel={channel} advanced={advanced} onChange={updateAdvanced} />
                        {protocolDefinition.advanced ? (
                            <>
                                {detectedCapabilities.has("video") ? (
                                    <LabeledControl label="兜底时长规则">
                                        <Input
                                            disabled={multipleGlobalPresets}
                                            value={advanced.durationRange}
                                            placeholder={multipleGlobalPresets ? "按模型自动匹配" : "例如：5、8、10 秒或 4-15 秒"}
                                            onChange={(event) => updateAdvanced({ durationRange: event.target.value })}
                                        />
                                    </LabeledControl>
                                ) : null}
                                <LabeledControl label="兜底创建路径">
                                    <Input
                                        disabled={multipleGlobalPresets}
                                        value={advanced.createPath}
                                        placeholder={multipleGlobalPresets ? "按模型自动路由" : "/video/generations"}
                                        onChange={(event) => updateAdvanced({ createPath: event.target.value })}
                                    />
                                </LabeledControl>
                                {detectedCapabilities.has("image") ? (
                                    <LabeledControl label="兜底图生图路径">
                                        <Input disabled={multipleGlobalPresets} value={advanced.editPath} placeholder={multipleGlobalPresets ? "按模型自动路由" : "/images/edits"} onChange={(event) => updateAdvanced({ editPath: event.target.value })} />
                                    </LabeledControl>
                                ) : null}
                                {detectedCapabilities.has("video") ? (
                                    <>
                                        <LabeledControl label="兜底图生视频路径">
                                            <Input
                                                disabled={multipleGlobalPresets}
                                                value={advanced.imageToVideoPath}
                                                placeholder={multipleGlobalPresets ? "按模型自动路由" : "/videos"}
                                                onChange={(event) => updateAdvanced({ imageToVideoPath: event.target.value })}
                                            />
                                        </LabeledControl>
                                        <LabeledControl label="兜底查询路径">
                                            <Input
                                                disabled={multipleGlobalPresets}
                                                value={advanced.queryPath}
                                                placeholder={multipleGlobalPresets ? "按模型自动路由" : "/video/generations/:task_id"}
                                                onChange={(event) => updateAdvanced({ queryPath: event.target.value })}
                                            />
                                        </LabeledControl>
                                    </>
                                ) : null}
                                <LabeledControl label="结果字段">
                                    <Input value={advanced.resultField} placeholder="例如：data[0].url / content.video_url" onChange={(event) => updateAdvanced({ resultField: event.target.value })} />
                                </LabeledControl>
                                <LabeledControl label="状态字段">
                                    <Input value={advanced.statusField} placeholder="例如：status / state" onChange={(event) => updateAdvanced({ statusField: event.target.value })} />
                                </LabeledControl>
                                <div className="md:col-span-2">
                                    <LabeledControl label="请求字段模板">
                                        <Input.TextArea value={advanced.requestTemplate} rows={3} placeholder='{"model":"{{model}}","prompt":"{{prompt}}"}' onChange={(event) => updateAdvanced({ requestTemplate: event.target.value })} />
                                    </LabeledControl>
                                    {detectedCapabilities.has("image") ? <div className="mt-1 text-[11px] leading-5 text-stone-500 dark:text-stone-400">{IMAGE_TEMPLATE_VARIABLE_HELP}</div> : null}
                                </div>
                                <div className="md:col-span-2">
                                    <LabeledControl label="参考素材规则">
                                        <Input.TextArea value={advanced.referenceRule} rows={3} placeholder="例如：参考图必须是公网 URL；单图字段 image，多图字段 images。" onChange={(event) => updateAdvanced({ referenceRule: event.target.value })} />
                                    </LabeledControl>
                                </div>
                                <div className="md:col-span-2">
                                    <div className="mb-1.5 text-xs font-medium text-stone-500 dark:text-stone-400">参考素材能力</div>
                                    <div className="flex flex-wrap gap-4">
                                        <Checkbox checked={advanced.supportsReferenceImage} onChange={(event) => updateAdvanced({ supportsReferenceImage: event.target.checked })}>
                                            支持参考图
                                        </Checkbox>
                                        <Checkbox checked={advanced.supportsReferenceVideo} onChange={(event) => updateAdvanced({ supportsReferenceVideo: event.target.checked })}>
                                            支持参考视频
                                        </Checkbox>
                                        <Checkbox checked={advanced.supportsReferenceAudio} onChange={(event) => updateAdvanced({ supportsReferenceAudio: event.target.checked })}>
                                            支持参考音频
                                        </Checkbox>
                                    </div>
                                </div>
                            </>
                        ) : (
                            <div className="md:col-span-2 text-xs leading-5 text-stone-500 dark:text-stone-400">当前协议的路径、请求字段、结果字段和参考素材能力由协议注册表固定；如需非标准字段，请在模型级路由中选择“自定义协议”。</div>
                        )}
                        {canSyncModels ? (
                            <div className="flex flex-wrap gap-2 md:col-span-2">
                                <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={fetching} onClick={onFetchModels}>
                                    拉取模型
                                </Button>
                            </div>
                        ) : null}
                        <div className="text-xs leading-5 text-stone-500 md:col-span-2 dark:text-stone-400">
                            {canSyncModels
                                ? "拉取会合并上游模型、官方目录和已有手工模型，不会覆盖手工配置；混合接口优先使用模型级路由，上方兜底字段只在模型没有专属配置时生效。"
                                : hasDocumentedModels
                                  ? "当前协议使用官方新版文档预置模型，不请求未公开的模型目录；真实任务继续使用协议注册表中的 V2 路径。"
                                  : "当前协议未公开模型目录，请在模型列表中手动维护真实模型 ID；任务仍严格使用协议注册表中的 V2 路径。"}
                        </div>
                    </div>
                </details>
            </div>
        </>
    );
}

function ModelRouteConfigEditor({ channel, advanced, onChange }: { channel: SystemModelChannel; advanced: SystemChannelAdvancedConfig; onChange: (patch: Partial<SystemChannelAdvancedConfig>) => void }) {
    const [selected, setSelected] = useState("");
    const models = channel.models;
    const selectedModel = models.some((model) => normalizeModelId(model) === normalizeModelId(selected)) ? models.find((model) => normalizeModelId(model) === normalizeModelId(selected)) || "" : models[0] || "";
    const key = normalizeModelId(selectedModel);
    const stored = key ? advanced.modelConfigs?.[key] : undefined;
    const config: SystemChannelModelConfig | undefined = selectedModel ? stored || { capability: channelModelCapability(channel, selectedModel) } : undefined;
    const selectedProtocol = config?.protocol || advanced.protocol;
    const definition = channelProtocolDefinition(selectedProtocol);
    const showImageEditPath = config?.capability === "image";
    const showImageToVideoPath = config?.capability === "video";
    const showAsyncFields = config?.capability === "video" || (!definition.strict && config?.capability !== "text");
    const write = (next: SystemChannelModelConfig) => {
        if (!key) return;
        onChange({
            modelCapabilities: { ...(advanced.modelCapabilities || {}), [key]: next.capability },
            modelConfigs: { ...(advanced.modelConfigs || {}), [key]: { ...next, source: "manual" } },
        });
    };
    const update = (patch: Partial<SystemChannelModelConfig>) => {
        if (!key || !config) return;
        write({ ...config, ...patch });
    };
    const selectProtocol = (protocol: SystemChannelProtocol | undefined) => config && write(applyModelProtocol(config, protocol || advanced.protocol, selectedModel));
    const selectCapability = (capability: LogicalModelCapability) => config && write(applyModelProtocol({ ...config, capability }, selectedProtocol, selectedModel));
    const clearRoutes = () => {
        if (!key || !config) return;
        const next = { ...(advanced.modelConfigs || {}) };
        delete next[key];
        onChange({ modelConfigs: next, modelCapabilities: { ...(advanced.modelCapabilities || {}), [key]: config.capability } });
    };

    return (
        <div className="rounded-md border border-stone-200 bg-white/70 p-3 md:col-span-2 dark:border-stone-800 dark:bg-stone-950/50">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                    <div className="text-xs font-semibold text-stone-800 dark:text-stone-100">模型级路由</div>
                    <div className="mt-1 text-[11px] leading-5 text-stone-500 dark:text-stone-400">同一公司接口包含多种能力时，每个模型独立保存协议与路径。</div>
                </div>
                {stored ? (
                    <Button type="text" size="small" onClick={clearRoutes}>
                        清除专属路径
                    </Button>
                ) : null}
            </div>
            {config ? (
                <>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        <LabeledControl label="模型">
                            <Select className="w-full" showSearch optionFilterProp="label" value={selectedModel} options={models.map((model) => ({ label: model, value: model }))} onChange={setSelected} />
                        </LabeledControl>
                        <LabeledControl label="能力">
                            <Select className="w-full" value={config.capability} options={definition.strict ? modelCapabilityOptions.filter((item) => definition.capabilities.includes(item.value)) : modelCapabilityOptions} onChange={selectCapability} />
                        </LabeledControl>
                        <LabeledControl label="API 格式">
                            <Select
                                className="w-full"
                                allowClear
                                placeholder="沿用渠道"
                                value={config.apiFormat}
                                options={[
                                    { label: "OpenAI", value: "openai" },
                                    { label: "Gemini", value: "gemini" },
                                ]}
                                onChange={(apiFormat) => update({ apiFormat })}
                            />
                        </LabeledControl>
                        <LabeledControl label="协议">
                            <Select className="w-full" allowClear placeholder="沿用渠道" value={config.protocol} options={protocolOptions} onChange={selectProtocol} />
                        </LabeledControl>
                        <LabeledControl label={config.capability === "text" ? "文本生成路径" : config.capability === "image" ? "文生图路径" : config.capability === "video" ? "文生视频路径" : "语音生成路径"}>
                            <Input
                                disabled={definition.strict}
                                value={config.createPath || ""}
                                placeholder={config.capability === "text" ? "/chat/completions" : config.capability === "video" ? "/videos" : "/images/generations"}
                                onChange={(event) => update({ createPath: event.target.value })}
                            />
                        </LabeledControl>
                        {showImageEditPath ? (
                            <LabeledControl label="图生图路径">
                                <Input disabled={definition.strict} value={config.editPath || ""} placeholder="/images/edits" onChange={(event) => update({ editPath: event.target.value })} />
                            </LabeledControl>
                        ) : null}
                        {showImageToVideoPath ? (
                            <LabeledControl label="图生视频路径">
                                <Input disabled={definition.strict} value={config.imageToVideoPath || ""} placeholder="/videos" onChange={(event) => update({ imageToVideoPath: event.target.value })} />
                            </LabeledControl>
                        ) : null}
                        {showAsyncFields ? (
                            <LabeledControl label="查询路径">
                                <Input disabled={definition.strict} value={config.queryPath || ""} placeholder="/videos/:task_id" onChange={(event) => update({ queryPath: event.target.value })} />
                            </LabeledControl>
                        ) : null}
                        {showAsyncFields ? (
                            <LabeledControl label="取消路径">
                                <Input disabled={definition.strict} value={config.cancelPath || ""} placeholder="/videos/:task_id/cancel" onChange={(event) => update({ cancelPath: event.target.value })} />
                            </LabeledControl>
                        ) : null}
                        {showAsyncFields && config.cancelPath ? (
                            <LabeledControl label="取消方式">
                                <Select
                                    className="w-full"
                                    disabled={definition.strict}
                                    value={config.cancelMethod || "POST"}
                                    options={[
                                        { label: "POST", value: "POST" },
                                        { label: "DELETE", value: "DELETE" },
                                    ]}
                                    onChange={(cancelMethod) => update({ cancelMethod })}
                                />
                            </LabeledControl>
                        ) : null}
                        <LabeledControl label="结果字段">
                            <Input disabled={definition.strict} value={config.resultField || ""} placeholder="video_url / data[0].url" onChange={(event) => update({ resultField: event.target.value })} />
                        </LabeledControl>
                        {showAsyncFields ? (
                            <LabeledControl label="状态字段">
                                <Input disabled={definition.strict} value={config.statusField || ""} placeholder="status / state" onChange={(event) => update({ statusField: event.target.value })} />
                            </LabeledControl>
                        ) : null}
                        {config.capability === "video" ? (
                            <LabeledControl label="时长规则">
                                <Input disabled={definition.strict} value={config.durationRange || ""} placeholder="5、8、10 秒或 4-15 秒" onChange={(event) => update({ durationRange: event.target.value })} />
                            </LabeledControl>
                        ) : null}
                    </div>
                    <details className="mt-3 border-t border-stone-200 pt-2 dark:border-stone-800">
                        <summary className="cursor-pointer text-xs font-medium text-stone-600 dark:text-stone-300">请求模板与参考素材</summary>
                        <div className="mt-3 grid gap-3 sm:grid-cols-2">
                            <div className="sm:col-span-2">
                                <LabeledControl label="请求字段模板">
                                    <Input.TextArea
                                        disabled={definition.strict}
                                        rows={3}
                                        value={config.requestTemplate || ""}
                                        placeholder='{"model":"{{model}}","prompt":"{{prompt}}"}'
                                        onChange={(event) => update({ requestTemplate: event.target.value })}
                                    />
                                </LabeledControl>
                                {config.capability === "image" ? <div className="mt-1 text-[11px] leading-5 text-stone-500 dark:text-stone-400">{IMAGE_TEMPLATE_VARIABLE_HELP}</div> : null}
                            </div>
                            <div className="sm:col-span-2 flex flex-wrap gap-4 text-xs text-stone-600 dark:text-stone-300">
                                <Checkbox disabled={definition.strict} checked={config.supportsReferenceImage === true} onChange={(event) => update({ supportsReferenceImage: event.target.checked })}>
                                    参考图片
                                </Checkbox>
                                <Checkbox disabled={definition.strict} checked={config.supportsReferenceVideo === true} onChange={(event) => update({ supportsReferenceVideo: event.target.checked })}>
                                    参考视频
                                </Checkbox>
                                <Checkbox disabled={definition.strict} checked={config.supportsReferenceAudio === true} onChange={(event) => update({ supportsReferenceAudio: event.target.checked })}>
                                    参考音频
                                </Checkbox>
                            </div>
                        </div>
                    </details>
                </>
            ) : (
                <div className="mt-3 text-xs text-stone-500 dark:text-stone-400">拉取或手动添加模型后可设置独立路由。</div>
            )}
        </div>
    );
}

function channelCapabilitySummary(channel: SystemModelChannel) {
    const counts = channel.models.reduce((result, model) => ({ ...result, [channelModelCapability(channel, model)]: result[channelModelCapability(channel, model)] + 1 }), { text: 0, image: 0, video: 0, audio: 0 } as Record<
        LogicalModelCapability,
        number
    >);
    return modelCapabilityOptions
        .filter(({ value }) => counts[value])
        .map(({ value }) => `${capabilityLabel(value)} ${counts[value]}`)
        .join(" · ");
}

function streamingMode(streaming: SystemChannelAdvancedConfig["streaming"]): "auto" | "enabled" | "disabled" {
    if (streaming?.enabled === false) return "disabled";
    if (streaming?.enabled === true) return "enabled";
    return "auto";
}
