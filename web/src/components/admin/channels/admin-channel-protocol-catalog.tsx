"use client";

import { Button, Input } from "antd";
import { Search } from "lucide-react";

import type { LogicalModelCapability, SystemChannelProtocol } from "@/lib/auth/store";
import { channelProtocolDefinitions, type ChannelProtocolDefinition } from "@/lib/channel-protocol-registry";
import { capabilityLabel } from "@/lib/model-routing-config";

export type ProtocolCapabilityFilter = LogicalModelCapability | "all";

const groups: ReadonlyArray<{ id: string; title: string; protocols: readonly SystemChannelProtocol[] }> = [
    { id: "gateway", title: "网关协议", protocols: ["dataeyes-gemini", "dataeyes-flux", "dataeyes-seedream", "dataeyes-seedance", "sub2api", "sub2api-grok", "newapi"] },
    { id: "platform", title: "平台协议", protocols: ["openai", "gemini", "zai-glm", "alibaba-bailian", "volcengine-image", "volcengine-video", "bfl", "kling", "vidu", "minimax", "anthropic", "xai", "yumeng"] },
    { id: "interface", title: "不绑定平台的接口", protocols: ["seedance", "stable-diffusion"] },
];

const definitions = new Map(channelProtocolDefinitions.map((definition) => [definition.id, definition]));

export const builtInProtocolCount = channelProtocolDefinitions.filter((definition) => !["auto", "compatible", "custom"].includes(definition.id)).length;

export function protocolCatalogDescription(definition: ChannelProtocolDefinition) {
    if (definition.id === "dataeyes-seedream") return "DataEyes 图片网关 · /v1/images/generations";
    if (definition.id === "volcengine-image") return "火山方舟接口 · /api/v3/images/generations";
    if (definition.id === "seedance") return "Seedance 2.0 视频任务接口；上游地址由渠道配置决定。";
    if (definition.id === "stable-diffusion") return "Automatic1111 / Forge WebUI 图片接口；上游地址由渠道配置决定。";
    return definition.description;
}

export function visibleProtocolGroups(query: string, capability: ProtocolCapabilityFilter) {
    const search = query.trim().toLocaleLowerCase();
    return groups
        .map((group) => ({
            ...group,
            definitions: group.protocols
                .map((id) => definitions.get(id))
                .filter((definition): definition is ChannelProtocolDefinition => Boolean(definition))
                .filter((definition) => capability === "all" || definition.capabilities.includes(capability))
                .filter((definition) => !search || `${definition.label} ${definition.id} ${protocolCatalogDescription(definition)} ${definition.id === "dataeyes-seedream" ? "ByteDance-Seedream-5.0-pro" : ""}`.toLocaleLowerCase().includes(search)),
        }))
        .filter((group) => group.definitions.length > 0);
}

export function ProtocolCatalogFilters({
    query,
    onQueryChange,
    capability,
    onCapabilityChange,
}: {
    query: string;
    onQueryChange: (value: string) => void;
    capability: ProtocolCapabilityFilter;
    onCapabilityChange: (value: ProtocolCapabilityFilter) => void;
}) {
    const options: ProtocolCapabilityFilter[] = ["all", "text", "image", "video", "audio"];
    return (
        <div className="mb-4 flex min-w-0 flex-col gap-2 lg:flex-row lg:items-center">
            <Input allowClear className="min-w-0 flex-1" prefix={<Search className="size-4 text-stone-400" />} value={query} placeholder="搜索协议、平台或模型" aria-label="搜索协议、平台或模型" onChange={(event) => onQueryChange(event.target.value)} />
            <div className="flex min-w-0 flex-wrap gap-1.5" role="group" aria-label="协议能力筛选">
                {options.map((option) => {
                    const active = capability === option;
                    return (
                        <Button
                            key={option}
                            size="small"
                            aria-label={option === "all" ? "全部" : capabilityLabel(option)}
                            aria-pressed={active}
                            className={
                                active
                                    ? "!border-stone-950 !bg-stone-950 !text-white hover:!border-stone-700 hover:!bg-stone-700 dark:!border-stone-100 dark:!bg-stone-100 dark:!text-stone-950 dark:hover:!border-stone-300 dark:hover:!bg-stone-300"
                                    : "!border-stone-200 !bg-white !text-stone-700 hover:!border-stone-400 hover:!text-stone-950 dark:!border-stone-700 dark:!bg-stone-950 dark:!text-stone-300 dark:hover:!border-stone-500 dark:hover:!text-white"
                            }
                            onClick={() => onCapabilityChange(option)}
                        >
                            {option === "all" ? "全部" : capabilityLabel(option)}
                        </Button>
                    );
                })}
            </div>
        </div>
    );
}
