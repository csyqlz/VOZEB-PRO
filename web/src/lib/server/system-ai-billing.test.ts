import { describe, expect, it } from "vitest";

import {
    hasSystemAiCharge,
    readSystemAiBilling,
    readVerifiedSystemAiBusinessRequestId,
    readVerifiedSystemAiBillingRequest,
    SYSTEM_AI_AUDIO_TASK_HEADER,
    SYSTEM_AI_VIDEO_TASK_HEADER,
    SYSTEM_AI_IMAGE_TASK_HEADER,
    SYSTEM_AI_TEXT_TASK_HEADER,
    systemAiBillingHeaders,
    systemAiIdempotencyKey,
    systemAiPointsIdempotencyKey,
    systemAiRequestFingerprint,
} from "./system-ai-billing";

describe("system AI billing helpers", () => {
    it("binds audio identity to its own signature domain and rejects mixed or altered attempts", () => {
        const audio = { taskId: "audio-one", attemptNo: 2 };
        const headers = new Headers(systemAiBillingHeaders("speaker", "business", "tts", undefined, undefined, undefined, audio));
        expect(readVerifiedSystemAiBillingRequest(headers, "speaker", "tts")).toEqual({ businessRequestId: "business", audioTask: audio });
        const mixed = new Headers(headers);
        mixed.set(SYSTEM_AI_VIDEO_TASK_HEADER, headers.get(SYSTEM_AI_AUDIO_TASK_HEADER)!);
        expect(readVerifiedSystemAiBillingRequest(mixed, "speaker", "tts")).toBeUndefined();
        const renamed = new Headers(headers);
        renamed.set(SYSTEM_AI_VIDEO_TASK_HEADER, renamed.get(SYSTEM_AI_AUDIO_TASK_HEADER)!);
        renamed.delete(SYSTEM_AI_AUDIO_TASK_HEADER);
        expect(readVerifiedSystemAiBillingRequest(renamed, "speaker", "tts")).toBeUndefined();
        headers.set(SYSTEM_AI_AUDIO_TASK_HEADER, Buffer.from(JSON.stringify({ ...audio, attemptNo: 3 })).toString("base64url"));
        expect(readVerifiedSystemAiBillingRequest(headers, "speaker", "tts")).toBeUndefined();
        expect(() => systemAiBillingHeaders("speaker", "business", "tts", audio, undefined, undefined, audio)).toThrow();
        expect(() => systemAiBillingHeaders("speaker", "business", "tts", undefined, undefined, undefined, { ...audio, attemptNo: 0 })).toThrow();
    });

    it("signs the task and attempt together with the model and business request", () => {
        const task = { taskId: "task-one", attemptNo: 2 };
        const headers = new Headers(systemAiBillingHeaders("writer", "business-one", "upstream", task));
        expect(readVerifiedSystemAiBillingRequest(headers, "writer", "upstream")).toEqual({ businessRequestId: "business-one", textTask: task });
        for (const forged of [
            { ...task, taskId: "other" },
            { ...task, attemptNo: 3 },
        ]) {
            const changed = new Headers(headers);
            changed.set(SYSTEM_AI_TEXT_TASK_HEADER, Buffer.from(JSON.stringify(forged)).toString("base64url"));
            expect(readVerifiedSystemAiBillingRequest(changed, "writer", "upstream")).toBeUndefined();
        }
        headers.delete(SYSTEM_AI_TEXT_TASK_HEADER);
        expect(readVerifiedSystemAiBusinessRequestId(headers, "writer", "upstream")).toBeUndefined();
        expect(() => systemAiBillingHeaders("writer", undefined, "upstream", task)).toThrow("身份无效");
        expect(() => systemAiBillingHeaders("writer", "business", "upstream", { ...task, attemptNo: 0 })).toThrow("身份无效");
    });
    it("binds image task references to the capability and rejects forged or swapped task headers", () => {
        const task = { taskId: "image-one", attemptNo: 1 };
        const headers = new Headers(systemAiBillingHeaders("image", "request", "flux-kontext-pro", undefined, task));
        expect(readVerifiedSystemAiBillingRequest(headers, "image", "flux-kontext-pro")).toEqual({ businessRequestId: "request", imageTask: task });
        for (const replacement of [
            { taskId: "other", attemptNo: 1 },
            { ...task, attemptNo: 2 },
        ]) {
            const changed = new Headers(headers);
            changed.set(SYSTEM_AI_IMAGE_TASK_HEADER, Buffer.from(JSON.stringify(replacement)).toString("base64url"));
            expect(readVerifiedSystemAiBillingRequest(changed, "image", "flux-kontext-pro")).toBeUndefined();
        }
        const swapped = new Headers(headers);
        swapped.set(SYSTEM_AI_TEXT_TASK_HEADER, swapped.get(SYSTEM_AI_IMAGE_TASK_HEADER)!);
        swapped.delete(SYSTEM_AI_IMAGE_TASK_HEADER);
        expect(readVerifiedSystemAiBillingRequest(swapped, "image", "flux-kontext-pro")).toBeUndefined();
        headers.delete(SYSTEM_AI_IMAGE_TASK_HEADER);
        expect(readVerifiedSystemAiBillingRequest(headers, "image", "flux-kontext-pro")).toBeUndefined();
        expect(() => systemAiBillingHeaders("image", "request", "flux", task, task)).toThrow("图片任务计费身份无效");
    });

    it("signs video task attempts separately from image/text and rejects any tampering", () => {
        const task = { taskId: "video-one", attemptNo: 2 };
        const headers = new Headers(systemAiBillingHeaders("video", "request", "MiniMax-H3", undefined, undefined, task));
        expect(readVerifiedSystemAiBillingRequest(headers, "video", "MiniMax-H3")).toEqual({ businessRequestId: "request", videoTask: task });
        for (const replacement of [
            { ...task, taskId: "other" },
            { ...task, attemptNo: 3 },
        ]) {
            const changed = new Headers(headers);
            changed.set(SYSTEM_AI_VIDEO_TASK_HEADER, Buffer.from(JSON.stringify(replacement)).toString("base64url"));
            expect(readVerifiedSystemAiBillingRequest(changed, "video", "MiniMax-H3")).toBeUndefined();
        }
        expect(readVerifiedSystemAiBillingRequest(headers, "other", "MiniMax-H3")).toBeUndefined();
        expect(readVerifiedSystemAiBillingRequest(headers, "video", "MiniMax-H3-Max")).toBeUndefined();
        for (const name of [SYSTEM_AI_IMAGE_TASK_HEADER, SYSTEM_AI_TEXT_TASK_HEADER]) {
            const changed = new Headers(headers);
            changed.set(name, changed.get(SYSTEM_AI_VIDEO_TASK_HEADER)!);
            expect(readVerifiedSystemAiBillingRequest(changed, "video", "MiniMax-H3")).toBeUndefined();
            changed.delete(SYSTEM_AI_VIDEO_TASK_HEADER);
            expect(readVerifiedSystemAiBillingRequest(changed, "video", "MiniMax-H3")).toBeUndefined();
        }
        expect(() => systemAiBillingHeaders("video", "request", "MiniMax-H3", undefined, task, task)).toThrow("身份无效");
        headers.delete(SYSTEM_AI_VIDEO_TASK_HEADER);
        expect(readVerifiedSystemAiBillingRequest(headers, "video", "MiniMax-H3")).toBeUndefined();
    });

    it("preserves a zero-cost consumption record so its quota can be refunded", () => {
        const billing = readSystemAiBilling(new Headers({ "x-vozeb-pro-points-cost": "0", "x-vozeb-pro-points-record-id": "points-free-text" }));

        expect(billing).toEqual({ pointsCost: 0, pointsRecordId: "points-free-text" });
        expect(hasSystemAiCharge(billing)).toBe(true);
    });

    it("creates stable scoped idempotency headers without exposing source identifiers", () => {
        const first = systemAiIdempotencyKey("workbench-plan", "user-one", "request-one", "image", "channel-one");
        const second = systemAiIdempotencyKey("workbench-plan", "user-one", "request-one", "image", "channel-one");
        const headers = new Headers(systemAiBillingHeaders("planner", first, "vendor-text"));

        expect(first).toBe(second);
        expect(first).toMatch(/^workbench-plan:[a-f0-9]{32}$/);
        expect(headers.get("x-vozeb-pro-logical-model")).toBe("planner");
        expect(headers.get("x-vozeb-pro-points-idempotency-key")).toBe(first);
        expect(headers.get("x-vozeb-pro-points-signature")).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(readVerifiedSystemAiBusinessRequestId(headers, "planner", "vendor-text")).toBe(first);

        headers.set("x-vozeb-pro-points-idempotency-key", `${first}:forged`);
        expect(readVerifiedSystemAiBusinessRequestId(headers, "planner", "vendor-text")).toBeUndefined();
    });

    it("binds the local billing key and request fingerprint to separate identities", () => {
        const identity = { userId: "user-one", businessRequestId: "task-one", logicalModel: "writer", channelId: "channel-one", upstreamModel: "vendor-text", callType: "text:create:/chat/completions" };
        const firstKey = systemAiPointsIdempotencyKey(identity);
        const secondKey = systemAiPointsIdempotencyKey(identity);
        const firstFingerprint = systemAiRequestFingerprint({
            method: "POST",
            callType: identity.callType,
            logicalModel: identity.logicalModel,
            channelId: identity.channelId,
            upstreamModel: identity.upstreamModel,
            usageKind: "text",
            amount: 1,
            bodyDigest: "a".repeat(64),
        });
        const secondFingerprint = systemAiRequestFingerprint({
            method: "POST",
            callType: identity.callType,
            logicalModel: identity.logicalModel,
            channelId: identity.channelId,
            upstreamModel: identity.upstreamModel,
            usageKind: "text",
            amount: 1,
            bodyDigest: "b".repeat(64),
        });

        expect(firstKey).toBe(secondKey);
        expect(firstKey).toMatch(/^system-ai:[a-f0-9]{64}$/);
        expect(firstFingerprint).not.toBe(secondFingerprint);
    });
});
