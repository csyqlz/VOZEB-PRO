"use client";

import type { AgentReadiness } from "@/components/admin/admin-generation-settings";
import { adminSectionHref, type AdminSectionKey } from "@/components/admin/admin-sections";
import { uniqueList } from "@/components/admin/admin-values";
import { App, Form } from "antd";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { useCallback, useMemo, useRef, useState } from "react";

import type { AdminBillingSummary } from "@/lib/admin-billing-types";
import { emptyAdminGenerationOverviewSummary } from "@/lib/admin-generation-overview";
import type { AuthSettings, CreatedCdkCode, PublicAnnouncement, PublicCdkCode, PublicUser, PublicUserSummary, UserRole, UserStatus } from "@/lib/auth/store";
import type { PaymentConfigSummary } from "@/lib/payment-config-types";
import type { AdminSetupSummary } from "@/lib/server/admin-setup-status";
import type { GenerationAssetStats, StoredGenerationLog } from "@/lib/server/generation-log-store";
import type { Prompt } from "@/services/api/prompts";

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

export type UserEditorValue = {
    username?: string;
    displayName: string;
    email?: string;
    password?: string;
    role: UserRole;
    adminPermissions: PublicUser["adminPermissions"];
    permissionPreset?: string;
    status: UserStatus;
    pointsBalance: number;
};

export const PROMPT_PAGE_SIZE = 20;
export const PROMPT_SEARCH_DEBOUNCE_MS = 300;
export const USER_PAGE_SIZE = 20;
export const CDK_PAGE_SIZE = 20;
export const GENERATION_LOG_PAGE_SIZE = 20;

export function useAdminDashboardState({ initialUsers, initialUserSummary, initialSettings, initialPromptCount, currentUser, initialSection = "overview", setupSummary, headerActions }: AdminDashboardProps) {
    const { message } = App.useApp();
    const [promptForm] = Form.useForm<PromptFormValue>();
    const [userForm] = Form.useForm<UserEditorValue>();
    const logoInputRef = useRef<HTMLInputElement>(null);
    const iconInputRef = useRef<HTMLInputElement>(null);
    const promptRequestIdRef = useRef(0);
    const userRequestIdRef = useRef(0);
    const generationLogRequestIdRef = useRef(0);
    const operationsSummaryRequestIdRef = useRef(0);
    const announcementRequestIdRef = useRef(0);
    const [users, setUsers] = useState(initialUsers);
    const [userSummary, setUserSummary] = useState(initialUserSummary);
    const [usersLoading, setUsersLoading] = useState(false);
    const [userPage, setUserPage] = useState(1);
    const [userTotal, setUserTotal] = useState(0);
    const [settings, setSettingsState] = useState(initialSettings);
    const settingsRef = useRef(initialSettings);
    const setSettings = useCallback((update: SetStateAction<AuthSettings>) => {
        const next = typeof update === "function" ? update(settingsRef.current) : update;
        settingsRef.current = next;
        setSettingsState(next);
    }, []) as Dispatch<SetStateAction<AuthSettings>>;
    const getSettings = useCallback(() => settingsRef.current, []);
    const [prompts, setPrompts] = useState<Prompt[]>([]);
    const [promptCount, setPromptCount] = useState(initialPromptCount);
    const [promptListTotal, setPromptListTotal] = useState(initialPromptCount);
    const [updatingUserId, setUpdatingUserId] = useState<string | null>(null);
    const [settingsLoading, setSettingsLoading] = useState(false);
    const [assetStats, setAssetStats] = useState<GenerationAssetStats | null>(null);
    const [operationsSummary, setOperationsSummary] = useState(emptyAdminGenerationOverviewSummary);
    const [operationsSummaryLoading, setOperationsSummaryLoading] = useState(false);
    const [mailTestLoading, setMailTestLoading] = useState(false);
    const [mailTestTo, setMailTestTo] = useState("");
    const [fetchingModelId, setFetchingModelId] = useState("");
    const [promptSaving, setPromptSaving] = useState(false);
    const [promptsLoading, setPromptsLoading] = useState(false);
    const [deletingPromptId, setDeletingPromptId] = useState("");
    const [promptSearch, setPromptSearch] = useState("");
    const [debouncedPromptSearch, setDebouncedPromptSearch] = useState("");
    const [promptPage, setPromptPage] = useState(1);
    const [selectedPromptIds, setSelectedPromptIds] = useState<string[]>([]);
    const [bulkDeletingPrompts, setBulkDeletingPrompts] = useState(false);
    const [userSearch, setUserSearch] = useState("");
    const [debouncedUserSearch, setDebouncedUserSearch] = useState("");
    const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
    const [bulkDeletingUsers, setBulkDeletingUsers] = useState(false);
    const [generationLogs, setGenerationLogs] = useState<StoredGenerationLog[]>([]);
    const [generationLogTotal, setGenerationLogTotal] = useState(0);
    const [generationLogPage, setGenerationLogPage] = useState(1);
    const [generationLogSearch, setGenerationLogSearch] = useState("");
    const [generationLogKind, setGenerationLogKind] = useState("");
    const [generationLogSource, setGenerationLogSource] = useState("");
    const [generationLogStatus, setGenerationLogStatus] = useState("");
    const [generationLogUserId, setGenerationLogUserId] = useState("");
    const [generationLogStart, setGenerationLogStart] = useState("");
    const [generationLogEnd, setGenerationLogEnd] = useState("");
    const [selectedGenerationLogIds, setSelectedGenerationLogIds] = useState<string[]>([]);
    const [generationLogsLoading, setGenerationLogsLoading] = useState(false);
    const [bulkDeletingGenerationLogs, setBulkDeletingGenerationLogs] = useState(false);
    const [viewingGenerationLog, setViewingGenerationLog] = useState<StoredGenerationLog | null>(null);
    const [paymentConfig, setPaymentConfig] = useState<PaymentConfigSummary | null>(null);
    const [billingSummary, setBillingSummary] = useState<AdminBillingSummary | null>(null);
    const [billingSummaryLoading, setBillingSummaryLoading] = useState(false);
    const [viewingCdkCode, setViewingCdkCode] = useState<PublicCdkCode | null>(null);
    const [cdkCodes, setCdkCodes] = useState<PublicCdkCode[]>([]);
    const [cdkLoading, setCdkLoading] = useState(false);
    const [cdkGenerating, setCdkGenerating] = useState(false);
    const [createdCdkCodes, setCreatedCdkCodes] = useState<CreatedCdkCode[]>([]);
    const [selectedCreatedCdkIds, setSelectedCreatedCdkIds] = useState<string[]>([]);
    const [cdkForm, setCdkForm] = useState({ count: 1, points: 10, maxRedemptions: 1, expiresInDays: null as number | null, note: "" });
    const [cdkSearch, setCdkSearch] = useState("");
    const [debouncedCdkSearch, setDebouncedCdkSearch] = useState("");
    const [cdkFilter, setCdkFilter] = useState<"all" | "redeemed" | "unused" | "expired">("all");
    const [cdkPage, setCdkPage] = useState(1);
    const [cdkTotal, setCdkTotal] = useState(0);
    const [cdkStats, setCdkStats] = useState({ total: 0, redeemed: 0, unused: 0, expired: 0 });
    const [selectedCdkIds, setSelectedCdkIds] = useState<string[]>([]);
    const [bulkDeletingCdk, setBulkDeletingCdk] = useState(false);
    const [announcements, setAnnouncements] = useState<PublicAnnouncement[]>([]);
    const [announcementPage, setAnnouncementPage] = useState(1);
    const [announcementTotal, setAnnouncementTotal] = useState(0);
    const [announcementsLoading, setAnnouncementsLoading] = useState(false);
    const [announcementSaving, setAnnouncementSaving] = useState(false);
    const [announcementModalOpen, setAnnouncementModalOpen] = useState(false);
    const [promptModalOpen, setPromptModalOpen] = useState(false);
    const [announcementDraft, setAnnouncementDraft] = useState<Partial<PublicAnnouncement>>({ title: "", content: "", enabled: true, popupHome: false, popupAfterLogin: false });
    const [editingUser, setEditingUser] = useState<PublicUser | null>(null);
    const [creatingUser, setCreatingUser] = useState(false);
    const [activeSection, setActiveSectionState] = useState<AdminSectionKey>(initialSection);
    const setActiveSection = useCallback((section: AdminSectionKey) => {
        setActiveSectionState(section);
        window.history.replaceState(window.history.state, "", adminSectionHref(section, window.location.href));
    }, []);
    const [agentReadiness, setAgentReadiness] = useState<AgentReadiness | null>(null);
    const [mobileNavOpen, setMobileNavOpen] = useState(false);
    const [desktopNavCollapsed, setDesktopNavCollapsed] = useState(false);
    const [customPointModel, setCustomPointModel] = useState("");
    const stats = useMemo(() => ({ total: userSummary.total, active: userSummary.active, admins: userSummary.admins, disabled: userSummary.disabled }), [userSummary]);
    const settingsSummary = useMemo(
        () => ({
            totalChannels: setupSummary?.totalChannels ?? settings.systemChannels.length,
            enabledChannels: setupSummary?.enabledChannels ?? settings.systemChannels.filter((channel) => channel.enabled).length,
            models: setupSummary?.modelCount ?? uniqueList(settings.systemChannels.flatMap((channel) => channel.models)).length,
        }),
        [settings.systemChannels, setupSummary?.enabledChannels, setupSummary?.modelCount, setupSummary?.totalChannels],
    );
    const walletSummary = useMemo(
        () => ({
            totalBalance: userSummary.totalPointsBalance,
            enabledPlans: setupSummary?.enabledPlanProducts ?? settings.entitlements.plans.filter((plan) => plan.enabled).length,
            usersWithPlan: userSummary.usersWithPlan,
        }),
        [settings.entitlements.plans, setupSummary?.enabledPlanProducts, userSummary],
    );
    const filteredUsers = users;
    const selectedUsers = useMemo(() => users.filter((user) => selectedUserIds.includes(user.id)), [selectedUserIds, users]);
    const selectedPrompts = useMemo(() => prompts.filter((prompt) => selectedPromptIds.includes(prompt.id)), [prompts, selectedPromptIds]);
    const selectedGenerationLogs = useMemo(() => generationLogs.filter((log) => selectedGenerationLogIds.includes(log.id)), [generationLogs, selectedGenerationLogIds]);
    const promptListStart = promptListTotal ? (promptPage - 1) * PROMPT_PAGE_SIZE + 1 : 0;
    const promptListEnd = Math.min(promptPage * PROMPT_PAGE_SIZE, promptListTotal);
    const selectedCreatedCdkCodes = useMemo(() => createdCdkCodes.filter((code) => selectedCreatedCdkIds.includes(code.id)), [createdCdkCodes, selectedCreatedCdkIds]);
    const createdCdkActionCodes = selectedCreatedCdkCodes.length ? selectedCreatedCdkCodes : createdCdkCodes;
    const allCreatedCdkSelected = Boolean(createdCdkCodes.length) && selectedCreatedCdkIds.length === createdCdkCodes.length;
    return {
        initialUsers,
        initialUserSummary,
        initialSettings,
        initialPromptCount,
        currentUser,
        initialSection,
        setupSummary,
        headerActions,
        message,
        promptForm,
        userForm,
        logoInputRef,
        iconInputRef,
        promptRequestIdRef,
        userRequestIdRef,
        generationLogRequestIdRef,
        operationsSummaryRequestIdRef,
        announcementRequestIdRef,
        users,
        setUsers,
        userSummary,
        setUserSummary,
        usersLoading,
        setUsersLoading,
        userPage,
        setUserPage,
        userTotal,
        setUserTotal,
        settings,
        setSettings,
        getSettings,
        prompts,
        setPrompts,
        promptCount,
        setPromptCount,
        promptListTotal,
        setPromptListTotal,
        updatingUserId,
        setUpdatingUserId,
        settingsLoading,
        setSettingsLoading,
        assetStats,
        setAssetStats,
        operationsSummary,
        setOperationsSummary,
        operationsSummaryLoading,
        setOperationsSummaryLoading,
        mailTestLoading,
        setMailTestLoading,
        mailTestTo,
        setMailTestTo,
        fetchingModelId,
        setFetchingModelId,
        promptSaving,
        setPromptSaving,
        promptsLoading,
        setPromptsLoading,
        deletingPromptId,
        setDeletingPromptId,
        promptSearch,
        setPromptSearch,
        debouncedPromptSearch,
        setDebouncedPromptSearch,
        promptPage,
        setPromptPage,
        selectedPromptIds,
        setSelectedPromptIds,
        bulkDeletingPrompts,
        setBulkDeletingPrompts,
        userSearch,
        setUserSearch,
        debouncedUserSearch,
        setDebouncedUserSearch,
        selectedUserIds,
        setSelectedUserIds,
        bulkDeletingUsers,
        setBulkDeletingUsers,
        generationLogs,
        setGenerationLogs,
        generationLogTotal,
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
        selectedGenerationLogIds,
        setSelectedGenerationLogIds,
        generationLogsLoading,
        setGenerationLogsLoading,
        bulkDeletingGenerationLogs,
        setBulkDeletingGenerationLogs,
        viewingGenerationLog,
        setViewingGenerationLog,
        paymentConfig,
        setPaymentConfig,
        billingSummary,
        setBillingSummary,
        billingSummaryLoading,
        setBillingSummaryLoading,
        viewingCdkCode,
        setViewingCdkCode,
        cdkCodes,
        setCdkCodes,
        cdkLoading,
        setCdkLoading,
        cdkGenerating,
        setCdkGenerating,
        createdCdkCodes,
        setCreatedCdkCodes,
        selectedCreatedCdkIds,
        setSelectedCreatedCdkIds,
        cdkForm,
        setCdkForm,
        cdkSearch,
        setCdkSearch,
        debouncedCdkSearch,
        setDebouncedCdkSearch,
        cdkFilter,
        setCdkFilter,
        cdkPage,
        setCdkPage,
        cdkTotal,
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
        announcementsLoading,
        setAnnouncementsLoading,
        announcementSaving,
        setAnnouncementSaving,
        announcementModalOpen,
        setAnnouncementModalOpen,
        promptModalOpen,
        setPromptModalOpen,
        announcementDraft,
        setAnnouncementDraft,
        editingUser,
        setEditingUser,
        creatingUser,
        setCreatingUser,
        activeSection,
        setActiveSection,
        agentReadiness,
        setAgentReadiness,
        mobileNavOpen,
        setMobileNavOpen,
        desktopNavCollapsed,
        setDesktopNavCollapsed,
        customPointModel,
        setCustomPointModel,
        stats,
        settingsSummary,
        walletSummary,
        filteredUsers,
        selectedUsers,
        selectedPrompts,
        selectedGenerationLogs,
        promptListStart,
        promptListEnd,
        selectedCreatedCdkCodes,
        createdCdkActionCodes,
        allCreatedCdkSelected,
    };
}

export type AdminDashboardState = ReturnType<typeof useAdminDashboardState>;
