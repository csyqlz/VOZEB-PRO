import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), settings: vi.fn(), commit: vi.fn(), preview: vi.fn(), audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/auth/store", () => ({ getFreshAuthSettings: mocks.settings }));
vi.mock("@/lib/server/model-priority-batch", () => ({
    commitModelPriorities: mocks.commit,
    previewModelPriorities: mocks.preview,
    ModelPriorityConflict: class ModelPriorityConflict extends Error {
        constructor(public items: string[]) {
            super("冲突");
        }
    },
}));
vi.mock("@/lib/server/audit-log-store", () => ({ auditActorFromRequest: vi.fn(() => ({ id: "admin" })), safeRecordAuditLog: mocks.audit }));

import { PATCH, POST } from "./route";
import { ModelPriorityConflict } from "@/lib/server/model-priority-batch";

const request = (method: string, body: unknown) => new Request("http://localhost/api/admin/model-priorities", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("model priority admin route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.user.mockResolvedValue({ id: "admin", role: "admin", status: "active", adminPermissions: ["upstream.manage"] });
        mocks.settings.mockResolvedValue({ logicalModels: [], systemChannels: [] });
        mocks.preview.mockReturnValue([]);
        mocks.commit.mockResolvedValue({ changes: [{ modelId: "m", bindingId: "b", channelId: "c", oldPriority: 3, newPriority: 1 }], excluded: [] });
    });

    it("requires upstream.manage for preview and commit", async () => {
        mocks.user.mockResolvedValue({ id: "admin", role: "admin", status: "active", adminPermissions: ["billing.manage"] });
        expect((await POST(request("POST", { channelIds: ["c"], priority: 1 }))).status).toBe(403);
        expect((await PATCH(request("PATCH", { selected: [], priority: 1 }))).status).toBe(403);
        expect(mocks.settings).not.toHaveBeenCalled();
        expect(mocks.commit).not.toHaveBeenCalled();
    });

    it("reads a fresh snapshot for preview and audits the exact committed changes", async () => {
        const preview = await POST(request("POST", { channelIds: ["c"], priority: 1 }));
        expect(preview.status).toBe(200);
        expect(mocks.preview).toHaveBeenCalledWith(expect.objectContaining({ logicalModels: [] }), { channelIds: ["c"], priority: 1 });
        const result = await PATCH(request("PATCH", { selected: [{ modelId: "m", bindingId: "b", version: "hash" }], priority: 1 }));
        expect(result.status).toBe(200);
        expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "admin.model-priority.batch-update", metadata: expect.objectContaining({ changes: [expect.objectContaining({ modelId: "m", newPriority: 1 })] }) }));
    });

    it("returns a conflict without success audit when the preview is stale", async () => {
        mocks.commit.mockRejectedValue(new ModelPriorityConflict(["m:b"]));
        const response = await PATCH(request("PATCH", { selected: [{ modelId: "m", bindingId: "b", version: "old" }], priority: 1 }));
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ data: { conflicts: ["m:b"] } });
        expect(mocks.audit).not.toHaveBeenCalled();
    });
});
