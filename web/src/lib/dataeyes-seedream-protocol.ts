import type { ChannelProtocolDefinition } from "@/lib/channel-protocol-registry";

export const DATAEYES_SEEDREAM_5_SIZES = ["1:1", "16:9", "4:3", "3:2", "2:3", "3:4", "9:16", "2K"];

export const dataeyesSeedreamProtocol: ChannelProtocolDefinition = {
    id: "dataeyes-seedream",
    label: "DataEyes Seedream",
    description: "DataEyes 图片网关的 Seedream 协议，与火山方舟官方路径独立。",
    apiFormat: "openai",
    authMode: "bearer",
    defaultBaseUrl: "https://platform.dataeyes.ai",
    modelCatalogPaths: ["/v1/models"],
    capabilities: ["image"],
    operations: {
        image: {
            capability: "image",
            createPath: "/v1/images/generations",
            editPath: "/v1/images/generations",
            requestTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","image":"{{images}}","size":"{{size}}","response_format":"url"}',
            resultField: "data[0].url",
            referenceRule: "参考图使用 DataEyes 可访问的 URL；文生图和图生图使用同一 JSON 接口。",
            supportsReferenceImage: true,
        },
    },
    strict: true,
};

export function isDataeyesSeedream5(protocol: string | undefined, model: string) {
    return protocol === "dataeyes-seedream" && model.trim().toLowerCase() === "bytedance-seedream-5.0-pro";
}
