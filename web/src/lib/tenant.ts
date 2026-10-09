import type { TenantRole } from "@/lib/tenant-permissions";

export type TenantMembershipStatus = "active" | "disabled";

export type TenantRecord = Readonly<{
    id: string;
    slug: string;
    name: string;
    ownerUserId: string;
    createdByUserId?: string;
    createdAt: string;
    updatedAt: string;
}>;

export type TenantMembershipRecord = Readonly<{
    tenantId: string;
    userId: string;
    role: TenantRole;
    status: TenantMembershipStatus;
    createdByUserId?: string;
    createdAt: string;
    updatedAt: string;
}>;

export type TenantContext = Readonly<{
    tenantId: string;
    tenantName: string;
    userId: string;
    role: TenantRole;
}>;

export type TenantListItem = TenantRecord &
    Readonly<{
        ownerUsername: string;
        ownerDisplayName: string;
        activeMembers: number;
        recentCalls: number;
    }>;

export type TenantMemberItem = TenantMembershipRecord &
    Readonly<{
        accountId: string;
        username: string;
        displayName: string;
        email?: string;
        userStatus: "active" | "disabled";
    }>;

export type TenantOverviewBucket = Readonly<{ key: string; value: number }>;

export type TenantOverviewAggregate = Readonly<{
    memberTotal: number;
    activeMembers: number;
    adminCount: number;
    totalCalls: number;
    successCalls: number;
    failedCalls: number;
    activeCreators: number;
    daily: TenantOverviewBucket[];
    models: TenantOverviewBucket[];
    sources: TenantOverviewBucket[];
    kinds: TenantOverviewBucket[];
}>;

export type TeamOverviewSummary = TenantOverviewAggregate &
    Readonly<{
        timezone: string;
        startAt: string;
        endAt: string;
        successRate: number | null;
    }>;
