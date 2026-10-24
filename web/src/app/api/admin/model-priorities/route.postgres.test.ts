import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: vi.fn(async () => ({ id: "priority-test-admin", role: "admin", status: "active", adminPermissions: ["upstream.manage"] })) }));
vi.mock("@/lib/server/audit-log-store", () => ({ auditActorFromRequest: vi.fn(() => ({ id: "priority-test-admin" })), safeRecordAuditLog: vi.fn(async () => undefined) }));

import { getFreshAuthSettings, setAuthSettings, updateAuthSettingsWith, type AuthSettings } from "@/lib/auth/store";
import { initializePostgresSchema } from "@/lib/server/database";
import { PATCH, POST } from "./route";

const postgresIt = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" ? it : it.skip;
const request = (method: "POST" | "PATCH", body: unknown) => new Request("http://localhost/api/admin/model-priorities", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const channel = (id: string): AuthSettings["systemChannels"][number] => ({ id, name: id, baseUrl: "https://example.com/v1", apiKey: "test-only-key", apiFormat: "openai", models: ["gemini-2.5-flash", "gemini-2.5-pro"], enabled: true });
const models = (): AuthSettings["logicalModels"] => [
    {
        id: "flash",
        name: "Flash",
        manufacturer: "Google",
        series: "Gemini 2.5",
        capability: "text",
        enabled: true,
        bindings: [
            { id: "flash-a", channelId: "a", upstreamModel: "gemini-2.5-flash", enabled: true, priority: 3, weight: 50 },
            { id: "flash-b", channelId: "b", upstreamModel: "gemini-2.5-flash", enabled: true, priority: 2, weight: 20 },
        ],
    },
    { id: "pro", name: "Pro", manufacturer: "Google", series: "Gemini 2.5", capability: "text", enabled: true, bindings: [{ id: "pro-a", channelId: "a", upstreamModel: "gemini-2.5-pro", enabled: true, priority: 4, weight: 70 }] },
];

async function preview(modelId: string, priority: number) {
    const response = await POST(request("POST", { channelIds: ["a"], manufacturer: "Google", series: "Gemini 2.5", capability: "text", priority }));
    expect(response.status).toBe(200);
    const body = await response.json();
    return body.data.rows.find((row: { modelId: string }) => row.modelId === modelId) as { modelId: string; bindingId: string; version: string; after: string[] };
}

describe("model priorities against isolated PostgreSQL", () => {
    beforeAll(async () => {
        if (process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1") await initializePostgresSchema();
    });

    beforeEach(async () => {
        if (process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1") await setAuthSettings({ systemChannels: [channel("a"), channel("b")], logicalModels: models() });
    });

    postgresIt("previews and saves only selected bindings, preserving other settings", async () => {
        const row = await preview("flash", 1);
        expect(row.after).toEqual(["flash-a", "flash-b"]);
        const baseline = await getFreshAuthSettings();
        const response = await PATCH(request("PATCH", { priority: 1, selected: [{ modelId: row.modelId, bindingId: row.bindingId, version: row.version }], excluded: ["pro:pro-a"] }));
        expect(response.status).toBe(200);
        const current = await getFreshAuthSettings();
        expect(current.logicalModels.find((model) => model.id === "flash")?.bindings.map((binding) => binding.priority)).toEqual([1, 2]);
        expect(current.logicalModels.find((model) => model.id === "pro")).toEqual(baseline.logicalModels.find((model) => model.id === "pro"));
        expect({ ...current, logicalModels: baseline.logicalModels }).toEqual(baseline);
    });

    postgresIt("serializes concurrent admin submissions and returns 409 for the stale one", async () => {
        const row = await preview("flash", 1);
        const baseline = await getFreshAuthSettings();
        const input = { selected: [{ modelId: row.modelId, bindingId: row.bindingId, version: row.version }] };
        const responses = await Promise.all([PATCH(request("PATCH", { ...input, priority: 1 })), PATCH(request("PATCH", { ...input, priority: 5 }))]);
        expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
        const conflict = responses.find((response) => response.status === 409)!;
        expect(await conflict.json()).toMatchObject({ data: { conflicts: ["flash:flash-a"] } });
        const current = await getFreshAuthSettings();
        expect([1, 5]).toContain(current.logicalModels.find((model) => model.id === "flash")?.bindings.find((binding) => binding.id === "flash-a")?.priority);
        expect(current.logicalModels.find((model) => model.id === "flash")?.bindings.find((binding) => binding.id === "flash-b")?.priority).toBe(2);
        expect(current.logicalModels.find((model) => model.id === "pro")).toEqual(baseline.logicalModels.find((model) => model.id === "pro"));
    });

    postgresIt("rejects a preview made before catalog synchronization without overwriting it", async () => {
        const row = await preview("flash", 1);
        await updateAuthSettingsWith((current) => ({ systemChannels: current.systemChannels.map((item) => (item.id === "a" ? { ...item, models: ["gemini-2.5-pro"] } : item)) }));
        const synchronized = await getFreshAuthSettings();
        const response = await PATCH(request("PATCH", { priority: 1, selected: [{ modelId: row.modelId, bindingId: row.bindingId, version: row.version }] }));
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ data: { conflicts: ["flash:flash-a"] } });
        expect(await getFreshAuthSettings()).toEqual(synchronized);
    });
});
