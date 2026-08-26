"use client";

import type { AdminSectionKey } from "@/components/admin/admin-sections";
import { toNumberOrZero } from "@/components/admin/admin-values";
import dayjs from "dayjs";
import type { ReactNode } from "react";
import { useRef } from "react";

import type { AdminBillingSummary } from "@/lib/admin-billing-types";
import type { AdminGenerationOverviewSummary } from "@/lib/admin-generation-overview";
import type { AuthSettings, CreatedCdkCode, PublicAnnouncement, PublicCdkCode, PublicUser, PublicUserSummary } from "@/lib/auth/store";
import type { PaymentConfigSummary } from "@/lib/payment-config-types";
import type { AdminSetupSummary } from "@/lib/server/admin-setup-status";
import type { StoredGenerationLog } from "@/lib/server/generation-log-store";
import type { Prompt } from "@/services/api/prompts";
import { applyPublicSiteSettings, notifyPublicSettingsChanged } from "@/stores/use-public-session-store";
import { applyAdminSettingsSaveSnapshot, beginAdminSettingsSave, createAdminSettingsSaveQueue, createAdminSettingsSaveSnapshot, finishAdminSettingsSave, mergeAdminSettingsSaveResponse, restoreAdminSettingsSaveFailure } from "./admin-settings-save";
import { downloadTextFile, formatCreatedCdkExport, splitTags } from "./admin-dashboard-elements";

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
export const USER_PAGE_SIZE = 20;
export const CDK_PAGE_SIZE = 20;
export const GENERATION_LOG_PAGE_SIZE = 20;
export const ANNOUNCEMENT_PAGE_SIZE = 12;

import type { AdminDashboardState, UserEditorValue } from "./use-admin-dashboard-state";

export function useAdminDashboardDataActions({ state }: { state: AdminDashboardState }) {
    const settingsSaveCountRef = useRef(0);
    const settingsSaveQueueRef = useRef(createAdminSettingsSaveQueue());
    const cdkRequestIdRef = useRef(0);
    const {
        currentUser,
        setupSummary,
        message,
        promptForm,
        promptRequestIdRef,
        userRequestIdRef,
        generationLogRequestIdRef,
        operationsSummaryRequestIdRef,
        announcementRequestIdRef,
        setUsers,
        setUserSummary,
        setUsersLoading,
        userPage,
        setUserPage,
        setUserTotal,
        settings,
        setSettings,
        getSettings,
        prompts,
        setPrompts,
        setPromptCount,
        promptListTotal,
        setPromptListTotal,
        setUpdatingUserId,
        setSettingsLoading,
        setAssetStats,
        setOperationsSummary,
        setOperationsSummaryLoading,
        promptSaving,
        setPromptSaving,
        setPromptsLoading,
        setDeletingPromptId,
        setPromptSearch,
        debouncedPromptSearch,
        setDebouncedPromptSearch,
        promptPage,
        setPromptPage,
        selectedPromptIds,
        setSelectedPromptIds,
        setBulkDeletingPrompts,
        setSelectedUserIds,
        setBulkDeletingUsers,
        setGenerationLogs,
        setGenerationLogTotal,
        generationLogPage,
        setGenerationLogPage,
        generationLogSearch,
        setGenerationLogSearch,
        generationLogKind,
        setGenerationLogKind,
        generationLogSource,
        setGenerationLogSource,
        generationLogStatus,
        setGenerationLogStatus,
        generationLogUserId,
        setGenerationLogUserId,
        generationLogStart,
        setGenerationLogStart,
        generationLogEnd,
        setGenerationLogEnd,
        setSelectedGenerationLogIds,
        setGenerationLogsLoading,
        setBulkDeletingGenerationLogs,
        paymentConfig,
        setPaymentConfig,
        setBillingSummary,
        setBillingSummaryLoading,
        setCdkCodes,
        setCdkLoading,
        setCdkGenerating,
        setCreatedCdkCodes,
        setSelectedCreatedCdkIds,
        cdkForm,
        setCdkSearch,
        debouncedCdkSearch,
        setDebouncedCdkSearch,
        cdkFilter,
        setCdkFilter,
        cdkPage,
        setCdkPage,
        setCdkTotal,
        cdkStats,
        setCdkStats,
        selectedCdkIds,
        setSelectedCdkIds,
        bulkDeletingCdk,
        setBulkDeletingCdk,
        announcements,
        setAnnouncements,
        announcementPage,
        setAnnouncementPage,
        announcementTotal,
        setAnnouncementTotal,
        setAnnouncementsLoading,
        announcementSaving,
        setAnnouncementSaving,
        setAnnouncementModalOpen,
        setPromptModalOpen,
        announcementDraft,
        setAnnouncementDraft,
        stats,
        selectedUsers,
        createdCdkActionCodes,
        debouncedUserSearch,
    } = state;

    const loadUsers = async (page = userPage, keyword = debouncedUserSearch) => {
        const requestId = userRequestIdRef.current + 1;
        userRequestIdRef.current = requestId;
        setUsersLoading(true);
        try {
            const params = new URLSearchParams({ page: String(page), pageSize: String(USER_PAGE_SIZE) });
            if (keyword) params.set("keyword", keyword);
            const response = await fetch(`/api/admin/users?${params.toString()}`, { cache: "no-store" });
            const payload = (await response.json().catch(() => null)) as { users?: PublicUser[]; total?: number; page?: number; summary?: PublicUserSummary; error?: string } | null;
            if (!response.ok || !payload?.users || !payload.summary) throw new Error(payload?.error || "加载用户失败");
            if (requestId !== userRequestIdRef.current) return;
            const total = Number(payload.total ?? payload.users.length);
            const resolvedPage = Math.max(1, Number(payload.page) || page);
            setUsers(payload.users);
            setUserTotal(total);
            setUserSummary(payload.summary);
            if (resolvedPage !== page) setUserPage(resolvedPage);
            setSelectedUserIds((ids) => ids.filter((id) => payload.users!.some((user) => user.id === id)));
        } catch (error) {
            if (requestId === userRequestIdRef.current) message.error(error instanceof Error ? error.message : "加载用户失败");
        } finally {
            if (requestId === userRequestIdRef.current) setUsersLoading(false);
        }
    };

    const saveSettings = async (input: Partial<AuthSettings> | ((current: AuthSettings) => Partial<AuthSettings>), successText = "设置已保存") => {
        const patch = typeof input === "function" ? input(getSettings()) : input;
        const snapshot = createAdminSettingsSaveSnapshot(patch);
        const current = getSettings();
        const previous = createAdminSettingsSaveSnapshot(Object.fromEntries(snapshot.keys.map((key) => [key, current[key]])) as Partial<AuthSettings>);
        setSettings((current) => applyAdminSettingsSaveSnapshot(current, snapshot));
        settingsSaveCountRef.current = beginAdminSettingsSave(settingsSaveCountRef.current);
        setSettingsLoading(true);
        try {
            const payload = await settingsSaveQueueRef.current.run(async () => {
                const response = await fetch("/api/admin/settings", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(patch),
                });
                const result = (await response.json()) as { settings?: AuthSettings; error?: string };
                if (!response.ok || !result.settings) throw new Error(result.error || "更新设置失败");
                return result as { settings: AuthSettings };
            });
            setSettings((current) => mergeAdminSettingsSaveResponse(current, payload.settings!, snapshot));
            if (patch.site) applyPublicSiteSettings(payload.settings.site);
            notifyPublicSettingsChanged();
            message.success(successText);
            return true;
        } catch (error) {
            setSettings((current) => restoreAdminSettingsSaveFailure(current, previous, snapshot));
            message.error(error instanceof Error ? error.message : "更新设置失败");
            return false;
        } finally {
            const settled = finishAdminSettingsSave(settingsSaveCountRef.current);
            settingsSaveCountRef.current = settled.remaining;
            setSettingsLoading(settled.loading);
        }
    };

    const loadBillingSummary = async () => {
        if (setupSummary?.databaseProvider === "file") {
            setBillingSummary(null);
            setBillingSummaryLoading(false);
            return;
        }
        setBillingSummaryLoading(true);
        try {
            const response = await fetch("/api/admin/billing/summary", { cache: "no-store" });
            const payload = (await response.json().catch(() => null)) as { summary?: AdminBillingSummary; error?: string } | null;
            if (!response.ok || !payload?.summary) throw new Error(payload?.error || "加载财务摘要失败");
            setBillingSummary(payload.summary);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载财务摘要失败");
        } finally {
            setBillingSummaryLoading(false);
        }
    };

    const loadOperationsSummary = async () => {
        const requestId = operationsSummaryRequestIdRef.current + 1;
        operationsSummaryRequestIdRef.current = requestId;
        setOperationsSummaryLoading(true);
        try {
            const response = await fetch("/api/admin/generation-overview", { cache: "no-store" });
            const payload = (await response.json().catch(() => null)) as { data?: AdminGenerationOverviewSummary; msg?: string } | null;
            if (!response.ok || !payload?.data) throw new Error(payload?.msg || "加载生成运维摘要失败");
            if (requestId === operationsSummaryRequestIdRef.current) setOperationsSummary(payload.data);
        } catch (error) {
            if (requestId === operationsSummaryRequestIdRef.current) message.error(error instanceof Error ? error.message : "加载生成运维摘要失败");
        } finally {
            if (requestId === operationsSummaryRequestIdRef.current) setOperationsSummaryLoading(false);
        }
    };

    const loadGenerationAssetStats = async () => {
        try {
            const response = await fetch("/api/admin/generation-assets?summaryOnly=1", { cache: "no-store" });
            const payload = (await response.json().catch(() => null)) as {
                data?: { summary?: { totalFiles: number; totalBytes: number; permanentFiles: number; permanentBytes: number; temporaryFiles: number; temporaryBytes: number } };
                msg?: string;
            } | null;
            const summary = payload?.data?.summary;
            if (!response.ok || !summary) throw new Error(payload?.msg || "加载生成资源统计失败");
            setAssetStats({
                totalFiles: summary.totalFiles,
                totalBytes: summary.totalBytes,
                referencedFiles: summary.permanentFiles,
                referencedBytes: summary.permanentBytes,
                unreferencedFiles: summary.temporaryFiles,
                unreferencedBytes: summary.temporaryBytes,
                missingReferences: 0,
            });
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载生成资源统计失败");
        }
    };

    const updateUser = async (userId: string, patch: Partial<Pick<PublicUser, "displayName" | "email" | "role" | "adminPermissions" | "status" | "pointsBalance">> & { password?: string }) => {
        setUpdatingUserId(userId);
        try {
            const response = await fetch(`/api/admin/users/${userId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(patch),
            });
            const payload = (await response.json()) as { user?: PublicUser; error?: string };
            if (!response.ok || !payload.user) throw new Error(payload.error || "更新用户失败");
            await loadUsers();
            message.success("用户已更新");
            return payload.user;
        } catch (error) {
            message.error(error instanceof Error ? error.message : "更新用户失败");
            return null;
        } finally {
            setUpdatingUserId(null);
        }
    };

    const createUser = async (value: UserEditorValue) => {
        setUpdatingUserId("__new__");
        try {
            const response = await fetch("/api/admin/users", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    username: value.username || "",
                    displayName: value.displayName,
                    email: value.email || "",
                    password: value.password || "",
                    role: value.role,
                    adminPermissions: value.adminPermissions,
                    status: value.status,
                    pointsBalance: toNumberOrZero(value.pointsBalance),
                }),
            });
            const payload = (await response.json()) as { user?: PublicUser; error?: string };
            if (!response.ok || !payload.user) throw new Error(payload.error || "Create user failed");
            setUserPage(1);
            await loadUsers(1);
            message.success("用户已新增");
            return payload.user;
        } catch (error) {
            message.error(error instanceof Error ? error.message : "Create user failed");
            return null;
        } finally {
            setUpdatingUserId(null);
        }
    };

    const deleteUser = async (userId: string) => {
        setUpdatingUserId(userId);
        try {
            const response = await fetch(`/api/admin/users/${userId}`, {
                method: "DELETE",
            });
            const payload = (await response.json()) as { error?: string };
            if (!response.ok) throw new Error(payload.error || "删除用户失败");
            setSelectedUserIds((items) => items.filter((id) => id !== userId));
            await loadUsers();
            message.success("用户已删除");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "删除用户失败");
        } finally {
            setUpdatingUserId(null);
        }
    };

    const bulkDeleteUsers = async () => {
        const deletable = selectedUsers.filter((user) => user.id !== currentUser.id);
        if (!deletable.length) {
            message.warning("请选择可删除的用户");
            return;
        }

        setBulkDeletingUsers(true);
        const deletedIds: string[] = [];
        const failedMessages: string[] = [];
        try {
            for (const user of deletable) {
                const response = await fetch(`/api/admin/users/${user.id}`, {
                    method: "DELETE",
                });
                const payload = (await response.json().catch(() => null)) as { error?: string } | null;
                if (response.ok) {
                    deletedIds.push(user.id);
                } else {
                    failedMessages.push(`${user.displayName || user.username}：${payload?.error || "删除失败"}`);
                }
            }
            if (deletedIds.length) {
                setSelectedUserIds((items) => items.filter((id) => !deletedIds.includes(id)));
                await loadUsers();
            }
            if (failedMessages.length) {
                message.warning(`已删除 ${deletedIds.length} 个，${failedMessages.length} 个失败：${failedMessages.join("；")}`);
            } else {
                message.success(`已删除 ${deletedIds.length} 个用户`);
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : "批量删除失败");
        } finally {
            setBulkDeletingUsers(false);
        }
    };

    const createPrompt = async (value: PromptFormValue) => {
        setPromptSaving(true);
        try {
            const response = await fetch("/api/admin/prompts", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...value, tags: splitTags(value.tags) }),
            });
            const payload = (await response.json()) as { prompt?: Prompt; error?: string };
            if (!response.ok || !payload.prompt) throw new Error(payload.error || "新增提示词失败");
            promptForm.resetFields();
            setPromptPage(1);
            setPromptSearch("");
            setDebouncedPromptSearch("");
            setPromptModalOpen(false);
            void loadPrompts(1, "");
            message.success("公共提示词已新增");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "新增提示词失败");
        } finally {
            setPromptSaving(false);
        }
    };

    const deletePrompt = async (id: string) => {
        setDeletingPromptId(id);
        try {
            const response = await fetch(`/api/admin/prompts/${id}`, { method: "DELETE" });
            const payload = (await response.json()) as { error?: string };
            if (!response.ok) throw new Error(payload.error || "删除提示词失败");
            setSelectedPromptIds((ids) => ids.filter((item) => item !== id));
            const nextTotal = Math.max(0, promptListTotal - 1);
            const nextPage = Math.min(promptPage, Math.max(1, Math.ceil(nextTotal / PROMPT_PAGE_SIZE)));
            setPromptCount((count) => Math.max(0, count - 1));
            setPromptListTotal(nextTotal);
            if (nextPage !== promptPage) {
                setPromptPage(nextPage);
            } else {
                void loadPrompts(nextPage, debouncedPromptSearch);
            }
            message.success("公共提示词已删除");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "删除提示词失败");
        } finally {
            setDeletingPromptId("");
        }
    };

    const bulkDeletePrompts = async () => {
        const ids = selectedPromptIds.filter((id) => prompts.some((prompt) => prompt.id === id));
        if (!ids.length) return;
        setBulkDeletingPrompts(true);
        try {
            for (const id of ids) {
                const response = await fetch(`/api/admin/prompts/${id}`, { method: "DELETE" });
                const payload = (await response.json()) as { error?: string };
                if (!response.ok) throw new Error(payload.error || "批量删除提示词失败");
            }
            setSelectedPromptIds([]);
            const nextTotal = Math.max(0, promptListTotal - ids.length);
            const nextPage = Math.min(promptPage, Math.max(1, Math.ceil(nextTotal / PROMPT_PAGE_SIZE)));
            setPromptCount((count) => Math.max(0, count - ids.length));
            setPromptListTotal(nextTotal);
            if (nextPage !== promptPage) {
                setPromptPage(nextPage);
            } else {
                void loadPrompts(nextPage, debouncedPromptSearch);
            }
            message.success(`已删除 ${ids.length} 条公共提示词`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "批量删除提示词失败");
        } finally {
            setBulkDeletingPrompts(false);
        }
    };

    const loadPrompts = async (page = promptPage, keyword = debouncedPromptSearch) => {
        const requestId = promptRequestIdRef.current + 1;
        promptRequestIdRef.current = requestId;
        setPromptsLoading(true);
        try {
            const params = new URLSearchParams({ page: String(page), pageSize: String(PROMPT_PAGE_SIZE) });
            if (keyword) params.set("keyword", keyword);
            const response = await fetch(`/api/admin/prompts?${params.toString()}`);
            const payload = (await response.json()) as { prompts?: Prompt[]; total?: number; scopeTotal?: number; error?: string };
            if (!response.ok || !payload.prompts) throw new Error(payload.error || "加载提示词失败");
            if (requestId !== promptRequestIdRef.current) return;
            setPrompts(payload.prompts);
            setPromptListTotal(Number(payload.total ?? payload.prompts.length));
            setPromptCount(Number(payload.scopeTotal ?? payload.total ?? payload.prompts.length));
            setSelectedPromptIds((ids) => ids.filter((id) => payload.prompts!.some((prompt) => prompt.id === id)));
        } catch (error) {
            if (requestId === promptRequestIdRef.current) message.error(error instanceof Error ? error.message : "加载提示词失败");
        } finally {
            if (requestId === promptRequestIdRef.current) setPromptsLoading(false);
        }
    };

    const loadGenerationLogs = async (page = generationLogPage, options: { pageSize?: number } = {}) => {
        const requestId = generationLogRequestIdRef.current + 1;
        generationLogRequestIdRef.current = requestId;
        setGenerationLogsLoading(true);
        try {
            const params = new URLSearchParams({ page: String(page), pageSize: String(options.pageSize || GENERATION_LOG_PAGE_SIZE) });
            if (generationLogSearch.trim()) params.set("keyword", generationLogSearch.trim());
            if (generationLogKind) params.set("kind", generationLogKind);
            if (generationLogSource) params.set("source", generationLogSource);
            if (generationLogStatus) params.set("status", generationLogStatus);
            if (generationLogUserId) params.set("userId", generationLogUserId);
            if (generationLogStart) params.set("start", generationLogStart);
            if (generationLogEnd) params.set("end", generationLogEnd);
            const response = await fetch(`/api/admin/generation-logs?${params.toString()}`, { cache: "no-store" });
            const payload = (await response.json()) as { logs?: StoredGenerationLog[]; total?: number; error?: string };
            if (!response.ok || !payload.logs) throw new Error(payload.error || "加载生成日志失败");
            if (requestId !== generationLogRequestIdRef.current) return;
            setGenerationLogs(payload.logs);
            setGenerationLogTotal(Number(payload.total ?? payload.logs.length));
            setSelectedGenerationLogIds((ids) => ids.filter((id) => payload.logs!.some((log) => log.id === id)));
        } catch (error) {
            if (requestId === generationLogRequestIdRef.current) message.error(error instanceof Error ? error.message : "加载生成日志失败");
        } finally {
            if (requestId === generationLogRequestIdRef.current) setGenerationLogsLoading(false);
        }
    };

    const loadPaymentConfig = async () => {
        try {
            const response = await fetch("/api/admin/billing/payment-config", { cache: "no-store" });
            const payload = (await response.json().catch(() => null)) as { paymentConfig?: PaymentConfigSummary; error?: string } | null;
            if (!response.ok || !payload?.paymentConfig) throw new Error(payload?.error || "加载支付配置失败");
            setPaymentConfig(payload.paymentConfig);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载支付配置失败");
        }
    };

    const deleteGenerationLogsByIds = async (ids: string[]) => {
        const deletingIds = Array.from(new Set(ids)).filter(Boolean);
        if (!deletingIds.length) return;
        setBulkDeletingGenerationLogs(true);
        try {
            const response = await fetch("/api/admin/generation-logs", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ids: deletingIds }),
            });
            const payload = (await response.json()) as { deleted?: number; error?: string };
            if (!response.ok) throw new Error(payload.error || "删除生成日志失败");
            setSelectedGenerationLogIds((current) => current.filter((id) => !deletingIds.includes(id)));
            void loadGenerationLogs();
            message.success(`已删除 ${payload.deleted ?? deletingIds.length} 条生成日志`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "删除生成日志失败");
        } finally {
            setBulkDeletingGenerationLogs(false);
        }
    };

    const resetGenerationLogFilters = () => {
        setGenerationLogSearch("");
        setGenerationLogKind("");
        setGenerationLogSource("");
        setGenerationLogStatus("");
        setGenerationLogUserId("");
        setGenerationLogStart("");
        setGenerationLogEnd("");
        setGenerationLogPage(1);
    };

    const loadCdkCodes = async (override?: { page?: number; keyword?: string; filter?: typeof cdkFilter }) => {
        const requestId = cdkRequestIdRef.current + 1;
        cdkRequestIdRef.current = requestId;
        setCdkLoading(true);
        try {
            const nextPage = override?.page ?? cdkPage;
            const nextKeyword = override?.keyword ?? debouncedCdkSearch;
            const nextFilter = override?.filter ?? cdkFilter;
            const params = new URLSearchParams({
                page: String(nextPage),
                pageSize: String(CDK_PAGE_SIZE),
                keyword: nextKeyword,
                filter: nextFilter,
            });
            const response = await fetch(`/api/admin/cdk?${params.toString()}`, { cache: "no-store" });
            const payload = (await response.json()) as {
                codes?: PublicCdkCode[];
                total?: number;
                page?: number;
                stats?: typeof cdkStats;
                error?: string;
            };
            if (!response.ok || !payload.codes) throw new Error(payload.error || "加载 CDK 失败");
            if (requestId !== cdkRequestIdRef.current) return;
            setCdkCodes(payload.codes);
            setCdkTotal(payload.total || 0);
            setCdkStats(payload.stats || { total: 0, redeemed: 0, unused: 0, expired: 0 });
            if (payload.page && payload.page !== cdkPage) setCdkPage(payload.page);
            setSelectedCdkIds((current) => current.filter((id) => payload.codes!.some((code) => code.id === id)));
        } catch (error) {
            if (requestId === cdkRequestIdRef.current) message.error(error instanceof Error ? error.message : "加载 CDK 失败");
        } finally {
            if (requestId === cdkRequestIdRef.current) setCdkLoading(false);
        }
    };

    const generateCdkCodes = async () => {
        setCdkGenerating(true);
        try {
            const response = await fetch("/api/admin/cdk", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(cdkForm),
            });
            const payload = (await response.json()) as { codes?: CreatedCdkCode[]; error?: string };
            if (!response.ok || !payload.codes) throw new Error(payload.error || "生成 CDK 失败");
            setCreatedCdkCodes((current) => [...payload.codes!, ...current]);
            setSelectedCreatedCdkIds(payload.codes.map((code) => code.id));
            setCdkSearch("");
            setDebouncedCdkSearch("");
            setCdkFilter("unused");
            setCdkPage(1);
            await loadCdkCodes({ page: 1, keyword: "", filter: "unused" });
            message.success(`已生成 ${payload.codes.length} 个 CDK`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "生成 CDK 失败");
        } finally {
            setCdkGenerating(false);
        }
    };

    const deleteCdkById = async (id: string) => {
        try {
            const response = await fetch(`/api/admin/cdk/${id}`, { method: "DELETE" });
            const payload = (await response.json().catch(() => ({}))) as { error?: string };
            if (!response.ok) throw new Error(payload.error || "删除 CDK 失败");
            setCreatedCdkCodes((current) => current.filter((code) => code.id !== id));
            setSelectedCreatedCdkIds((current) => current.filter((item) => item !== id));
            setSelectedCdkIds((current) => current.filter((item) => item !== id));
            await loadCdkCodes();
            message.success("CDK 已删除");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "删除 CDK 失败");
        }
    };

    const deleteCreatedCdkCodes = async (ids: string[]) => {
        const deletingIds = Array.from(new Set(ids)).filter(Boolean);
        if (!deletingIds.length) return;
        try {
            const response = await fetch("/api/admin/cdk", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ids: deletingIds }),
            });
            const payload = (await response.json().catch(() => ({}))) as { deleted?: number; error?: string };
            if (!response.ok) throw new Error(payload.error || "删除 CDK 失败");
            setCreatedCdkCodes((current) => current.filter((code) => !deletingIds.includes(code.id)));
            setSelectedCreatedCdkIds((current) => current.filter((id) => !deletingIds.includes(id)));
            setSelectedCdkIds((current) => current.filter((id) => !deletingIds.includes(id)));
            await loadCdkCodes();
            message.success(`已删除 ${payload.deleted ?? deletingIds.length} 个 CDK`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "删除 CDK 失败");
        }
    };

    const bulkDeleteCdkCodes = async () => {
        const ids = Array.from(new Set(selectedCdkIds));
        if (!ids.length || bulkDeletingCdk) return;
        setBulkDeletingCdk(true);
        try {
            const response = await fetch("/api/admin/cdk", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ids }),
            });
            const payload = (await response.json().catch(() => ({}))) as { deleted?: number; error?: string };
            if (!response.ok) throw new Error(payload.error || "批量删除 CDK 失败");
            setSelectedCdkIds([]);
            setCreatedCdkCodes((current) => current.filter((code) => !ids.includes(code.id)));
            setSelectedCreatedCdkIds((current) => current.filter((id) => !ids.includes(id)));
            await loadCdkCodes();
            message.success(`已删除 ${payload.deleted ?? ids.length} 个 CDK`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "批量删除 CDK 失败");
        } finally {
            setBulkDeletingCdk(false);
        }
    };

    const copyCreatedCdkCodes = async (codes = createdCdkActionCodes) => {
        if (!codes.length) return;
        try {
            await navigator.clipboard.writeText(codes.map((code) => code.code).join("\n"));
            message.success(`已复制 ${codes.length} 个 CDK`);
        } catch {
            message.error("复制失败，请手动复制明文 CDK");
        }
    };

    const copyCdkPlainCode = async (code: PublicCdkCode) => {
        if (!code.code) {
            message.warning("这个 CDK 没有可复制的明文");
            return;
        }
        try {
            await navigator.clipboard.writeText(code.code);
            message.success("已复制 CDK 明文");
        } catch {
            message.error("复制失败，请手动复制明文 CDK");
        }
    };

    const exportCreatedCdkCodes = (codes = createdCdkActionCodes) => {
        if (!codes.length) return;
        const text = formatCreatedCdkExport(codes, settings.site.title);
        downloadTextFile(`vozeb-pro-cdk-${dayjs().format("YYYYMMDD-HHmmss")}.txt`, text);
        message.success(`已导出 ${codes.length} 个 CDK`);
    };

    const loadAnnouncements = async (nextPage = announcementPage) => {
        const requestId = ++announcementRequestIdRef.current;
        setAnnouncementsLoading(true);
        try {
            const params = new URLSearchParams({ page: String(nextPage), pageSize: String(ANNOUNCEMENT_PAGE_SIZE) });
            const response = await fetch(`/api/admin/announcements?${params}`, { cache: "no-store" });
            const payload = (await response.json()) as { announcements?: PublicAnnouncement[]; total?: number; page?: number; error?: string };
            if (!response.ok || !payload.announcements) throw new Error(payload.error || "加载公告失败");
            if (requestId !== announcementRequestIdRef.current) return;
            setAnnouncements(payload.announcements);
            setAnnouncementPage(payload.page || nextPage);
            setAnnouncementTotal(Math.max(0, Number(payload.total) || 0));
        } catch (error) {
            if (requestId === announcementRequestIdRef.current) message.error(error instanceof Error ? error.message : "加载公告失败");
        } finally {
            if (requestId === announcementRequestIdRef.current) setAnnouncementsLoading(false);
        }
    };

    const saveAnnouncementDraft = async () => {
        setAnnouncementSaving(true);
        try {
            const response = await fetch("/api/admin/announcements", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(announcementDraft),
            });
            const payload = (await response.json()) as { announcement?: PublicAnnouncement; error?: string };
            if (!response.ok || !payload.announcement) throw new Error(payload.error || "保存公告失败");
            setAnnouncementModalOpen(false);
            setAnnouncementDraft({ title: "", content: "", enabled: true, popupHome: false, popupAfterLogin: false });
            await loadAnnouncements(1);
            message.success("公告已发布");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存公告失败");
        } finally {
            setAnnouncementSaving(false);
        }
    };

    const openAnnouncementModal = () => {
        setAnnouncementDraft({ title: "", content: "", enabled: true, popupHome: false, popupAfterLogin: false });
        setAnnouncementModalOpen(true);
    };

    const closeAnnouncementModal = () => {
        if (announcementSaving) return;
        setAnnouncementModalOpen(false);
        setAnnouncementDraft({ title: "", content: "", enabled: true, popupHome: false, popupAfterLogin: false });
    };

    const openPromptModal = () => {
        promptForm.resetFields();
        setPromptModalOpen(true);
    };

    const closePromptModal = () => {
        if (promptSaving) return;
        setPromptModalOpen(false);
    };

    const updateAnnouncementById = async (announcement: PublicAnnouncement, patch: Partial<PublicAnnouncement>) => {
        try {
            const response = await fetch(`/api/admin/announcements/${announcement.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(patch),
            });
            const payload = (await response.json()) as { announcement?: PublicAnnouncement; error?: string };
            if (!response.ok || !payload.announcement) throw new Error(payload.error || "更新公告失败");
            setAnnouncements((current) => current.map((item) => (item.id === payload.announcement!.id ? payload.announcement! : item)));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "更新公告失败");
        }
    };

    const deleteAnnouncementById = async (id: string) => {
        try {
            const response = await fetch(`/api/admin/announcements/${id}`, { method: "DELETE" });
            const payload = (await response.json().catch(() => ({}))) as { error?: string };
            if (!response.ok) throw new Error(payload.error || "删除公告失败");
            const remaining = Math.max(0, announcementTotal - 1);
            const nextPage = Math.min(announcementPage, Math.max(1, Math.ceil(remaining / ANNOUNCEMENT_PAGE_SIZE)));
            await loadAnnouncements(nextPage);
            message.success("公告已删除");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "删除公告失败");
        }
    };
    return {
        loadUsers,
        saveSettings,
        loadBillingSummary,
        loadOperationsSummary,
        loadGenerationAssetStats,
        updateUser,
        createUser,
        deleteUser,
        bulkDeleteUsers,
        createPrompt,
        deletePrompt,
        bulkDeletePrompts,
        loadPrompts,
        loadGenerationLogs,
        loadPaymentConfig,
        deleteGenerationLogsByIds,
        resetGenerationLogFilters,
        loadCdkCodes,
        generateCdkCodes,
        deleteCdkById,
        deleteCreatedCdkCodes,
        bulkDeleteCdkCodes,
        copyCreatedCdkCodes,
        copyCdkPlainCode,
        exportCreatedCdkCodes,
        loadAnnouncements,
        saveAnnouncementDraft,
        openAnnouncementModal,
        closeAnnouncementModal,
        openPromptModal,
        closePromptModal,
        updateAnnouncementById,
        deleteAnnouncementById,
    };
}

export type AdminDashboardDataActions = ReturnType<typeof useAdminDashboardDataActions>;
