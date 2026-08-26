import type { AgentRun, AgentRunTask } from "./agent-run-store";

export function runWithTasks(tasks: AgentRunTask[]): AgentRun {
    const now = Date.now();
    return runFixture({ projectId: "project", prompt: "生成两张图", status: "running", tasks, reviewed: true, createdAt: now, updatedAt: now });
}

export function imageTask(id: string): AgentRunTask {
    return { id, title: id, type: "image", prompt: `生成 ${id}`, count: 1, dependencies: [], status: "ready", attempts: 0 };
}

export function planningRun(prompt = "为发布会生成横版主视觉"): AgentRun {
    const now = Date.now();
    return runFixture({ projectId: "project", prompt, snapshot: { nodes: [] }, status: "planning", tasks: [], reviewed: true, createdAt: now, updatedAt: now });
}

export function runFixture(patch: Partial<AgentRun> = {}): AgentRun {
    const now = Date.now();
    return {
        id: "agent-run",
        userId: "user",
        conversationId: "conversation",
        clientRequestId: "request",
        surface: "canvas",
        projectId: "project",
        inputMessageId: "input-message",
        assistantMessageId: "assistant-message",
        prompt: "生成内容",
        referencedAssetIds: [],
        assetIds: [],
        status: "planning",
        tasks: [],
        reviewed: false,
        createdAt: now,
        updatedAt: now,
        ...patch,
    };
}

export function canvasPlan(model: string) {
    return {
        intent: "generation",
        objective: "制作发布会主视觉",
        audience: "科技产品用户",
        reply: "我建议使用横版纪实构图，突出舞台、人物和现场氛围。",
        decisions: [
            { label: "模型", value: "创意图像模型", reason: "更适合复杂场景和人物关系" },
            { label: "画幅", value: "16:9", reason: "容纳舞台与观众环境" },
        ],
        deliverables: [{ id: "main", title: "主视觉", type: "image", model, prompt: "生成发布会横版主视觉", count: 1, ratio: "16:9", quality: "high", dependencies: [] }],
    };
}

export function conversationPlan(model: string, reply: string) {
    return { ...canvasPlan(model), intent: "conversation", reply, decisions: [], deliverables: [] };
}

export function creativeImageAsset(id: string, title: string, remoteUrl: string) {
    return {
        id,
        userId: "user",
        conversationId: "conversation",
        ordinal: 0,
        type: "image",
        status: "ready",
        title,
        remoteUrl,
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
    };
}

export function settings(imageModel: string, channelId: string) {
    return {
        site: { title: "星河创作" },
        defaultModels: { textModel: "planner", imageModel, videoModel: "", audioModel: "" },
        systemChannels: [
            { id: "planner-channel", name: "规划", enabled: true, baseUrl: "https://api.example.com/v1", apiKey: "planner-secret", models: ["vendor/planner"] },
            { id: channelId, name: "图片", enabled: true, baseUrl: "https://api.example.com/v1", apiKey: "image-secret", models: [`vendor/${imageModel}`] },
        ],
        logicalModels: [
            { id: "planner", name: "规划", capability: "text", enabled: true, bindings: [{ id: "planner-binding", channelId: "planner-channel", upstreamModel: "vendor/planner", enabled: true, priority: 1 }] },
            { id: imageModel, name: "图片", capability: "image", enabled: true, bindings: [{ id: `${imageModel}-binding`, channelId, upstreamModel: `vendor/${imageModel}`, enabled: true, priority: 1 }] },
        ],
        agentSkills: [],
        generationDefaults: {},
        generationConcurrency: { agent: 2, image: 2, video: 1, audio: 2, text: 2, render: 1 },
    } as never;
}

export function disabledSettings(imageModel: string, channelId: string) {
    const value = settings(imageModel, channelId) as unknown as { systemChannels: Array<{ id: string; enabled: boolean }> };
    value.systemChannels.find((channel) => channel.id === channelId)!.enabled = false;
    return value as never;
}

export function plannerFailoverSettings(imageModel: string, channelId: string) {
    const value = settings(imageModel, channelId) as unknown as {
        systemChannels: Array<{ id: string; name: string; enabled: boolean; baseUrl: string; apiKey: string; models: string[] }>;
        logicalModels: Array<{ id: string; bindings: Array<{ id: string; channelId: string; upstreamModel: string; enabled: boolean; priority: number }> }>;
    };
    value.systemChannels[0] = { id: "planner-primary", name: "主规划", enabled: true, baseUrl: "https://api.example.com/v1", apiKey: "primary-secret", models: ["vendor/planner-primary"] };
    value.systemChannels.push({ id: "planner-backup", name: "备用规划", enabled: true, baseUrl: "https://api.example.com/v1", apiKey: "backup-secret", models: ["vendor/planner-backup"] });
    value.logicalModels[0].bindings = [
        { id: "planner-primary-binding", channelId: "planner-primary", upstreamModel: "vendor/planner-primary", enabled: true, priority: 1 },
        { id: "planner-backup-binding", channelId: "planner-backup", upstreamModel: "vendor/planner-backup", enabled: true, priority: 2 },
    ];
    return value as never;
}

export function canvasSettings(defaultImageModel: string, defaultChannelId: string, extraImageModel?: string, extraChannelId?: string) {
    const value = settings(defaultImageModel, defaultChannelId) as unknown as {
        systemChannels: Array<{ id: string; name: string; enabled: boolean; baseUrl: string; apiKey: string; models: string[] }>;
        logicalModels: Array<{ id: string; name: string; capability: string; enabled: boolean; bindings: Array<{ id: string; channelId: string; upstreamModel: string; enabled: boolean; priority: number }> }>;
    };
    if (extraImageModel && extraChannelId) {
        value.systemChannels.push({ id: extraChannelId, name: "创意图片", enabled: true, baseUrl: "https://api.example.com/v1", apiKey: "creative-secret", models: [`vendor/${extraImageModel}`] });
        value.logicalModels.push({
            id: extraImageModel,
            name: "创意图像模型",
            capability: "image",
            enabled: true,
            bindings: [{ id: `${extraImageModel}-binding`, channelId: extraChannelId, upstreamModel: `vendor/${extraImageModel}`, enabled: true, priority: 1 }],
        });
    }
    return value as never;
}
