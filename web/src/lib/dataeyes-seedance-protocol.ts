import type { ChannelProtocolDefinition } from "@/lib/channel-protocol-registry";

const taskPath = "/seedance/api/v3/contents/generations/tasks";

export const dataeyesSeedanceProtocol: ChannelProtocolDefinition = {
    id: "dataeyes-seedance",
    label: "DataEyes Seedance",
    description: "DataEyes 网关的 Seedance 视频协议；从当前密钥的模型目录同步模型。",
    apiFormat: "openai",
    authMode: "bearer",
    defaultBaseUrl: "https://platform.dataeyes.ai",
    modelCatalogPaths: ["/v1/models"],
    capabilities: ["video"],
    operations: {
        video: {
            capability: "video",
            createPath: taskPath,
            imageToVideoPath: taskPath,
            queryPath: `${taskPath}/:task_id`,
            cancelPath: `${taskPath}/:task_id`,
            cancelMethod: "DELETE",
            requestTemplate: '{"model":"{{model}}","content":"{{content}}","ratio":"{{ratio}}","resolution":"{{resolution}}","duration":"{{duration}}","generate_audio":"{{generate_audio}}"}',
            resultField: "content.video_url",
            statusField: "status",
            referenceRule: "参考素材通过 content 多模态数组提交；具体素材类型、首尾帧和声音能力以所选模型为准。",
            supportsReferenceImage: true,
            supportsReferenceVideo: true,
            supportsReferenceAudio: true,
        },
    },
    strict: true,
};
