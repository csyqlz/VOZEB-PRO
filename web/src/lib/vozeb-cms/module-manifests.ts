import type { VozebCmsCapabilityDefinition, VozebCmsModuleManifest } from "@/lib/vozeb-cms/module-contract";

export const VOZEB_CMS_CAPABILITIES = [
    capability("asset.manage", "资产管理", "登记、引用和管理统一资产", "platform", "asset.manage", undefined, false),
    capability("workflow.run", "工作流运行", "启动和控制已发布工作流", "platform", "workflow.run", "workflow", false, "workflow"),
    capability("layout.compose", "页面编排", "创建、预览、发布和回滚受控页面布局", "platform", "layout.compose", undefined, false, "layout-compose"),
    capability("agent.run", "Agent 运行", "规划并执行创作任务", "create", "agent.run", "agent", true, "agent"),
    capability("text.generate", "文本生成", "通过统一创作入口生成文本", "create", "text.generate", "text", true, "text-generate"),
    capability("audio.generate", "音频生成", "通过统一创作入口生成音频", "create", "audio.generate", "audio", true, "audio-generate"),
    capability("canvas.project.manage", "Canvas 项目", "创建和编辑 Canvas 项目", "canvas", "canvas.project.manage", undefined, false, "canvas"),
    capability("drama.project.manage", "短剧项目", "创建和编辑短剧项目", "drama", "drama.project.manage", "drama", false, "drama"),
    capability("drama.workflow.run", "短剧工作流", "运行短剧生产和审核流程", "drama", "drama.workflow.run", "drama", true, "drama-workflow"),
    capability("image.generate", "图片生成", "创建图片生成或编辑任务", "image", "image.generate", "image", true, "image-generate"),
    capability("video.generate", "视频生成", "创建视频生成任务", "video", "video.generate", "video", true, "video-generate"),
] as const satisfies readonly VozebCmsCapabilityDefinition[];

export const VOZEB_CMS_MODULE_MANIFESTS = [
    manifest({
        id: "create",
        name: "创作 Agent",
        description: "统一需求输入、智能规划和多媒体创作入口。",
        routes: ["/create", "/create/*"],
        permissions: ["agent.use"],
        capabilities: ["agent.run", "text.generate", "audio.generate"],
    }),
    manifest({
        id: "canvas",
        name: "Canvas",
        description: "节点式多媒体创作与项目编排工作区。",
        routes: ["/canvas", "/canvas/*"],
        permissions: ["canvas.use"],
        capabilities: ["canvas.project.manage"],
    }),
    manifest({
        id: "drama",
        name: "短剧系统",
        description: "剧本、资产、分镜、镜头生成、审核与合成工作区。",
        routes: ["/drama", "/drama/*"],
        permissions: ["drama.use", "workflow.run"],
        capabilities: ["drama.project.manage", "drama.workflow.run"],
    }),
    manifest({
        id: "image",
        name: "图片生成",
        description: "统一 Agent 中的图片生成与编辑能力。",
        routes: ["/image", "/image/*"],
        permissions: ["image.generate"],
        capabilities: ["image.generate"],
        dependencies: ["create"],
    }),
    manifest({
        id: "video",
        name: "视频生成",
        description: "统一 Agent 中的视频生成能力。",
        routes: ["/video", "/video/*"],
        permissions: ["video.generate"],
        capabilities: ["video.generate"],
        dependencies: ["create"],
    }),
] as const satisfies readonly VozebCmsModuleManifest[];

function manifest(input: Pick<VozebCmsModuleManifest, "id" | "name" | "description" | "routes" | "permissions" | "capabilities"> & Partial<Pick<VozebCmsModuleManifest, "dependencies">>): VozebCmsModuleManifest {
    return { ...input, version: "0.0.8", enabled: true, dependencies: input.dependencies || [] };
}

function capability(
    id: string,
    name: string,
    description: string,
    moduleId: VozebCmsCapabilityDefinition["moduleId"],
    actionId: string,
    taskType: VozebCmsCapabilityDefinition["taskType"],
    billable: boolean,
    feature?: string,
): VozebCmsCapabilityDefinition {
    return { id, name, description, moduleId, actionId, taskType, billable, ...(feature ? { feature } : {}) };
}
