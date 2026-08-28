import type { ApiCallFormat, LogicalModelCapability, SystemChannelAdvancedConfig, SystemChannelAuthMode, SystemChannelModelConfig, SystemChannelProtocol, SystemModelChannel } from "@/lib/auth/store-types";
import { inferModelCapability, normalizeModelId } from "@/lib/model-capability";
import { SEEDANCE_SPECIAL_MODELS } from "@/lib/seedance-special";
import { normalizeYumengModelCenterBaseUrl, YUMENG_DEFAULT_IMAGE_OPERATION, YUMENG_DEFAULT_VIDEO_OPERATION, YUMENG_MODEL_CENTER_BASE_URL, YUMENG_MODEL_CENTER_MODELS } from "@/lib/yumeng-model-center";

type ProtocolOperation = Omit<SystemChannelModelConfig, "capability" | "source" | "protocol" | "apiFormat"> & {
    capability: LogicalModelCapability;
};

export type ChannelProtocolDefinition = {
    id: SystemChannelProtocol;
    label: string;
    description: string;
    apiFormat: ApiCallFormat;
    authMode: SystemChannelAuthMode;
    defaultBaseUrl?: string;
    modelCatalogPaths: string[];
    capabilities: LogicalModelCapability[];
    operations: Partial<Record<LogicalModelCapability, ProtocolOperation>>;
    builtInModels?: ReadonlyArray<{ id: string; label: string; capability: LogicalModelCapability; operation?: ProtocolOperation }>;
    strict?: boolean;
    advanced?: boolean;
};

const openAiOperations: ChannelProtocolDefinition["operations"] = {
    text: { capability: "text", createPath: "/chat/completions", requestTemplate: '{"model":"{{model}}","messages":[{"role":"user","content":"{{prompt}}"}]}', resultField: "choices[0].message.content" },
    image: {
        capability: "image",
        createPath: "/images/generations",
        editPath: "/images/edits",
        requestTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","size":"{{size}}","quality":"{{quality}}"}',
        resultField: "data[0].url / data[0].b64_json",
        referenceRule: "文生图使用 /images/generations；参考图编辑使用 /images/edits multipart/form-data。",
        supportsReferenceImage: true,
    },
    video: {
        capability: "video",
        createPath: "/videos",
        imageToVideoPath: "/videos",
        queryPath: "/videos/:task_id",
        requestTemplate: "multipart/form-data: model、prompt、seconds、size、input_reference",
        resultField: "/videos/:task_id/content",
        statusField: "status",
        referenceRule: "参考图使用 multipart/form-data 的单个 input_reference 文件字段。",
        supportsReferenceImage: true,
    },
    audio: { capability: "audio", createPath: "/audio/speech", requestTemplate: '{"model":"{{model}}","input":"{{prompt}}","voice":"alloy","response_format":"mp3"}', resultField: "binary" },
};

const newApiOperations: ChannelProtocolDefinition["operations"] = {
    ...openAiOperations,
    video: {
        ...openAiOperations.video!,
        referenceRule: "单张普通参考图使用 multipart/form-data input_reference；多图、首尾帧或视频/音频参考使用 JSON content 多模态数组。",
        supportsReferenceImage: true,
        supportsReferenceVideo: true,
        supportsReferenceAudio: true,
    },
};

const geminiVideoOperation: ProtocolOperation = {
    capability: "video",
    createPath: "/models/:model:predictLongRunning",
    imageToVideoPath: "/models/:model:predictLongRunning",
    queryPath: "/models/:model/operations/:task_id",
    requestTemplate:
        '{"instances":[{"prompt":"{{prompt}}","image":"{{image}}","lastFrame":"{{last_frame}}","referenceImages":"{{references}}"}],"parameters":{"durationSeconds":"{{duration}}","aspectRatio":"{{ratio}}","resolution":"{{resolution}}","generateAudio":"{{generate_audio}}"}}',
    resultField: "response.generateVideoResponse.generatedSamples[0].video.uri",
    statusField: "done",
    durationRange: "4、6、8 秒",
    referenceRule: "服务端将参考图片转为 inlineData；支持普通参考图、首帧和尾帧，不支持参考视频或参考音频。",
    supportsReferenceImage: true,
    supportsReferenceVideo: false,
    supportsReferenceAudio: false,
};

const seedanceOperation: ProtocolOperation = {
    capability: "video",
    createPath: "/contents/generations/tasks",
    imageToVideoPath: "/contents/generations/tasks",
    queryPath: "/contents/generations/tasks/:task_id",
    requestTemplate: '{"model":"{{model}}","content":"{{content}}","ratio":"{{ratio}}","resolution":"{{resolution}}","duration":"{{duration}}","generate_audio":true,"watermark":false}',
    resultField: "content.video_url",
    statusField: "status",
    durationRange: "4-15 秒，具体范围以模型文档为准",
    referenceRule: "图片、视频和音频使用 content 多模态数组；首帧与尾帧分别使用 first_frame、last_frame 角色；媒体必须使用上游可访问的 URL 或供应商素材 ID。",
    supportsReferenceImage: true,
    supportsReferenceVideo: true,
    supportsReferenceAudio: true,
};

const seedanceSpecialOperation: ProtocolOperation = {
    capability: "video",
    createPath: "/v1/seedance-special/videos",
    imageToVideoPath: "/v1/seedance-special/videos",
    queryPath: "/v1/result/:task_id",
    requestTemplate: '{"model":"{{model}}","ratio":"{{ratio}}","duration":"{{duration}}","generate_audio":true,"return_last_frame":false,"seed":-1,"content":"{{content}}"}',
    resultField: "video_url",
    statusField: "status",
    durationRange: "4-15 秒",
    referenceRule: "严格使用 content 数组；图片/视频/音频只能是公网 URL 或 assetId://，禁止 base64。首帧、首尾帧和多模态参考不可混用；音频不能单独输入。",
    supportsReferenceImage: true,
    supportsReferenceVideo: true,
    supportsReferenceAudio: true,
};

const vozebRecommendedVideoOperation: ProtocolOperation = {
    capability: "video",
    createPath: "/v1/videos/generations",
    imageToVideoPath: "/v1/videos/generations",
    queryPath: "/v1/videos/generations/:task_id",
    requestTemplate:
        '{"model":"{{model}}","prompt":"{{prompt}}","duration":"{{duration}}","resolution":"{{resolution}}","generate_audio":"{{generate_audio}}","aspect_ratio":"{{aspect_ratio}}","images":"{{images}}","videos":"{{videos}}","audios":"{{audios}}"}',
    resultField: "metadata.url",
    statusField: "status",
    durationRange: "5-15 秒",
    referenceRule: "使用 application/json；参考图片、视频和音频分别写入 images、videos、audios 字符串数组。Seedance 2.0-fast-720p 仅支持参考图片且不支持声音生成。",
    supportsReferenceImage: true,
    supportsReferenceVideo: true,
    supportsReferenceAudio: true,
};

const stableDiffusionOperation: ProtocolOperation = {
    capability: "image",
    createPath: "/sdapi/v1/txt2img",
    editPath: "/sdapi/v1/img2img",
    requestTemplate: '{"prompt":"{{prompt}}","width":"{{width}}","height":"{{height}}","batch_size":1,"init_images":"{{images}}","override_settings":{"sd_model_checkpoint":"{{model}}"},"override_settings_restore_afterwards":true}',
    resultField: "images[0]",
    referenceRule: "文生图使用 txt2img；图生图使用 img2img，参考图写入 init_images 数组。",
    supportsReferenceImage: true,
};

export const registeredChannelProtocolDefinitions: ChannelProtocolDefinition[] = [
    {
        id: "openai",
        label: "OpenAI",
        description: "OpenAI 官方及严格兼容接口，支持文本、图片、视频和语音。",
        apiFormat: "openai",
        authMode: "bearer",
        modelCatalogPaths: ["/v1/models"],
        capabilities: ["text", "image", "video", "audio"],
        operations: openAiOperations,
        strict: true,
    },
    {
        id: "yumeng",
        label: "昱梦",
        description: "昱梦新版模型中心协议，统一提交和查询图片、视频异步任务。",
        apiFormat: "openai",
        authMode: "bearer",
        defaultBaseUrl: YUMENG_MODEL_CENTER_BASE_URL,
        modelCatalogPaths: [],
        builtInModels: YUMENG_MODEL_CENTER_MODELS,
        capabilities: ["image", "video"],
        operations: { image: YUMENG_DEFAULT_IMAGE_OPERATION, video: YUMENG_DEFAULT_VIDEO_OPERATION },
        strict: true,
    },
    {
        id: "gemini",
        label: "Google Gemini / Veo",
        description: "Google Gemini API 的 Veo 异步视频协议，使用 predictLongRunning 与 operation 轮询。",
        apiFormat: "gemini",
        authMode: "custom-header",
        defaultBaseUrl: "https://generativelanguage.googleapis.com",
        modelCatalogPaths: ["/v1beta/models"],
        capabilities: ["video"],
        operations: { video: geminiVideoOperation },
        strict: true,
    },
    {
        id: "seedance",
        label: "Seedance 2.0 / SD2",
        description: "Seedance 2.0 多模态视频协议。SD2 在这里不表示 Stable Diffusion。",
        apiFormat: "openai",
        authMode: "bearer",
        modelCatalogPaths: ["/models"],
        capabilities: ["video"],
        operations: { video: seedanceOperation },
        strict: true,
    },
    {
        id: "stable-diffusion",
        label: "Stable Diffusion（SD）",
        description: "Automatic1111 / Forge WebUI 图片协议；与 Seedance 2.0（SD2）视频协议完全独立。",
        apiFormat: "openai",
        authMode: "none",
        modelCatalogPaths: ["/sdapi/v1/sd-models"],
        capabilities: ["image"],
        operations: { image: stableDiffusionOperation },
        strict: true,
    },
    {
        id: "volcengine-video",
        label: "火山方舟视频",
        description: "火山方舟视频生成协议，仅配置视频模型与文生视频、图生视频任务路径。",
        apiFormat: "openai",
        authMode: "bearer",
        defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        modelCatalogPaths: ["/api/v3/models"],
        capabilities: ["video"],
        operations: { video: seedanceOperation },
        strict: true,
    },
    {
        id: "sub2api",
        label: "sub2api",
        description: "sub2api 聚合接口；文本沿用 OpenAI，图生图严格使用 image_urls 字符串数组。",
        apiFormat: "openai",
        authMode: "bearer",
        modelCatalogPaths: ["/v1/models"],
        capabilities: ["text", "image", "video", "audio"],
        operations: {
            ...openAiOperations,
            image: {
                ...openAiOperations.image!,
                editPath: "/images/generations",
                requestTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","image_urls":"{{images}}","size":"{{size}}"}',
                referenceRule: "图生图使用 JSON 请求体，参考图字段必须是 image_urls 字符串数组。",
            },
        },
        strict: true,
    },
    {
        id: "newapi",
        label: "New API",
        description: "New API 聚合网关，按 OpenAI 路径调用，视频支持 content 多模态参考素材。",
        apiFormat: "openai",
        authMode: "bearer",
        modelCatalogPaths: ["/v1/models"],
        capabilities: ["text", "image", "video", "audio"],
        operations: newApiOperations,
        strict: true,
    },
    {
        id: "vozeb-recommended",
        label: "VOZEB推荐",
        description: "VOZEB 推荐的 JSON 异步视频协议，支持多模态参考素材与持久结果地址。",
        apiFormat: "openai",
        authMode: "bearer",
        defaultBaseUrl: "https://new.aiym.ink/v1",
        modelCatalogPaths: ["/v1/models"],
        capabilities: ["video"],
        operations: { video: vozebRecommendedVideoOperation },
        strict: true,
    },
    {
        id: "seedance-special",
        label: "Seedance 2.0 特价版",
        description: "按特价版接口文档固定模型、参数、素材与轮询路径。",
        apiFormat: "openai",
        authMode: "bearer",
        defaultBaseUrl: "https://zcbservice.aizfw.cn/kyyReactApiServer",
        modelCatalogPaths: [],
        capabilities: ["video"],
        operations: { video: seedanceSpecialOperation },
        builtInModels: SEEDANCE_SPECIAL_MODELS.map(([id, label]) => ({ id, label, capability: "video" as const })),
        strict: true,
    },
    {
        id: "custom",
        label: "自定义协议",
        description: "通过文档 URL、cURL 和请求/响应示例生成可复核的声明式协议。",
        apiFormat: "openai",
        authMode: "bearer",
        modelCatalogPaths: [],
        capabilities: ["text", "image", "video", "audio"],
        operations: {},
        advanced: true,
    },
    {
        id: "globalaiopc",
        label: "GlobalAiOpc",
        description: "按现有 GlobalAiOpc 模型预设执行文本、图片与视频请求。",
        apiFormat: "openai",
        authMode: "bearer",
        modelCatalogPaths: [],
        capabilities: ["text", "image", "video"],
        operations: {},
        advanced: true,
    },
    {
        id: "compatible",
        label: "通用兼容",
        description: "保留旧版兼容模式；新接口优先使用自定义协议并完成测试。",
        apiFormat: "openai",
        authMode: "bearer",
        modelCatalogPaths: ["/v1/models"],
        capabilities: ["text", "image", "video", "audio"],
        operations: {},
        advanced: true,
    },
    {
        id: "auto",
        label: "自动识别（旧配置）",
        description: "仅用于已有渠道过渡；新增渠道应明确选择协议。",
        apiFormat: "openai",
        authMode: "bearer",
        modelCatalogPaths: ["/v1/models"],
        capabilities: ["text", "image", "video", "audio"],
        operations: {},
        advanced: true,
    },
];

const retiredProtocolIds = new Set<SystemChannelProtocol>(["vozeb-recommended", "seedance-special", "globalaiopc"]);

export const channelProtocolDefinitions = registeredChannelProtocolDefinitions.filter((definition) => !retiredProtocolIds.has(definition.id));

export function channelProtocolDefinition(protocol: SystemChannelProtocol) {
    return registeredChannelProtocolDefinitions.find((item) => item.id === protocol) || registeredChannelProtocolDefinitions.at(-1)!;
}

export function channelProtocolOptions() {
    return channelProtocolDefinitions.map(({ id: value, label, description, advanced }) => ({ value, label, description, advanced }));
}

export function channelSupportsModelCatalog(channel: Pick<SystemModelChannel, "advancedConfig">) {
    const advanced = channel.advancedConfig;
    const paths = advanced?.modelCatalogPaths ?? channelProtocolDefinition(advanced?.protocol || "auto").modelCatalogPaths;
    return paths.some((path) => Boolean(path.trim()));
}

export function protocolCatalogCapability(protocol: SystemChannelProtocol): LogicalModelCapability | undefined {
    const definition = channelProtocolDefinition(protocol);
    return definition.strict && definition.capabilities.length === 1 ? definition.capabilities[0] : undefined;
}

export function protocolModelConfig(protocol: SystemChannelProtocol, capability: LogicalModelCapability, model?: string): SystemChannelModelConfig | undefined {
    const definition = channelProtocolDefinition(protocol);
    const builtIn = model ? definition.builtInModels?.find((item) => normalizeModelId(item.id) === normalizeModelId(model)) : undefined;
    const operation = builtIn?.capability === capability && builtIn.operation ? builtIn.operation : definition.operations[capability];
    if (!operation) return undefined;
    return { ...operation, capability, source: "manual", protocol, apiFormat: definition.apiFormat };
}

export function applyModelProtocol(config: SystemChannelModelConfig, protocol: SystemChannelProtocol, model?: string): SystemChannelModelConfig {
    return protocolModelConfig(protocol, config.capability, model) || { ...config, source: "manual", protocol };
}

export function normalizeStrictProtocolModelConfig(config: SystemChannelModelConfig, fallbackProtocol: SystemChannelProtocol, model?: string): SystemChannelModelConfig {
    const protocol = config.protocol || fallbackProtocol;
    if (!channelProtocolDefinition(protocol).strict) return config;
    return protocolModelConfig(protocol, config.capability, model) || config;
}

export function resolveChannelModelConfig(config: SystemChannelAdvancedConfig | undefined, model: string) {
    if (!config) return undefined;
    const key = normalizeModelId(model);
    const modelConfig = config.modelConfigs?.[key];
    if (modelConfig) return modelConfig;
    const capability = protocolCatalogCapability(config.protocol) || config.modelCapabilities?.[key] || inferModelCapability(model);
    return config.operationConfigs?.[capability];
}

export function resolveChannelModelAdvancedConfig(config: SystemChannelAdvancedConfig | undefined, model: string) {
    if (!config) return undefined;
    const modelConfig = resolveChannelModelConfig(config, model);
    if (!modelConfig) return config;
    const { capability: _capability, apiFormat: _apiFormat, ...modelAdvanced } = modelConfig;
    return { ...config, ...modelAdvanced };
}

export function applyChannelProtocol(channel: SystemModelChannel, protocol: SystemChannelProtocol): SystemModelChannel {
    const definition = channelProtocolDefinition(protocol);
    const advanced = channel.advancedConfig || emptyAdvancedConfig();
    const builtInModels = definition.builtInModels?.map((item) => item.id) || [];
    const models = builtInModels.length ? builtInModels : channel.models;
    const modelConfigs = { ...(advanced.modelConfigs || {}) };
    const modelCapabilities = { ...(advanced.modelCapabilities || {}) };
    const operationConfigs = definition.strict
        ? Object.fromEntries(definition.capabilities.flatMap((capability) => (protocolModelConfig(protocol, capability) ? [[capability, protocolModelConfig(protocol, capability)!] as const] : [])))
        : protocol === "custom"
          ? advanced.operationConfigs || {}
          : {};
    for (const model of models) {
        const key = normalizeModelId(model);
        const builtIn = definition.builtInModels?.find((item) => normalizeModelId(item.id) === key);
        const capability = builtIn?.capability || protocolCatalogCapability(protocol) || modelConfigs[key]?.capability || modelCapabilities[key] || inferModelCapability(model);
        const strict = protocolModelConfig(protocol, capability, model);
        if (strict) modelConfigs[key] = strict;
        modelCapabilities[key] = capability;
    }
    const primary = definition.capabilities.length === 1 ? definition.operations[definition.capabilities[0]] : undefined;
    const primaryAdvanced = primary ? Object.fromEntries(Object.entries(primary).filter(([key]) => key !== "capability")) : {};
    return {
        ...channel,
        baseUrl: protocol === "yumeng" ? normalizeYumengModelCenterBaseUrl(channel.baseUrl) : channel.baseUrl.trim() || definition.defaultBaseUrl || "",
        apiFormat: definition.apiFormat,
        models,
        advancedConfig: {
            ...advanced,
            protocol,
            authMode: definition.authMode,
            modelCatalogPaths: definition.modelCatalogPaths,
            ...primaryAdvanced,
            modelConfigs,
            modelCapabilities,
            operationConfigs,
        },
    };
}

export function protocolAuthHeaders(apiKey: string, input: Pick<SystemChannelAdvancedConfig, "protocol" | "authMode" | "authHeader" | "authPrefix"> | undefined, fallback: ApiCallFormat = "openai"): Record<string, string> {
    if (input?.protocol === "gemini") return { "x-goog-api-key": apiKey };
    const mode = resolveChannelAuthMode(input);
    if (mode === "none") return {};
    if (fallback === "gemini" && !input?.authMode) return { "x-goog-api-key": apiKey };
    if (mode === "x-api-key") return { "x-api-key": apiKey };
    if (mode === "custom-header") {
        const name = input?.authHeader?.trim() || "x-api-key";
        const prefix = input?.authPrefix?.trim();
        return { [name]: prefix ? `${prefix} ${apiKey}` : apiKey };
    }
    return { authorization: `Bearer ${apiKey}` };
}

export function resolveChannelAuthMode(input: Pick<SystemChannelAdvancedConfig, "protocol" | "authMode"> | undefined): SystemChannelAuthMode {
    const definition = channelProtocolDefinition(input?.protocol || "auto");
    return definition.strict ? definition.authMode : input?.authMode || definition.authMode;
}

export function channelRequiresApiKey(channel: Pick<SystemModelChannel, "advancedConfig">) {
    return resolveChannelAuthMode(channel.advancedConfig) !== "none";
}

export function channelCredentialsReady(channel: Pick<SystemModelChannel, "apiKey" | "hasApiKey" | "advancedConfig">) {
    return !channelRequiresApiKey(channel) || Boolean(channel.apiKey.trim() || channel.hasApiKey);
}

export function channelConnectionReady(channel: Pick<SystemModelChannel, "baseUrl" | "apiKey" | "hasApiKey" | "advancedConfig">) {
    return Boolean(channel.baseUrl.trim() && channelCredentialsReady(channel));
}

export function channelProtocolValidationErrors(channel: SystemModelChannel) {
    const advanced = channel.advancedConfig;
    if (!advanced) return [];
    const errors: string[] = [];
    const definition = channelProtocolDefinition(advanced.protocol);
    if (definition.strict && advanced.authMode && advanced.authMode !== definition.authMode) errors.push(`${channel.name || "渠道"} 的鉴权方式必须使用 ${definition.label} 协议预设`);
    if (advanced.authMode === "custom-header" && !isSafeAuthHeaderName(advanced.authHeader)) errors.push(`${channel.name || "渠道"} 的自定义鉴权请求头名称无效`);
    for (const model of channel.models) {
        const key = normalizeModelId(model);
        const config = resolveChannelModelConfig(advanced, model);
        const protocol = config?.protocol || advanced.protocol;
        const definition = channelProtocolDefinition(protocol);
        if (protocol === "custom") {
            if (!config?.createPath) errors.push(`${model} 的自定义协议缺少创建路径`);
            if (!config?.requestTemplate) errors.push(`${model} 的自定义协议缺少请求模板`);
            if (!config?.resultField && config?.capability !== "audio") errors.push(`${model} 的自定义协议缺少结果字段`);
            continue;
        }
        if (!definition.strict) continue;
        const capability = config?.capability || advanced.modelCapabilities?.[key] || inferModelCapability(model);
        const expected = protocolModelConfig(protocol, capability, model);
        if (!expected) {
            errors.push(`${definition.label} 不支持 ${capability} 模型 ${model}`);
            continue;
        }
        if (definition.builtInModels && !definition.builtInModels.some((item) => normalizeModelId(item.id) === key)) errors.push(`${model} 不在 ${definition.label} 文档模型列表中`);
        if (!config) {
            errors.push(`${model} 缺少 ${definition.label} 的严格模型配置`);
            continue;
        }
        if (config.protocol !== protocol) errors.push(`${model} 的协议必须为 ${protocol}`);
        if ((config.apiFormat || definition.apiFormat) !== expected.apiFormat) errors.push(`${model} 的 API 格式必须为 ${expected.apiFormat}`);
        if (config.createPath !== expected.createPath) errors.push(`${model} 的创建路径必须为 ${expected.createPath}`);
        if ((config.editPath || "") !== (expected.editPath || "")) errors.push(`${model} 的图生图路径必须为 ${expected.editPath || "空"}`);
        if ((config.imageToVideoPath || "") !== (expected.imageToVideoPath || "")) errors.push(`${model} 的图生视频路径必须为 ${expected.imageToVideoPath || "空"}`);
        if ((config.queryPath || "") !== (expected.queryPath || "")) errors.push(`${model} 的查询路径必须为 ${expected.queryPath || "空"}`);
        if ((config.requestTemplate || "") !== (expected.requestTemplate || "")) errors.push(`${model} 的请求参数必须使用 ${definition.label} 协议预设`);
        if ((config.resultField || "") !== (expected.resultField || "")) errors.push(`${model} 的结果字段必须使用 ${definition.label} 协议预设`);
        if ((config.statusField || "") !== (expected.statusField || "")) errors.push(`${model} 的状态字段必须使用 ${definition.label} 协议预设`);
        if (Boolean(config.supportsReferenceImage) !== Boolean(expected.supportsReferenceImage)) errors.push(`${model} 的参考图片能力必须使用 ${definition.label} 协议预设`);
        if (Boolean(config.supportsReferenceVideo) !== Boolean(expected.supportsReferenceVideo)) errors.push(`${model} 的参考视频能力必须使用 ${definition.label} 协议预设`);
        if (Boolean(config.supportsReferenceAudio) !== Boolean(expected.supportsReferenceAudio)) errors.push(`${model} 的参考音频能力必须使用 ${definition.label} 协议预设`);
    }
    return errors;
}

function isSafeAuthHeaderName(value: string | undefined) {
    const name = value?.trim() || "";
    return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) && !["connection", "content-length", "cookie", "host", "transfer-encoding"].includes(name.toLowerCase());
}

export function emptyAdvancedConfig(): SystemChannelAdvancedConfig {
    return {
        protocol: "auto",
        textModel: "",
        imageModel: "",
        videoModel: "",
        createPath: "",
        editPath: "",
        imageToVideoPath: "",
        queryPath: "",
        requestTemplate: "",
        resultField: "",
        statusField: "",
        durationRange: "",
        referenceRule: "",
        supportsReferenceImage: false,
        supportsReferenceVideo: false,
        supportsReferenceAudio: false,
    };
}
