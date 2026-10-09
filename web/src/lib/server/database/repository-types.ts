import type { RegistrationPolicyConsent } from "@/lib/registration-consent";
import type { AdminPermission } from "@/lib/admin-permissions";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type PageInput = {
    page?: number;
    pageSize?: number;
};

export type PageResult<T> = {
    items: T[];
    total: number;
    page: number;
    pageSize: number;
};

export type UserRole = "admin" | "user";
export type UserStatus = "active" | "disabled";
export type PromptScope = "library" | "user";
export type UsageKind = "api" | "image" | "video" | "audio" | "text";
export type GenerationKind = "image" | "video";
export type GenerationStatus = "pending" | "success" | "failed";
export type AuditStatus = "success" | "failure";
export type BillingOrderStatus = "pending" | "paid" | "closed" | "canceled" | "refunding" | "refunded";
export type BillingProductKind = "plan" | "points";
export type PaymentTransactionStatus = "pending" | "succeeded" | "failed" | "refunded";
export type BillingReconciliationRunStatus = "completed" | "failed";
export type BillingReconciliationSource = "csv" | "provider-api" | "manual";
export type BillingReconciliationStatementStatus = "paid" | "refunded" | "pending" | "failed" | "unknown";
export type PlanAssignmentStatus = "active" | "expired" | "canceled";
export type PlanAssignmentSource = "admin" | "order" | "cdk" | "system";
export type CouponDiscountType = "fixed" | "percentage";
export type UserCouponStatus = "available" | "locked" | "redeemed" | "expired" | "revoked";
export type CouponRedemptionStatus = "redeemed" | "refunded";
export type ReferralInviteeRewardType = "points" | "coupon";
export type ReferralRiskStatus = "clear" | "review" | "frozen" | "rejected";
export type ReferralRewardStatus = "pending" | "settled" | "revoked" | "rejected" | "reversal_pending";
export type ReferralRewardType = "points" | "coupon";
export type ReferralBeneficiaryRole = "inviter" | "invitee";

export type UserRecord = {
    id: string;
    accountId: string;
    username: string;
    email?: string;
    displayName: string;
    bio: string;
    avatarStorageKey?: string;
    role: UserRole;
    adminPermissions: AdminPermission[];
    status: UserStatus;
    planId: string;
    pointsBalance: number;
    passwordHash: string;
    mfaSecretCiphertext?: string;
    mfaEnabledAt?: string;
    registrationConsent?: RegistrationPolicyConsent;
    lastLoginAt?: string;
    createdAt: string;
    updatedAt: string;
};

export type SessionRecord = {
    id: string;
    userId: string;
    tokenHash: string;
    createdAt: string;
    expiresAt: string;
};

export type EmailCodeRecord = {
    id: string;
    purpose: "register" | "email-change" | "password-reset";
    email: string;
    userId?: string;
    codeHash: string;
    createdAt: string;
    expiresAt: string;
    consumedAt?: string;
    attempts: number;
};

export type AuthenticatedUserRecord = {
    user: UserRecord;
    planId: string;
    planName: string;
    hasActivePlan: boolean;
    permanentPoints: number;
    dailyPoints: number;
};

export type UserSummaryRecord = {
    total: number;
    active: number;
    disabled: number;
    admins: number;
    activeAdmins: number;
    usersWithPlan: number;
    totalPointsBalance: number;
};

export type EntitlementPlanRecord = {
    id: string;
    name: string;
    enabled: boolean;
    dailyPoints: number;
    limits: JsonValue;
    features: JsonValue;
    sortOrder: number;
    createdAt: string;
    updatedAt: string;
};

export type AppSettingsRecord = {
    id: "default";
    site: JsonValue;
    registrationEnabled: boolean;
    emailRegistrationEnabled: boolean;
    freeDailyPointsEnabled: boolean;
    freeDailyPoints: number;
    mail: JsonValue;
    allowUserApiConfig: boolean;
    modelPointCosts: JsonValue;
    generationPointMultipliers: JsonValue;
    generationCostControl: JsonValue;
    dataLifecycle: JsonValue;
    entitlementsEnabled: boolean;
    defaultPlanId: string;
    generationConcurrency: JsonValue;
    generationDefaults: JsonValue;
    paymentConfig: JsonValue;
    logicalModels: JsonValue;
    defaultModels: JsonValue;
    agentSkills: JsonValue;
    createdAt: string;
    updatedAt: string;
};

export type SystemModelChannelRecord = {
    id: string;
    name: string;
    baseUrl: string;
    apiKeyCiphertext: string;
    webhookSecretCiphertext: string;
    apiFormat: "openai" | "gemini";
    models: JsonValue;
    enabled: boolean;
    advancedConfig?: JsonValue;
    sortOrder: number;
    createdAt: string;
    updatedAt: string;
};

export type PointRecord = {
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
    requestFingerprint?: string;
    sourceRecordId?: string;
    sourceDate?: string;
    createdAt: string;
};

export type PointRecordInput = Omit<PointRecord, "permanentAmount" | "dailyAmount" | "permanentBalanceAfter" | "dailyBalanceAfter"> & Partial<Pick<PointRecord, "permanentAmount" | "dailyAmount" | "permanentBalanceAfter" | "dailyBalanceAfter">>;

export type DailyPlanPointWalletRecord = {
    userId: string;
    date: string;
    planId: string;
    assignmentId?: string;
    grantedPoints: number;
    remainingPoints: number;
    createdAt: string;
    updatedAt: string;
};

export type QuotaUsageRecord = {
    userId: string;
    date: string;
    usageKind: UsageKind;
    pointsSpent: number;
    units: number;
    updatedAt: string;
};

export type CdkCodeRecord = {
    id: string;
    codeHash: string;
    codePreview: string;
    points: number;
    maxRedemptions: number;
    redeemedCount: number;
    status: "active" | "disabled";
    note: string;
    expiresAt?: string;
    createdAt: string;
    updatedAt: string;
};

export type CdkCodeCreateRecord = CdkCodeRecord & {
    codeCiphertext: string;
};

export type CdkRedemptionRecord = {
    cdkCodeId: string;
    userId: string;
    redeemedAt: string;
};

export type CdkListFilter = "all" | "redeemed" | "unused" | "expired";

export type CdkListInput = PageInput & {
    keyword?: string;
    codeHash?: string;
    filter?: CdkListFilter;
};

export type CdkListRedemptionRecord = CdkRedemptionRecord & {
    accountId?: string;
    username?: string;
    displayName?: string;
};

export type CdkListCodeRecord = CdkCodeRecord & {
    codeCiphertext: string;
    redemptions: CdkListRedemptionRecord[];
};

export type CdkListResult = PageResult<CdkListCodeRecord> & {
    stats: {
        total: number;
        redeemed: number;
        unused: number;
        expired: number;
    };
};

export type AnnouncementRecord = {
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

export type PromptRecord = {
    id: string;
    scope: PromptScope;
    ownerUserId?: string;
    title: string;
    coverUrl: string;
    prompt: string;
    tags: JsonValue;
    category: string;
    preview: string;
    githubUrl?: string;
    source?: string;
    createdAt: string;
    updatedAt: string;
};

export type GenerationLogAssetRecord = {
    type: GenerationKind;
    url: string;
    remoteUrl?: string;
    serverUrl?: string;
    mimeType?: string;
    width?: number;
    height?: number;
    bytes?: number;
};

export type GenerationLogRecord = {
    id: string;
    userId: string;
    conversationId?: string;
    username: string;
    displayName: string;
    kind: GenerationKind;
    source: string;
    status: GenerationStatus;
    title: string;
    prompt: string;
    model: string;
    summary: string;
    durationMs: number;
    count: number;
    successCount: number;
    failCount: number;
    assets: GenerationLogAssetRecord[];
    requestSnapshot?: JsonValue;
    taskId?: string;
    error?: string;
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
};

export type AuditLogRecord = {
    id: string;
    action: string;
    status: AuditStatus;
    actorUserId?: string;
    actorUsername?: string;
    actorRole?: UserRole;
    actorIp?: string;
    actorUserAgent?: string;
    targetType?: string;
    targetId?: string;
    targetLabel?: string;
    metadata?: JsonValue;
    tenantId?: string;
    scope?: "platform" | "tenant";
    actorTenantRole?: "owner" | "admin" | "member";
    createdAt: string;
};

export type BillingOrderRecord = {
    id: string;
    orderNo: string;
    productId?: string;
    userId?: string;
    userAccountId?: string;
    userUsername?: string;
    userDisplayName?: string;
    productKind: BillingProductKind;
    planId?: string;
    status: BillingOrderStatus;
    subject: string;
    listAmountCents: number;
    promotionDiscountCents: number;
    couponDiscountCents: number;
    amountCents: number;
    currency: string;
    pointsAmount: number;
    dailyPoints: number;
    periodDays: number;
    quantity: number;
    provider: string;
    providerOrderId?: string;
    providerPaymentId?: string;
    promotionCampaignId?: string;
    userCouponId?: string;
    expiresAt?: string;
    paidAt?: string;
    closedAt?: string;
    pricingSnapshot?: JsonValue;
    metadata?: JsonValue;
    createdAt: string;
    updatedAt: string;
};

export type PromotionProductRecord = {
    productId: string;
    promotionalAmountCents: number;
};

export type PromotionCampaignRecord = {
    id: string;
    name: string;
    label: string;
    enabled: boolean;
    startsAt: string;
    endsAt: string;
    createdByUserId?: string;
    products: PromotionProductRecord[];
    createdAt: string;
    updatedAt: string;
};

export type CouponTemplateRecord = {
    id: string;
    code: string;
    name: string;
    description: string;
    discountType: CouponDiscountType;
    discountValue: number;
    minimumAmountCents: number;
    maximumDiscountCents: number;
    stackWithPromotion: boolean;
    claimable: boolean;
    enabled: boolean;
    startsAt: string;
    endsAt: string;
    totalLimit: number;
    perUserLimit: number;
    issuedCount: number;
    redeemedCount: number;
    createdByUserId?: string;
    productIds: string[];
    createdAt: string;
    updatedAt: string;
};

export type UserCouponRecord = {
    id: string;
    templateId: string;
    userId: string;
    status: UserCouponStatus;
    grantSource: string;
    claimedAt: string;
    expiresAt: string;
    lockedOrderId?: string;
    lockedAt?: string;
    redeemedOrderId?: string;
    redeemedAt?: string;
    revokedAt?: string;
    createdAt: string;
    updatedAt: string;
};

export type UserCouponListItemRecord = UserCouponRecord & {
    template: CouponTemplateRecord;
};

export type CouponRedemptionRecord = {
    id: string;
    userCouponId: string;
    orderId: string;
    userId: string;
    templateId: string;
    status: CouponRedemptionStatus;
    discountCents: number;
    ruleSnapshot: JsonValue;
    redeemedAt: string;
    refundedAt?: string;
    createdAt: string;
    updatedAt: string;
};

export type ReferralProgramRecord = {
    id: "default";
    enabled: boolean;
    inviterPoints: number;
    inviteeRewardType: ReferralInviteeRewardType;
    inviteePoints: number;
    inviteeCouponTemplateId?: string;
    minimumPaidCents: number;
    coolingOffDays: number;
    inviterMonthlyLimit: number;
    campaignTotalLimit: number;
    autoFreezeRisk: boolean;
    createdByUserId?: string;
    updatedByUserId?: string;
    createdAt: string;
    updatedAt: string;
};

export type ReferralCodeRecord = {
    id: string;
    userId: string;
    code: string;
    enabled: boolean;
    clickCount: number;
    lastClickedAt?: string;
    createdAt: string;
    updatedAt: string;
};

export type ReferralRelationshipRecord = {
    id: string;
    inviterUserId: string;
    inviteeUserId: string;
    referralCodeId: string;
    attributionSource: string;
    attributionMetadata: JsonValue;
    registrationIpHash?: string;
    paymentIdentityHash?: string;
    riskStatus: ReferralRiskStatus;
    riskSignals: JsonValue;
    registeredAt: string;
    createdAt: string;
    updatedAt: string;
    code?: string;
    inviterUsername?: string;
    inviterDisplayName?: string;
    inviterAccountId?: string;
    inviteeUsername?: string;
    inviteeDisplayName?: string;
    inviteeAccountId?: string;
};

export type ReferralRewardRecord = {
    id: string;
    relationshipId: string;
    beneficiaryUserId: string;
    beneficiaryRole: ReferralBeneficiaryRole;
    rewardType: ReferralRewardType;
    pointsAmount: number;
    couponTemplateId?: string;
    triggerOrderId: string;
    status: ReferralRewardStatus;
    settleAfter: string;
    walletRecordId?: string;
    reversalWalletRecordId?: string;
    userCouponId?: string;
    reason?: string;
    settledAt?: string;
    revokedAt?: string;
    createdAt: string;
    updatedAt: string;
    beneficiaryUsername?: string;
    beneficiaryDisplayName?: string;
    beneficiaryAccountId?: string;
};

export type BillingProductRecord = {
    id: string;
    productKind: BillingProductKind;
    planId?: string;
    name: string;
    description: string;
    amountCents: number;
    currency: string;
    pointsAmount: number;
    dailyPoints: number;
    periodDays: number;
    enabled: boolean;
    sortOrder: number;
    metadata?: JsonValue;
    createdAt: string;
    updatedAt: string;
};

export type PaymentTransactionRecord = {
    id: string;
    orderId: string;
    userId?: string;
    provider: string;
    channel: string;
    status: PaymentTransactionStatus;
    amountCents: number;
    currency: string;
    providerTradeId?: string;
    providerPaymentId?: string;
    rawPayload?: JsonValue;
    paidAt?: string;
    refundedAt?: string;
    failedAt?: string;
    createdAt: string;
    updatedAt: string;
};

export type BillingReconciliationRunRecord = {
    id: string;
    provider: string;
    source: BillingReconciliationSource;
    status: BillingReconciliationRunStatus;
    totalRows: number;
    matchedRows: number;
    okRows: number;
    issueRows: number;
    statementPaidAmountCents: number;
    statementRefundedAmountCents: number;
    localMatchedAmountCents: number;
    differenceAmountCents: number;
    importedByUserId?: string;
    importedByUsername?: string;
    fileName?: string;
    fileHash?: string;
    note?: string;
    metadata?: JsonValue;
    createdAt: string;
    updatedAt: string;
};

export type BillingReconciliationRowRecord = {
    id: string;
    runId: string;
    rowNumber: number;
    rowKey: string;
    provider: string;
    orderNo?: string;
    providerOrderId?: string;
    providerPaymentId?: string;
    statementStatus: BillingReconciliationStatementStatus;
    amountCents?: number;
    currency?: string;
    localOrderId?: string;
    localOrderNo?: string;
    localOrderStatus?: string;
    localAmountCents?: number;
    localCurrency?: string;
    issueCodes: JsonValue;
    issues: JsonValue;
    createdAt: string;
    updatedAt: string;
};

export type UserPlanAssignmentRecord = {
    id: string;
    userId: string;
    planId: string;
    status: PlanAssignmentStatus;
    source: PlanAssignmentSource;
    sourceId?: string;
    startsAt: string;
    endsAt?: string;
    metadata?: JsonValue;
    createdAt: string;
    updatedAt: string;
};

export type PaymentProviderEventRecord = {
    id: string;
    provider: string;
    eventId?: string;
    eventType: string;
    orderId?: string;
    signatureValid: boolean;
    payload?: JsonValue;
    processingAt?: string;
    processedAt?: string;
    error?: string;
    createdAt: string;
    updatedAt: string;
};

export type BillingSummaryProviderRecord = {
    provider: string;
    totalOrders: number;
    pendingOrders: number;
    paidOrders: number;
    refundedOrders: number;
    paidAmountCents: number;
    refundedAmountCents: number;
};

export type BillingSummaryRecord = {
    orders: {
        total: number;
        pending: number;
        paid: number;
        closed: number;
        canceled: number;
        refunded: number;
        grossAmountCents: number;
        paidAmountCents: number;
        pendingAmountCents: number;
        refundedAmountCents: number;
    };
    payments: {
        succeeded: number;
        refunded: number;
        succeededAmountCents: number;
        refundedAmountCents: number;
    };
    commerce: {
        convertedOrders: number;
        promotionOrders: number;
        promotionConvertedOrders: number;
        promotionDiscountCents: number;
        couponOrders: number;
        couponConvertedOrders: number;
        couponDiscountCents: number;
    };
    providers: BillingSummaryProviderRecord[];
    reconciliation: {
        paidOrdersWithoutSucceededPayment: number;
        succeededPaymentsWithoutPaidOrder: number;
        amountMismatchPayments: number;
    };
};

export type PublishedWorkSourceType = "media" | "canvas" | "drama";
export type PublishedWorkLifecycleStatus = "active" | "revoked";
export type PublishedWorkVisibility = "private" | "unlisted" | "public";
export type PublishedWorkModerationStatus = "draft" | "pending" | "approved" | "rejected" | "taken_down";
export type PublishedWorkAuthorDisplay = "profile" | "custom" | "hidden";
export type PublishedWorkAssetRole = "cover" | "content";
export type PublishedWorkCaseType = "report" | "appeal";
export type PublishedWorkCaseStatus = "open" | "approved" | "rejected";
export type WorkCommunityRankingWindow = "weekly" | "monthly";
export type UserNotificationType = "work_like" | "user_follow";

export type PublishedWorkRecord = {
    id: string;
    ownerUserId: string;
    slug: string;
    sourceType: PublishedWorkSourceType;
    sourceId: string;
    lifecycleStatus: PublishedWorkLifecycleStatus;
    currentVersionId?: string;
    publishedVersionId?: string;
    isFeatured: boolean;
    featuredAt?: string;
    featuredByUserId?: string;
    viewCount: number;
    likeCount: number;
    lastViewedAt?: string;
    revokedAt?: string;
    createdAt: string;
    updatedAt: string;
    ownerUsername?: string;
    ownerDisplayName?: string;
    ownerAccountId?: string;
    ownerAvatarStorageKey?: string;
    ownerAvatarUpdatedAt?: string;
};

export type PublishedWorkVersionRecord = {
    id: string;
    workId: string;
    versionNumber: number;
    title: string;
    description: string;
    publicPrompt: string;
    category: string;
    tags: string[];
    visibility: PublishedWorkVisibility;
    authorDisplay: PublishedWorkAuthorDisplay;
    authorName?: string;
    moderationStatus: PublishedWorkModerationStatus;
    rejectionReason?: string;
    submittedAt?: string;
    reviewedAt?: string;
    reviewedByUserId?: string;
    moderationProvider?: string;
    moderationSignal?: JsonValue;
    createdAt: string;
    updatedAt: string;
};

export type PublishedWorkAssetRecord = {
    id: string;
    versionId: string;
    storageKey: string;
    mediaType: "image" | "video" | "audio";
    mimeType: string;
    role: PublishedWorkAssetRole;
    sortOrder: number;
    metadata: JsonValue;
    createdAt: string;
};

export type PublishedWorkSummaryRecord = PublishedWorkRecord & {
    currentVersion?: PublishedWorkVersionRecord;
    publishedVersion?: PublishedWorkVersionRecord;
    currentPreview?: PublishedWorkAssetRecord;
};

export type PublishedGalleryItemRecord = {
    workId: string;
    versionId: string;
    authorUserId: string;
    slug: string;
    sourceType: PublishedWorkSourceType;
    viewCount: number;
    likeCount: number;
    isFeatured: boolean;
    featuredAt?: string;
    publishedAt: string;
    title: string;
    description: string;
    publicPrompt: string;
    category: string;
    tags: string[];
    authorDisplay: PublishedWorkAuthorDisplay;
    authorName?: string;
    authorUsername?: string;
    authorAvatarStorageKey?: string;
    authorAvatarUpdatedAt?: string;
    assetId?: string;
    assetMediaType?: "image" | "video" | "audio";
    assetMimeType?: string;
};

export type PublishedWorkCaseRecord = {
    id: string;
    workId: string;
    versionId: string;
    submitterUserId: string;
    caseType: PublishedWorkCaseType;
    category: string;
    description: string;
    status: PublishedWorkCaseStatus;
    resolution?: string;
    handledByUserId?: string;
    handledAt?: string;
    createdAt: string;
    updatedAt: string;
};

export type PublishedWorkCaseSummaryRecord = PublishedWorkCaseRecord & {
    slug: string;
    title: string;
    ownerUserId: string;
    ownerUsername?: string;
    ownerDisplayName?: string;
    ownerAccountId?: string;
    submitterUsername?: string;
    submitterDisplayName?: string;
    submitterAccountId?: string;
};

export type WorkCommunitySummaryRecord = {
    workId: string;
    versionId: string;
    slug: string;
    ownerUserId: string;
    authorDisplay: PublishedWorkAuthorDisplay;
    likeCount: number;
    followerCount: number;
    liked: boolean;
    followingAuthor: boolean;
    canFollow: boolean;
};

export type WorkCommunityRelationResultRecord = {
    workId: string;
    versionId: string;
    ownerUserId: string;
    changed: boolean;
    active: boolean;
    likeCount: number;
};

export type UserFollowResultRecord = {
    followedUserId: string;
    changed: boolean;
    active: boolean;
    followerCount: number;
};

export type UserBlockResultRecord = {
    blockedUserId: string;
    changed: boolean;
    active: boolean;
    removedFollowCount: number;
};

export type WorkCommunityRankingCursor = {
    score: number;
    windowLikeCount: number;
    publishedAt: string;
    id: string;
};

export type PublishedWorkRankingRecord = PublishedGalleryItemRecord & {
    score: number;
    windowLikeCount: number;
};

export type UserNotificationRecord = {
    id: string;
    userId: string;
    actorUserId?: string;
    notificationType: UserNotificationType;
    workId?: string;
    targetPath: string;
    summary: string;
    dedupKey: string;
    readAt?: string;
    createdAt: string;
    actorUsername?: string;
    actorDisplayName?: string;
};

export type FollowedUserRecord = {
    userId: string;
    username: string;
    displayName: string;
    bio: string;
    avatarStorageKey?: string;
    avatarUpdatedAt?: string;
    followerCount: number;
    followedAt: string;
    publicProfileAvailable: boolean;
};

export type CommunityUserRecord = Omit<FollowedUserRecord, "followedAt"> & {
    relatedAt: string;
};

export type LikedPublishedWorkRecord = PublishedGalleryItemRecord & {
    likedAt: string;
};

export type UserCommunitySummaryRecord = {
    username: string;
    publishedWorkCount: number;
    followingCount: number;
    followerCount: number;
    likedWorkCount: number;
    publicProfileAvailable: boolean;
};

export type PublicCreatorProfileRecord = {
    userId: string;
    username: string;
    displayName: string;
    bio: string;
    avatarStorageKey?: string;
    avatarUpdatedAt?: string;
    publishedWorkCount: number;
    receivedLikeCount: number;
    followerCount: number;
    followingCount: number;
};

export type PublicCreatorWorkCursor = {
    publishedAt: string;
    id: string;
};
