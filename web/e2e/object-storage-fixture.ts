import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { encodeXML } from "entities";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";

export async function objectStorageFixture() {
    const certificateDirectory = await mkdtemp(path.join(tmpdir(), "vozeb-cdn-e2e-"));
    const keyPath = path.join(certificateDirectory, "key.pem");
    const certificatePath = path.join(certificateDirectory, "certificate.pem");
    await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certificatePath, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"]);
    const objects = new Map<string, { bytes: Buffer; contentType: string }>();
    const requests: Array<{ method: string; path: string }> = [];
    const handleRequest: RequestListener = async (request, response) => {
        const url = new URL(request.url || "/", "http://127.0.0.1");
        requests.push({ method: request.method || "GET", path: url.pathname });
        const cdn = /^\/cdn-[ab]\//.test(url.pathname);
        const key = decodeURIComponent(url.pathname.replace(cdn ? /^\/cdn-[ab]\// : /^\/s3\/e2e-media\/?/, ""));
        if (!cdn && !String(request.headers.authorization || url.searchParams.get("X-Amz-Credential") || "").includes("e2e-oss-access")) {
            response.writeHead(403).end();
            return;
        }
        if (request.method === "PUT") {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            objects.set(key, { bytes: Buffer.concat(chunks), contentType: String(request.headers["content-type"] || "application/octet-stream") });
            response.writeHead(200, { ETag: '"e2e-object"' }).end();
            return;
        }
        if (url.searchParams.has("list-type")) {
            const entries = [...objects].filter(([objectKey]) => objectKey.startsWith(url.searchParams.get("prefix") || ""));
            const contents = entries.map(([objectKey, object]) => `<Contents><Key>${encodeXML(objectKey)}</Key><Size>${object.bytes.length}</Size><LastModified>2026-09-08T00:00:00.000Z</LastModified></Contents>`).join("");
            response.writeHead(200, { "Content-Type": "application/xml" }).end(`<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);
            return;
        }
        if (request.method === "POST" && url.searchParams.has("delete")) {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const visit = (node: DefaultTreeAdapterMap["node"]) => {
                if ("tagName" in node && node.tagName === "key") objects.delete(node.childNodes.map((child) => ("value" in child ? child.value : "")).join(""));
                if ("childNodes" in node) node.childNodes.forEach(visit);
            };
            visit(parseFragment(Buffer.concat(chunks).toString("utf8")));
            response.writeHead(200, { "Content-Type": "application/xml" }).end("<DeleteResult />");
            return;
        }
        const object = objects.get(key);
        if (!object) {
            response.writeHead(404).end();
            return;
        }
        response.writeHead(200, { "Content-Type": object.contentType, "Content-Length": object.bytes.length, "Cache-Control": "no-store" });
        response.end(request.method === "HEAD" ? undefined : object.bytes);
    };
    const server = createServer(handleRequest);
    const cdnServer = createHttpsServer({ key: await readFile(keyPath), cert: await readFile(certificatePath) }, handleRequest);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cdnServer.listen(0, "127.0.0.1");
    await once(cdnServer, "listening");
    const address = server.address();
    const cdnAddress = cdnServer.address();
    if (!address || typeof address === "string" || !cdnAddress || typeof cdnAddress === "string") throw new Error("Object storage fixture did not bind TCP ports");
    return {
        origin: `http://127.0.0.1:${address.port}`,
        cdnOrigin: `https://127.0.0.1:${cdnAddress.port}`,
        objects,
        requests,
        close: async () => {
            await Promise.all([server, cdnServer].map((listener) => new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())))));
            await rm(certificateDirectory, { recursive: true });
        },
    };
}
