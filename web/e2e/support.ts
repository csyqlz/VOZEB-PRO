import type { APIRequestContext } from "@playwright/test";

export const E2E_ADMIN = {
    username: "e2e_admin",
    password: "VozebE2E!2026",
    displayName: "E2E 管理员",
    installToken: "vozeb-pro-e2e-install-token-32chars",
};

export const E2E_PROTOCOL_ORIGIN = `http://127.0.0.1:${Number(process.env.VOZEB_PRO_PROTOCOL_FIXTURE_PORT || 4010)}`;
export const E2E_PAYMENT_WEBHOOK_SECRET = "vozeb-pro-e2e-payply-webhook-secret";

const models = [
    "e2e-text",
    "e2e-text-fallback",
    "e2e-text-fail",
    "e2e-ecommerce-vision-upstream",
    "e2e-ecommerce-planner-upstream",
    "e2e-ecommerce-quality-upstream",
    "e2e-image",
    "e2e-image-fallback",
    "gpt-image-2.5-flare",
    "e2e-video",
    "e2e-video-fallback",
    "e2e-video-slow",
    "e2e-audio",
    "e2e-audio-fallback",
];

const ecommerceLogicalModels = [
    logicalModel("e2e-ecommerce-vision", "E2E Ecommerce Vision", "text", "e2e-ecommerce-vision-upstream"),
    logicalModel("e2e-ecommerce-planner", "E2E Ecommerce Planner", "text", "e2e-ecommerce-planner-upstream"),
    logicalModel("e2e-ecommerce-image", "E2E Ecommerce Image", "image", "gpt-image-2.5-flare"),
    logicalModel("e2e-ecommerce-quality", "E2E Ecommerce Quality", "text", "e2e-ecommerce-quality-upstream"),
];

const operations = {
    text: {
        capability: "text",
        source: "manual",
        protocol: "openai",
        apiFormat: "openai",
        createPath: "/chat/completions",
        requestTemplate: '{"model":"{{model}}","messages":[{"role":"user","content":"{{prompt}}"}]}',
        resultField: "choices[0].message.content",
    },
    image: {
        capability: "image",
        source: "manual",
        protocol: "openai",
        apiFormat: "openai",
        createPath: "/images/generations",
        editPath: "/images/edits",
        requestTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","size":"{{size}}","quality":"{{quality}}"}',
        resultField: "data[0].url / data[0].b64_json",
        referenceRule: "文生图使用 /images/generations；参考图编辑使用 /images/edits multipart/form-data。",
        supportsReferenceImage: true,
    },
    video: {
        capability: "video",
        source: "manual",
        protocol: "openai",
        apiFormat: "openai",
        createPath: "/videos",
        imageToVideoPath: "/videos",
        queryPath: "/videos/:task_id",
        requestTemplate: "multipart/form-data: model、prompt、seconds、size、input_reference",
        resultField: "/videos/:task_id/content",
        statusField: "status",
        referenceRule: "参考图使用 multipart/form-data 的单个 input_reference 文件字段。",
        supportsReferenceImage: true,
    },
    audio: {
        capability: "audio",
        source: "manual",
        protocol: "openai",
        apiFormat: "openai",
        createPath: "/audio/speech",
        requestTemplate: '{"model":"{{model}}","input":"{{prompt}}","voice":"alloy","response_format":"mp3"}',
        resultField: "binary",
    },
} as const;

export function e2eSettingsPatch() {
    const modelCapabilities = Object.fromEntries(models.map((model) => [model, model.includes("image") ? "image" : model.includes("video") ? "video" : model.includes("audio") ? "audio" : "text"]));
    const modelConfigs = Object.fromEntries(models.map((model) => [model, operations[modelCapabilities[model] as keyof typeof operations]]));
    return {
        systemChannels: [channel("e2e-primary", "E2E 主渠道", "e2e-primary-secret", modelCapabilities, modelConfigs), channel("e2e-backup", "E2E 备用渠道", "e2e-backup-secret", modelCapabilities, modelConfigs)],
        logicalModels: ecommerceLogicalModels,
        defaultModels: { textModel: "e2e-text", imageModel: "e2e-image", videoModel: "e2e-video", audioModel: "e2e-audio" },
        ecommerceGenerationEnabled: true,
        ecommerceVisualQualityCheckEnabled: false,
        ecommerceModelRoles: {
            vision_analysis: ["e2e-ecommerce-vision"],
            edit_planning: ["e2e-ecommerce-planner"],
            image_generation: ["e2e-ecommerce-image"],
            quality_check: ["e2e-ecommerce-quality"],
        },
        modelPointCosts: Object.fromEntries([...models, ...ecommerceLogicalModels.map((model) => model.id)].map((model) => [model, 0])),
        generationConcurrency: { agent: 2, image: 2, video: 2, audio: 2, text: 2, render: 1 },
    };
}

function logicalModel(id: string, name: string, capability: "text" | "image", upstreamModel: string) {
    return {
        id,
        name,
        capability,
        enabled: true,
        bindings: [{ id: `${id}-primary`, channelId: "e2e-primary", upstreamModel, enabled: true, priority: 1 }],
    };
}

function channel(id: string, name: string, apiKey: string, modelCapabilities: Record<string, string>, modelConfigs: Record<string, unknown>) {
    return {
        id,
        name,
        baseUrl: `${E2E_PROTOCOL_ORIGIN}/v1`,
        apiKey,
        apiFormat: "openai",
        models,
        enabled: true,
        advancedConfig: {
            protocol: "openai",
            authMode: "bearer",
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
            modelCatalogPaths: ["/v1/models"],
            modelCapabilities,
            modelConfigs,
            operationConfigs: operations,
        },
    };
}

export async function pollTask(request: APIRequestContext, path: string, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    let latest: Record<string, unknown> = {};
    while (Date.now() < deadline) {
        const response = await request.get(path);
        if (!response.ok()) throw new Error(`${path} returned ${response.status()}: ${await response.text()}`);
        const payload = (await response.json()) as { task?: Record<string, unknown> };
        latest = payload.task || {};
        if (["success", "error", "cancelled"].includes(String(latest.status || ""))) return latest;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`${path} did not reach a terminal state: ${JSON.stringify(latest)}`);
}

export async function resetProtocolFixture(request: APIRequestContext) {
    const response = await request.post(`${E2E_PROTOCOL_ORIGIN}/__reset`);
    if (!response.ok()) throw new Error(`Unable to reset protocol fixture: ${response.status()}`);
}

export async function protocolFixtureState(request: APIRequestContext) {
    const response = await request.get(`${E2E_PROTOCOL_ORIGIN}/__state`);
    if (!response.ok()) throw new Error(`Unable to inspect protocol fixture: ${response.status()}`);
    return (await response.json()) as {
        requests: Array<{ method: string; path: string; authorization: string; contentType: string; bodyBytes: number; model: string }>;
        tasks: Array<{ id: string; status: string }>;
    };
}
