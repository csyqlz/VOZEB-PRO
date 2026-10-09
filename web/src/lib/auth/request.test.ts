import { describe, expect, it } from "vitest";

import { readJsonBody, readJsonBodyResult, readJsonObjectBody } from "./request";

describe("readJsonBody", () => {
    it("parses JSON within the default limit", async () => {
        await expect(readJsonBody<{ value: string }>(new Request("http://localhost", { method: "POST", body: JSON.stringify({ value: "ok" }) }))).resolves.toEqual({ value: "ok" });
    });

    it("preserves the previous empty-body behavior", async () => {
        await expect(readJsonBody(new Request("http://localhost", { method: "POST" }))).resolves.toEqual({});
    });

    it("maps malformed JSON to a 400 input error", async () => {
        await expect(readJsonBody(new Request("http://localhost", { method: "POST", body: "{" }))).rejects.toMatchObject({ status: 400, message: "请求内容不是有效 JSON" });
    });

    it("maps an oversized default JSON body to 413", async () => {
        const request = new Request("http://localhost", { method: "POST", headers: { "content-length": String(4 * 1024 * 1024 + 1) }, body: "{}" });
        await expect(readJsonBody(request)).rejects.toMatchObject({ status: 413, message: "请求体过大" });
    });

    it("returns structured input errors for route-specific response envelopes", async () => {
        await expect(readJsonBodyResult(new Request("http://localhost", { method: "POST", body: "{" }))).resolves.toEqual({ ok: false, status: 400, message: "请求内容不是有效 JSON" });
    });

    it("rejects JSON scalars and arrays when an endpoint requires an object", async () => {
        await expect(readJsonObjectBody(new Request("http://localhost", { method: "POST", body: "null" }))).rejects.toMatchObject({ status: 400, message: "请求内容必须是 JSON 对象" });
        await expect(readJsonObjectBody(new Request("http://localhost", { method: "POST", body: "[]" }))).rejects.toMatchObject({ status: 400, message: "请求内容必须是 JSON 对象" });
    });
});
