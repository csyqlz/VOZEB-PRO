import type { ChannelProtocolDefinition } from "@/lib/channel-protocol-registry";

/** DataEyes FLUX ignores n and quality and returns one image per request. */
export function dataeyesFluxFixedImageUnits(protocol: string | undefined, regularUnits: number) {
    return protocol === "dataeyes-flux" ? 1 : regularUnits;
}

export const dataeyesFluxProtocol: ChannelProtocolDefinition = {
    id: "dataeyes-flux",
    label: "DataEyes FLUX",
    description: "DataEyes 的同步 OpenAI 图片接口；与 BFL 官方异步协议分别配置。",
    apiFormat: "openai",
    authMode: "bearer",
    defaultBaseUrl: "https://platform.dataeyes.ai",
    modelCatalogPaths: ["/v1/models"],
    capabilities: ["image"],
    operations: {
        image: {
            capability: "image",
            createPath: "/images/generations",
            editPath: "/images/edits",
            requestTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","size":"{{size}}"}',
            resultField: "data[0].url",
            referenceRule: "参考图编辑使用 /images/edits multipart/form-data；返回临时 URL，平台应立即转存。",
            supportsReferenceImage: true,
        },
    },
    strict: true,
};
