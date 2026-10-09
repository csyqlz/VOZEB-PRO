"use client";

import { AutoComplete, Input, InputNumber, Select } from "antd";
import { CircleGauge, SlidersHorizontal, Sparkles } from "lucide-react";

import type { AuthSettings } from "@/lib/auth/store";
import { resolveLogicalModelConfig } from "@/lib/model-routing-config";
import { LabeledControl, SectionTitle } from "@/components/admin/admin-settings-controls";

const settingsPanelSurfaceClass = "rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950";

export type AgentReadiness = {
    ready: boolean;
    capabilities: Array<{
        type: "text" | "image" | "video" | "audio";
        model: string;
        configured?: boolean;
        channelId?: string;
        channelName?: string;
        upstreamModel?: string;
        protocol?: string;
        apiFormat?: string;
        ready: boolean;
        message: string;
        checks: Array<{ key: string; label: string; status: "pass" | "warn" | "fail"; message: string }>;
    }>;
    skills: Record<"image" | "video" | "canvas" | "drama", number>;
    diagnostics?: {
        checkedAt: string;
        summary: string;
        blockingIssues: string[];
        warnings: string[];
        probes?: Array<{
            capability: "text";
            status: "pass" | "fail" | "skip";
            message: string;
            protocol?: string;
            channelName?: string;
            logicalModel?: string;
            upstreamModel?: string;
            elapsedMs?: number;
            pointsCost?: number;
        }>;
    };
};

export function GenerationConcurrencyPanel({ settings, onChange }: { settings: AuthSettings; onChange: (key: keyof AuthSettings["generationConcurrency"], value: number | null) => void }) {
    return (
        <div className={settingsPanelSurfaceClass}>
            <SectionTitle icon={<Sparkles className="size-4" />} title="每用户并发上限" />
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <LabeledControl label="Agent 同时运行">
                    <InputNumber className="w-full" min={1} precision={0} value={settings.generationConcurrency.agent} onChange={(value) => onChange("agent", value)} />
                </LabeledControl>
                <LabeledControl label="生图同时生成">
                    <InputNumber className="w-full" min={1} precision={0} value={settings.generationConcurrency.image} onChange={(value) => onChange("image", value)} />
                </LabeledControl>
                <LabeledControl label="视频同时生成">
                    <InputNumber className="w-full" min={1} precision={0} value={settings.generationConcurrency.video} onChange={(value) => onChange("video", value)} />
                </LabeledControl>
                <LabeledControl label="音频同时生成">
                    <InputNumber className="w-full" min={1} precision={0} value={settings.generationConcurrency.audio} onChange={(value) => onChange("audio", value)} />
                </LabeledControl>
                <LabeledControl label="文本同时生成">
                    <InputNumber className="w-full" min={1} precision={0} value={settings.generationConcurrency.text} onChange={(value) => onChange("text", value)} />
                </LabeledControl>
                <LabeledControl label="整集合成同时运行">
                    <InputNumber className="w-full" min={1} precision={0} value={settings.generationConcurrency.render} onChange={(value) => onChange("render", value)} />
                </LabeledControl>
            </div>
            <div className="mt-2 text-xs leading-5 text-stone-500 dark:text-stone-400">限制的是单个用户自己的并发任务，不是全站共享上限。</div>
        </div>
    );
}

export function GenerationCostControlPanel({ settings, onChange }: { settings: AuthSettings; onChange: (key: keyof AuthSettings["generationCostControl"], value: number | null) => void }) {
    return (
        <div className={settingsPanelSurfaceClass}>
            <SectionTitle icon={<CircleGauge className="size-4" />} title="生成成本保护" />
            <div className="mt-4 grid gap-3 sm:grid-cols-3 xl:grid-cols-1 2xl:grid-cols-3">
                <LabeledControl label="单任务积分上限">
                    <InputNumber className="w-full" min={0} precision={2} value={settings.generationCostControl.maxPointsPerTask} onChange={(value) => onChange("maxPointsPerTask", value)} />
                </LabeledControl>
                <LabeledControl label="单用户每日积分上限">
                    <InputNumber className="w-full" min={0} precision={2} value={settings.generationCostControl.dailyUserPointSpend} onChange={(value) => onChange("dailyUserPointSpend", value)} />
                </LabeledControl>
                <LabeledControl label="全站每日积分上限">
                    <InputNumber className="w-full" min={0} precision={2} value={settings.generationCostControl.dailyTotalPointSpend} onChange={(value) => onChange("dailyTotalPointSpend", value)} />
                </LabeledControl>
            </div>
        </div>
    );
}

export function localAgentReadiness(settings: AuthSettings): AgentReadiness {
    const models = { text: settings.defaultModels.textModel, image: settings.defaultModels.imageModel, video: settings.defaultModels.videoModel, audio: settings.defaultModels.audioModel } as const;
    const capabilities = Object.entries(models).map(([type, model]) => {
        const capability = type as keyof typeof models;
        const resolved = resolveLogicalModelConfig(settings.logicalModels, settings.systemChannels, capability, model);
        const configured = isRequiredCapability(capability) || Boolean(model) || settings.logicalModels.some((item) => item.enabled && item.capability === capability && item.bindings.some((binding) => binding.enabled));
        const checks = !configured
            ? [
                  { key: "optional-capability", label: "能力状态", status: "warn" as const, message: "当前 MVP 未启用，可后续接入" },
                  { key: "generation-defaults", label: "生成参数", status: "pass" as const, message: "默认参数可用于诊断" },
              ]
            : [
            { key: "default-model", label: "默认模型", status: model ? ("pass" as const) : ("fail" as const), message: model ? `默认模型：${model}` : "未设置默认模型" },
            { key: "logical-binding", label: "逻辑绑定", status: resolved ? ("pass" as const) : ("fail" as const), message: resolved ? `已绑定上游模型：${resolved.binding.upstreamModel}` : "默认模型没有可用渠道绑定" },
            { key: "channel", label: "渠道状态", status: resolved?.channel.enabled ? ("pass" as const) : ("fail" as const), message: resolved?.channel ? `渠道可用：${resolved.channel.name}` : "没有可用渠道" },
            { key: "api-key", label: "API Key", status: resolved?.channel.apiKey?.trim() ? ("pass" as const) : ("fail" as const), message: resolved?.channel.apiKey?.trim() ? "API Key 已配置" : "API Key 未配置" },
        ];
        return { type: capability, model, configured, channelId: resolved?.channel.id, channelName: resolved?.channel.name, upstreamModel: resolved?.binding.upstreamModel, protocol: resolved?.channel.advancedConfig?.protocol || resolved?.channel.apiFormat, apiFormat: resolved?.channel.apiFormat, ready: !configured || Boolean(model && resolved), message: !configured ? "当前 MVP 未启用" : !model ? "未设置默认模型" : !resolved ? "默认模型没有可用渠道绑定" : "使用渠道：" + resolved.channel.name, checks };
    });
    const skills = { image: 0, video: 0, canvas: 0, drama: 0 };
    for (const skill of settings.agentSkills) if (skill.enabled) for (const workspace of skill.workspaces || ["image"]) skills[workspace] += 1;
    const blockingIssues = capabilities.flatMap((capability) => {
        if (!isRequiredCapability(capability.type) && !capability.configured) return [];
        return capability.checks.filter((check) => check.status === "fail").map((check) => `${{ text: "文本", image: "图片", video: "视频", audio: "音频" }[capability.type]}：${check.message}`);
    });
    return { ready: capabilities.every((item) => item.ready), capabilities, skills, diagnostics: { checkedAt: new Date().toISOString(), summary: blockingIssues.length ? `发现 ${blockingIssues.length} 个阻断项` : "模型配置已就绪", blockingIssues, warnings: [] } };
}

function isRequiredCapability(type: "text" | "image" | "video" | "audio") {
    return type === "text" || type === "image";
}

export function GenerationDefaultsPanel({ settings, onChange }: { settings: AuthSettings; onChange: <K extends keyof AuthSettings["generationDefaults"]>(key: K, value: AuthSettings["generationDefaults"][K]) => void }) {
    return (
        <div className={settingsPanelSurfaceClass}>
            <SectionTitle icon={<SlidersHorizontal className="size-4" />} title="生成默认值" />
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <LabeledControl label="画布默认生图张数">
                    <InputNumber className="w-full" min={1} precision={0} value={settings.generationDefaults.canvasImageCount} onChange={(value) => onChange("canvasImageCount", value || 1)} />
                </LabeledControl>
                <LabeledControl label="Agent 默认生图张数">
                    <InputNumber className="w-full" min={1} precision={0} value={settings.generationDefaults.imageCount} onChange={(value) => onChange("imageCount", value || 1)} />
                </LabeledControl>
                <LabeledControl label="默认图片/视频比例">
                    <Select
                        className="w-full"
                        value={settings.generationDefaults.imageSize}
                        options={["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"].map((value) => ({ value, label: value }))}
                        onChange={(value) => onChange("imageSize", value)}
                    />
                </LabeledControl>
                <LabeledControl label="默认图片质量">
                    <Select
                        className="w-full"
                        value={settings.generationDefaults.imageQuality}
                        options={[
                            { value: "auto", label: "自动" },
                            { value: "low", label: "低清" },
                            { value: "medium", label: "中等" },
                            { value: "high", label: "高清" },
                        ]}
                        onChange={(value) => onChange("imageQuality", value)}
                    />
                </LabeledControl>
                <LabeledControl label="默认视频清晰度">
                    <AutoComplete
                        className="w-full"
                        value={settings.generationDefaults.videoQuality}
                        options={["480", "720", "1080"].map((value) => ({ value, label: value + "p" }))}
                        placeholder="例如 720、1440 或 2K"
                        onChange={(value) => onChange("videoQuality", value)}
                    />
                </LabeledControl>
                <LabeledControl label="默认视频秒数">
                    <InputNumber className="w-full" min={-1} precision={0} placeholder="-1 表示智能" value={settings.generationDefaults.videoSeconds} onChange={(value) => onChange("videoSeconds", value ?? 5)} />
                </LabeledControl>
                <LabeledControl label="默认音频音色">
                    <Input value={settings.generationDefaults.audioVoice} onChange={(event) => onChange("audioVoice", event.target.value)} />
                </LabeledControl>
                <LabeledControl label="默认音频格式">
                    <Select className="w-full" value={settings.generationDefaults.audioFormat} options={["mp3", "wav", "opus", "aac", "flac"].map((value) => ({ value, label: value.toUpperCase() }))} onChange={(value) => onChange("audioFormat", value)} />
                </LabeledControl>
            </div>
            <div className="mt-2 text-xs leading-5 text-stone-500 dark:text-stone-400">新建画布生图节点和配置节点默认使用，单个节点仍可单独覆盖。</div>
        </div>
    );
}
