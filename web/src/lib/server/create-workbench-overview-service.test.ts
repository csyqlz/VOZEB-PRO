import { describe, expect, it } from "vitest";

import type { StoredGenerationLog } from "@/lib/server/generation-log-types";

import { buildCreateAgentRunOverview, buildCreateGenerationOverview } from "./create-workbench-overview-service";

describe("create workbench overview service", () => {
    it("returns four running tasks and eight latest unique stable assets", () => {
        const logs = [
            ...Array.from({ length: 6 }, (_, index) => generationLog(`pending-${index}`, "pending", `2026-07-2${index}T12:00:00.000Z`, [])),
            generationLog("success-new", "success", "2026-07-26T12:00:00.000Z", [
                { type: "image", url: "/api/media/image-one.webp" },
                { type: "image", url: "data:image/png;base64,abc" },
            ]),
            generationLog("success-old", "success", "2026-07-26T11:00:00.000Z", [{ type: "image", url: "/api/media/image-one.webp" }, ...Array.from({ length: 9 }, (_, index) => ({ type: "video" as const, url: `/api/media/video-${index}.mp4` }))]),
        ];

        const overview = buildCreateGenerationOverview(logs, Date.parse("2026-07-26T12:01:00.000Z"));

        expect(overview.runningTasks).toHaveLength(4);
        expect(overview.runningTasks[0].id).toBe("pending-5");
        expect(overview.recentAssets).toHaveLength(8);
        expect(overview.recentAssets[0]).toMatchObject({ id: "success-new-0", url: "/api/media/image-one.webp" });
        expect(overview.recentAssets[0]?.expiresAt).toBe("2026-07-27T12:00:00.000Z");
        expect(overview.recentAssets.filter((asset) => asset.url === "/api/media/image-one.webp")).toHaveLength(1);
        expect(overview.recentAssets.some((asset) => asset.url.startsWith("data:"))).toBe(false);
    });

    it("omits expired generated media from the temporary download area", () => {
        const overview = buildCreateGenerationOverview(
            [
                generationLog("expired", "success", "2026-07-25T12:00:00.000Z", [{ type: "image", url: "/api/media/expired.webp" }]),
                generationLog("available", "success", "2026-07-26T11:30:00.000Z", [{ type: "video", url: "/api/media/available.mp4" }]),
            ],
            Date.parse("2026-07-26T12:00:00.000Z"),
        );

        expect(overview.recentAssets).toEqual([
            expect.objectContaining({ id: "available-0", url: "/api/media/available.mp4", expiresAt: "2026-07-27T11:30:00.000Z" }),
        ]);
    });

    it("keeps active Agent runs linked to their original conversation", () => {
        const tasks = buildCreateAgentRunOverview([
            { id: "run-one", surface: "chat", status: "running", prompt: "生成西瓜海报", conversationId: "conversation-one", createdAt: 100, tasks: [{ type: "image" }] },
            { id: "run-two", surface: "chat", status: "completed", prompt: "已完成", conversationId: "conversation-two", createdAt: 200, tasks: [] },
        ] as never);

        expect(tasks).toEqual([expect.objectContaining({ id: "run-one", kind: "image", source: "agent", conversationId: "conversation-one", status: "running" })]);
    });
});

function generationLog(id: string, status: StoredGenerationLog["status"], createdAt: string, assets: StoredGenerationLog["assets"]): StoredGenerationLog {
    return {
        id,
        userId: "user-one",
        username: "user",
        displayName: "User",
        kind: assets[0]?.type || "image",
        source: "agent",
        status,
        title: id,
        prompt: "",
        model: "model",
        summary: "",
        durationMs: 0,
        count: Math.max(1, assets.length),
        successCount: status === "success" ? assets.length : 0,
        failCount: 0,
        assets,
        createdAt,
        updatedAt: createdAt,
    };
}
