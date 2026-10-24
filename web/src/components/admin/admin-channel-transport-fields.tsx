"use client";

import { Input, Select } from "antd";

import { LabeledControl } from "@/components/admin/admin-settings-controls";
import type { SystemChannelAdvancedConfig, SystemChannelAuthMode, SystemModelChannel } from "@/lib/auth/store";
import { validChannelPathPrefix } from "@/lib/channel-path-prefix";

export function AdminChannelTransportFields({ channel, onChange }: { channel: SystemModelChannel; onChange: (patch: Partial<SystemModelChannel>) => void }) {
    const advanced = channel.advancedConfig!;
    const update = (patch: Partial<SystemChannelAdvancedConfig>) => onChange({ advancedConfig: { ...advanced, ...patch } });
    const authMode = advanced.channelAuthMode || "official";
    return (
        <div className="grid gap-3 sm:grid-cols-2">
            <LabeledControl label="渠道路径前缀（可选）">
                <Input value={advanced.pathPrefix || ""} status={validChannelPathPrefix(advanced.pathPrefix || "") ? undefined : "error"} placeholder="例如 /kling；官方直连留空" onChange={(event) => update({ pathPrefix: event.target.value })} />
            </LabeledControl>
            <LabeledControl label="渠道鉴权（与官方不同时选择）">
                <Select
                    className="w-full"
                    value={authMode}
                    options={[
                        { value: "official", label: "沿用官方协议" },
                        { value: "bearer", label: "Bearer Token" },
                        { value: "x-api-key", label: "X-API-Key" },
                        { value: "custom-header", label: "自定义 Header" },
                        { value: "none", label: "无需鉴权" },
                    ]}
                    onChange={(value: SystemChannelAuthMode | "official") => update({ channelAuthMode: value === "official" ? undefined : value })}
                />
            </LabeledControl>
            {authMode === "custom-header" ? (
                <>
                    <LabeledControl label="渠道鉴权 Header">
                        <Input value={advanced.channelAuthHeader || ""} placeholder="例如 Authorization" onChange={(event) => update({ channelAuthHeader: event.target.value })} />
                    </LabeledControl>
                    <LabeledControl label="Header 值前缀（可选）">
                        <Input value={advanced.channelAuthPrefix || ""} placeholder="例如 Token" onChange={(event) => update({ channelAuthPrefix: event.target.value })} />
                    </LabeledControl>
                </>
            ) : null}
            <p className="sm:col-span-2 text-xs text-stone-500 dark:text-stone-400">Base URL 填根域名；调用路径由渠道前缀和所选协议的原始路径组成。模型目录路径独立填写，不自动添加前缀。</p>
        </div>
    );
}
