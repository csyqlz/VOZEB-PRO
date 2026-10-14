import { describe, expect, it } from "vitest";

import {
    assertReferenceCapabilities,
    assertReferenceUrls,
    assertVideoReferenceRoles,
    buildProviderRequest,
    buildVideoProviderRequest,
    isProviderBusinessError,
    providerQueryPaths,
    providerTaskPath,
    readProviderError,
    readProviderString,
    templateVideoReferenceRoles,
    videoPollingPolicy,
} from "./provider-task-config";

describe("provider task config", () => {
    it("uses the documented slower polling window for GlobalAiOpc video tasks only", () => {
        expect(videoPollingPolicy(true)).toEqual({ attempts: 40, intervalMs: 30_000 });
        expect(videoPollingPolicy(false)).toEqual({ attempts: 180, intervalMs: 2_500 });
    });

    it("renders JSON request templates without converting arrays and numbers to strings", () => {
        expect(buildProviderRequest('{"model":"{{model}}","duration":"{{duration}}","images":"{{images}}"}', {}, { model: "video-v1", duration: 10, images: ["a", "b"] })).toEqual({ model: "video-v1", duration: 10, images: ["a", "b"] });
    });

    it("omits intelligent parameters that intentionally have no fixed upstream value", () => {
        expect(buildProviderRequest('{"model":"{{model}}","ratio":"{{ratio}}","resolution":"{{resolution}}"}', {}, { model: "image-v1", ratio: undefined, resolution: undefined })).toEqual({ model: "image-v1" });
    });

    it("removes empty optional reference placeholders and containers", () => {
        const template = '{"model":"{{model}}","image":"{{image}}","images":"{{images}}","reference_images":["{{image}}"],"referenceVideos":["https://..."],"ref_assets":[{"type":"image","url":"{{image}}"}],"metadata":{"label":""}}';

        expect(buildProviderRequest(template, {}, { model: "video-v1", image: "", images: [] })).toEqual({ model: "video-v1", metadata: { label: "" } });
    });

    it("fills detected video template examples with the current parameters and reference image", () => {
        const template = '{"model":"{{model}}","prompt":"{{prompt}}","duration":5,"ratio":"16:9","image":"https://...","images":["https://..."]}';

        expect(buildVideoProviderRequest(template, {}, { model: "video-v1", prompt: "animate", duration: 10, ratio: "9:16", image: "https://cdn.example.com/reference.jpg", images: [] })).toEqual({
            model: "video-v1",
            prompt: "animate",
            duration: 10,
            ratio: "9:16",
            image: "https://cdn.example.com/reference.jpg",
        });
    });

    it("renders the documented Yumeng stable media and frame fields without empty placeholders", () => {
        const template = '{"reference_images":"{{images}}","reference_videos":"{{videos}}","reference_audios":"{{audios}}","first_image":"{{first_frame}}","last_image":"{{last_frame}}"}';

        expect(
            buildVideoProviderRequest(
                template,
                {},
                {
                    images: ["https://cdn.example.com/reference.png"],
                    videos: ["https://cdn.example.com/reference.mp4"],
                    audios: ["https://cdn.example.com/reference.mp3"],
                    first_frame: "https://cdn.example.com/first.png",
                    last_frame: "https://cdn.example.com/last.png",
                },
            ),
        ).toEqual({
            reference_images: ["https://cdn.example.com/reference.png"],
            reference_videos: ["https://cdn.example.com/reference.mp4"],
            reference_audios: ["https://cdn.example.com/reference.mp3"],
            first_image: "https://cdn.example.com/first.png",
            last_image: "https://cdn.example.com/last.png",
        });
        expect(buildVideoProviderRequest(template, {}, { images: [], videos: [], audios: [], first_frame: "", last_frame: "" })).toEqual({});
    });

    it("resolves configured query and nested result fields", () => {
        expect(providerQueryPaths({ queryPath: "/tasks/{{taskId}}" } as never, "task 1", [])).toEqual(["/tasks/task%201"]);
        expect(providerQueryPaths({ queryPath: "/result/:task_id" } as never, "video_123", [])).toEqual(["/result/video_123"]);
        expect(providerQueryPaths({ queryPath: "/agnesapi?video_id=:task_id" } as never, "video 123", [])).toEqual(["/agnesapi?video_id=video%20123"]);
        expect(readProviderString({ data: { output: { url: "https://cdn.example.com/result.mp3" } } }, "data.output.url", ["url"])).toBe("https://cdn.example.com/result.mp3");
        expect(readProviderString({ result: { data: [{ url: "/api/v1/gen/cached/generated/result.mp4" }] } }, "result.data[0].url / video_url / url", ["video_url", "url"])).toBe("/api/v1/gen/cached/generated/result.mp4");
    });

    it("uses an explicit query path without appending guessed fallbacks", () => {
        expect(providerQueryPaths({ queryPath: "/tasks/:task_id" } as never, "task-one", ["/videos/task-one", "/result/task-one"])).toEqual(["/tasks/task-one"]);
    });

    it("renders documented cancellation paths with encoded task ids", () => {
        expect(providerTaskPath("/jobs/:task_id/cancel", "task 1")).toBe("/jobs/task%201/cancel");
        expect(providerTaskPath("/jobs?task_id={{taskId}}", "task 1")).toBe("/jobs?task_id=task%201");
    });

    it("recognizes business errors returned with an HTTP 200 response", () => {
        const payload = { code: "204", msg: "登录验证失败" };
        expect(isProviderBusinessError(payload)).toBe(true);
        expect(readProviderError(payload)).toBe("登录验证失败");
        expect(isProviderBusinessError({ id: "video_123", status: "queued", error: null })).toBe(false);
    });

    it("rejects reference media disabled by the backend channel", () => {
        const config = { supportsReferenceImage: true, supportsReferenceVideo: false, supportsReferenceAudio: false } as never;
        expect(() => assertReferenceCapabilities(config, [{ type: "image" }])).not.toThrow();
        expect(() => assertReferenceCapabilities(config, [{ type: "video" }])).toThrow("当前渠道未启用参考视频能力");
        expect(() => assertReferenceCapabilities(config, [{ type: "audio" }])).toThrow("当前渠道未启用参考音频能力");
    });

    it("enforces protocol-specific first and last frame support before submission", () => {
        const frames = [
            { type: "image" as const, url: "https://cdn.example.com/first.png", role: "first_frame" as const },
            { type: "image" as const, url: "https://cdn.example.com/last.png", role: "last_frame" as const },
        ];

        expect(() => assertVideoReferenceRoles({ protocol: "seedance" } as never, frames)).not.toThrow();
        expect(() => assertVideoReferenceRoles({ protocol: "yumeng", requestTemplate: '{"first_image":"{{first_frame}}","last_image":"{{last_frame}}"}' } as never, frames)).not.toThrow();
        expect(() => assertVideoReferenceRoles({ protocol: "newapi" } as never, frames)).not.toThrow();
        expect(() => assertVideoReferenceRoles({ protocol: "openai" } as never, frames)).toThrow("当前视频模型不支持尾帧输入");
        expect(() => assertVideoReferenceRoles({ protocol: "custom", requestTemplate: '{"first":"{{first_frame_url}}","last":"{{last_frame_url}}"}' } as never, frames)).not.toThrow();
        expect(() => assertVideoReferenceRoles({ protocol: "custom", requestTemplate: '{"first":"{{first_frame_url}}"}' } as never, frames)).toThrow("当前视频模型不支持尾帧输入");
    });

    it("derives custom template frame roles only from explicit variables or structured references", () => {
        expect(templateVideoReferenceRoles('{"first":"{{first_frame}}","last":"{{last_frame_url}}"}')).toEqual(["reference", "first_frame", "last_frame"]);
        expect(templateVideoReferenceRoles('{"references":"{{references}}"}')).toEqual(["reference", "first_frame", "last_frame"]);
        expect(templateVideoReferenceRoles('{"images":"{{images}}"}')).toEqual(["reference"]);
    });

    it("rejects loopback assets when the provider requires public reference URLs", () => {
        const config = { referenceRule: "参考图必须使用公网 URL" } as never;
        expect(() => assertReferenceUrls(config, [{ url: "http://127.0.0.1:3000/api/reference-assets/test.jpg" }])).toThrow("站内参考素材");
        expect(() => assertReferenceUrls(config, [{ url: "https://cdn.example.com/reference.jpg" }])).not.toThrow();
    });

    it("requires a short-lived signature before sending a protected reference asset upstream", () => {
        const config = { referenceRule: "参考图必须使用公网 URL" } as never;
        expect(() => assertReferenceUrls(config, [{ url: "https://drama.example/api/reference-assets/temporary/2026/07/25/images/file.png" }])).toThrow("站内参考素材");
        expect(() => assertReferenceUrls(config, [{ url: "https://drama.example/api/reference-assets/temporary/2026/07/25/images/file.png?expires=1&signature=test" }])).toThrow("站内参考素材");
        expect(() => assertReferenceUrls(config, [{ url: "https://drama.example/api/reference-assets/temporary/2026/07/25/images/file.png?purpose=provider-read&expires=1&signature=test" }])).not.toThrow();
        expect(() => assertReferenceUrls(config, [{ url: "https://drama.example/api/generation-log-assets/permanent/2026/07/25/images/file.png?purpose=provider-read&expires=1&signature=test" }])).not.toThrow();
        expect(() => assertReferenceUrls(config, [{ url: "https://drama.example/api/generation-log-assets/permanent/2026/07/25/images/file.png" }])).toThrow("站内参考素材");
    });
});
