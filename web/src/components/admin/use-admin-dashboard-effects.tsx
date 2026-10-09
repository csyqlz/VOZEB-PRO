"use client";

import { localAgentReadiness } from "@/components/admin/admin-generation-settings";
import type { AdminSectionKey } from "@/components/admin/admin-sections";
import type { ReactNode } from "react";
import { useEffect } from "react";

import type { AuthSettings, PublicUser, PublicUserSummary } from "@/lib/auth/store";
import type { AdminSetupSummary } from "@/lib/server/admin-setup-status";

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
import type { AdminDashboardSettingsActions } from "./use-admin-dashboard-settings-actions";
import type { AdminDashboardState } from "./use-admin-dashboard-state";

export function useAdminDashboardEffects({ state, data, settingsActions }: { state: AdminDashboardState; data: AdminDashboardDataActions; settingsActions: AdminDashboardSettingsActions }) {
    const {
        initialSection,
        settings,
        settingsLoading,
        promptSearch,
        debouncedPromptSearch,
        setDebouncedPromptSearch,
        promptPage,
        generationLogPage,
        generationLogSearch,
        generationLogKind,
        generationLogSource,
        generationLogStatus,
        generationLogUserId,
        generationLogStart,
        generationLogEnd,
        cdkSearch,
        debouncedCdkSearch,
        setDebouncedCdkSearch,
        cdkFilter,
        cdkPage,
        userSearch,
        debouncedUserSearch,
        setDebouncedUserSearch,
        userPage,
        setUserPage,
        activeSection,
        setActiveSection,
        setAgentReadiness,
    } = state;
    const { loadBillingSummary, loadOperationsSummary, loadGenerationAssetStats, loadPrompts, loadGenerationLogs, loadPaymentConfig, loadCdkCodes, loadAnnouncements, loadUsers } = data;
    const {} = settingsActions;

    useEffect(() => {
        if ((activeSection !== "skills" && activeSection !== "channels") || settingsLoading) return;
        void fetch("/api/admin/agent-readiness", { cache: "no-store" })
            .then((response) => (response.ok ? response.json() : null))
            .then((payload) => setAgentReadiness(payload?.data || localAgentReadiness(settings)));
    }, [activeSection, settingsLoading]);

    useEffect(() => {
        const timer = window.setTimeout(() => setDebouncedPromptSearch(promptSearch.trim()), PROMPT_SEARCH_DEBOUNCE_MS);
        return () => window.clearTimeout(timer);
    }, [promptSearch]);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            setUserPage(1);
            setDebouncedUserSearch(userSearch.trim());
        }, PROMPT_SEARCH_DEBOUNCE_MS);
        return () => window.clearTimeout(timer);
    }, [userSearch]);

    useEffect(() => {
        const timer = window.setTimeout(() => setDebouncedCdkSearch(cdkSearch.trim()), PROMPT_SEARCH_DEBOUNCE_MS);
        return () => window.clearTimeout(timer);
    }, [cdkSearch]);

    useEffect(() => {
        setActiveSection(initialSection);
    }, [initialSection]);

    useEffect(() => {
        if (activeSection !== "prompts") return;
        void loadPrompts(promptPage, debouncedPromptSearch);
    }, [activeSection, promptPage, debouncedPromptSearch]);

    useEffect(() => {
        if (activeSection !== "users") return;
        void loadUsers(userPage, debouncedUserSearch);
    }, [activeSection, userPage, debouncedUserSearch]);

    useEffect(() => {
        if (activeSection !== "overview") return;
        void loadGenerationAssetStats();
        void loadOperationsSummary();
    }, [activeSection]);

    useEffect(() => {
        if (activeSection !== "logs") return;
        void loadGenerationLogs();
    }, [activeSection, generationLogPage, generationLogSearch, generationLogKind, generationLogSource, generationLogStatus, generationLogUserId, generationLogStart, generationLogEnd]);

    useEffect(() => {
        if (activeSection !== "cdk") return;
        void loadCdkCodes();
    }, [activeSection, cdkPage, debouncedCdkSearch, cdkFilter]);

    useEffect(() => {
        if (activeSection !== "announcements") return;
        void loadAnnouncements();
    }, [activeSection]);

    useEffect(() => {
        if (activeSection !== "payments") return;
        void loadPaymentConfig();
    }, [activeSection]);

    useEffect(() => {
        if (activeSection !== "wallet" && activeSection !== "overview") return;
        void loadBillingSummary();
    }, [activeSection]);
}
