# Aliyun OSS S3 Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make connection checks, image previews, downloads, and object deletion work against Aliyun OSS without regressing other S3-compatible providers.

**Architecture:** Keep the existing AWS SDK S3 client and batch APIs. Add the protocol-required MD5 header to the exact serialized multi-delete body, and let stored object metadata provide `Content-Type` instead of signing an unsupported response-header override.

**Tech Stack:** TypeScript, AWS SDK v3 S3 client and presigner, Vitest, Next.js, Docker Compose.

## Global Constraints

- Do not add provider-name or Endpoint-specific branches.
- Do not add dependencies or change database, object-key, credential, or deployment schemas.
- Preserve `ResponseContentDisposition` behavior and existing batch deletion.
- Live probes must use random keys under `vozeb-pro/media/.codex-oss-probe/` and clean them in `finally`.
- Deploy only with `/home/VOZEB-PRO/docker-compose.external-db.yml`, preserving its existing local modifications.

---

### Task 1: Add `Content-MD5` to Batch Delete Requests

**Files:**
- Modify: `web/src/lib/server/object-storage-client.test.ts`
- Modify: `web/src/lib/server/object-storage-client.ts`

**Interfaces:**
- Consumes: AWS SDK `DeleteObjectsCommand` serialization and Node `createHash("md5")`.
- Produces: the existing `deleteObjects(config, keys): Promise<void>` behavior with a valid `Content-MD5` header on every batch.

- [ ] **Step 1: Write the failing regression assertion**

Import `createHash` in the test and add this assertion after the existing delete-body check:

```ts
expect(requests[2]?.headers["content-md5"]).toBe(createHash("md5").update(requests[2]!.body).digest("base64"));
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm -C web test src/lib/server/object-storage-client.test.ts`

Expected: the connection-check test fails because `content-md5` is `undefined`.

- [ ] **Step 3: Add command-local MD5 middleware**

Import `createHash` beside `randomUUID`. In `deleteObjectBatch`, construct the command first, attach build middleware, and then send it:

```ts
const command = new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } });
command.middlewareStack.add(
    (next) => async (args) => {
        const request = args.request as { body?: string | Uint8Array; headers: Record<string, string> };
        const body = typeof request.body === "string" ? Buffer.from(request.body) : Buffer.from(request.body || []);
        request.headers["content-md5"] = createHash("md5").update(body).digest("base64");
        return next(args);
    },
    { step: "build", name: "deleteObjectsContentMd5", priority: "high" },
);
const result = await client.send(command);
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm -C web test src/lib/server/object-storage-client.test.ts`

Expected: all tests in the file pass and the fixture observes the correct base64 MD5 of the serialized XML body.

### Task 2: Remove the Unsupported Signed Content-Type Override

**Files:**
- Modify: `web/src/lib/server/object-storage-client.test.ts`
- Modify: `web/src/lib/server/object-storage-client.ts`

**Interfaces:**
- Consumes: `signObjectRead(config, { key, contentType?, contentDisposition?, expiresIn? })`.
- Produces: signed `GetObject` URLs without `response-content-type`, while preserving `response-content-disposition`.

- [ ] **Step 1: Write the failing signed-URL regression test**

Import `signObjectRead` and add:

```ts
it("uses stored object content type without signing a response override", async () => {
    const url = new URL(
        await signObjectRead({ ...config, endpoint: "http://127.0.0.1:9000" }, { key: "vozeb-pro/media/image.png", contentType: "image/png", contentDisposition: 'inline; filename="image.png"' }),
    );
    expect(url.searchParams.has("response-content-type")).toBe(false);
    expect(url.searchParams.get("response-content-disposition")).toBe('inline; filename="image.png"');
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm -C web test src/lib/server/object-storage-client.test.ts`

Expected: the new assertion fails because the URL contains `response-content-type=image/png`.

- [ ] **Step 3: Stop setting `ResponseContentType`**

Change the `GetObjectCommand` in `signObjectRead` to:

```ts
new GetObjectCommand({ Bucket: config.bucket, Key: input.key, ResponseContentDisposition: input.contentDisposition })
```

Keep the current input shape so service call sites remain stable and the scope stays limited.

- [ ] **Step 4: Run object-storage tests and verify GREEN**

Run: `pnpm -C web test src/lib/server/object-storage-client.test.ts src/lib/server/object-storage-service.test.ts src/app/api/admin/object-storage/files/preview/route.test.ts src/app/api/admin/object-storage/files/route.test.ts`

Expected: all selected tests pass.

### Task 3: Record the User-Visible Fix

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/content/docs/progress/pending-test.mdx`

**Interfaces:**
- Consumes: verified behavior from Tasks 1 and 2.
- Produces: an `Unreleased` summary and a concrete real-environment verification entry.

- [ ] **Step 1: Update release records**

Add this line under `CHANGELOG.md` `Unreleased`:

```md
- [存储] 修复阿里云 OSS 批量删除缺少 Content-MD5，以及签名读取覆盖 Content-Type 导致的连接检查、缩略图、下载和删除失败。
```

Add a leading pending-test item describing the Aliyun OSS regression, focused tests, live probe, and deployed-site checks actually completed. Do not claim checks before they run; update the item with final counts after verification.

- [ ] **Step 2: Check formatting and text integrity**

Run: `pnpm -C web format:check ../CHANGELOG.md ../docs/content/docs/progress/pending-test.mdx src/lib/server/object-storage-client.ts src/lib/server/object-storage-client.test.ts`

Expected: Prettier exits 0. Strictly decode modified text files as UTF-8 and assert they contain no `U+FFFD` or known mojibake sequences.

### Task 4: Verify, Publish, and Deploy

**Files:**
- Verify all modified files.
- Preserve: `/home/VOZEB-PRO/docker-compose.external-db.yml` and its local modifications.

**Interfaces:**
- Consumes: the completed implementation branch.
- Produces: a pushed fork branch, an upstream draft PR, and a verified external-db deployment.

- [ ] **Step 1: Run automated quality gates**

Run from the repository root:

```bash
pnpm -C web test src/lib/server/object-storage-client.test.ts src/lib/server/object-storage-service.test.ts src/app/api/admin/object-storage/files/preview/route.test.ts src/app/api/admin/object-storage/files/route.test.ts
pnpm -C web typecheck
pnpm -C web lint
pnpm -C web format:check
pnpm -C web build
```

Expected: every command exits 0.

- [ ] **Step 2: Run the isolated live OSS probe**

Use the configured Endpoint, Region, Bucket, and credentials to upload random small objects under `.codex-oss-probe`, verify a signed read with disposition but no content-type override returns 200, verify `DeleteObjects` carries MD5 and succeeds, then confirm the keys no longer exist. Cleanup runs in `finally`.

Expected: put, signed read, batch delete, and cleanup all pass.

- [ ] **Step 3: Commit and publish the scoped diff**

Inspect `git status -sb`, `git diff --check`, and the full branch diff. Commit only the client, test, changelog, pending-test, design, and plan files. Push `codex/fix-aliyun-oss-compatibility` to `ZpitQ/VOZEB-PRO`, then create a draft PR targeting `csyqlz/VOZEB-PRO:main` with the repository PR template.

- [ ] **Step 4: Align the server worktree without touching runtime configuration**

Fetch the pushed branch in `/home/github/VOZEB-PRO` and switch to it only after confirming the worktree is clean. In `/home/VOZEB-PRO`, record the current commit and `git diff -- docker-compose.external-db.yml`; do not reset or overwrite its modified Compose files.

- [ ] **Step 5: Build and restart the external-db services**

Build from `/home/github/VOZEB-PRO` using the repository Dockerfile and tag the resulting image locally. Update only the image reference used by the running external-db Compose invocation, or build through an explicit Compose override that leaves `/home/VOZEB-PRO/docker-compose.external-db.yml` unchanged. Recreate `vozeb-pro` and `vozeb-pro-generation-worker`, then wait for their configured health checks rather than using a fixed delay.

- [ ] **Step 6: Verify the deployed symptom paths**

Using the authenticated admin site/API, verify:

```text
connection check -> code 0 and available true
image preview route -> 307 then OSS 200 image/webp
image download -> OSS 200 with original media type
unreferenced probe delete -> code 0 and object absent
app and worker containers -> healthy with no new object-storage errors
```

If any deployment verification fails, restore the previously recorded image/commit through the same external-db Compose file and report the exact failing check.
