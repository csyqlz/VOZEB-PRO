"use client";

import type { AdminSectionKey } from "@/components/admin/admin-sections";
import { createDefaultChannelAdvancedConfig } from "@/components/admin/admin-system-channel-editor";
import { toNumberOrOne, toNumberOrZero, uniqueList } from "@/components/admin/admin-values";
import { channelProtocolDefinition, channelSupportsModelCatalog, normalizeStrictProtocolModelConfig } from "@/lib/channel-protocol-registry";
import { nanoid } from "nanoid";
import type { ReactNode } from "react";

import type { AuthSettings, LogicalModelPricing, PublicUser, PublicUserSummary, SiteFriendLink, SiteSocialKey, SystemChannelAdvancedConfig, SystemModelChannel } from "@/lib/auth/store";
import { buildGlobalAiOpcSelection } from "@/lib/globalaiopc-catalog";
import { effectiveBillingUnit } from "@/lib/model-pricing";
import { normalizeDefaultModelsConfig, synchronizeLogicalModelsWithChannels } from "@/lib/model-routing-config";
import type { AdminSetupSummary } from "@/lib/server/admin-setup-status";
import { clampInteger, createSystemChannel, requestAdminModels, type AdminModelsResult } from "./admin-dashboard-elements";
import { removeChannelFromWorkspace } from "./channels/admin-channel-workspace-model";

export type AdminDashboardProps = {
    initialUsers: PublicUser[];
    initialUserSummary: PublicUserSummary;
    initialSettings: AuthSettings;
    initialPromptCount: number;
    currentUser: PublicUser;
    initialSection?: AdminSectionKey;
    setupSummary?: AdminSetupSummary;
    headerActions?: ReactNode;
};
export type PromptFormValue = {
    title: string;
    prompt: string;
    category?: string;
    tags?: string;
    coverUrl?: string;
    preview?: string;
};

export const PROMPT_PAGE_SIZE = 20;
export const PROMPT_SEARCH_DEBOUNCE_MS = 300;
export const CDK_PAGE_SIZE = 20;
export const GENERATION_LOG_PAGE_SIZE = 20;

import type { AdminDashboardDataActions } from "./use-admin-dashboard-data-actions";
import type { AdminDashboardState } from "./use-admin-dashboard-state";

export function useAdminDashboardSettingsActions({ state, data }: { state: AdminDashboardState; data: AdminDashboardDataActions }) {
    const { message, setSettings, getSettings, setMailTestLoading, mailTestTo, setFetchingModelId, customPointModel, setCustomPointModel } = state;
    const { saveSettings } = data;

    const updateSite = (update: (site: AuthSettings["site"]) => AuthSettings["site"]) => {
        const current = getSettings();
        const next = { ...current, site: update(current.site) };
        setSettings(next);
    };
    const getLatestSiteSettings = () => getSettings().site;
    const getLatestSettings = getSettings;

    const updateChannel = (id: string, patch: Partial<SystemModelChannel>) => {
        setSettings((current) => {
            const systemChannels = current.systemChannels.map((channel) => {
                if (channel.id !== id) return channel;
                return {
                    ...channel,
                    ...patch,
                    apiFormat: patch.apiFormat || channel.apiFormat,
                    models: patch.models ? uniqueList(patch.models) : channel.models,
                };
            });
            if (!("models" in patch)) return { ...current, systemChannels };
            const logicalModels = synchronizeLogicalModelsWithChannels(current.logicalModels, systemChannels);
            return { ...current, systemChannels, logicalModels, defaultModels: normalizeDefaultModelsConfig(current.defaultModels, logicalModels, systemChannels) };
        });
    };

    const addChannel = () => {
        setSettings((current) => ({ ...current, systemChannels: [...current.systemChannels, createSystemChannel()] }));
    };

    const deleteChannel = async (id: string) => {
        const current = latestSettingsRef.current;
        const systemChannels = current.systemChannels.filter((channel) => channel.id !== id);
        const logicalModels = synchronizeLogicalModelsWithChannels(current.logicalModels, systemChannels);
        const defaultModels = normalizeDefaultModelsConfig(current.defaultModels, logicalModels, systemChannels);
        return saveSettings({ systemChannels, logicalModels, defaultModels }, "渠道已删除");
    };

    const updateFreeDailyPoints = (value: number | null) => {
        setSettings((current) => ({ ...current, freeDailyPoints: toNumberOrZero(value) }));
    };

    const updateGenerationConcurrency = (key: keyof AuthSettings["generationConcurrency"], value: number | null) => {
        setSettings((current) => ({
            ...current,
            generationConcurrency: {
                ...current.generationConcurrency,
                [key]: Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : current.generationConcurrency[key],
            },
        }));
    };

    const updateGenerationDefaults = <K extends keyof AuthSettings["generationDefaults"]>(key: K, value: AuthSettings["generationDefaults"][K]) => {
        setSettings((current) => ({
            ...current,
            generationDefaults: {
                ...current.generationDefaults,
                [key]: value,
            },
        }));
    };

    const updateGenerationCostControl = (key: keyof AuthSettings["generationCostControl"], value: number | null) => {
        setSettings((current) => ({
            ...current,
            generationCostControl: {
                ...current.generationCostControl,
                [key]: toNumberOrZero(value),
            },
        }));
    };

    const updateDataLifecycle = (key: keyof AuthSettings["dataLifecycle"], value: boolean | number) => {
        const current = getSettings();
        const next = {
            ...current,
            dataLifecycle: {
                ...current.dataLifecycle,
                [key]: key === "maintenanceBatchSize" ? clampInteger(value, 1, 500, current.dataLifecycle.maintenanceBatchSize) : value,
            },
        };
        setSettings(next);
    };

    const updateModelPointCost = (model: string, value: number | null) => {
        setSettings((current) => ({ ...current, modelPointCosts: { ...current.modelPointCosts, [model]: toNumberOrOne(value) } }));
    };

    const updateModelPricing = (modelId: string, patch: Partial<LogicalModelPricing>) => {
        setSettings((current) => ({
            ...current,
            logicalModels: current.logicalModels.map((model) => {
                if (model.id !== modelId) return model;
                const target = model.bindings.find((binding) => binding.enabled !== false) || model.bindings[0];
                if (!target) return model;
                const currentPricing = target.capabilityProfile?.pricing;
                const pricing: LogicalModelPricing = {
                    ...(currentPricing || {}),
                    ...patch,
                    billingUnit: effectiveBillingUnit(model.capability, patch.billingUnit || currentPricing?.billingUnit),
                    currency: "CNY",
                };
                return { ...model, bindings: model.bindings.map((binding) => (binding.id === target.id ? { ...binding, capabilityProfile: { ...(binding.capabilityProfile || {}), pricing } } : binding)) };
            }),
        }));
    };

    const updateGenerationPointMultiplier = (group: keyof AuthSettings["generationPointMultipliers"], key: string, value: number | null) => {
        setSettings((current) => ({
            ...current,
            generationPointMultipliers: {
                ...current.generationPointMultipliers,
                [group]: {
                    ...current.generationPointMultipliers[group],
                    [key]: toNumberOrOne(value),
                },
            },
        }));
    };

    const deleteGenerationPointMultiplier = (group: keyof AuthSettings["generationPointMultipliers"], key: string) => {
        setSettings((current) => {
            const nextGroup = { ...current.generationPointMultipliers[group] };
            delete nextGroup[key];
            return {
                ...current,
                generationPointMultipliers: {
                    ...current.generationPointMultipliers,
                    [group]: nextGroup,
                },
            };
        });
    };

    const addCustomPointModel = () => {
        const model = customPointModel.trim();
        if (!model) {
            message.warning("请输入模型名称");
            return;
        }
        updateModelPointCost(model, getSettings().modelPointCosts[model] ?? 1);
        setCustomPointModel("");
    };

    const deleteModelPointCost = (model: string) => {
        setSettings((current) => {
            const next = { ...current.modelPointCosts };
            delete next[model];
            return { ...current, modelPointCosts: next };
        });
    };

    const updateMailSetting = (key: keyof AuthSettings["mail"], value: string | number | boolean) => {
        setSettings((current) => ({ ...current, mail: { ...current.mail, [key]: value } }));
    };

    const testMailSettings = async () => {
        setMailTestLoading(true);
        try {
            const response = await fetch("/api/admin/mail/test", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ mail: getSettings().mail, to: mailTestTo }),
            });
            const payload = (await response.json()) as { error?: string };
            if (!response.ok) throw new Error(payload.error || "测试邮件发送失败");
            message.success("测试邮件已发送，请检查收件箱");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "测试邮件发送失败");
        } finally {
            setMailTestLoading(false);
        }
    };

    const updateSiteSetting = <K extends keyof Omit<AuthSettings["site"], "socials">>(key: K, value: AuthSettings["site"][K]) => {
        updateSite((site) => ({ ...site, [key]: value }));
    };

    const uploadSiteImage = (file: File | undefined, key: "logoUrl" | "iconUrl", label: string) => {
        if (!file) return;
        const allowed = ["image/png", "image/jpeg", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon"];
        if (!allowed.includes(file.type)) {
            message.warning(`${label} 仅支持 PNG、JPG、SVG 或 ICO`);
            return;
        }
        if (file.size > 300 * 1024) {
            message.warning(`${label} 文件不能超过 300KB`);
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            updateSiteSetting(key, String(reader.result || ""));
            message.success(`${label} 已读取，保存设置后生效`);
        };
        reader.onerror = () => message.error(`${label} 读取失败`);
        reader.readAsDataURL(file);
    };

    const uploadSiteLogo = (file?: File) => uploadSiteImage(file, "logoUrl", "Logo");
    const uploadSiteIcon = (file?: File) => uploadSiteImage(file, "iconUrl", "浏览器图标");

    const updateSiteSocialSetting = (key: SiteSocialKey, patch: Partial<AuthSettings["site"]["socials"][SiteSocialKey]>) => {
        updateSite((site) => ({
            ...site,
            socials: {
                ...site.socials,
                [key]: { ...site.socials[key], ...patch },
            },
        }));
    };

    const addFriendLink = () => {
        updateSite((site) => ({
            ...site,
            friendLinks: [...(site.friendLinks || []), { id: nanoid(), label: "友情链接", url: "https://", enabled: true }],
        }));
    };

    const updateFriendLink = (id: string, patch: Partial<SiteFriendLink>) => {
        updateSite((site) => ({
            ...site,
            friendLinks: (site.friendLinks || []).map((link) => (link.id === id ? { ...link, ...patch } : link)),
        }));
    };

    const deleteFriendLink = async (id: string) => {
        const previousSite = getLatestSiteSettings();
        const site = {
            ...previousSite,
            friendLinks: (previousSite.friendLinks || []).filter((link) => link.id !== id),
        };
        updateSite(() => site);
        const saved = await saveSettings({ site }, "友情链接已删除");
        if (!saved && getLatestSiteSettings() === site) updateSite(() => previousSite);
        return saved;
    };

    const fetchModelsForChannel = async (channel: SystemModelChannel) => {
        if (!channelSupportsModelCatalog(channel)) {
            message.warning("当前协议没有可用的模型目录，请手动填写上游模型 ID");
            return;
        }
        if (!channel.baseUrl.trim()) {
            message.error("请先填写该渠道的 Base URL");
            return;
        }
        setFetchingModelId(channel.id);
        try {
            const result = await requestAdminModels(channel);
            updateChannel(channel.id, adminModelsChannelPatch(channel, result));
            const discovered = result.discoveredCount ?? result.models.length;
            const total = result.totalCount ?? result.models.length;
            message.success(`${channel.name || "渠道"} 本次发现 ${discovered} 个模型，合并后共 ${total} 个${result.warning ? `；${result.warning}` : ""}`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "拉取模型失败");
        } finally {
            setFetchingModelId("");
        }
    };

    const fetchAllModels = async () => {
        const runnable = getSettings().systemChannels.filter((channel) => channel.baseUrl.trim() && channelSupportsModelCatalog(channel));
        if (!runnable.length) {
            message.warning("当前没有可同步模型目录的渠道；请先配置目录，或手动维护模型 ID");
            return;
        }
        setFetchingModelId("all");
        try {
            const results = await Promise.allSettled(runnable.map(async (channel) => [channel.id, await requestAdminModels(channel)] as const));
            const entries = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
            const modelMap = new Map(entries);
            if (modelMap.size) {
                setSettings((current) => {
                    const systemChannels = current.systemChannels.map((channel) => {
                        const result = modelMap.get(channel.id);
                        return result ? { ...channel, ...adminModelsChannelPatch(channel, result) } : channel;
                    });
                    const logicalModels = synchronizeLogicalModelsWithChannels(current.logicalModels, systemChannels);
                    return { ...current, systemChannels, logicalModels, defaultModels: normalizeDefaultModelsConfig(current.defaultModels, logicalModels, systemChannels) };
                });
            }
            const failedChannels = results.flatMap((result, index) => (result.status === "rejected" ? [`${runnable[index].name || "未命名渠道"}：${result.reason instanceof Error ? result.reason.message : "拉取模型失败"}`] : []));
            if (!failedChannels.length) message.success("模型列表已拉取");
            else if (modelMap.size) message.warning(`已更新可拉取的模型；${failedChannels.join("；")}`);
            else message.error(failedChannels.join("；"));
        } finally {
            setFetchingModelId("");
        }
    };

    return {
        updateChannel,
        addChannel,
        deleteChannel,
        updateFreeDailyPoints,
        updateGenerationConcurrency,
        updateGenerationDefaults,
        updateGenerationCostControl,
        updateDataLifecycle,
        updateModelPointCost,
        updateModelPricing,
        updateGenerationPointMultiplier,
        deleteGenerationPointMultiplier,
        addCustomPointModel,
        deleteModelPointCost,
        updateMailSetting,
        testMailSettings,
        updateSiteSetting,
        getLatestSiteSettings,
        getLatestSettings,
        uploadSiteLogo,
        uploadSiteIcon,
        updateSiteSocialSetting,
        addFriendLink,
        updateFriendLink,
        deleteFriendLink,
        fetchModelsForChannel,
        fetchAllModels,
    };
}

export type AdminDashboardSettingsActions = ReturnType<typeof useAdminDashboardSettingsActions>;

function adminModelsChannelPatch(channel: SystemModelChannel, result: AdminModelsResult): Partial<SystemModelChannel> {
    const advanced = channel.advancedConfig || createDefaultChannelAdvancedConfig();
    const models = uniqueList([...channel.models, ...result.models]);
    const modelCapabilities = { ...(advanced.modelCapabilities || {}), ...(result.modelCapabilities || {}) };
    const modelConfigs = mergeAdminModelConfigs(advanced.modelConfigs, result.modelConfigs, advanced.protocol);
    if (!result.globalAiOpcPresets?.length) {
        return {
            models,
            advancedConfig: {
                ...advanced,
                ...(result.recommendedConfig || {}),
                modelCapabilities,
                modelConfigs,
            },
        };
    }
    const selection = buildGlobalAiOpcSelection(result.globalAiOpcPresets);
    const onlyPreset = selection.presetIds.length === 1;
    return {
        models: uniqueList([...models, ...selection.models]),
        apiFormat: selection.apiFormat,
        advancedConfig: {
            ...advanced,
            protocol: "globalaiopc",
            globalAiOpcPresets: selection.presetIds,
            globalAiOpcPreset: onlyPreset ? selection.presetIds[0] : undefined,
            textModel: selection.textModel,
            imageModel: selection.imageModel,
            videoModel: selection.videoModel,
            createPath: selection.createPath,
            queryPath: selection.queryPath,
            requestTemplate: "",
            durationRange: selection.durationRange,
            referenceRule: "参考素材使用可被上游访问的公网 URL；由服务器在提交前生成受控访问地址。",
            supportsReferenceImage: selection.supportsReferenceImage,
            supportsReferenceVideo: selection.supportsReferenceVideo,
            supportsReferenceAudio: selection.supportsReferenceAudio,
            modelCapabilities,
            modelConfigs,
        },
    };
}

function mergeAdminModelConfigs(current: SystemChannelAdvancedConfig["modelConfigs"], discovered: SystemChannelAdvancedConfig["modelConfigs"], channelProtocol: SystemChannelAdvancedConfig["protocol"]) {
    const merged = { ...(current || {}), ...(discovered || {}) };
    Object.entries(current || {}).forEach(([model, config]) => {
        const protocol = config.protocol || channelProtocol;
        if (config.source === "manual" && (protocol !== channelProtocol || !channelProtocolDefinition(protocol).strict || !merged[model])) merged[model] = config;
    });
    return Object.fromEntries(Object.entries(merged).map(([model, config]) => [model, normalizeStrictProtocolModelConfig(config, channelProtocol, model)]));
}
