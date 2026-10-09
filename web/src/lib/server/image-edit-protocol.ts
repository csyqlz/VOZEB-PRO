import type { ApiCallFormat, SystemChannelAdvancedConfig, SystemChannelProtocol } from "@/lib/auth/store-types";
import { resolveChannelModelAdvancedConfig, resolveChannelModelConfig } from "@/lib/channel-protocol-registry";
import { resolveGlobalAiOpcPreset } from "@/lib/globalaiopc-catalog";

type ImageEditConfig = { apiFormat: ApiCallFormat; model: string; baseUrl?: string; advancedConfig?: SystemChannelAdvancedConfig };
export type ImageEditProtocol = {
    protocol: SystemChannelProtocol;
    editPath: string;
    transport: "multipart" | "json";
    supportsIndependentMask: boolean;
};

// Resolve the same model-level settings and encoder used by the image adapter.
// Only native sub2api JSON has the independent mask.image_url contract.
export function resolveImageEditProtocol(input: ImageEditConfig, apiBase = input.baseUrl || ""): ImageEditProtocol {
    const model = resolveChannelModelConfig(input.advancedConfig, input.model);
    const config = { ...input, apiFormat: model?.apiFormat || input.apiFormat, advancedConfig: resolveChannelModelAdvancedConfig(input.advancedConfig, input.model) };
    const protocol = config.advancedConfig?.protocol || "auto";
    const nativeSub2Api = isNativeSub2ApiImageEdit(config);
    const preset = resolveGlobalAiOpcPreset(config.advancedConfig, config.model);
    const referenceMode = configuredImageEditReferenceMode(config);
    const transport = nativeSub2Api || preset?.capability === "image" || shouldUseSub2ApiImageEdit(config, apiBase) || referenceMode === "json" || referenceMode === "public-url" ? "json" : "multipart";
    const configuredPath = config.advancedConfig?.createPath?.trim();
    const createPath = configuredPath ? normalizeImageTaskPath(configuredPath) : "";
    const configuredEdit = config.advancedConfig?.editPath?.trim();
    const editPath = configuredEdit
        ? normalizeImageTaskPath(configuredEdit)
        : nativeSub2Api
          ? "/images/edits"
          : shouldUseSub2ApiImageEdit(config, apiBase)
            ? createPath || "/images/generations"
            : configuredImageEditPath(config) ||
              (!createPath
                  ? "/images/edits"
                  : referenceMode === "json" || referenceMode === "public-url" || preset?.capability === "image"
                    ? createPath
                    : isStandardOpenAiImageGenerationPath(createPath)
                      ? createPath.replace(/\/generations$/i, "/edits")
                      : createPath);
    const standardEdits = /^\/(?:v1\/)?images\/edits$/i.test(editPath);
    const supportsIndependentMask = config.apiFormat === "openai" && standardEdits && (nativeSub2Api || (transport === "multipart" && ["openai", "auto", "compatible", "newapi"].includes(protocol)));
    return { protocol, editPath, transport, supportsIndependentMask };
}

export function sameImageEditProtocol(left: ImageEditProtocol, right: ImageEditProtocol) {
    return left.protocol === right.protocol && left.editPath === right.editPath && left.transport === right.transport && left.supportsIndependentMask === right.supportsIndependentMask;
}

export function configuredImageEditPath(config: Pick<ImageEditConfig, "advancedConfig">) {
    const match = (config.advancedConfig?.referenceRule || "").trim().match(/\/(?:[a-z0-9._-]+\/)*images\/edits\b/i);
    return match?.[0] ? normalizeImageTaskPath(match[0]) : "";
}

export function normalizeImageTaskPath(path: string) {
    return path.startsWith("/") ? path : `/${path}`;
}

export function isStandardOpenAiImageGenerationPath(path: string) {
    return /^\/(?:v1\/)?images\/generations$/i.test(path);
}

export function configuredImageEditReferenceMode(config: Pick<ImageEditConfig, "advancedConfig">): "auto" | "multipart" | "json" | "public-url" {
    const rule = (config.advancedConfig?.referenceRule || "").trim().toLowerCase();
    if (!rule) return "auto";
    if (/\bmultipart\b|form-?data|file upload|\u6587\u4ef6\u4e0a\u4f20|\u4e0a\u4f20\u6587\u4ef6/i.test(rule)) return "multipart";
    if (/\u516c\u7f51|public|next_public_site_url|localhost|must.*\burl\b|\burl\b.*only|\u5fc5\u987b.*\burl\b|\u4ec5.*\burl\b|\u53ea.*\burl\b/i.test(rule)) return "public-url";
    if (/\bjson\b|base64.*json|json.*base64|data:image|inline|ref_assets|input_image|image\/images/i.test(rule)) return "json";
    return "auto";
}

export function shouldUseSub2ApiImageEdit(config: Pick<ImageEditConfig, "model" | "advancedConfig">, apiBase: string) {
    if (isNativeSub2ApiImageEdit(config) || isCode2AlitaApiBase(apiBase)) return true;
    const requestTemplate = (config.advancedConfig?.requestTemplate || "").toLowerCase();
    const referenceRule = (config.advancedConfig?.referenceRule || "").toLowerCase();
    if (/\bsub2api\b/i.test(`${requestTemplate}\n${referenceRule}`)) return true;
    return /\bimage_urls\b|images\[\]\.image_url|"images"\s*:\s*\[\s*\{\s*"image_url"|images\s*:\s*\[\s*\{\s*image_url/i.test(requestTemplate);
}

export function isNativeSub2ApiImageEdit(config: Pick<ImageEditConfig, "model" | "advancedConfig">) {
    return (resolveChannelModelConfig(config.advancedConfig, config.model)?.protocol || config.advancedConfig?.protocol) === "sub2api";
}

export function isCode2AlitaApiBase(baseUrl: string) {
    return matchesApiHost(baseUrl, "code2alita.com");
}

export function matchesApiHost(baseUrl: string, hostname: string) {
    try {
        const host = new URL(baseUrl).hostname.toLowerCase();
        const target = hostname.toLowerCase();
        return host === target || host.endsWith(`.${target}`);
    } catch {
        return false;
    }
}
