import type { AuthSettings, LogicalModelCapability } from "@/lib/auth/store";

import type { EcommerceLogicalModelRole } from "./agent-run-surface-policy";
import { resolveLogicalModelCandidates, resolveLogicalModelSnapshot, type ResolvedLogicalModel } from "./logical-model-router";
import { toSystemGenerationChannel } from "./generation-channel";
import { resolveImageEditProtocol, sameImageEditProtocol, type ImageEditProtocol } from "./image-edit-protocol";

export type EcommerceModelRoutingSettings = Pick<AuthSettings, "defaultModels" | "logicalModels" | "systemChannels"> & {
    ecommerceModelRoles?: Partial<Record<EcommerceLogicalModelRole, string[]>>;
};

export type EcommerceRoleRouteSnapshot = {
    logicalRole: EcommerceLogicalModelRole;
    capability: LogicalModelCapability;
    logicalModelId: string;
    channelId: string;
    upstreamModel: string;
    apiFormat: "openai" | "gemini";
    imageEdit?: ImageEditProtocol;
};

export type EcommerceRoleCandidate = ResolvedLogicalModel & {
    logicalRole: EcommerceLogicalModelRole;
    capability: LogicalModelCapability;
    snapshot: EcommerceRoleRouteSnapshot;
};

export function resolveEcommerceRoleCandidates(settings: EcommerceModelRoutingSettings, role: EcommerceLogicalModelRole, capability: LogicalModelCapability): EcommerceRoleCandidate[] {
    if (capability !== capabilityForRole(role)) return [];
    const configured = settings.ecommerceModelRoles?.[role]?.map((id) => id.trim()).filter(Boolean);
    const modelIds = configured?.length ? configured : [capability === "image" ? settings.defaultModels.imageModel : settings.defaultModels.textModel].filter(Boolean);
    const seen = new Set<string>();
    return modelIds.flatMap((logicalModelId) =>
        resolveLogicalModelCandidates(settings, capability, logicalModelId).flatMap((candidate) => {
            const key = `${candidate.logicalModelId}\u0000${candidate.channelId}\u0000${candidate.upstreamModel}`;
            if (seen.has(key)) return [];
            seen.add(key);
            return [withRole(candidate, role, capability)];
        }),
    );
}

export function routeEcommerceRole(settings: EcommerceModelRoutingSettings, role: EcommerceLogicalModelRole, snapshot?: EcommerceRoleRouteSnapshot | null): EcommerceRoleCandidate | null {
    const capability = capabilityForRole(role);
    if (snapshot) {
        if (snapshot.logicalRole !== role || snapshot.capability !== capability) return null;
        const resolved = resolveLogicalModelSnapshot(settings, capability, snapshot);
        if (!resolved) return null;
        const candidate = withRole(resolved, role, capability);
        if (candidate.snapshot.apiFormat !== snapshot.apiFormat || (snapshot.imageEdit && (!candidate.snapshot.imageEdit || !sameImageEditProtocol(snapshot.imageEdit, candidate.snapshot.imageEdit)))) return null;
        return candidate;
    }
    return resolveEcommerceRoleCandidates(settings, role, capability)[0] || null;
}

function capabilityForRole(role: EcommerceLogicalModelRole): LogicalModelCapability {
    return role === "image_generation" ? "image" : "text";
}

function withRole(candidate: ResolvedLogicalModel, role: EcommerceLogicalModelRole, capability: LogicalModelCapability): EcommerceRoleCandidate {
    const config = toSystemGenerationChannel(candidate);
    const apiFormat = config.apiFormat;
    return {
        ...candidate,
        logicalRole: role,
        capability,
        snapshot: {
            logicalRole: role,
            capability,
            logicalModelId: candidate.logicalModelId,
            channelId: candidate.channelId,
            upstreamModel: candidate.upstreamModel,
            apiFormat,
            ...(capability === "image" ? { imageEdit: resolveImageEditProtocol(config, candidate.channel.baseUrl) } : {}),
        },
    };
}
