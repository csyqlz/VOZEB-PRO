import type { AuthSettings } from "@/lib/auth/store";
import { agentSkillSupportsGenerationMode, CreativeRuntimeInputError, type CreativeAsset, type CreativeConversationContext, type CreativeRunRequest, type CreativeSurface } from "@/lib/creative-runtime-contract";
import { creativeAssetReferenceAliases, orderCreativeAssetsByIds } from "@/lib/creative-asset-references";
import { resolveSiteTitle } from "@/lib/site-brand";
import type { AgentRun, AgentRunPlannerContextSummary, AgentRunTask } from "@/lib/server/agent-run-store";
import type { AgentPlan } from "@/lib/server/agent-run-validation";
import { resolveAgentPlanningProfile } from "@/lib/server/agent-run-planning-profile";
import { canvasSnapshotPlannerView, selectedCanvasNodeIds } from "./agent-run-canvas-snapshot";
import { resolveDramaPlannerSnapshot } from "./agent-context-resolver";

export function availableAgentSkills(settings: AuthSettings, surface: CreativeSurface) {
    const workspaces = surface === "canvas" ? new Set(["canvas"]) : surface === "drama" ? new Set(["drama"]) : new Set(["image", "video", "drama"]);
    return settings.agentSkills.filter((skill) => skill.enabled && (skill.workspaces || ["image"]).some((workspace) => workspaces.has(workspace)));
}

export function selectAgentSkills(settings: AuthSettings, surface: CreativeSurface, requestedSkillIds: string[] = []) {
    const available = new Map(availableAgentSkills(settings, surface).map((skill) => [skill.id, skill]));
    return Array.from(new Set(requestedSkillIds.map((id) => id.trim()).filter(Boolean))).flatMap((id) => (available.has(id) ? [available.get(id)!] : []));
}

export function assertAgentSkillModeCompatibility(settings: AuthSettings, input: Pick<CreativeRunRequest, "surface" | "skillIds" | "preferences">) {
    const mode = input.preferences?.mode;
    if (!mode) return;
    const incompatible = selectAgentSkills(settings, input.surface, input.skillIds).find((skill) => !agentSkillSupportsGenerationMode(skill.workspaces, mode));
    if (!incompatible) return;
    const supported = (incompatible.workspaces || ["image"]).filter((workspace) => workspace === "image" || workspace === "video").map((workspace) => (workspace === "image" ? "图片" : "视频"));
    throw new CreativeRuntimeInputError(`${incompatible.name}仅支持${supported.join("、")}生成，请切换创作类型或取消该 Skill`);
}

export function plannerAgentSkills(settings: AuthSettings, run: Pick<AgentRun, "surface" | "selectedSkillIds">) {
    return selectAgentSkills(settings, run.surface, run.selectedSkillIds || []);
}

export function agentPlannerSystemPrompt(surface: CreativeSurface, fallbackExample: string, siteTitle: string) {
    const brand = resolveSiteTitle(siteTitle);
    const identity =
        surface === "canvas"
            ? `你是 ${brand} 画布创作 Agent，也能进行普通对话。`
            : surface === "drama"
              ? `你是 ${brand} 短剧项目创作 Agent，负责围绕当前项目规划文本、图片、视频和音频产物，也能进行普通对话。`
              : `你是 ${brand} 统一创作 Agent，负责通过一个对话入口规划并生成文本、图片、视频和音频产物，也能进行普通对话。`;
    const surfaceRules =
        surface === "canvas"
            ? "明确要求创建、修改、删除、移动、连接画布节点，或生成媒体产物时为 generation。用户要求修改已有画布产物时必须填写该节点真实 targetNodeId。选中文本/提示词节点并要求修改、优化或改写时，只规划一个 type=text 的原位编辑任务，targetNodeId 必须是该文本节点；除非用户同时明确要求生成媒体，否则禁止规划图片、视频或音频任务。canvasSnapshot.selectedNodeIds 是用户本轮明确选中并展示在输入框中的附件：非空时，当前编辑任务必须优先且只能从这些节点选择 targetNodeId，禁止被 conversationContext 的上一张、旧主体或其他未选中画布节点覆盖；只有本轮没有选中节点时，才允许结合会话记忆选择旧节点。"
            : "明确要求生成或修改文本、图片、视频、音频产物时为 generation。禁止创建、更新、删除或连接任何 Canvas 节点，targetNodeId 必须省略。";
    const projectRule =
        surface === "drama"
            ? "projectSnapshot 是本次短剧生产的权威上下文：必须遵循其中 currentStage、project.ratio、project.style、episode、shots、characters、scenes、props、clues 和 currentTurnReferences。所有生成任务必须服务于当前项目与当前集，沿用项目画幅、视觉设定、角色/场景/道具基准和镜头连续性；不得把短剧入口当成脱离项目的通用图片或视频工作台。短剧项目中的角色、场景、多镜头和依赖生产默认是 complex。"
            : surface === "canvas"
              ? "Canvas 的品牌系列、多物料和依赖生产默认是 complex。"
              : "多物料、系列内容和依赖生产默认是 complex。";
    const handoffRule =
        surface === "chat"
            ? "只有用户原文明确要求创建、建立或整理成画布/短剧项目时才填写 projectHandoff；生成短视频、短片、图片或系列媒体不等于创建项目，必须省略 projectHandoff。只做明确项目交接且无需新产物时允许 deliverables=[]。projectHandoff.assetIds 只能引用 referencedAssets，当前 Run 新生成的资产会由服务端自动合并。"
            : "当前入口不得填写 projectHandoff。";
    return `${identity}先结合 conversationContext 的长期摘要和近期消息理解用户的自然语言、指代和连续创作关系，再判断 intent：问候、闲聊、能力咨询、使用说明和知识问答为 conversation；${surfaceRules}conversation 必须 deliverables=[]、decisions=[]，直接在 reply 回答。generationPreferences.mode 非空时代表用户本轮明确选择的产物类型，必须按该类型执行 generation，deliverables 只能使用该媒体类型；generationPreferences 中该类型的尺寸、画质、时长、音色和格式是用户本轮明确参数，不得改选。视频 generationPreferences.referenceMode、firstFrameAssetId 和 lastFrameAssetId 是用户显式指定的首尾帧角色，必须规划视频任务且不得猜测、交换、删除或改成普通参考图；服务端会强制注入对应资产。generation 必须先形成 foundation：brief 说明目标、受众、使用场景、核心信息、约束和参考素材策略；direction 给出一个明确推荐的风格、构图/镜头、色彩、光线、视觉关键词和避免事项。${projectRule}${handoffRule}requestedSkillIds 非空时必须使用且只使用这些技能；requestedSkillIds 为空时 skillIds 必须为空，不得自动选择任何普通 Skill。没有 Skill 时仍需执行提示词优化、视觉方向、模型选择和参数规划。referenceContext.source=current-turn-explicit 表示 referencedAssets 是本轮用户明确附件，必须优先且排他；其中 alias 是用户正文中的通用引用名，必须严格按 alias 对应的真实 id 理解“@图片1 做什么、@图片2 做什么”等逐素材指令，不得按标题、数组偶然顺序或文本相似度猜测。source=conversation-memory-candidates 表示它们只是同会话最近成功媒体候选，只有自然语义明确延续、修改、变体或保持上一轮主体/场景时，才把确需使用的资产 ID 写入 deliverable.assetIds，新主题、独立创作或无法确认时不得引用。随后规划整套 deliverables 和依赖顺序，并主动从 availableModels 中为每个产物选择能力匹配的逻辑模型，决定画幅、质量、数量、时长、音色或格式。只能引用 referencedAssets 中存在的资产 ID；需要使用一个或多个资产时，将它们写入对应 deliverable.assetIds。每个 deliverable 的 prompt 必须执行同一 foundation，保持主体、信息、色彩和视觉语言一致。不要盲目照抄默认值，默认值只在没有更明确判断时作为兜底。reply 用自然中文概括推荐方向；decisions 用 2–6 项说明“选择了什么、为什么”；每个 deliverable 必须填写 model。优先调用 create_agent_plan；若渠道不支持工具调用，必须直接返回与函数参数完全一致的单个 JSON 对象，不要 Markdown 或额外文本，严格仿照这个完整结构：${fallbackExample}。不得暴露隐藏思维链，只输出可验证的决策摘要。`;
}

export function agentPlannerInput(
    run: AgentRun,
    conversationContext: CreativeConversationContext,
    referencedAssets: CreativeAsset[],
    referenceSource: "current-turn-explicit" | "conversation-memory-candidates" | "none",
    availableSkills: AuthSettings["agentSkills"],
    availableModels: Array<{ id: string; name: string; capability: string }>,
    settings: AuthSettings,
) {
    return buildAgentPlannerInput(run, conversationContext, referencedAssets, referenceSource, availableSkills, availableModels, settings).input;
}

export function buildAgentPlannerInput(
    run: AgentRun,
    conversationContext: CreativeConversationContext,
    referencedAssets: CreativeAsset[],
    referenceSource: "current-turn-explicit" | "conversation-memory-candidates" | "none",
    availableSkills: AuthSettings["agentSkills"],
    availableModels: Array<{ id: string; name: string; capability: string }>,
    settings: AuthSettings,
): { input: Record<string, unknown>; summary: AgentRunPlannerContextSummary } {
    const selectedNodeIds = run.surface === "canvas" ? selectedCanvasNodeIds(run.snapshot) : [];
    const prioritizedModels = prioritizeAgentPlannerModels(availableModels, run, settings);
    const orderedAssets = orderCreativeAssetsByIds(referencedAssets, run.referencedAssetIds || []);
    const referenceAliases = referenceSource === "current-turn-explicit" ? creativeAssetReferenceAliases(orderedAssets, run.referencedAssetIds || []) : new Map<string, string>();
    const payload = {
        requirement: run.prompt,
        conversationContext: {
            summary: conversationContext.summary,
            recentMessages: conversationContext.recentMessages.map((item) => ({ role: item.role, content: item.content, sequence: item.sequence })),
        },
        surface: run.surface,
        ...(run.projectId ? { projectId: run.projectId } : {}),
        ...(run.surface === "canvas" ? { canvasSnapshot: canvasSnapshotPlannerView(run.snapshot) } : run.surface === "drama" ? { projectSnapshot: compactProjectSnapshot(run.snapshot) } : {}),
        ...(selectedNodeIds.length ? { currentTurnSelection: { selectedNodeIds, rule: "这些节点是本轮明确附件；编辑任务不得改用历史节点" } } : {}),
        referenceContext: { source: referenceSource },
        referencedAssets: orderedAssets.map((asset) => plannerAssetSummary(asset, referenceAliases.get(asset.id))),
        requestedSkillIds: run.selectedSkillIds || [],
        ...(run.generationPreferences ? { generationPreferences: run.generationPreferences } : {}),
        availableSkills: availableSkills.map(plannerSkillSummary),
        availableModels: prioritizedModels,
        defaultModels: settings.defaultModels,
        generationDefaults: settings.generationDefaults,
    };
    const kept = plannerContextIds(payload);
    return {
        input: payload,
        summary: {
            serializedChars: serializedLength(payload),
            kept,
            omitted: { modelIds: [], skillIds: [], assetIds: [], recentMessageSequences: [] },
        },
    };
}

export function prioritizeAgentPlannerModels<T extends { id: string; capability: string }>(models: T[], run: Pick<AgentRun, "requestedModelIds" | "surface" | "prompt" | "snapshot" | "generationPreferences">, settings: AuthSettings) {
    const profile = resolveAgentPlanningProfile(run);
    const requestedOrder = new Map((run.requestedModelIds || []).map((id, index) => [id, index]));
    const defaultOrder = new Map(defaultPlannerModelIds(settings, profile.capabilities).map((id, index) => [id, index]));
    return models
        .map((model, index) => ({ model, index }))
        .sort((left, right) => modelPriority(left.model.id, requestedOrder, defaultOrder) - modelPriority(right.model.id, requestedOrder, defaultOrder) || left.index - right.index)
        .map(({ model }) => model);
}

function plannerSkillSummary(skill: AuthSettings["agentSkills"][number]) {
    return {
        id: skill.id,
        name: skill.name,
        plannerSummary: skill.plannerSummary || skill.description || skill.instructions,
        workspaces: skill.workspaces || ["image"],
    };
}

export function compactCanvasSnapshot(snapshot: unknown) {
    return canvasSnapshotPlannerView(snapshot);
}

function compactProjectSnapshot(snapshot: unknown) {
    return resolveDramaPlannerSnapshot(snapshot);
}

function defaultPlannerModelIds(settings: AuthSettings, capabilities: Set<string>) {
    return [
        ["text", settings.defaultModels.textModel],
        ["image", settings.defaultModels.imageModel],
        ["video", settings.defaultModels.videoModel],
        ["audio", settings.defaultModels.audioModel],
    ].flatMap(([capability, id]) => (capabilities.has(capability) && id ? [id] : []));
}

function modelPriority(id: string, requested: Map<string, number>, defaults: Map<string, number>) {
    if (requested.has(id)) return requested.get(id)!;
    if (defaults.has(id)) return requested.size + defaults.get(id)!;
    return requested.size + defaults.size;
}

function plannerContextIds(input: Record<string, unknown>) {
    return {
        modelIds: records(input.availableModels)
            .map((item) => text(item.id))
            .filter(Boolean),
        skillIds: records(input.availableSkills)
            .map((item) => text(item.id))
            .filter(Boolean),
        assetIds: records(input.referencedAssets)
            .map((item) => text(item.id))
            .filter(Boolean),
        recentMessageSequences: records(record(input.conversationContext).recentMessages)
            .map((item) => Number(item.sequence))
            .filter((value) => Number.isFinite(value)),
    };
}

function serializedLength(value: unknown) {
    return JSON.stringify(value).length;
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function records(value: unknown): Array<Record<string, unknown>> {
    return Array.isArray(value) ? value.map(record) : [];
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

export { selectedCanvasNodeIds } from "./agent-run-canvas-snapshot";

export function taskPlanSummary(task: AgentRunTask) {
    return { id: task.id, title: task.title, type: task.type, model: task.model, dependencies: task.dependencies, referenceAssetIds: task.references?.map((item) => item.assetId).filter(Boolean) || [] };
}

export function conversationFallbackReply(surface: CreativeSurface) {
    if (surface === "canvas") return "在的，你可以直接告诉我想了解什么，或让我操作当前画布。";
    if (surface === "drama") return "在的，你可以直接询问当前项目，也可以让我继续创作角色、场景、分镜或媒体产物。";
    return "在的，你可以直接告诉我想了解什么，或描述你想创作的内容。";
}

export function resolveTaskReference(requestedIds: string[] | undefined, assets: Map<string, CreativeAsset>, taskType: AgentRunTask["type"]) {
    return resolveTaskReferences(requestedIds, assets, taskType)[0];
}

export function resolveTaskReferences(requestedIds: string[] | undefined, assets: Map<string, CreativeAsset>, taskType: AgentRunTask["type"]) {
    const requested = Array.from(new Set((requestedIds || []).map((id) => id.trim()).filter(Boolean)))
        .map((id) => assets.get(id))
        .filter((asset): asset is CreativeAsset => Boolean(asset));
    return requested.filter((asset) => {
        if (taskType === "image") return asset.type === "image" && Boolean(assetAccessUrl(asset));
        if (taskType === "video") return asset.type !== "text" && Boolean(assetAccessUrl(asset));
        if (taskType === "audio") return asset.type === "audio" || asset.type === "text";
        return true;
    });
}

export function assetAccessUrl(asset?: CreativeAsset) {
    if (!asset) return undefined;
    return [asset.remoteUrl, asset.serverUrl].find((value) => typeof value === "string" && value.trim() && !value.startsWith("data:"))?.trim();
}

export function creativeAssetContext(asset: CreativeAsset, alias?: string) {
    const content = asset.textContent?.trim();
    const url = assetAccessUrl(asset);
    return [alias ? `引用别名：@${alias}` : "", `资产 ID：${asset.id}`, `类型：${asset.type}`, `标题：${asset.title}`, content ? `文本：${content}` : "", url ? `媒体地址：${url}` : ""].filter(Boolean).join("；");
}

export function agentPlanReply(_plan: AgentPlan, tasks: AgentRunTask[], surface: CreativeSurface) {
    const hasReferences = tasks.some((task) => task.targetNodeId || task.references?.length);
    if (surface === "canvas" && tasks.length === 1 && tasks[0]?.type === "text" && tasks[0].targetNodeId) return "已收到，我会直接修改当前提示词节点，不会自动生成图片。";
    if (surface === "canvas") return hasReferences ? "已收到，我会基于当前参考素材完成这次画布创作。" : "已收到，我会按你的要求完成这次画布创作。";
    if (surface === "drama") return hasReferences ? "已收到，我会基于当前项目素材继续创作。" : "已收到，我会按你的要求继续完成项目创作。";
    return hasReferences ? "已收到，我会基于当前参考素材完成这次创作。" : "已收到，我会按你的要求完成这次创作。";
}

function plannerAssetSummary(asset: CreativeAsset, alias?: string) {
    return {
        id: asset.id,
        ...(alias ? { alias: `@${alias}` } : {}),
        type: asset.type,
        title: asset.title,
        ...(asset.textContent ? { textContent: asset.textContent } : {}),
        ...(assetAccessUrl(asset) ? { url: assetAccessUrl(asset) } : {}),
        ...(asset.mimeType ? { mimeType: asset.mimeType } : {}),
    };
}
