import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getCurrentUser: vi.fn(), applyDramaVisualResultForUser: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/server/drama-project-service", () => ({
    DramaProjectServiceError: class DramaProjectServiceError extends Error {
        constructor(
            message: string,
            readonly status: number,
        ) {
            super(message);
        }
    },
    applyDramaVisualResultForUser: mocks.applyDramaVisualResultForUser,
}));

import { POST } from "./route";

describe("POST drama visual analysis result", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getCurrentUser.mockResolvedValue({ id: "user-one" });
        mocks.applyDramaVisualResultForUser.mockResolvedValue({
            project: { updatedAt: "2026-08-26T06:00:00.000Z", episodes: [{ id: "episode-one", reviewStatus: "visual_ready", shots: [] }] },
            version: { id: "version-one", projectId: "project-one", version: 2, reason: "视觉方案生成前", createdAt: "2026-08-26T06:00:00.000Z" },
        });
    });

    it("returns the atomically persisted episode and version", async () => {
        const response = await POST(new Request("http://localhost", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: "visual-task-one", analysis: { shots: [] } }) }), {
            params: Promise.resolve({ id: "project-one", episodeId: "episode-one" }),
        });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ code: 0, data: { episode: { id: "episode-one", reviewStatus: "visual_ready" }, projectUpdatedAt: "2026-08-26T06:00:00.000Z", version: { id: "version-one" } } });
        expect(mocks.applyDramaVisualResultForUser).toHaveBeenCalledWith("user-one", "project-one", "episode-one", { taskId: "visual-task-one", analysis: { shots: [] } });
    });
});
