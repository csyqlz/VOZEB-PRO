import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    cleanupExpiredAuthRecords: vi.fn(),
    cleanupExpiredStoredGenerationTasks: vi.fn(),
    cleanupExpiredLocalMediaAssets: vi.fn(),
    getAuthSettings: vi.fn(),
    reconcileRefunds: vi.fn(),
    cleanupAudio: vi.fn(),
}));

vi.mock("@/lib/auth/store", () => ({ cleanupExpiredAuthRecords: mocks.cleanupExpiredAuthRecords, getAuthSettings: mocks.getAuthSettings }));
vi.mock("@/lib/server/generation-task-store", () => ({ cleanupExpiredStoredGenerationTasks: mocks.cleanupExpiredStoredGenerationTasks }));
vi.mock("@/lib/server/local-media-storage", () => ({ cleanupExpiredLocalMediaAssets: mocks.cleanupExpiredLocalMediaAssets }));

vi.mock("./model-pricing-shadow-refund", () => ({ reconcileMediaShadowRefundBatch: mocks.reconcileRefunds }));

vi.mock("./model-pricing-audio-lifecycle", () => ({ cleanupAudioPriceMedia: mocks.cleanupAudio }));

import { runDataLifecycleMaintenance } from "./data-lifecycle-service";

describe("data lifecycle maintenance", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.cleanupAudio.mockResolvedValue({ checked: 1, archived: 1, failed: 0, orphanFilesDeleted: 0 });
        mocks.reconcileRefunds.mockResolvedValue({ checked: 2, reversed: 2, failed: 0 });
        mocks.cleanupExpiredAuthRecords.mockResolvedValue({ sessions: 2, emailCodes: 3 });
        mocks.cleanupExpiredStoredGenerationTasks.mockResolvedValue(4);
        mocks.cleanupExpiredLocalMediaAssets.mockResolvedValue({ deletedFiles: 5, deletedBytes: 60, blocked: [] });
    });

    it("runs one configured bounded batch across technical expiry stores", async () => {
        mocks.getAuthSettings.mockResolvedValue({
            dataLifecycle: {
                cleanupExpiredSessions: true,
                cleanupExpiredEmailCodes: true,
                cleanupExpiredGenerationTasks: true,
                cleanupExpiredTemporaryMedia: true,
                maintenanceBatchSize: 24,
            },
        });

        await expect(runDataLifecycleMaintenance()).resolves.toEqual({
            sessions: 2,
            emailCodes: 3,
            generationTasks: 4,
            audioPricingMedia: { checked: 1, archived: 1, failed: 0, orphanFilesDeleted: 0 },
            mediaShadowRefunds: { checked: 2, reversed: 2, failed: 0 },
            temporaryMedia: { deletedFiles: 5, deletedBytes: 60, blocked: [] },
        });
        expect(mocks.cleanupExpiredAuthRecords).toHaveBeenCalledWith({ cleanupSessions: true, cleanupEmailCodes: true, limit: 24 });
        expect(mocks.cleanupExpiredStoredGenerationTasks).toHaveBeenCalledWith({ limit: 24 });
        expect(mocks.cleanupExpiredLocalMediaAssets).toHaveBeenCalledWith(24);
        expect(mocks.reconcileRefunds).toHaveBeenCalledWith(24);
        expect(mocks.cleanupAudio).toHaveBeenCalledWith(24);
    });

    it("waits for physical task deletion before archiving audio", async () => {
        mocks.getAuthSettings.mockResolvedValue({ dataLifecycle: { cleanupExpiredGenerationTasks: true, maintenanceBatchSize: 1 } });
        let finish!: (value: number) => void;
        const deleting = new Promise<number>((resolve) => {
            finish = resolve;
        });
        mocks.cleanupExpiredStoredGenerationTasks.mockImplementation(() => deleting);
        const running = runDataLifecycleMaintenance();
        await vi.waitFor(() => expect(mocks.cleanupExpiredStoredGenerationTasks).toHaveBeenCalled());
        expect(mocks.cleanupAudio).not.toHaveBeenCalled();
        finish(1);
        await running;
        expect(mocks.cleanupAudio).toHaveBeenCalledWith(1);
        mocks.cleanupExpiredStoredGenerationTasks.mockResolvedValue(4);
    });

    it("does not delete categories disabled by the administrator", async () => {
        mocks.getAuthSettings.mockResolvedValue({
            dataLifecycle: {
                cleanupExpiredSessions: false,
                cleanupExpiredEmailCodes: false,
                cleanupExpiredGenerationTasks: false,
                cleanupExpiredTemporaryMedia: false,
                maintenanceBatchSize: 50,
            },
        });

        await expect(runDataLifecycleMaintenance()).resolves.toEqual({
            sessions: 0,
            emailCodes: 0,
            generationTasks: 0,
            audioPricingMedia: { checked: 0, archived: 0, failed: 0, orphanFilesDeleted: 0 },
            mediaShadowRefunds: { checked: 2, reversed: 2, failed: 0 },
            temporaryMedia: { deletedFiles: 0, deletedBytes: 0, blocked: [] },
        });
        expect(mocks.cleanupAudio).not.toHaveBeenCalled();
        expect(mocks.cleanupExpiredAuthRecords).not.toHaveBeenCalled();
        expect(mocks.cleanupExpiredStoredGenerationTasks).not.toHaveBeenCalled();
        expect(mocks.cleanupExpiredLocalMediaAssets).not.toHaveBeenCalled();
    });
});
