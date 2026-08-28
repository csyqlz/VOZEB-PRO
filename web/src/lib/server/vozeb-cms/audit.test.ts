import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    actor: vi.fn(() => ({ id: "user-one" })),
    record: vi.fn(async () => null),
}));

vi.mock("@/lib/server/audit-log-store", () => ({ auditActorFromRequest: mocks.actor, safeRecordAuditLog: mocks.record }));

import { createVozebCmsAuditScope, recordVozebCmsAccessBlock } from "./audit";

describe("VOZEBCMS audit boundary", () => {
    beforeEach(() => vi.clearAllMocks());

    it("keeps only operational summary fields", async () => {
        const audit = createVozebCmsAuditScope(new Request("http://localhost/api/vozeb-cms/layouts"), { id: "user-one" }, "vozeb.layout.create", { type: "layout" });

        await audit.success({
            targetId: "layout-one",
            metadata: {
                revision: 2,
                nodeCount: 6,
                projectId: "project-one",
                prompt: "private page prompt",
                context: { authorization: "Bearer private-token" },
                apiKey: "private-api-key",
            },
        });

        expect(mocks.record).toHaveBeenCalledWith(
            expect.objectContaining({
                action: "vozeb.layout.create",
                target: { type: "layout", id: "layout-one" },
                metadata: { revision: 2, nodeCount: 6, projectId: "project-one" },
            }),
        );
        expect(JSON.stringify(mocks.record.mock.calls)).not.toContain("private");
    });

    it("records only the failure class and status, never the error message", async () => {
        const audit = createVozebCmsAuditScope(new Request("http://localhost/api/vozeb-cms/workflows"), { id: "user-one" }, "vozeb.workflow.definition.create", { type: "workflow_definition" });
        const error = Object.assign(new Error("prompt and secret-key must stay private"), { status: 409 });

        await audit.failure(error, { metadata: { nodeCount: 3, body: "private body" } });

        expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ status: "failure", metadata: { nodeCount: 3, errorType: "Error", errorStatus: 409 } }));
        expect(JSON.stringify(mocks.record.mock.calls)).not.toContain("secret-key");
        expect(JSON.stringify(mocks.record.mock.calls)).not.toContain("private body");
    });

    it("records capability blocks without request content", async () => {
        await recordVozebCmsAccessBlock({ request: new Request("http://localhost/private?prompt=hidden"), user: { id: "user-one" }, kind: "capability", id: "workflow.run", status: 403 });

        expect(mocks.record).toHaveBeenCalledWith(
            expect.objectContaining({
                action: "vozeb.access.capability.blocked",
                target: { type: "capability", id: "workflow.run" },
                metadata: { capabilityId: "workflow.run", errorStatus: 403 },
            }),
        );
        expect(JSON.stringify(mocks.record.mock.calls)).not.toContain("hidden");
    });
});
