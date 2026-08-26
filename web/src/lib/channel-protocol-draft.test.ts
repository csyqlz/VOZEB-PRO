import { describe, expect, it } from "vitest";

import { parseDeterministicProtocolDraft, protocolDraftFromUnknown, redactProtocolSecrets } from "./channel-protocol-draft";
import { safeProtocolDocumentationUrl } from "./channel-protocol-security";

describe("custom channel protocol drafts", () => {
    it("extracts a complete image operation and model catalog from examples", () => {
        const draft = parseDeterministicProtocolDraft({
            text: `GET https://api.example.com/v1/models
curl --url https://api.example.com/v1/images/generations --header 'Authorization: Bearer secret-value' --data '{"model":"image-one","prompt":"test"}'
{"data":[{"url":"https://cdn.example.com/out.png"}]}
curl --url https://api.example.com/v1/images/edits --header 'Authorization: Bearer secret-value' --data '{"model":"image-one","prompt":"test","image":"https://cdn.example.com/ref.png"}'
{"data":[{"url":"https://cdn.example.com/out.png"}]}`,
        });
        expect(draft?.modelCatalogPaths).toEqual(["/v1/models"]);
        expect(draft?.operations).toHaveLength(1);
        expect(draft?.operations[0]).toMatchObject({ capability: "image", models: ["image-one"], config: { createPath: "/images/generations", editPath: "/images/edits", resultField: "data[0].url" } });
    });

    it("accepts multiple capabilities and operations without static models when a catalog exists", () => {
        const draft = protocolDraftFromUnknown({
            baseUrl: "https://api.example.com/v1",
            authMode: "bearer",
            modelCatalogPaths: ["/v1/models"],
            operations: [
                { capability: "text", models: [], config: { createPath: "/chat/completions", requestTemplate: '{"model":"{{model}}","messages":"{{messages}}"}', resultField: "choices[0].message.content" } },
                {
                    capability: "video",
                    models: ["video-one"],
                    config: {
                        createPath: "/videos",
                        queryPath: "/videos/:task_id",
                        cancelPath: "/videos/:task_id/cancel",
                        cancelMethod: "POST",
                        requestTemplate: '{"model":"{{model}}","prompt":"{{prompt}}"}',
                        resultField: "data.video_url",
                    },
                },
            ],
        });
        expect(draft?.operations.map((item) => item.capability)).toEqual(["text", "video"]);
        expect(draft?.operations[1].config).toMatchObject({ cancelPath: "/videos/:task_id/cancel", cancelMethod: "POST" });
    });

    it("accepts explicit first-frame and last-frame video template variables", () => {
        const draft = protocolDraftFromUnknown({
            baseUrl: "https://api.example.com/v1",
            authMode: "bearer",
            operations: [
                {
                    capability: "video",
                    models: ["video-frames"],
                    config: {
                        createPath: "/videos",
                        requestTemplate: '{"model":"{{model}}","prompt":"{{prompt}}","first_frame":"{{first_frame}}","first_frame_url":"{{first_frame_url}}","last_frame":"{{last_frame}}","last_frame_url":"{{last_frame_url}}"}',
                        resultField: "data.video_url",
                    },
                },
            ],
        });

        expect(draft?.operations[0].config.requestTemplate).toContain("{{last_frame_url}}");
    });

    it("extracts every capability path from one relative multi-endpoint example", () => {
        const draft = parseDeterministicProtocolDraft({
            text: `GET /v1/models
Response {"data":[{"id":"writer-v1","capability":"text"},{"id":"image-v1","capability":"image"},{"id":"video-v1","capability":"video"}]}
POST /v1/chat/completions
Body {"model":"{{model}}","messages":"{{messages}}"}
Response {"choices":[{"message":{"content":"ok"}}]}
POST /v1/images/generations
Body {"model":"{{model}}","prompt":"{{prompt}}","size":"{{size}}"}
Response {"data":[{"url":"https://cdn.example.com/image.png"}]}
POST /v1/videos
Body {"model":"{{model}}","prompt":"{{prompt}}","duration":"{{duration}}"}
Response {"id":"task-1","status":"queued"}
GET /v1/videos/:task_id
Response {"status":"succeeded","result":{"url":"https://cdn.example.com/video.mp4"}}
DELETE /v1/videos/:task_id`,
        });

        expect(draft?.modelCatalogPaths).toEqual(["/v1/models"]);
        expect(draft?.operations.map((item) => item.capability)).toEqual(["text", "image", "video"]);
        expect(draft?.operations.every((item) => item.models.length === 0)).toBe(true);
        expect(draft?.operations[0].config.createPath).toBe("/v1/chat/completions");
        expect(draft?.operations[1].config.createPath).toBe("/v1/images/generations");
        expect(draft?.operations[2].config).toMatchObject({ createPath: "/v1/videos", queryPath: "/v1/videos/:task_id", cancelPath: "/v1/videos/:task_id", cancelMethod: "DELETE" });
    });

    it("distinguishes curl GET polling examples from curl POST creation examples", () => {
        const draft = parseDeterministicProtocolDraft({
            text: [
                `curl --url https://api.example.com/custom/videos --header 'Content-Type: application/json' --data '{"model":"video-v1","prompt":"test"}'`,
                `{"data":{"task_id":"task-1","status":"queued"}}`,
                `curl --url https://api.example.com/custom/results/{task_id} --header 'X-API-Key: token'`,
                `{"data":{"status":"completed","video_url":"https://cdn.example.com/video.mp4"}}`,
            ].join("\n"),
        });

        expect(draft?.operations[0]?.config).toMatchObject({ createPath: "/custom/videos", queryPath: "/custom/results/:task_id", resultField: "data.video_url", statusField: "data.status" });
    });

    it("extracts rendered API documentation without cURL or JSON examples", () => {
        const draft = parseDeterministicProtocolDraft({
            text: `SOURCE https://developer.example.test/reference/image-create
POST
/service/v2/tasks
基础 URL
https://api.example.test/service
模型信息
模型 ID（
model
）
image-v2
模型类型
图片模型
请求参数
model
string 必填
prompt
string 必填
reference_images
image[]
aspect_ratio
string
resolution
string
返回约定
id
任务 ID
status
queued、processing、completed、failed
result_url
完成后的通用结果
image_url
完成后的图片结果
GET
https://api.example.test/service/v2/tasks/{id}
响应参数
status
image_url`,
        });

        expect(draft).toMatchObject({
            baseUrl: "https://api.example.test",
            operations: [
                {
                    capability: "image",
                    models: ["image-v2"],
                    config: {
                        createPath: "/service/v2/tasks",
                        queryPath: "/service/v2/tasks/:task_id",
                        resultField: "result_url / image_url",
                        statusField: "status",
                        supportsReferenceImage: true,
                    },
                },
            ],
        });
        expect(draft?.operations[0].config.requestTemplate).toBe('{"model":"{{model}}","prompt":"{{prompt}}","reference_images":"{{images}}","aspect_ratio":"{{aspect_ratio}}","resolution":"{{resolution}}"}');
    });

    it("keeps query paths inside their own documentation source", () => {
        const draft = parseDeterministicProtocolDraft({
            text: `GET /v2/models
SOURCE https://developer.example.test/reference/image
POST /v2/tasks
Body {"model":"image-standard","prompt":"test","reference_images":[]}
Response {"task_id":"image-task","status":"queued"}
GET /v2/image-tasks/:task_id
Response {"status":"completed","image_url":"https://cdn.example.test/image.png"}
SOURCE https://developer.example.test/reference/video
POST /v2/tasks
Body {"model":"video-standard","prompt":"test","duration":8}
Response {"task_id":"video-task","status":"queued"}
GET /v2/video-tasks/:task_id
Response {"status":"completed","video_url":"https://cdn.example.test/video.mp4"}`,
        });

        expect(draft?.operations.find((operation) => operation.capability === "image")?.config.queryPath).toBe("/v2/image-tasks/:task_id");
        expect(draft?.operations.find((operation) => operation.capability === "video")?.config.queryPath).toBe("/v2/video-tasks/:task_id");
    });

    it("does not treat documentation field or header names as models", () => {
        const draft = parseDeterministicProtocolDraft({
            text: `GET /v2/models
POST /v2/images
模型 ID
modelId
Authorization
请求参数
model
prompt
返回约定
image_url`,
        });

        expect(draft?.operations[0].models).toEqual([]);
    });

    it("redacts cookies, authorization values, and sensitive URL parameters", () => {
        const redacted = redactProtocolSecrets("Cookie: session=secret\nhttps://api.example.com/docs?token=secret&lang=zh\nAuthorization: Bearer sk-secretvalue");
        expect(redacted).not.toContain("session=secret");
        expect(redacted).not.toContain("token=secret");
        expect(redacted).not.toContain("sk-secretvalue");
        expect(redacted).toContain("token=[REDACTED]");
    });

    it("rejects documentation URLs that carry credentials or key-like query parameters", () => {
        expect(safeProtocolDocumentationUrl("https://user:pass@example.com/docs")).toBe("");
        expect(safeProtocolDocumentationUrl("https://example.com/docs?api_key=secret")).toBe("");
        expect(safeProtocolDocumentationUrl("https://example.com/docs?lang=zh")).toBe("https://example.com/docs?lang=zh");
    });

    it("rejects executable variables, unsafe paths, and model-free drafts without a catalog", () => {
        expect(
            protocolDraftFromUnknown({
                operations: [{ capability: "image", models: ["one"], config: { createPath: "/jobs", requestTemplate: '{"prompt":"{{process.mainModule}}"}', resultField: "url" } }],
            }),
        ).toBeNull();
        expect(
            protocolDraftFromUnknown({
                operations: [{ capability: "image", models: ["one"], config: { createPath: "https://evil.example/jobs", requestTemplate: '{"prompt":"{{prompt}}"}', resultField: "url" } }],
            }),
        ).toBeNull();
        expect(
            protocolDraftFromUnknown({
                operations: [{ capability: "image", models: [], config: { createPath: "/jobs", requestTemplate: '{"prompt":"{{prompt}}"}', resultField: "url" } }],
            }),
        ).toBeNull();
    });

    it("accepts an explicitly keyless custom protocol package", () => {
        expect(
            protocolDraftFromUnknown({
                authMode: "none",
                operations: [{ capability: "image", models: ["local-image"], config: { createPath: "/generate", requestTemplate: '{"prompt":"{{prompt}}"}', resultField: "image" } }],
            })?.authMode,
        ).toBe("none");
    });
});
