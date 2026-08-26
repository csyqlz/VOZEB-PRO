import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import type { ObjectStorageRuntimeConfig } from "@/lib/server/object-storage-config";
import { objectStorageErrorMessage, testObjectStorageConnection } from "./object-storage-client";

const config: ObjectStorageRuntimeConfig = {
    id: "default",
    enabled: true,
    endpoint: "",
    region: "auto",
    bucket: "media",
    prefix: "vozeb-pro",
    accessKeyId: "access",
    secretAccessKey: "secret",
    forcePathStyle: true,
};

const servers: Array<ReturnType<typeof createServer>> = [];

describe("object storage client", () => {
    afterEach(async () => {
        await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    });

    it("checks list, write and delete capabilities without leaving the probe object", async () => {
        const requests: Array<{ method: string; url: string; headers: IncomingMessage["headers"]; body: string }> = [];
        const server = createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on("data", (chunk: Buffer) => chunks.push(chunk));
            request.on("end", () => {
                requests.push({ method: request.method || "", url: request.url || "", headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
                respondToS3Probe(request, response);
            });
        });
        servers.push(server);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("测试服务器没有可用端口");

        await testObjectStorageConnection({ ...config, endpoint: `http://127.0.0.1:${address.port}` });

        expect(requests.map((request) => request.method)).toEqual(["GET", "PUT", "POST"]);
        expect(requests[1]?.url).toMatch(/^\/media\/vozeb-pro\/media\/\.vozeb-healthcheck\/[0-9a-f-]+\.txt\?x-id=PutObject$/);
        expect(requests[1]?.body).toBe("vozeb-pro-storage-check");
        expect(requests[1]?.headers["x-amz-sdk-checksum-algorithm"]).toBeUndefined();
        expect(requests[2]?.url).toBe("/media/?delete=");
        expect(requests[2]?.body).toContain("<Key>vozeb-pro/media/.vozeb-healthcheck/");
    });

    it("turns provider failures into actionable messages without exposing signed query values", () => {
        expect(objectStorageErrorMessage({ name: "AccessDenied", message: "Access denied", $metadata: { httpStatusCode: 403 } })).toContain("列表、读取、写入和删除权限");
        expect(objectStorageErrorMessage({ code: "SignatureDoesNotMatch", message: "request failed at https://example.com/file?X-Amz-Signature=secret" })).toContain("Access Key、Secret Key、Region、Endpoint");
        expect(objectStorageErrorMessage({ code: "InvalidRequest", message: "request failed at https://example.com/file?X-Amz-Signature=secret" })).toBe("InvalidRequest：request failed at https://example.com/file");
    });
});

function respondToS3Probe(request: IncomingMessage, response: ServerResponse) {
    if (request.method === "GET") {
        response.writeHead(200, { "Content-Type": "application/xml" });
        response.end('<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>media</Name><Prefix>vozeb-pro/</Prefix><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>');
        return;
    }
    if (request.method === "POST") {
        response.writeHead(200, { "Content-Type": "application/xml" });
        response.end('<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>');
        return;
    }
    response.writeHead(200, { "Content-Type": "application/xml" });
    response.end("<PutObjectResult/>");
}
