import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext } from "@playwright/test";
import { protocolFixtureState, resetProtocolFixture } from "./support";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request }) => {
    await resetProtocolFixture(request);
});

test("drama Workflow resumes through video, review and unified assets", async ({ request }) => {
    const suffix = randomUUID().slice(0, 8);
    const drama = await responseData<{ project: DramaProject }>(
        await request.post("/api/drama/projects", {
            data: {
                title: `工作流短剧 ${suffix}`,
                summary: "验证可恢复工作流正式链路",
                style: "清晰电影画面",
                ratio: "16:9",
                initialScript: "主角走进明亮房间，说：开始拍摄。",
            },
        }),
    ).then((data) => data.project);
    try {
        const workflow = await responseData<{ workflow: { id: string } }>(await request.post("/api/vozeb-cms/workflows/templates/drama", { data: { projectId: drama.id, id: `workflow-e2e-${suffix}` } })).then((data) => data.workflow);
        const episodeId = drama.episodes[0].id;
        const created = await responseData<{ run: WorkflowRun }>(
            await request.post(`/api/vozeb-cms/workflows/${workflow.id}/runs`, {
                data: { idempotencyKey: `workflow-e2e-run-${suffix}`, context: { surface: "drama", projectId: drama.id, episodeId } },
            }),
        ).then((data) => data.run);

        const review = await waitForRun(request, created.id, (run) => run.status === "waiting" && run.nodeStates.review?.status === "waiting");
        const analyzed = await dramaProject(request, drama.id);
        expect(analyzed.episodes[0]).toMatchObject({ reviewStatus: "visual_ready" });
        expect(analyzed.episodes[0].shots.length).toBeGreaterThan(0);
        const episode = analyzed.episodes[0];
        expect(review.nodeStates.video).toMatchObject({ status: "success" });
        expect(review.nodeStates.video.taskIds?.length).toBe(episode.shots.length);

        const completed = await responseData<{ run: WorkflowRun }>(await request.post(`/api/vozeb-cms/workflows/runs/${created.id}/review`, { data: { nodeId: "review", decision: "approved" } })).then((data) => data.run);
        expect(completed).toMatchObject({ status: "completed", nodeStates: { review: { status: "success" }, asset: { status: "success" } } });

        const restored = await responseData<{ run: WorkflowRun }>(await request.get(`/api/vozeb-cms/workflows/runs/${created.id}`)).then((data) => data.run);
        expect(restored.status).toBe("completed");
        expect(restored.id).toBe(created.id);

        const assets = await responseData<{ assets: Array<{ id: string; project_id?: string; task_id?: string; run_id?: string }> }>(await request.get(`/api/vozeb-cms/assets?projectId=${encodeURIComponent(drama.id)}&projectType=drama&limit=100`)).then(
            (data) => data.assets,
        );
        expect(assets.some((asset) => asset.id.startsWith("drama-video:") && asset.project_id === drama.id && asset.task_id && asset.run_id === created.id)).toBe(true);

        const fixture = await protocolFixtureState(request);
        expect(fixture.requests.some((item) => item.method === "POST" && item.path.endsWith("/chat/completions"))).toBe(true);
        expect(fixture.requests.filter((item) => item.method === "POST" && item.path.endsWith("/videos"))).toHaveLength(episode.shots.length);
    } finally {
        await request.delete(`/api/drama/projects/${drama.id}`);
    }
});

async function waitForRun(request: APIRequestContext, runId: string, done: (run: WorkflowRun) => boolean) {
    let latest: WorkflowRun | undefined;
    await expect
        .poll(
            async () => {
                latest = await responseData<{ run: WorkflowRun }>(await request.get(`/api/vozeb-cms/workflows/runs/${runId}`)).then((data) => data.run);
                return done(latest);
            },
            { timeout: 120_000 },
        )
        .toBe(true);
    return latest!;
}

async function dramaProject(request: APIRequestContext, projectId: string) {
    return responseData<{ project: DramaProject }>(await request.get(`/api/drama/projects/${projectId}`)).then((data) => data.project);
}

async function responseData<T = unknown>(response: Awaited<ReturnType<APIRequestContext["get"]>>) {
    expect(response.ok(), await response.text()).toBe(true);
    return ((await response.json()) as { data: T }).data;
}

type WorkflowRun = {
    id: string;
    status: string;
    error?: string;
    nodeStates: Record<string, { status: string; taskId?: string; taskIds?: string[] }>;
};

type DramaProject = {
    id: string;
    updatedAt: string;
    episodes: Array<{
        id: string;
        reviewStatus: string;
        shots: Array<Record<string, unknown> & { id: string }>;
    }>;
} & Record<string, unknown>;
