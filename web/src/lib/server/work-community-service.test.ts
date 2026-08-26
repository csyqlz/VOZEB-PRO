import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
    const users = { getById: vi.fn() };
    const workCommunity = {
        getSummary: vi.fn(),
        setLiked: vi.fn(),
        setFollowingAuthor: vi.fn(),
        setFollowingUser: vi.fn(),
        setBlockedUser: vi.fn(),
        getPublicCreatorProfile: vi.fn(),
        listPublicCreatorWorks: vi.fn(),
        isFollowingUser: vi.fn(),
        isBlockedUser: vi.fn(),
        getUserCommunitySummary: vi.fn(),
        listUserFollowers: vi.fn(),
        listUserLikedWorks: vi.fn(),
        listUserFollows: vi.fn(),
        listRanking: vi.fn(),
        createNotification: vi.fn(),
    };
    return {
        users,
        workCommunity,
        createPostgresRepositories: vi.fn(() => ({ users, workCommunity })),
        ensurePostgresSchema: vi.fn(),
        getDatabaseProvider: vi.fn(() => "postgres"),
        withPostgresTransaction: vi.fn(async (handler: (client: unknown) => Promise<unknown>) => handler({})),
    };
});

vi.mock("@/lib/server/database", () => ({
    createPostgresRepositories: mocks.createPostgresRepositories,
    ensurePostgresSchema: mocks.ensurePostgresSchema,
    getDatabaseProvider: mocks.getDatabaseProvider,
    withPostgresTransaction: mocks.withPostgresTransaction,
}));

import { getPublicCreatorPage, listCommunityRanking, listUserCommunityActivity, setPublicCreatorFollow, setPublicUserBlock, setWorkAuthorFollow, setWorkLike } from "./work-community-service";

const now = "2026-07-27T00:00:00.000Z";

describe("work community service", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getDatabaseProvider.mockReturnValue("postgres");
        mocks.createPostgresRepositories.mockReturnValue({ users: mocks.users, workCommunity: mocks.workCommunity });
        mocks.users.getById.mockResolvedValue({ id: "user-one", status: "active" });
        mocks.workCommunity.createNotification.mockImplementation(async (value) => value);
        mocks.workCommunity.getSummary.mockResolvedValue({ workId: "work-one", versionId: "version-one", ownerUserId: "owner-one" });
        mocks.workCommunity.isFollowingUser.mockResolvedValue(false);
        mocks.workCommunity.isBlockedUser.mockResolvedValue(false);
    });

    it("does not notify an author about their own like", async () => {
        mocks.workCommunity.setLiked.mockResolvedValue({ workId: "work-one", versionId: "version-one", ownerUserId: "user-one", changed: true, active: true, likeCount: 1 });

        await setWorkLike("user-one", "publicwork123", true);

        expect(mocks.workCommunity.createNotification).not.toHaveBeenCalled();
    });

    it("returns ranking DTOs without internal work or version ids", async () => {
        mocks.workCommunity.listRanking.mockResolvedValue({
            items: [
                {
                    workId: "work-one",
                    versionId: "version-one",
                    slug: "publicwork123",
                    sourceType: "media",
                    viewCount: 10,
                    likeCount: 4,
                    isFeatured: true,
                    publishedAt: now,
                    title: "公开作品",
                    description: "说明",
                    category: "插画",
                    tags: [],
                    score: 42,
                    windowLikeCount: 4,
                },
            ],
            hasMore: false,
        });

        const result = await listCommunityRanking({ window: "weekly" });
        const serialized = JSON.stringify(result);

        expect(result.items[0]).toMatchObject({ slug: "publicwork123", score: 42, likeCount: 4 });
        expect(serialized).not.toContain("work-one");
        expect(serialized).not.toContain("version-one");
    });

    it("returns public creator data without internal ids or custom author usernames", async () => {
        mocks.workCommunity.getPublicCreatorProfile.mockResolvedValue({
            userId: "creator-internal-id",
            username: "creator",
            displayName: "创作者",
            bio: "简介",
            publishedWorkCount: 1,
            receivedLikeCount: 2,
            followerCount: 3,
            followingCount: 4,
        });
        mocks.workCommunity.listPublicCreatorWorks.mockResolvedValue({
            items: [
                {
                    workId: "work-internal-id",
                    versionId: "version-internal-id",
                    authorUserId: "creator-internal-id",
                    slug: "publicwork123",
                    sourceType: "media",
                    viewCount: 1,
                    likeCount: 2,
                    isFeatured: false,
                    publishedAt: now,
                    title: "公开作品",
                    description: "说明",
                    publicPrompt: "提示词",
                    category: "插画",
                    tags: [],
                    authorDisplay: "custom",
                    authorName: "自定义作者",
                    authorUsername: "must-not-leak",
                },
            ],
            hasMore: false,
        });

        const result = await getPublicCreatorPage("creator", "viewer-one");
        const serialized = JSON.stringify(result);

        expect(result.profile).toMatchObject({ username: "creator", canFollow: true, following: false });
        expect(result.items[0]?.authorUsername).toBeUndefined();
        expect(serialized).not.toContain("creator-internal-id");
        expect(serialized).not.toContain("work-internal-id");
        expect(serialized).not.toContain("version-internal-id");
        expect(serialized).not.toContain("must-not-leak");
    });

    it("accepts a Chinese account in public creator links", async () => {
        mocks.workCommunity.getPublicCreatorProfile.mockResolvedValue({
            userId: "creator-internal-id",
            username: "星启2026",
            displayName: "星启创作者",
            bio: "简介",
            publishedWorkCount: 0,
            receivedLikeCount: 0,
            followerCount: 0,
            followingCount: 0,
        });
        mocks.workCommunity.listPublicCreatorWorks.mockResolvedValue({ items: [], hasMore: false });

        await getPublicCreatorPage("星启2026", "viewer-one");

        expect(mocks.workCommunity.getPublicCreatorProfile).toHaveBeenCalledWith("星启2026");
    });

    it("returns the authenticated community summary without leaking an internal user id", async () => {
        mocks.workCommunity.getUserCommunitySummary.mockResolvedValue({
            userId: "user-one",
            username: "viewer",
            publishedWorkCount: 1,
            followingCount: 2,
            followerCount: 3,
            likedWorkCount: 4,
            publicProfileAvailable: true,
        });

        const result = await listUserCommunityActivity("user-one", { view: "summary" });

        expect(result).toEqual({ view: "summary", username: "viewer", publishedWorkCount: 1, followingCount: 2, followerCount: 3, likedWorkCount: 4, publicProfileAvailable: true });
        expect(JSON.stringify(result)).not.toContain("user-one");
    });

    it("follows a public creator directly and emits only the public relation result", async () => {
        mocks.workCommunity.setFollowingUser.mockResolvedValue({ followedUserId: "creator-one", changed: true, active: true, followerCount: 6 });

        const result = await setPublicCreatorFollow("user-one", "creator", true);

        expect(mocks.workCommunity.setFollowingUser).toHaveBeenCalledWith("creator", "user-one", true, expect.any(String));
        expect(result).toEqual({ changed: true, active: true, followerCount: 6 });
        expect(mocks.workCommunity.createNotification).toHaveBeenCalledTimes(1);
    });

    it("links work-author follow notifications to the personal community homepage", async () => {
        mocks.workCommunity.setFollowingAuthor.mockResolvedValue({ followedUserId: "creator-one", changed: true, active: true, followerCount: 6 });

        await setWorkAuthorFollow("user-one", "publicwork123", true);

        expect(mocks.workCommunity.createNotification).toHaveBeenCalledWith(expect.objectContaining({ targetPath: "/me" }));
    });

    it("prevents following a creator when either user has blocked the other", async () => {
        mocks.workCommunity.getPublicCreatorProfile.mockResolvedValue({
            userId: "creator-one",
            username: "creator",
            displayName: "创作者",
            bio: "",
            publishedWorkCount: 1,
            receivedLikeCount: 0,
            followerCount: 0,
            followingCount: 0,
        });
        mocks.workCommunity.listPublicCreatorWorks.mockResolvedValue({ items: [], hasMore: false });
        mocks.workCommunity.isBlockedUser.mockResolvedValue(true);

        const result = await getPublicCreatorPage("creator", "user-one");

        expect(result.profile.canFollow).toBe(false);
    });

    it("returns only public block state and removed follow count", async () => {
        mocks.workCommunity.setBlockedUser.mockResolvedValue({ blockedUserId: "user-two", changed: true, active: true, removedFollowCount: 2 });

        const result = await setPublicUserBlock("user-one", "user-two", true);

        expect(mocks.workCommunity.setBlockedUser).toHaveBeenCalledWith("user-two", "user-one", true, expect.any(String));
        expect(result).toEqual({ changed: true, active: true, removedFollowCount: 2 });
        expect(JSON.stringify(result)).not.toContain("user-two");
    });
});
