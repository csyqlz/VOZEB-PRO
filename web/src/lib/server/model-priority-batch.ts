import { createHash } from "node:crypto";

import type { AuthSettings, LogicalModel, LogicalModelBinding, LogicalModelCapability } from "@/lib/auth/store";
import { updateAuthSettingsWith } from "@/lib/auth/store";
import { channelConnectionReady } from "@/lib/channel-protocol-registry";
import { currentChannelModels } from "@/lib/channel-model-availability";
import { compareLogicalModelBindings } from "@/lib/model-routing-config";
import { channelSupportsModel } from "@/lib/server/generation-channel";

type Scope = { channelIds: string[]; manufacturer?: string; series?: string; capability?: LogicalModelCapability; priority: number; excluded?: string[] };
type SelectedBinding = { modelId: string; bindingId: string; version: string };
type BatchInput = { priority: number; selected: SelectedBinding[]; excluded?: string[] };

export class ModelPriorityConflict extends Error {
    constructor(public readonly items: string[]) {
        super("模型绑定已变化，请重新预览");
    }
}

export function validPriority(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 10000;
}

export function previewModelPriorities(settings: Pick<AuthSettings, "logicalModels" | "systemChannels">, scope: Scope) {
    if (!validPriority(scope.priority) || !Array.isArray(scope.channelIds) || !scope.channelIds.length || scope.channelIds.some((id) => typeof id !== "string")) throw new Error("请选择渠道和有效优先级");
    const channelIds = new Set(scope.channelIds);
    const excluded = new Set(scope.excluded || []);
    const rows = settings.logicalModels.flatMap((model) => {
        if (scope.manufacturer && model.manufacturer !== scope.manufacturer) return [];
        if (scope.series && model.series !== scope.series) return [];
        if (scope.capability && model.capability !== scope.capability) return [];
        const selected = model.bindings.filter((binding) => channelIds.has(binding.channelId));
        if (!selected.length) return [];
        const version = modelRoutingVersion(model, settings.systemChannels);
        const before = orderedBindings(model, settings.systemChannels);
        const after = orderedBindings(
            {
                ...model,
                bindings: model.bindings.map((binding) =>
                    selected.some((item) => item.id === binding.id) && !excluded.has(`${model.id}:${binding.id}`) && binding.enabled && model.enabled && settings.systemChannels.some((channel) => channel.id === binding.channelId && channel.enabled)
                        ? { ...binding, priority: scope.priority }
                        : binding,
                ),
            },
            settings.systemChannels,
        );
        return selected.map((binding) => ({
            modelId: model.id,
            modelName: model.name,
            manufacturer: model.manufacturer || "",
            series: model.series || "",
            capability: model.capability,
            modelEnabled: model.enabled,
            bindingId: binding.id,
            channelId: binding.channelId,
            channelName: settings.systemChannels.find((channel) => channel.id === binding.channelId)?.name || binding.channelId,
            upstreamModel: binding.upstreamModel,
            enabled: binding.enabled,
            channelEnabled: settings.systemChannels.some((channel) => channel.id === binding.channelId && channel.enabled),
            weight: binding.weight || 100,
            oldPriority: binding.priority,
            newPriority: scope.priority,
            before,
            after,
            version,
            excluded: excluded.has(`${model.id}:${binding.id}`) || !binding.enabled || !model.enabled || !settings.systemChannels.some((channel) => channel.id === binding.channelId && channel.enabled),
        }));
    });
    return rows;
}

export async function commitModelPriorities(input: BatchInput) {
    if (!validPriority(input.priority) || !Array.isArray(input.selected) || !input.selected.length || input.selected.some((item) => !item || typeof item.modelId !== "string" || typeof item.bindingId !== "string" || typeof item.version !== "string")) {
        throw new Error("请选择有效的模型绑定和优先级");
    }
    const keys = input.selected.map((item) => `${item.modelId}:${item.bindingId}`);
    if (new Set(keys).size !== keys.length) throw new Error("模型绑定不能重复提交");
    const changes: Array<{ modelId: string; bindingId: string; channelId: string; oldPriority: number; newPriority: number }> = [];
    await updateAuthSettingsWith((current) => {
        const conflicts: string[] = [];
        const selected = new Map(input.selected.map((item) => [`${item.modelId}:${item.bindingId}`, item]));
        const matched = new Set<string>();
        const next = current.logicalModels.map((model) => {
            const modelSelected = input.selected.filter((item) => item.modelId === model.id);
            if (!modelSelected.length) return model;
            const version = modelRoutingVersion(model, current.systemChannels);
            const bindings = model.bindings.map((binding) => {
                const key = `${model.id}:${binding.id}`;
                const request = selected.get(key);
                if (!request) return binding;
                matched.add(key);
                if (request.version !== version || !model.enabled || !binding.enabled || !current.systemChannels.some((channel) => channel.id === binding.channelId && channel.enabled)) {
                    conflicts.push(key);
                    return binding;
                }
                changes.push({ modelId: model.id, bindingId: binding.id, channelId: binding.channelId, oldPriority: binding.priority, newPriority: input.priority });
                return { ...binding, priority: input.priority };
            });
            return { ...model, bindings };
        });
        for (const key of keys) if (!matched.has(key)) conflicts.push(key);
        if (conflicts.length) throw new ModelPriorityConflict(conflicts);
        return { logicalModels: next };
    });
    return { changes, scope: { channelIds: Array.from(new Set(changes.map((item) => item.channelId))), modelIds: Array.from(new Set(changes.map((item) => item.modelId))), priority: input.priority }, excluded: input.excluded || [] };
}

function orderedBindings(model: LogicalModel, channels: AuthSettings["systemChannels"]) {
    if (!model.enabled) return [];
    return model.bindings
        .filter((binding) => binding.enabled && channels.some((channel) => channel.id === binding.channelId && channel.enabled && channelConnectionReady(channel) && channelSupportsModel(currentChannelModels(channel), binding.upstreamModel)))
        .sort(compareLogicalModelBindings)
        .map((binding) => binding.id);
}

function modelRoutingVersion(model: LogicalModel, channels: AuthSettings["systemChannels"]) {
    const snapshot = {
        id: model.id,
        capability: model.capability,
        enabled: model.enabled,
        manufacturer: model.manufacturer || "",
        series: model.series || "",
        bindings: model.bindings.map((binding: LogicalModelBinding) => ({ id: binding.id, channelId: binding.channelId, upstreamModel: binding.upstreamModel, enabled: binding.enabled, priority: binding.priority, weight: binding.weight || 100 })),
        channels: model.bindings.map((binding) => {
            const channel = channels.find((item) => item.id === binding.channelId);
            return { id: binding.channelId, enabled: channel?.enabled, models: channel?.models };
        }),
    };
    return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}
