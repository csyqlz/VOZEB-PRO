export type UserRole = "admin" | "user";
export type UserStatus = "active" | "disabled";
export type { AdminPermission } from "@/lib/admin-permissions";
import type { AdminPermission } from "@/lib/admin-permissions";
import type { GlobalAiOpcPresetId } from "@/lib/globalaiopc-catalog";
import type { RegistrationPolicyConsent } from "@/lib/registration-consent";
import { VOZEB_QQ_GROUP_URL } from "@/constant/community";

export type ApiCallFormat = "openai" | "gemini";
export type SystemChannelProtocol =
    "auto" | "openai" | "yumeng" | "gemini" | "gcp-agent-platform" | "sub2api" | "newapi" | "vozeb-recommended" | "globalaiopc" | "seedance" | "stable-diffusion" | "volcengine-video" | "seedance-special" | "custom" | "compatible";
export type SystemChannelAuthMode = "none" | "bearer" | "x-api-key" | "custom-header" | "google-adc";

export type SystemChannelModelConfig = {
    capability: LogicalModelCapability;
    source?: "manual" | "provider" | "official" | "health";
    apiFormat?: ApiCallFormat;
    protocol?: SystemChannelProtocol;
    createPath?: string;
    editPath?: string;
    imageToVideoPath?: string;
    queryPath?: string;
    cancelPath?: string;
    cancelMethod?: "POST" | "DELETE";
    requestTemplate?: string;
    resultField?: string;
    statusField?: string;
    durationRange?: string;
    referenceRule?: string;
    supportsReferenceImage?: boolean;
    supportsReferenceVideo?: boolean;
    supportsReferenceAudio?: boolean;
    streaming?: SystemChannelStreamingConfig;
};

export type SystemChannelStreamingConfig = {
    enabled?: boolean;
    path?: string;
    format?: "sse" | "ndjson";
};

export type SystemChannelAdvancedConfig = {
    protocol: SystemChannelProtocol;
    authMode?: SystemChannelAuthMode;
    authHeader?: string;
    authPrefix?: string;
    gcpProjectId?: string;
    gcpLocation?: string;
    documentationUrl?: string;
    globalAiOpcPreset?: GlobalAiOpcPresetId;
    globalAiOpcPresets?: GlobalAiOpcPresetId[];
    textModel: string;
    imageModel: string;
    videoModel: string;
    createPath: string;
    editPath?: string;
    imageToVideoPath?: string;
    queryPath: string;
    cancelPath?: string;
    cancelMethod?: "POST" | "DELETE";
    requestTemplate: string;
    resultField: string;
    statusField: string;
    durationRange: string;
    referenceRule: string;
    supportsReferenceImage: boolean;
    supportsReferenceVideo: boolean;
    supportsReferenceAudio: boolean;
    modelCatalogPaths?: string[];
    modelCapabilities?: Record<string, LogicalModelCapability>;
    modelConfigs?: Record<string, SystemChannelModelConfig>;
    operationConfigs?: Partial<Record<LogicalModelCapability, SystemChannelModelConfig>>;
    streaming?: SystemChannelStreamingConfig;
    contextWindowTokens?: number;
};

export type LegacyUserQuota = {
    imageDaily: number;
    videoDaily: number;
    textDaily: number;
    audioDaily: number;
};

export type ModelPointCosts = Record<string, number>;
export type PointUsageKind = "api" | "image" | "video" | "audio" | "text";

export type SystemModelChannel = {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    webhookSecret?: string;
    apiFormat: ApiCallFormat;
    models: string[];
    enabled: boolean;
    advancedConfig?: SystemChannelAdvancedConfig;
    hasApiKey?: boolean;
    clearApiKey?: boolean;
    hasWebhookSecret?: boolean;
    clearWebhookSecret?: boolean;
};

export type LogicalModelCapability = "text" | "image" | "video" | "audio";

export type LogicalModelCapabilityProfile = {
    supportsReferenceImage?: boolean;
    supportsReferenceVideo?: boolean;
    supportsReferenceAudio?: boolean;
    maxReferenceImages?: number;
    aspectRatios?: string[];
    resolutions?: string[];
    durationSeconds?: number[];
    minDurationSeconds?: number;
    maxDurationSeconds?: number;
    maxBatchSize?: number;
    supportsAsync?: boolean;
    supportsCancel?: boolean;
    supportsWebhook?: boolean;
    timeoutMs?: number;
    concurrencyLimit?: number;
    unitCost?: number;
    unitCostCurrency?: string;
};

export type LogicalModelBinding = {
    id: string;
    channelId: string;
    upstreamModel: string;
    enabled: boolean;
    priority: number;
    weight?: number;
    capabilityProfile?: LogicalModelCapabilityProfile;
};

export type LogicalModel = {
    id: string;
    name: string;
    capability: LogicalModelCapability;
    enabled: boolean;
    bindings: LogicalModelBinding[];
};

export type SystemDefaultModels = {
    imageModel: string;
    videoModel: string;
    textModel: string;
    audioModel: string;
};

export type AgentSkillWorkspace = "image" | "video" | "canvas" | "drama";

export type AgentSkill = {
    id: string;
    name: string;
    description: string;
    plannerSummary?: string;
    instructions: string;
    enabled: boolean;
    keywords: string[];
    workspaces?: AgentSkillWorkspace[];
    action?: "generate" | "edit";
    requiresReference?: boolean;
    defaultConfig?: Record<string, string | number | boolean>;
    sourceUrl?: string;
    sourceRepository?: string;
    sourcePath?: string;
    sourceVersion?: string;
    sourceCommit?: string;
    sourceContentHash?: string;
    license?: string;
};

export type GenerationConcurrencySettings = {
    agent: number;
    image: number;
    video: number;
    audio: number;
    text: number;
    render: number;
};

export type GenerationDefaultSettings = {
    canvasImageCount: number;
    imageSize: string;
    imageQuality: string;
    imageCount: number;
    videoQuality: string;
    videoSeconds: number;
    audioVoice: string;
    audioFormat: string;
};

export type GenerationPointMultipliers = {
    imageQuality: Record<string, number>;
    videoQuality: Record<string, number>;
    videoSeconds: Record<string, number>;
};

export type GenerationCostControlSettings = {
    maxPointsPerTask: number;
    dailyUserPointSpend: number;
    dailyTotalPointSpend: number;
};

export type DataLifecycleSettings = {
    cleanupExpiredSessions: boolean;
    cleanupExpiredEmailCodes: boolean;
    cleanupExpiredGenerationTasks: boolean;
    cleanupExpiredTemporaryMedia: boolean;
    maintenanceBatchSize: number;
};

export type EntitlementPlanLimits = {
    dailyPointSpend: number;
    dailyApiCalls: number;
    dailyImages: number;
    dailyVideos: number;
    dailyAudio: number;
    dailyText: number;
};

export type EntitlementPlan = {
    id: string;
    name: string;
    enabled: boolean;
    dailyPoints: number;
    limits: EntitlementPlanLimits;
    features: string[];
};

export type EntitlementSettings = {
    enabled: boolean;
    defaultPlanId: string;
    plans: EntitlementPlan[];
};

export type CdkStatus = "active" | "disabled";

export type PublicCdkRedemption = {
    userId: string;
    accountId?: string;
    username: string;
    displayName: string;
    redeemedAt: string;
};

export type PublicCdkCode = {
    id: string;
    codePreview: string;
    code?: string;
    points: number;
    maxRedemptions: number;
    redeemedCount: number;
    redemptions: PublicCdkRedemption[];
    status: CdkStatus;
    note: string;
    expiresAt?: string;
    createdAt: string;
    updatedAt: string;
};

export type CreatedCdkCode = PublicCdkCode & {
    code: string;
};

export type StoredCdkRedemption = {
    userId: string;
    redeemedAt: string;
};

export type StoredCdkCode = Omit<PublicCdkCode, "redemptions"> & {
    codeHash: string;
    redemptions: StoredCdkRedemption[];
};

export type PublicAnnouncement = {
    id: string;
    title: string;
    content: string;
    enabled: boolean;
    popupHome: boolean;
    popupAfterLogin: boolean;
    startsAt?: string;
    endsAt?: string;
    createdAt: string;
    updatedAt: string;
};

export type AnnouncementPageInput = {
    page?: number;
    pageSize?: number;
};

export type AnnouncementPage = {
    items: PublicAnnouncement[];
    total: number;
    page: number;
    pageSize: number;
};

export type SiteSettings = {
    title: string;
    logoUrl: string;
    iconUrl: string;
    seoTitle: string;
    seoDescription: string;
    seoKeywords: string;
    footerCopyright: string;
    termsUrl: string;
    termsVersion: string;
    privacyUrl: string;
    privacyVersion: string;
    friendLinks: SiteFriendLink[];
    socials: SiteSocialSettings;
};

export type SiteFriendLink = {
    id: string;
    label: string;
    url: string;
    enabled: boolean;
};

export type SiteSocialKey = "email" | "telegram" | "x" | "instagram";

export type SiteSocialSettings = Record<
    SiteSocialKey,
    {
        enabled: boolean;
        label: string;
        url: string;
    }
>;

export const DEFAULT_SITE_SOCIALS: SiteSocialSettings = {
    email: { enabled: true, label: "邮箱联系", url: "mailto:csyqlz@gmail.com" },
    telegram: { enabled: false, label: "Telegram", url: "" },
    x: { enabled: false, label: "X", url: "" },
    instagram: { enabled: false, label: "Instagram", url: "" },
};

export const DEFAULT_SITE_FRIEND_LINKS: SiteFriendLink[] = [
    { id: "vozeb-pro-home", label: "VOZEB PRO", url: "https://www.vozeb.com/", enabled: true },
    { id: "qq-vozeb-open-source", label: "VOZEB 开源交流 QQ 群", url: VOZEB_QQ_GROUP_URL, enabled: true },
    { id: "linux-do", label: "Linux.do", url: "https://linux.do/", enabled: true },
];

export type MailSettings = {
    provider: string;
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password: string;
    fromEmail: string;
    fromName: string;
};

export type PublicUser = {
    id: string;
    accountId: string;
    username: string;
    email?: string;
    displayName: string;
    bio: string;
    avatarUrl?: string;
    role: UserRole;
    adminPermissions: AdminPermission[];
    status: UserStatus;
    planId: string;
    planName: string;
    hasActivePlan: boolean;
    pointsBalance: number;
    permanentPointsBalance: number;
    dailyPointsBalance: number;
    dailyPointsExpiresAt: string;
    mfaEnabled: boolean;
    createdAt: string;
    updatedAt: string;
    lastLoginAt?: string;
};

export type PublicUserSummary = {
    total: number;
    active: number;
    disabled: number;
    admins: number;
    activeAdmins: number;
    usersWithPlan: number;
    totalPointsBalance: number;
};

export type StoredUser = Omit<PublicUser, "avatarUrl" | "planName" | "hasActivePlan" | "permanentPointsBalance" | "dailyPointsBalance" | "dailyPointsExpiresAt" | "mfaEnabled"> & {
    avatarStorageKey?: string;
    passwordHash: string;
    mfaSecretCiphertext?: string;
    mfaEnabledAt?: string;
    registrationConsent?: RegistrationPolicyConsent;
};

export type StoredSession = {
    id: string;
    userId: string;
    tokenHash: string;
    createdAt: string;
    expiresAt: string;
};

export type PublicPointRecord = {
    id: string;
    userId: string;
    type: "consume" | "refund" | "credit" | "admin-adjust";
    amount: number;
    balanceAfter: number;
    permanentAmount: number;
    dailyAmount: number;
    permanentBalanceAfter: number;
    dailyBalanceAfter: number;
    description: string;
    model?: string;
    idempotencyKey?: string;
    sourceRecordId?: string;
    sourceDate?: string;
    createdAt: string;
};

export type StoredPointRecord = PublicPointRecord & {
    requestFingerprint?: string;
};

export type StoredDailyPlanPointWallet = {
    userId: string;
    date: string;
    planId: string;
    assignmentId?: string;
    grantedPoints: number;
    remainingPoints: number;
    createdAt: string;
    updatedAt: string;
};

export type StoredQuotaUsage = {
    userId: string;
    date: string;
    usageKind: PointUsageKind;
    pointsSpent: number;
    units: number;
    updatedAt: string;
};

export type EmailCodePurpose = "register" | "email-change" | "password-reset";

export type StoredEmailCode = {
    id: string;
    purpose: EmailCodePurpose;
    email: string;
    userId?: string;
    codeHash: string;
    createdAt: string;
    expiresAt: string;
    consumedAt?: string;
    attempts?: number;
};

export type AuthSettings = {
    site: SiteSettings;
    registrationEnabled: boolean;
    emailRegistrationEnabled: boolean;
    freeDailyPointsEnabled: boolean;
    freeDailyPoints: number;
    mail: MailSettings;
    allowUserApiConfig: boolean;
    modelPointCosts: ModelPointCosts;
    generationPointMultipliers: GenerationPointMultipliers;
    generationCostControl: GenerationCostControlSettings;
    dataLifecycle: DataLifecycleSettings;
    entitlements: EntitlementSettings;
    generationConcurrency: GenerationConcurrencySettings;
    generationDefaults: GenerationDefaultSettings;
    systemChannels: SystemModelChannel[];
    logicalModels: LogicalModel[];
    defaultModels: SystemDefaultModels;
    agentSkills: AgentSkill[];
};

export type AuthDatabase = {
    version: 1;
    nextUserAccountId: number;
    users: StoredUser[];
    sessions: StoredSession[];
    quotaUsage: StoredQuotaUsage[];
    pointRecords: StoredPointRecord[];
    dailyPlanPointWallets: StoredDailyPlanPointWallet[];
    emailCodes: StoredEmailCode[];
    cdkCodes: StoredCdkCode[];
    announcements: PublicAnnouncement[];
    settings: AuthSettings;
};
