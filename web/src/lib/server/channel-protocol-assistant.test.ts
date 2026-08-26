import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetchSafeOutbound: vi.fn() }));

vi.mock("@/lib/server/safe-outbound-fetch", () => ({
    fetchSafeOutbound: mocks.fetchSafeOutbound,
    UnsafeOutboundUrlError: class UnsafeOutboundUrlError extends Error {},
}));

import { createChannelProtocolDraft, htmlDocumentText } from "./channel-protocol-assistant";
import { parseDeterministicProtocolDraft } from "../channel-protocol-draft";
import { extractProtocolHtmlDocument, selectProtocolDocumentLinks } from "./protocol-document-source";

describe("channel protocol document parsing", () => {
    beforeEach(() => mocks.fetchSafeOutbound.mockReset());

    it("keeps visible HTML text and removes executable or hidden blocks", () => {
        const text = htmlDocumentText('<main>API <strong>/v1/models</strong><script src="x">secret()</script><style>.hidden{}</style><template>hidden</template><p>&amp; ready</p></main>');

        expect(text).toBe("API /v1/models & ready");
        expect(text).not.toContain("secret");
        expect(text).not.toContain("hidden");
    });

    it("handles malformed HTML without leaking script contents", () => {
        expect(htmlDocumentText("<p>before<script>secret()<p>after")).toBe("before");
    });

    it("discovers Next.js API navigation pages and splits different upstream origins into reviewable drafts", async () => {
        const rootUrl = "https://docs.provider.test/guide";
        const pages = new Map<string, string>([
            [
                rootUrl,
                `<html><body><main>API 文档</main><script>self.__next_f.push([1,{"href":"/api-reference/text/chat-standard"},{"href":"/api-reference/model-center/image-gen/image-standard"},{"href":"/api-reference/model-center/video-gen/video-standard"}])</script></body></html>`,
            ],
            [
                "https://docs.provider.test/api-reference/text/chat-standard",
                `<article><h1>Chat API</h1><pre>curl --url https://language-api.provider.test/v1/chat/completions --header 'Authorization: Bearer token' --data '{"model":"text-standard","messages":[{"role":"user","content":"hello"}]}'</pre><pre>{"choices":[{"message":{"content":"ok"}}]}</pre></article>`,
            ],
            [
                "https://docs.provider.test/api-reference/model-center/image-gen/image-standard",
                `<article><h1>Image API</h1><pre>curl --url https://media-api.provider.test/platform/v2/tasks --header 'Authorization: Bearer token' --data '{"model":"image-standard","prompt":"test","reference_images":[],"aspect_ratio":"1:1","resolution":"high"}'</pre><pre>{"task_id":"image-task","status":"success","result_url":"https://cdn.test/image.png"}</pre></article>`,
            ],
            [
                "https://docs.provider.test/api-reference/model-center/video-gen/video-standard",
                `<article><h1>Video API</h1><pre>curl --url https://media-api.provider.test/platform/v2/tasks --header 'Authorization: Bearer token' --data '{"model":"video-standard","prompt":"test","reference_images":[],"reference_videos":[],"reference_audios":[],"duration":5}'</pre><pre>{"task_id":"video-task","status":"success","video_url":"https://cdn.test/video.mp4"}</pre></article>`,
            ],
        ]);
        const rootDocument = extractProtocolHtmlDocument(pages.get(rootUrl) || "", rootUrl);
        expect(rootDocument.links).toHaveLength(3);
        expect(selectProtocolDocumentLinks(rootDocument.links, rootUrl)).toHaveLength(3);
        const textSource = extractProtocolHtmlDocument(pages.get("https://docs.provider.test/api-reference/text/chat-standard") || "").text;
        const mediaSource = [
            extractProtocolHtmlDocument(pages.get("https://docs.provider.test/api-reference/model-center/image-gen/image-standard") || "").text,
            extractProtocolHtmlDocument(pages.get("https://docs.provider.test/api-reference/model-center/video-gen/video-standard") || "").text,
        ].join("\n\n");
        expect(parseDeterministicProtocolDraft({ text: textSource })).not.toBeNull();
        expect(parseDeterministicProtocolDraft({ text: mediaSource })).not.toBeNull();
        mocks.fetchSafeOutbound.mockImplementation(async (url: string) => {
            const page = pages.get(url);
            return page ? new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } }) : new Response("not found", { status: 404 });
        });

        const result = await createChannelProtocolDraft({ requestUrl: "http://localhost/api/admin/channel-protocol-draft", cookie: "", userId: "admin", documentationUrl: rootUrl, useTextModel: false });

        expect(result.sourcePages).toBe(4);
        expect(result.drafts).toHaveLength(2);
        expect(result.warnings[0]).toContain("2 套独立上游协议");
        expect(result.drafts.map((draft) => draft.baseUrl)).toEqual(expect.arrayContaining(["https://language-api.provider.test/v1", "https://media-api.provider.test"]));
        expect(result.drafts.find((draft) => draft.baseUrl.includes("media-api"))?.operations.map((operation) => operation.capability)).toEqual(["image", "video"]);
    });

    it("uses a generic same-origin model hub when representative model pages are unavailable", async () => {
        const rootUrl = "https://docs.provider.test/guide/start";
        const hubUrl = "https://docs.provider.test/reference/model-center";
        const imageLeafUrl = "https://docs.provider.test/reference/model-center/image-gen/image-one";
        const videoLeafUrl = "https://docs.provider.test/reference/model-center/video-gen/video-one";
        const root = `<html><body><main>Provider API</main><script>self.__next_f.push([1,{"href":"/reference/model-center"},{"href":"/reference/model-center/image-gen/image-one"},{"href":"/reference/model-center/image-gen/image-two"},{"href":"/reference/model-center/video-gen/video-one"},{"href":"/reference/model-center/video-gen/video-two"},{"href":"https://other.test/reference/model-center"}])</script></body></html>`;
        const hub = `<article><h1>模型中心</h1><p>GET https://api.provider.test/platform/v2/models</p><pre>curl --url https://api.provider.test/platform/v2/tasks --header 'Authorization: Bearer token' --data '{"model":"image-standard","prompt":"test","reference_images":[],"aspect_ratio":"1:1","resolution":"high"}'</pre><pre>{"task_id":"image-task","status":"success","result_url":"https://cdn.test/image.png"}</pre><pre>curl --url https://api.provider.test/platform/v2/tasks --header 'Authorization: Bearer token' --data '{"model":"video-standard","prompt":"test","reference_images":[],"reference_videos":[],"reference_audios":[],"duration":5}'</pre><pre>{"task_id":"video-task","status":"success","video_url":"https://cdn.test/video.mp4"}</pre></article>`;
        mocks.fetchSafeOutbound.mockImplementation(async (url: string) => {
            if (url === rootUrl) return new Response(root, { headers: { "content-type": "text/html; charset=utf-8" } });
            if (url === hubUrl) return new Response(hub, { headers: { "content-type": "text/html; charset=utf-8" } });
            return new Response("not found", { status: 404 });
        });

        const links = selectProtocolDocumentLinks(extractProtocolHtmlDocument(root, rootUrl).links, rootUrl);
        expect(links.map((link) => link.url)).toEqual([hubUrl, imageLeafUrl, videoLeafUrl]);

        const result = await createChannelProtocolDraft({ requestUrl: "http://localhost/api/admin/channel-protocol-draft", cookie: "", userId: "admin", documentationUrl: rootUrl, useTextModel: false });

        expect(mocks.fetchSafeOutbound.mock.calls.map(([url]) => url)).toEqual([rootUrl, hubUrl, imageLeafUrl, videoLeafUrl]);
        expect(result.sourcePages).toBe(2);
        expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining("image-one"), expect.stringContaining("video-one")]));
        expect(result.drafts).toHaveLength(1);
        expect(result.drafts[0].baseUrl).toBe("https://api.provider.test");
        expect(result.drafts[0].modelCatalogPaths).toContain("/platform/v2/models");
        expect(result.drafts[0].operations.map((operation) => operation.capability)).toEqual(["image", "video"]);
    });

    it("reads a directly entered documentation page without relying on a site-specific path", async () => {
        const documentationUrl = "https://developer.provider.test/manual/custom-protocol";
        const page = `<article><pre>curl --url https://api.provider.test/v1/images/generations --header 'Authorization: Bearer token' --data '{"model":"image-v1","prompt":"test","size":"1024x1024"}'</pre><pre>{"data":[{"url":"https://cdn.test/image.png"}]}</pre></article>`;
        mocks.fetchSafeOutbound.mockResolvedValue(new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } }));

        const result = await createChannelProtocolDraft({ requestUrl: "http://localhost/api/admin/channel-protocol-draft", cookie: "", userId: "admin", documentationUrl, useTextModel: false });

        expect(result.sourcePages).toBe(1);
        expect(result.warnings).toEqual([]);
        expect(result.drafts).toHaveLength(1);
        expect(result.drafts[0].baseUrl).toBe("https://api.provider.test/v1");
        expect(result.drafts[0].operations[0].capability).toBe("image");
    });
});
