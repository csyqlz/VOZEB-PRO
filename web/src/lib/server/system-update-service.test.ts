import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSystemUpdateInfo, requestSystemUpdate } from "./system-update-service";

const confirmations = { databaseBackup: true, environmentReviewed: true, changelogReviewed: true, rollbackReviewed: true };

describe("system update service", () => {
    beforeEach(() => {
        vi.unstubAllEnvs();
        vi.stubGlobal("fetch", vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    it("reads the latest stable GitHub Release without enabling mutation by default", async () => {
        vi.mocked(fetch).mockResolvedValue(
            response({ tag_name: "v0.0.9", name: "VOZEB PRO v0.0.9", body: "更新说明", published_at: "2026-08-27T00:00:00.000Z", html_url: "https://github.com/csyqlz/VOZEB-PRO/releases/tag/v0.0.9", draft: false, prerelease: false }),
        );
        const info = await getSystemUpdateInfo();
        expect(info).toMatchObject({ currentVersion: "v0.0.8", latestVersion: "v0.0.9", hasUpdate: true, releaseCheck: { status: "succeeded" }, onlineUpgrade: { supported: false, operation: { status: "idle" } } });
    });

    it("does not describe an older GitHub Release as the latest running version", async () => {
        vi.mocked(fetch).mockResolvedValue(
            response({ tag_name: "v0.0.7", name: "VOZEB PRO v0.0.7", body: "", published_at: "2026-08-22T00:00:00.000Z", html_url: "https://github.com/csyqlz/VOZEB-PRO/releases/tag/v0.0.7", draft: false, prerelease: false }),
        );
        const info = await getSystemUpdateInfo();
        expect(info).toMatchObject({ currentVersion: "v0.0.8", latestVersion: "v0.0.8", hasUpdate: false, release: { version: "v0.0.7" } });
    });

    it("starts only the exact latest stable release through a configured supervisor", async () => {
        vi.stubEnv("VOZEB_PRO_UPDATER_URL", "http://updater:8787");
        vi.stubEnv("VOZEB_PRO_UPDATER_TOKEN", "0123456789abcdef0123456789abcdef");
        vi.mocked(fetch).mockImplementation(async (url, init) => {
            if (String(url).includes("api.github.com"))
                return response({ tag_name: "v0.0.9", name: "VOZEB PRO v0.0.9", body: "", published_at: "2026-08-27T00:00:00.000Z", html_url: "https://github.com/csyqlz/VOZEB-PRO/releases/tag/v0.0.9", draft: false, prerelease: false });
            expect(init?.headers).toMatchObject({ Authorization: "Bearer 0123456789abcdef0123456789abcdef" });
            return response({ id: "request-one", action: "upgrade", status: "preparing", currentVersion: "v0.0.8", targetVersion: "v0.0.9", pollAfterMs: 2000 }, 202);
        });

        await expect(requestSystemUpdate({ action: "upgrade", targetVersion: "v0.0.9", idempotencyKey: "request-one", confirmations })).resolves.toMatchObject({ status: "preparing", targetVersion: "v0.0.9" });
    });

    it("keeps supervisor progress observable without repeatedly querying GitHub", async () => {
        vi.stubEnv("VOZEB_PRO_UPDATER_URL", "http://updater:8787");
        vi.stubEnv("VOZEB_PRO_UPDATER_TOKEN", "0123456789abcdef0123456789abcdef");
        vi.mocked(fetch).mockImplementation(async (url) => {
            return response({ id: "request-running", action: "upgrade", status: "health_check", currentVersion: "v0.0.8", targetVersion: "v0.0.9", pollAfterMs: 2000 });
        });

        await expect(getSystemUpdateInfo()).resolves.toMatchObject({
            currentVersion: "v0.0.8",
            latestVersion: "v0.0.9",
            hasUpdate: true,
            releaseCheck: { status: "deferred" },
            onlineUpgrade: { supported: true, operation: { id: "request-running", status: "health_check" } },
        });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("does not expose supervisor filesystem paths or credential-bearing errors", async () => {
        vi.stubEnv("VOZEB_PRO_UPDATER_URL", "http://updater:8787");
        vi.stubEnv("VOZEB_PRO_UPDATER_TOKEN", "0123456789abcdef0123456789abcdef");
        vi.mocked(fetch).mockImplementation(async (url) => {
            if (String(url).includes("api.github.com"))
                return response({ tag_name: "v0.0.8", name: "VOZEB PRO v0.0.8", body: "", published_at: "2026-08-27T00:00:00.000Z", html_url: "https://github.com/csyqlz/VOZEB-PRO/releases/tag/v0.0.8", draft: false, prerelease: false });
            return response({ status: "failed", backupPath: "/app/web/.data/disaster-recovery/private", error: "postgres://admin:secret@database/vozeb", imageDigest: "not-a-digest" });
        });

        const info = await getSystemUpdateInfo();
        expect(info.onlineUpgrade.operation).toEqual({ status: "failed", error: "升级执行失败，请查看服务器升级器日志" });
        expect(JSON.stringify(info)).not.toContain("/app/web/.data");
        expect(JSON.stringify(info)).not.toContain("postgres://");
        expect(JSON.stringify(info)).not.toContain("not-a-digest");
    });

    it("disables online updates when the updater token reuses another system credential", async () => {
        const shared = "0123456789abcdef0123456789abcdef";
        vi.stubEnv("VOZEB_PRO_UPDATER_URL", "http://updater:8787");
        vi.stubEnv("VOZEB_PRO_UPDATER_TOKEN", shared);
        vi.stubEnv("VOZEB_PRO_WORKER_TOKEN", shared);
        vi.mocked(fetch).mockResolvedValue(
            response({ tag_name: "v0.0.8", name: "VOZEB PRO v0.0.8", body: "", published_at: "2026-08-27T00:00:00.000Z", html_url: "https://github.com/csyqlz/VOZEB-PRO/releases/tag/v0.0.8", draft: false, prerelease: false }),
        );

        await expect(getSystemUpdateInfo()).resolves.toMatchObject({ onlineUpgrade: { supported: false } });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("does not allow the browser to select an arbitrary release", async () => {
        vi.stubEnv("VOZEB_PRO_UPDATER_URL", "http://updater:8787");
        vi.stubEnv("VOZEB_PRO_UPDATER_TOKEN", "0123456789abcdef0123456789abcdef");
        vi.mocked(fetch).mockResolvedValue(
            response({ tag_name: "v0.0.9", name: "VOZEB PRO v0.0.9", body: "", published_at: "2026-08-27T00:00:00.000Z", html_url: "https://github.com/csyqlz/VOZEB-PRO/releases/tag/v0.0.9", draft: false, prerelease: false }),
        );
        await expect(requestSystemUpdate({ action: "upgrade", targetVersion: "v9.9.9", idempotencyKey: "request-two", confirmations })).rejects.toMatchObject({ status: 409 });
    });

    it("requires the named commercial upgrade confirmations", async () => {
        vi.stubEnv("VOZEB_PRO_UPDATER_URL", "http://updater:8787");
        vi.stubEnv("VOZEB_PRO_UPDATER_TOKEN", "0123456789abcdef0123456789abcdef");
        await expect(
            requestSystemUpdate({
                action: "upgrade",
                targetVersion: "v0.0.9",
                idempotencyKey: "request-three",
                confirmations: { one: true, two: true, three: true, four: true } as never,
            }),
        ).rejects.toMatchObject({ status: 400 });
        expect(fetch).not.toHaveBeenCalled();
    });

    it("does not expose a failed same-version operation as a rollback", async () => {
        vi.stubEnv("VOZEB_PRO_UPDATER_URL", "http://updater:8787");
        vi.stubEnv("VOZEB_PRO_UPDATER_TOKEN", "0123456789abcdef0123456789abcdef");
        vi.mocked(fetch).mockResolvedValue(response({ status: "failed", currentVersion: "v0.0.8", targetVersion: "v0.0.9", previousVersion: "v0.0.8" }));
        await expect(requestSystemUpdate({ action: "rollback", targetVersion: "v0.0.8", idempotencyKey: "request-four", confirmations })).rejects.toMatchObject({ status: 409 });
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});

function response(value: unknown, status = 200) {
    return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}
