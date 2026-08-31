# Aliyun OSS S3 Compatibility Fix

## Problem

The S3-compatible object storage integration can list and upload objects to Aliyun OSS, but connection checks and media deletion fail. Image thumbnails and image downloads also fail after the application redirects the browser to a signed object URL.

Live probes against the configured bucket confirmed two independent protocol compatibility issues:

- `DeleteObjects` requests do not include the `Content-MD5` header required by Aliyun OSS, which returns `MissingArgument` with `ArgumentName: Content-MD5`.
- Signed `GetObject` URLs include `response-content-type`. Aliyun OSS rejects that response-header override with `InvalidRequest: Can not override response header on content-type`.

## Design

Keep the existing S3 client and batch deletion behavior.

For each `DeleteObjectsCommand`, attach a command-local build middleware. The middleware hashes the serialized XML request body with MD5 and sets the base64 digest as `Content-MD5` before signing and sending the request. This remains valid for S3-compatible providers and preserves the current request batching.

For signed reads, stop setting `ResponseContentType` on `GetObjectCommand`. Uploaded media and generated WebP previews already persist the correct object `Content-Type`, so browsers can rely on the stored metadata. Continue setting `ResponseContentDisposition` so inline display and downloads retain their existing filename behavior.

No provider-name or Endpoint-specific branch will be added.

## Error Handling

Existing operation-level error mapping remains unchanged. Delete responses will continue to surface per-object errors returned by the provider. The connection check will still verify list, write, and delete capabilities, and its cleanup path will use the corrected batch deletion request.

## Tests

Add regression assertions that fail on the current implementation:

- The serialized batch-delete request carries a valid `Content-MD5` matching its exact XML body.
- Signed read URLs omit `response-content-type` while retaining `response-content-disposition`.
- Existing list, upload, preview, migration, and deletion tests remain green.

After automated tests, run a live isolated OSS probe under `vozeb-pro/media/.codex-oss-probe/`, verify signed reads and batch deletion, and clean all probe objects. Build the production image, deploy with `/home/VOZEB-PRO/docker-compose.external-db.yml`, then verify the connection check, an image thumbnail, an image download, and deletion behavior against the running site.

## Scope

The change is limited to the object storage client, its regression tests, and the repository's required pending-test and changelog records. It does not alter stored media registrations, object keys, database schema, credentials, or deployment configuration.
