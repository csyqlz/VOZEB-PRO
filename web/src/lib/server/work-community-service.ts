import { randomUUID } from "node:crypto";

import {
    createPostgresRepositories,
    ensurePostgresSchema,
    getDatabaseProvider,
    withPostgresTransaction,
    type PublicCreatorProfileRecord,
    type PublicCreatorWorkCursor,
    type PublishedWorkRankingRecord,
    type UserNotificationRecord,
    type WorkCommunityRankingCursor,
} from "@/lib/server/database";
import { USERNAME_PATTERN } from "@/lib/auth/store-foundation";
import { publicGalleryItem } from "@/lib/server/public-work-view";
import { userAvatarUrl } from "@/lib/user-avatar";

type Repositories = ReturnType<typeof createPostgresRepositories>;
type CursorRecord = { createdAt: string; id: string };

export class WorkCommunityServiceError extends Error {
    constructor(
        message: string,
        readonly status = 400,
    ) {
        super(message);
        this.name = "WorkCommunityServiceError";
    }
}

export async function getWorkCommunitySummary(slugValue: unknown, viewerUserIdValue?: unknown) {
    await assertReady();
    const summary = await createPostgresRepositories().workCommunity.getSummary(requiredSlug(slugValue), optionalId(viewerUserIdValue));
    if (!summary) throw new WorkCommunityServiceError("作品不存在", 404);
    return summary;
}

export async function setWorkLike(userIdValue: unknown, slugValue: unknown, activeValue: unknown) {
    await assertReady();
    const userId = requiredId(userIdValue, "用户");
    const slug = requiredSlug(slugValue);
    const active = booleanValue(activeValue);
    return withPostgresTransaction(async (client) => {
        const repos = createPostgresRepositories(client);
        await assertActiveUser(repos, userId);
        const result = await repos.workCommunity.setLiked(slug, userId, active, new Date().toISOString());
        if (!result) throw new WorkCommunityServiceError("作品不存在或当前不可互动", 404);
        if (active && result.changed && result.ownerUserId !== userId) {
            await createNotification(repos, {
                userId: result.ownerUserId,
                actorUserId: userId,
                notificationType: "work_like",
                workId: result.workId,
                targetPath: `/share/${encodeURIComponent(slug)}`,
                summary: "有用户赞了你的作品",
                dedupKey: `work-like:${result.workId}:${userId}`,
            });
        }
        return result;
    });
}

export async function setWorkAuthorFollow(userIdValue: unknown, slugValue: unknown, activeValue: unknown) {
    await assertReady();
    const userId = requiredId(userIdValue, "用户");
    const slug = requiredSlug(slugValue);
    const active = booleanValue(activeValue);
    return withPostgresTransaction(async (client) => {
        const repos = createPostgresRepositories(client);
        await assertActiveUser(repos, userId);
        const result = await repos.workCommunity.setFollowingAuthor(slug, userId, active, new Date().toISOString());
        if (!result) throw new WorkCommunityServiceError("该作者当前不可关注", 409);
        if (active && result.changed) {
            await createNotification(repos, {
                userId: result.followedUserId,
                actorUserId: userId,
                notificationType: "user_follow",
                targetPath: "/me",
                summary: "有用户关注了你",
                dedupKey: `user-follow:${result.followedUserId}:${userId}`,
            });
        }
        return { changed: result.changed, active: result.active, followerCount: result.followerCount };
    });
}

export async function setPublicCreatorFollow(userIdValue: unknown, usernameValue: unknown, activeValue: unknown) {
    await assertReady();
    const userId = requiredId(userIdValue, "用户");
    const username = requiredUsername(usernameValue);
    const active = booleanValue(activeValue);
    return withPostgresTransaction(async (client) => {
        const repos = createPostgresRepositories(client);
        await assertActiveUser(repos, userId);
        const result = await repos.workCommunity.setFollowingUser(username, userId, active, new Date().toISOString());
        if (!result) throw new WorkCommunityServiceError(active ? "该作者当前不可关注" : "关注关系不存在", active ? 409 : 404);
        if (active && result.changed) {
            await createNotification(repos, {
                userId: result.followedUserId,
                actorUserId: userId,
                notificationType: "user_follow",
                targetPath: `/u/${encodeURIComponent(username)}`,
                summary: "有用户关注了你",
                dedupKey: `user-follow:${result.followedUserId}:${userId}`,
            });
        }
        return { changed: result.changed, active: result.active, followerCount: result.followerCount };
    });
}

export async function setPublicUserBlock(userIdValue: unknown, usernameValue: unknown, activeValue: unknown) {
    await assertReady();
    const userId = requiredId(userIdValue, "用户");
    const username = requiredUsername(usernameValue);
    const active = booleanValue(activeValue);
    return withPostgresTransaction(async (client) => {
        const repos = createPostgresRepositories(client);
        await assertActiveUser(repos, userId);
        const result = await repos.workCommunity.setBlockedUser(username, userId, active, new Date().toISOString());
        if (!result) throw new WorkCommunityServiceError("用户不存在或当前不可操作", 404);
        return { changed: result.changed, active: result.active, removedFollowCount: result.removedFollowCount };
    });
}

export async function getPublicCreatorProfile(usernameValue: unknown) {
    await assertReady();
    const profile = await createPostgresRepositories().workCommunity.getPublicCreatorProfile(requiredUsername(usernameValue));
    if (!profile) throw new WorkCommunityServiceError("创作者主页不存在", 404);
    return publicCreatorProfile(profile);
}

export async function getPublicCreatorPage(usernameValue: unknown, viewerUserIdValue?: unknown, input: { limit?: number; cursor?: unknown } = {}) {
    await assertReady();
    const username = requiredUsername(usernameValue);
    const viewerUserId = optionalId(viewerUserIdValue);
    const repos = createPostgresRepositories();
    const [profile, works, following, blocked] = await Promise.all([
        repos.workCommunity.getPublicCreatorProfile(username),
        repos.workCommunity.listPublicCreatorWorks(username, { limit: normalizeLimit(input.limit, 18, 36), after: decodePublicCreatorCursor(input.cursor) }),
        viewerUserId ? repos.workCommunity.isFollowingUser(viewerUserId, username) : Promise.resolve(false),
        viewerUserId ? repos.workCommunity.isBlockedUser(viewerUserId, username) : Promise.resolve(false),
    ]);
    if (!profile) throw new WorkCommunityServiceError("创作者主页不存在", 404);
    const last = works.items.at(-1);
    return {
        profile: { ...publicCreatorProfile(profile), following, canFollow: viewerUserId !== profile.userId && !blocked },
        items: works.items.map(publicGalleryItem),
        nextCursor: works.hasMore && last ? encodeCursor({ publishedAt: last.publishedAt, id: last.workId }) : undefined,
    };
}

export async function listCommunityRanking(input: { window?: unknown; limit?: number; cursor?: unknown } = {}) {
    await assertReady();
    const window = input.window === "monthly" ? "monthly" : "weekly";
    const result = await createPostgresRepositories().workCommunity.listRanking({
        windowDays: window === "monthly" ? 30 : 7,
        limit: normalizeLimit(input.limit, 12, 48),
        after: decodeRankingCursor(input.cursor),
    });
    const last = result.items.at(-1);
    return {
        window,
        items: result.items.map(publicRankingItem),
        nextCursor: result.hasMore && last ? encodeRankingCursor(last) : undefined,
    };
}

export async function listUserCommunityActivity(userIdValue: unknown, input: { view?: unknown; page?: number; pageSize?: number } = {}) {
    await assertReady();
    const userId = requiredId(userIdValue, "用户");
    const repos = createPostgresRepositories();
    await assertActiveUser(repos, userId);
    if (input.view === "summary") {
        const summary = await repos.workCommunity.getUserCommunitySummary(userId);
        if (!summary) throw new WorkCommunityServiceError("用户当前不可用", 403);
        return {
            view: "summary" as const,
            username: summary.username,
            publishedWorkCount: summary.publishedWorkCount,
            followingCount: summary.followingCount,
            followerCount: summary.followerCount,
            likedWorkCount: summary.likedWorkCount,
            publicProfileAvailable: summary.publicProfileAvailable,
        };
    }
    if (input.view === "followers") {
        const page = await repos.workCommunity.listUserFollowers(userId, { page: input.page, pageSize: input.pageSize });
        return { view: "followers" as const, ...page, items: page.items.map(publicCommunityUser) };
    }
    if (input.view === "likes") {
        const page = await repos.workCommunity.listUserLikedWorks(userId, { page: input.page, pageSize: input.pageSize });
        return { view: "likes" as const, ...page, items: page.items.map((item) => ({ ...publicGalleryItem(item), likedAt: item.likedAt })) };
    }
    const page = await repos.workCommunity.listUserFollows(userId, { page: input.page, pageSize: input.pageSize });
    return { view: "following" as const, ...page, items: page.items.map((item) => publicCommunityUser({ ...item, relatedAt: item.followedAt })) };
}

export async function listUserNotifications(userIdValue: unknown, input: { limit?: number; cursor?: unknown } = {}) {
    await assertReady();
    const userId = requiredId(userIdValue, "用户");
    const repos = createPostgresRepositories();
    await assertActiveUser(repos, userId);
    const [result, unreadCount] = await Promise.all([repos.workCommunity.listNotifications(userId, { limit: normalizeLimit(input.limit, 20, 50), after: decodeTupleCursor(input.cursor) }), repos.workCommunity.countUnreadNotifications(userId)]);
    const last = result.items.at(-1);
    return { items: result.items.map(publicNotification), unreadCount, nextCursor: result.hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : undefined };
}

export async function markUserNotificationRead(userIdValue: unknown, notificationIdValue: unknown) {
    await assertReady();
    const item = await createPostgresRepositories().workCommunity.markNotificationRead(requiredId(notificationIdValue, "通知"), requiredId(userIdValue, "用户"), new Date().toISOString());
    if (!item) throw new WorkCommunityServiceError("通知不存在", 404);
    return publicNotification(item);
}

export async function markAllUserNotificationsRead(userIdValue: unknown) {
    await assertReady();
    return { updated: await createPostgresRepositories().workCommunity.markAllNotificationsRead(requiredId(userIdValue, "用户"), new Date().toISOString()) };
}

async function assertActiveUser(repos: Repositories, userId: string) {
    const user = await repos.users.getById(userId);
    if (!user || user.status !== "active") throw new WorkCommunityServiceError("用户当前不可操作", 403);
    return user;
}

async function createNotification(
    repos: Repositories,
    input: Omit<UserNotificationRecord, "id" | "createdAt" | "dedupKey"> & {
        dedupKey: string;
    },
) {
    if (input.userId === input.actorUserId) return null;
    return repos.workCommunity.createNotification({ ...input, id: randomUUID(), createdAt: new Date().toISOString() });
}

function publicNotification(notification: UserNotificationRecord) {
    return {
        id: notification.id,
        type: notification.notificationType,
        targetPath: notification.targetPath,
        summary: notification.summary,
        readAt: notification.readAt,
        createdAt: notification.createdAt,
        actor: notification.actorUserId ? { id: notification.actorUserId, username: notification.actorUsername, displayName: notification.actorDisplayName } : undefined,
    };
}

function publicRankingItem(item: PublishedWorkRankingRecord) {
    return { ...publicGalleryItem(item), score: item.score, windowLikeCount: item.windowLikeCount };
}

function publicCreatorProfile(profile: PublicCreatorProfileRecord) {
    return {
        username: profile.username,
        displayName: profile.displayName,
        bio: profile.bio,
        avatarUrl: profile.avatarStorageKey ? userAvatarUrl(profile.username, profile.avatarUpdatedAt) : undefined,
        publishedWorkCount: profile.publishedWorkCount,
        receivedLikeCount: profile.receivedLikeCount,
        followerCount: profile.followerCount,
        followingCount: profile.followingCount,
    };
}

function publicCommunityUser(user: { userId: string; username: string; displayName: string; bio: string; avatarStorageKey?: string; avatarUpdatedAt?: string; followerCount: number; relatedAt: string; publicProfileAvailable: boolean }) {
    return {
        username: user.username,
        displayName: user.displayName,
        bio: user.bio,
        avatarUrl: user.avatarStorageKey ? userAvatarUrl(user.username, user.avatarUpdatedAt) : undefined,
        followerCount: user.followerCount,
        relatedAt: user.relatedAt,
        publicProfileAvailable: user.publicProfileAvailable,
    };
}

function encodeRankingCursor(item: PublishedWorkRankingRecord) {
    return encodeCursor({ score: item.score, windowLikeCount: item.windowLikeCount, publishedAt: item.publishedAt, id: item.workId });
}

function decodeRankingCursor(value: unknown): WorkCommunityRankingCursor | undefined {
    const parsed = decodeCursor(value) as Partial<WorkCommunityRankingCursor> | undefined;
    if (!parsed || !Number.isFinite(parsed.score) || !Number.isFinite(parsed.windowLikeCount) || !validIso(parsed.publishedAt) || typeof parsed.id !== "string" || !parsed.id) return undefined;
    return parsed as WorkCommunityRankingCursor;
}

function decodeTupleCursor(value: unknown): CursorRecord | undefined {
    const parsed = decodeCursor(value) as Partial<CursorRecord> | undefined;
    if (!parsed || !validIso(parsed.createdAt) || typeof parsed.id !== "string" || !parsed.id) return undefined;
    return parsed as CursorRecord;
}

function decodePublicCreatorCursor(value: unknown): PublicCreatorWorkCursor | undefined {
    const parsed = decodeCursor(value) as Partial<PublicCreatorWorkCursor> | undefined;
    if (!parsed || !validIso(parsed.publishedAt) || typeof parsed.id !== "string" || !parsed.id) return undefined;
    return parsed as PublicCreatorWorkCursor;
}

function encodeCursor(value: object) {
    return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeCursor(value: unknown): unknown {
    if (typeof value !== "string" || !value || value.length > 800) return undefined;
    try {
        return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    } catch {
        return undefined;
    }
}

function booleanValue(value: unknown) {
    if (value === true || value === false) return value;
    throw new WorkCommunityServiceError("操作状态无效");
}

function requiredSlug(value: unknown) {
    const slug = text(value, 80).toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{5,79}$/.test(slug)) throw new WorkCommunityServiceError("作品链接无效", 404);
    return slug;
}

function requiredUsername(value: unknown) {
    const username = text(value, 32);
    if (!USERNAME_PATTERN.test(username)) throw new WorkCommunityServiceError("创作者主页不存在", 404);
    return username;
}

function requiredId(value: unknown, label: string) {
    const result = text(value, 160);
    if (!result) throw new WorkCommunityServiceError(`${label}标识无效`);
    return result;
}

function optionalId(value: unknown) {
    const result = text(value, 160);
    return result || undefined;
}

function text(value: unknown, max: number) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function normalizeLimit(value: unknown, fallback: number, max: number) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(max, Math.floor(parsed)) : fallback;
}

function validIso(value: unknown) {
    return typeof value === "string" && Number.isFinite(Date.parse(value));
}

async function assertReady() {
    if (getDatabaseProvider() !== "postgres") throw new WorkCommunityServiceError("社区互动需要启用 PostgreSQL 数据库", 409);
    await ensurePostgresSchema();
}
