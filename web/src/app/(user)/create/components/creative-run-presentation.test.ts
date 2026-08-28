import { describe, expect, it } from "vitest";

import type { CreativeAgentRun } from "@/services/api/creative";

import { creativeRunDuration, creativeRunPresentation } from "./creative-run-presentation";

describe("creativeRunPresentation", () => {
    it("shows public final video parameters without internal planning fields", () => {
        const run: CreativeAgentRun = {
            id: "run-one",
            conversationId: "conversation-one",
            inputMessageId: "user-one",
            assistantMessageId: "assistant-one",
            status: "completed",
            prompt: "让参考图自然动起来",
            requestedModelIds: ["seedance"],
            generationPreferences: { mode: "video", video: { size: "16:9", quality: "720P", seconds: 10, referenceMode: "first_frame" } },
            assetIds: [],
            tasks: [{ id: "task-one", title: "生成视频", type: "video", model: "seedance", ratio: "16:9", quality: "720P", seconds: 10, count: 1, status: "completed" }],
        };

        expect(creativeRunPresentation(run, new Map([["seedance", "Seedance 2.0"]]))).toEqual([
            { key: "mode", label: "类型", value: "视频生成" },
            { key: "model", label: "模型", value: "Seedance 2.0" },
            { key: "size", label: "比例", value: "16:9" },
            { key: "quality", label: "清晰度", value: "720P" },
            { key: "seconds", label: "时长", value: "10秒" },
            { key: "status", label: "状态", value: "已完成" },
        ]);
    });

    it("falls back to explicit preferences while planning", () => {
        const run = {
            id: "run-two",
            conversationId: "conversation-one",
            inputMessageId: "user-two",
            assistantMessageId: "assistant-two",
            status: "planning",
            generationPreferences: { mode: "image", image: { size: "3:4", quality: "high" } },
            assetIds: [],
            tasks: [],
        } satisfies CreativeAgentRun;

        expect(creativeRunPresentation(run, new Map())).toEqual([
            { key: "mode", label: "类型", value: "图片生成" },
            { key: "size", label: "尺寸", value: "3:4" },
            { key: "quality", label: "画质", value: "高画质" },
            { key: "status", label: "状态", value: "规划中" },
        ]);
    });

    it("keeps every media model and output count for mixed concurrent generation", () => {
        const run = {
            id: "run-mixed",
            conversationId: "conversation-one",
            inputMessageId: "user-mixed",
            assistantMessageId: "assistant-mixed",
            status: "running",
            assetIds: [],
            tasks: [
                { id: "images", title: "生成图片", type: "image", model: "image-model", count: 2, status: "running" },
                { id: "videos", title: "生成视频", type: "video", model: "video-model", count: 2, status: "running" },
            ],
        } satisfies CreativeAgentRun;

        const items = creativeRunPresentation(
            run,
            new Map([
                ["image-model", "图片模型"],
                ["video-model", "视频模型"],
            ]),
        );

        expect(items).toContainEqual({ key: "model", label: "模型", value: "图片模型 + 视频模型" });
        expect(items).toContainEqual({ key: "count", label: "数量", value: "4个结果" });
    });

    it("formats the persisted run duration without inventing a timeout", () => {
        expect(creativeRunDuration({ createdAt: 1_000, updatedAt: 66_000 } as CreativeAgentRun)).toBe("1分5秒");
        expect(creativeRunDuration({ createdAt: 1_000, updatedAt: 1_200 } as CreativeAgentRun)).toBe("1秒");
        expect(creativeRunDuration({ createdAt: 2_000, updatedAt: 1_000 } as CreativeAgentRun)).toBe("");
    });
});
