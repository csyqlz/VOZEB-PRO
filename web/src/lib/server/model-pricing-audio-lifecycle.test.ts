import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyDb } from "@/lib/auth/store-normalizers";
import * as auth from "@/lib/auth/store-repository";
import * as data from "./data-adapter";
import { cleanupAudioPriceMedia } from "./model-pricing-audio-lifecycle";
import { prepareAudioPriceResponse } from "./model-pricing-audio-response";
import { insertAudioPriceResponseReceipt, insertAudioPriceReview, readAudioPriceResponseReceipt, readAudioPriceReview } from "./model-pricing-audio-response-store";
import type { PricingWalletReservation } from "./model-pricing-wallet-service";

describe("file audio private-media lifecycle", () => {
    let directory: string;
    const receipt = (userId = "owner", requestId = "request") =>
        prepareAudioPriceResponse(
            { userId, requestId, requestFingerprint: "original-request", claimId: "original-claim" },
            { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: Buffer.from("private fixture audio").toString("base64") } }] } }] },
            new Date().toISOString(),
        );
    const reservation = (requestId: string) => ({ userId: "owner", requestId, status: "settled", preparation: { taskId: requestId, taskType: "audio", claimId: "preparation" } }) as PricingWalletReservation;
    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "audio-lifecycle-"));
        vi.stubEnv("VOZEB_PRO_DATABASE_PROVIDER", "file");
        vi.stubEnv("VOZEB_PRO_DATA_DIR", directory);
        vi.stubEnv("VOZEB_PRO_ENCRYPTION_KEY", "a".repeat(64));
        const db = emptyDb();
        const now = new Date().toISOString();
        db.users.push({
            id: "owner",
            accountId: "0001",
            planId: db.settings.entitlements.defaultPlanId,
            username: "fixture",
            displayName: "fixture",
            bio: "",
            role: "user",
            status: "active",
            adminPermissions: [],
            pointsBalance: 0.17,
            passwordHash: "fixture",
            createdAt: now,
            updatedAt: now,
        });
        await auth.writeAuthDb(db);
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });

    it("uses the configured batch and leaves unrelated or present-task media intact", async () => {
        await auth.mutateAuthDb((db) => {
            db.pricingReservations = ["a", "b", "present"].map(reservation);
        });
        for (const request of ["a", "b", "present", "unassociated"]) await insertAudioPriceResponseReceipt(receipt("owner", request));
        await data.writeJsonDataFile("generation-tasks.json", [{ id: "present", expiresAt: 0 }]);
        expect(await cleanupAudioPriceMedia(1)).toMatchObject({ checked: 1, archived: 1 });
        expect((await readAudioPriceResponseReceipt("owner", "a"))?.audio[0].data).toBe("");
        expect((await readAudioPriceResponseReceipt("owner", "b"))?.mediaPurgedAt).toBeUndefined();
        expect(await cleanupAudioPriceMedia(1)).toMatchObject({ checked: 1, archived: 1 });
        expect(await cleanupAudioPriceMedia(1)).toMatchObject({ checked: 0, archived: 0 });
        for (const request of ["present", "unassociated"]) expect((await readAudioPriceResponseReceipt("owner", request))?.audio[0].data).toBe(receipt().audio[0].data);
    });
    it("does not grant eligible daily points or touch financial state during maintenance", async () => {
        await auth.mutateAuthDb((db) => {
            db.settings.freeDailyPointsEnabled = true;
            db.settings.freeDailyPoints = 12.34;
            db.pricingReservations.push(reservation("request"));
        });
        await insertAudioPriceResponseReceipt(receipt());
        const before = await auth.readAuthDb();
        expect(await cleanupAudioPriceMedia(1)).toMatchObject({ archived: 1 });
        const after = await auth.readAuthDb();
        expect(after.users).toEqual(before.users);
        expect(after.dailyPlanPointWallets).toEqual(before.dailyPlanPointWallets);
        expect(after.pointRecords).toEqual(before.pointRecords);
        expect(after.quotaUsage).toEqual(before.quotaUsage);
        expect(after.pricingAccruals).toEqual(before.pricingAccruals);
        expect(after.pricingRefunds).toEqual(before.pricingRefunds);
    });
    it("rechecks physical task presence after candidate selection", async () => {
        await auth.mutateAuthDb((db) => {
            db.pricingReservations.push(reservation("request"));
        });
        await insertAudioPriceResponseReceipt(receipt());
        const mutate = auth.mutateAuthDb;
        vi.spyOn(auth, "mutateAuthDb").mockImplementationOnce(async (callback) => {
            await data.writeJsonDataFile("generation-tasks.json", [{ id: "request" }]);
            return mutate(callback);
        });
        expect(await cleanupAudioPriceMedia(1)).toMatchObject({ checked: 1, archived: 0 });
        expect((await readAudioPriceResponseReceipt("owner", "request"))?.mediaPurgedAt).toBeUndefined();
    });
    it("rechecks reservation status under the lock", async () => {
        await auth.mutateAuthDb((db) => {
            db.pricingReservations.push(reservation("request"));
        });
        await insertAudioPriceResponseReceipt(receipt());
        const mutate = auth.mutateAuthDb;
        vi.spyOn(auth, "mutateAuthDb").mockImplementationOnce((callback) =>
            mutate(async (db) => {
                db.pricingReservations[0].status = "reserved";
                return callback(db);
            }),
        );
        expect(await cleanupAudioPriceMedia(1)).toMatchObject({ checked: 1, archived: 0 });
        expect((await readAudioPriceResponseReceipt("owner", "request"))?.mediaPurgedAt).toBeUndefined();
    });
    it("resumes after review media deletion fails without recreating cleared original bytes", async () => {
        const original = receipt();
        await auth.mutateAuthDb((db) => {
            db.pricingReservations.push(reservation("request"));
        });
        await insertAudioPriceResponseReceipt(original);
        const review = {
            userId: original.userId,
            requestId: original.requestId,
            requestFingerprint: original.requestFingerprint,
            taskId: "request",
            attemptNo: 1,
            response: original,
            decision: { id: "review", claimId: original.claimId, reviewedBy: "admin", reviewedAt: original.observedAt, evidence: "fixture", outcome: { kind: "not_charged" as const } },
        };
        await insertAudioPriceReview(review);
        const write = data.writeJsonDataFile;
        const fail = vi.spyOn(data, "writeJsonDataFile").mockImplementation(async (name, value) => {
            if (name.startsWith("pricing-audio-reviews/")) throw new Error("fixture review cleanup interruption");
            return write(name, value);
        });
        expect(await cleanupAudioPriceMedia(1)).toMatchObject({ archived: 0, failed: 1 });
        const cleared = await readAudioPriceResponseReceipt("owner", "request");
        expect(cleared?.audio[0].data).toBe("");
        expect((await readAudioPriceReview("owner", "request"))?.response).toEqual(original);
        fail.mockRestore();
        expect(await cleanupAudioPriceMedia(1)).toMatchObject({ archived: 1, failed: 0 });
        expect(await readAudioPriceResponseReceipt("owner", "request")).toEqual(cleared);
        expect((await readAudioPriceReview("owner", "request"))?.response?.audio[0].data).toBe("");
    });
    it("bounds removed-account file deletion and never reads orphan audio bodies", async () => {
        await insertAudioPriceResponseReceipt(receipt());
        await insertAudioPriceResponseReceipt(receipt("deleted", "one"));
        await insertAudioPriceResponseReceipt(receipt("deleted", "two"));
        const read = data.readJsonDataFile;
        vi.spyOn(data, "readJsonDataFile").mockImplementation((name, fallback) => {
            if (name.startsWith("pricing-audio-")) throw new Error("orphan audio must not be read");
            return read(name, fallback);
        });
        expect(await cleanupAudioPriceMedia(1)).toEqual({ checked: 0, archived: 0, failed: 0, orphanFilesDeleted: 1 });
        expect(await cleanupAudioPriceMedia(1)).toMatchObject({ orphanFilesDeleted: 1 });
        expect(await cleanupAudioPriceMedia(1)).toMatchObject({ orphanFilesDeleted: 0 });
        vi.mocked(data.readJsonDataFile).mockRestore();
        expect(await readAudioPriceResponseReceipt("deleted", "one")).toBeUndefined();
        expect(await readAudioPriceResponseReceipt("deleted", "two")).toBeUndefined();
        expect((await readAudioPriceResponseReceipt("owner", "request"))?.audio[0].data).toBe(receipt().audio[0].data);
    });
    it.each([0, -1, 0.17, NaN])("rejects invalid maintenance batch %s before mutation", async (limit) => {
        await expect(cleanupAudioPriceMedia(limit)).rejects.toThrow("正整数");
    });
});
