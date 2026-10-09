import { ECOMMERCE_IMAGE_SKILL } from "@/lib/server/agent-skills/ecommerce-image";
import { YANAI_BEAUTY_SKILL } from "@/lib/server/agent-skills/yanai-beauty";
import { DEFAULT_CREATIVE_SHORTCUT_SKILLS } from "@/lib/server/agent-skills/creative-shortcuts";
import { EMPTY_ECOMMERCE_MODEL_ROLES } from "@/lib/ecommerce-model-role-config";
import {
    type UserRole,
    type UserStatus,
    type ApiCallFormat,
    type SystemChannelProtocol,
    type SystemChannelAdvancedConfig,
    type LegacyUserQuota,
    type ModelPointCosts,
    type PointUsageKind,
    type SystemModelChannel,
    type LogicalModelCapability,
    type LogicalModelCapabilityProfile,
    type LogicalModelBinding,
    type LogicalModel,
    type SystemDefaultModels,
    type AgentSkill,
    type GenerationConcurrencySettings,
    type GenerationDefaultSettings,
    type GenerationPointMultipliers,
    type GenerationCostControlSettings,
    type DataLifecycleSettings,
    type EntitlementPlanLimits,
    type EntitlementPlan,
    type EntitlementSettings,
    type CdkStatus,
    type PublicCdkRedemption,
    type PublicCdkCode,
    type CreatedCdkCode,
    type StoredCdkRedemption,
    type StoredCdkCode,
    type PublicAnnouncement,
    type SiteSettings,
    type SiteFriendLink,
    type SiteSocialKey,
    type SiteSocialSettings,
    DEFAULT_SITE_SOCIALS,
    DEFAULT_SITE_FRIEND_LINKS,
    type MailSettings,
    type PublicUser,
    type StoredUser,
    type StoredSession,
    type PublicPointRecord,
    type StoredPointRecord,
    type StoredQuotaUsage,
    type EmailCodePurpose,
    type StoredEmailCode,
    type AuthSettings,
    type AuthDatabase,
} from "./store-types";

export class AuthInputError extends Error {
    constructor(
        message: string,
        public status = 400,
    ) {
        super(message);
    }
}

export class EmailCodeAttemptError extends AuthInputError {
    persistAttempt = true;
}

export class QuotaExceededError extends Error {
    status = 429;
}

export function isAuthInputError(error: unknown): error is AuthInputError {
    return error instanceof AuthInputError;
}

export function isQuotaExceededError(error: unknown): error is QuotaExceededError {
    return Boolean(error && typeof error === "object" && (error as { status?: unknown }).status === 429);
}

export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
export const EMAIL_CODE_MAX_AGE_MS = 1000 * 60 * 10;
export const EMAIL_CODE_RESEND_COOLDOWN_MS = 1000 * 60;
export const DEFAULT_USER_POINTS = 0;
export const DEFAULT_MODEL_POINT_COST_KEY = "__default__";
export const DEFAULT_SITE_SETTINGS: SiteSettings = {
    title: "VOZEB PRO",
    logoUrl: "/logo.svg",
    iconUrl: "/icon.svg",
    seoTitle: "VOZEB PRO",
    seoDescription: "面向 Agent、图片、视频、画布与短剧生产的一体化 AI 创作工作台",
    seoKeywords: "VOZEB PRO,AI Agent,AI 绘图,AI 视频,画布,短剧,提示词库,素材管理",
    footerCopyright: "© 2026 VOZEB PRO. All rights reserved.",
    termsUrl: "/terms",
    termsVersion: "1.0",
    privacyUrl: "/privacy",
    privacyVersion: "1.0",
    friendLinks: DEFAULT_SITE_FRIEND_LINKS,
    socials: DEFAULT_SITE_SOCIALS,
};
export const DEFAULT_MAIL_SETTINGS: MailSettings = {
    provider: "QQ 邮箱",
    host: "smtp.qq.com",
    port: 465,
    secure: true,
    username: "",
    password: "",
    fromEmail: "",
    fromName: "VOZEB PRO",
};
export const DEFAULT_GENERATION_POINT_MULTIPLIERS: GenerationPointMultipliers = {
    imageQuality: { auto: 1, low: 1, medium: 1, high: 1 },
    videoQuality: { "480": 1, "720": 1, "1080": 1 },
    videoSeconds: { "-1": 1, "5": 1, "10": 1 },
};
export const DEFAULT_GENERATION_COST_CONTROL: GenerationCostControlSettings = {
    maxPointsPerTask: 0,
    dailyUserPointSpend: 0,
    dailyTotalPointSpend: 0,
};
export const DEFAULT_DATA_LIFECYCLE: DataLifecycleSettings = {
    cleanupExpiredSessions: true,
    cleanupExpiredEmailCodes: true,
    cleanupExpiredGenerationTasks: true,
    cleanupExpiredTemporaryMedia: true,
    maintenanceBatchSize: 100,
};
export const DEFAULT_ENTITLEMENT_LIMITS: EntitlementPlanLimits = {
    dailyPointSpend: 0,
    dailyApiCalls: 0,
    dailyImages: 0,
    dailyVideos: 0,
    dailyAudio: 0,
    dailyText: 0,
};
export const DEFAULT_ENTITLEMENT_PLAN_ID = "free";
export const DEFAULT_ENTITLEMENT_SETTINGS: EntitlementSettings = {
    enabled: false,
    defaultPlanId: DEFAULT_ENTITLEMENT_PLAN_ID,
    plans: [
        {
            id: DEFAULT_ENTITLEMENT_PLAN_ID,
            name: "免费版",
            enabled: true,
            dailyPoints: 0,
            limits: DEFAULT_ENTITLEMENT_LIMITS,
            features: ["system-api", "points-wallet"],
        },
    ],
};
export const DEFAULT_SETTINGS: AuthSettings = {
    site: DEFAULT_SITE_SETTINGS,
    registrationEnabled: true,
    emailRegistrationEnabled: false,
    freeDailyPointsEnabled: true,
    freeDailyPoints: 0,
    mail: DEFAULT_MAIL_SETTINGS,
    allowUserApiConfig: false,
    modelPointCosts: {},
    generationPointMultipliers: DEFAULT_GENERATION_POINT_MULTIPLIERS,
    generationCostControl: DEFAULT_GENERATION_COST_CONTROL,
    dataLifecycle: DEFAULT_DATA_LIFECYCLE,
    entitlements: DEFAULT_ENTITLEMENT_SETTINGS,
    generationConcurrency: { agent: 2, image: 4, video: 1, audio: 2, text: 4, render: 1 },
    generationDefaults: {
        canvasImageCount: 1,
        imageSize: "1:1",
        imageQuality: "auto",
        imageCount: 1,
        videoQuality: "720",
        videoSeconds: 5,
        audioVoice: "alloy",
        audioFormat: "mp3",
    },
    systemChannels: [],
    logicalModels: [],
    defaultModels: { imageModel: "", videoModel: "", textModel: "", audioModel: "" },
    ecommerceGenerationEnabled: false,
    ecommerceVisualQualityCheckEnabled: false,
    ecommerceModelRoles: structuredClone(EMPTY_ECOMMERCE_MODEL_ROLES),
    agentSkills: [
        { ...ECOMMERCE_IMAGE_SKILL, keywords: [...ECOMMERCE_IMAGE_SKILL.keywords], workspaces: [...ECOMMERCE_IMAGE_SKILL.workspaces] },
        { ...YANAI_BEAUTY_SKILL, keywords: [...YANAI_BEAUTY_SKILL.keywords], workspaces: [...YANAI_BEAUTY_SKILL.workspaces] },
        ...DEFAULT_CREATIVE_SHORTCUT_SKILLS.map((skill) => ({ ...skill, keywords: [...skill.keywords], workspaces: [...skill.workspaces] })),
    ],
};
export const AUTH_DATA_FILE = "auth.json";
export const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,32}$/;
