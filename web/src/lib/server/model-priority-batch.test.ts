import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("@/lib/auth/store", () => ({ updateAuthSettingsWith: mocks.update }));

import { commitModelPriorities, ModelPriorityConflict, previewModelPriorities } from "./model-priority-batch";
import type { AuthSettings } from "@/lib/auth/store";

const channel = (id: string) => ({ id, name: id, baseUrl: "https://api.example.com/v1", apiKey: "fixture", apiFormat: "openai" as const, models: ["gemini-2.5-flash"], enabled: true });
const settings = () =>
    ({
        systemChannels: [channel("a"), channel("b"), channel("c")],
        logicalModels: [
            {
                id: "gemini-2.5-flash",
                name: "Gemini Flash",
                manufacturer: "Google",
                series: "Gemini 2.5",
                capability: "text" as const,
                enabled: true,
                bindings: [
                    { id: "a:flash", channelId: "a", upstreamModel: "gemini-2.5-flash", enabled: true, priority: 2, weight: 50 },
                    { id: "b:flash", channelId: "b", upstreamModel: "gemini-2.5-flash", enabled: true, priority: 1, weight: 20 },
                    { id: "c:flash", channelId: "c", upstreamModel: "gemini-2.5-flash", enabled: false, priority: 3, weight: 100 },
                ],
            },
            { id: "other", name: "Other", capability: "image" as const, enabled: true, bindings: [{ id: "other-binding", channelId: "a", upstreamModel: "other", enabled: true, priority: 5 }] },
        ],
    }) as unknown as AuthSettings;

describe("model priority batch", () => {
    let current: AuthSettings;
    beforeEach(() => {
        current = settings();
        mocks.update.mockReset();
        mocks.update.mockImplementation(async (createPatch: (value: AuthSettings) => Partial<AuthSettings>) => {
            current = { ...current, ...createPatch(current) };
            return current;
        });
    });

    it("previews runtime priority, weight and binding ID order while excluding inactive bindings", () => {
        const rows = previewModelPriorities(current, { channelIds: ["a", "b", "c"], manufacturer: "Google", series: "Gemini 2.5", capability: "text", priority: 1 });
        expect(rows).toHaveLength(3);
        expect(rows[0]).toMatchObject({ oldPriority: 2, after: ["a:flash", "b:flash"], excluded: false });
        expect(rows[2]).toMatchObject({ excluded: true, enabled: false });
        expect(previewModelPriorities(current, { channelIds: ["a"], manufacturer: "Anthropic", priority: 1 })).toEqual([]);
    });

    it("updates only selected bindings and preserves unrelated model edits made after preview", async () => {
        const [row] = previewModelPriorities(current, { channelIds: ["a"], priority: 1 });
        current.logicalModels[1].name = "New name from another admin";
        const result = await commitModelPriorities({ priority: 1, selected: [{ modelId: row.modelId, bindingId: row.bindingId, version: row.version }], excluded: ["other:other-binding"] });
        expect(result.changes).toEqual([{ modelId: "gemini-2.5-flash", bindingId: "a:flash", channelId: "a", oldPriority: 2, newPriority: 1 }]);
        expect(result.scope).toEqual({ channelIds: ["a"], modelIds: ["gemini-2.5-flash"], priority: 1 });
        expect(current.logicalModels[0].bindings.map((item) => item.priority)).toEqual([1, 1, 3]);
        expect(current.logicalModels[1].name).toBe("New name from another admin");
    });

    it("rejects changed priority, weight, grouping or directory membership atomically", async () => {
        const [row] = previewModelPriorities(current, { channelIds: ["a"], priority: 1 });
        const selection = { priority: 1, selected: [{ modelId: row.modelId, bindingId: row.bindingId, version: row.version }] };
        current.logicalModels[0].bindings[1].weight = 200;
        await expect(commitModelPriorities(selection)).rejects.toBeInstanceOf(ModelPriorityConflict);
        expect(current.logicalModels[0].bindings[0].priority).toBe(2);
        current = settings();
        current.logicalModels[0].manufacturer = "Other";
        await expect(commitModelPriorities(selection)).rejects.toBeInstanceOf(ModelPriorityConflict);
        current = settings();
        current.systemChannels[0].models = [];
        await expect(commitModelPriorities(selection)).rejects.toBeInstanceOf(ModelPriorityConflict);
    });
});
