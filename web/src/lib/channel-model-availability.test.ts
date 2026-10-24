import { describe, expect, it } from "vitest";

import { currentChannelModels } from "./channel-model-availability";

describe("channel model availability", () => {
    const models = ["ByteDance-Seed-1.6", "doubao-seed-2-1-pro-260915"];

    it("uses the current DataEyes key catalog without deleting retained local models", () => {
        const channel = { baseUrl: "https://studio.dataeyes.ai", models, advancedConfig: { providerModels: ["models/DOUBAO-SEED-2-1-PRO-260915"] } };
        expect(currentChannelModels(channel as never)).toEqual(["doubao-seed-2-1-pro-260915"]);
        expect(channel.models).toEqual(models);
    });

    it("keeps other suppliers and not-yet-synchronized channels unchanged", () => {
        expect(currentChannelModels({ baseUrl: "https://api.example.com", models, advancedConfig: { providerModels: [models[1]] } } as never)).toEqual(models);
        expect(currentChannelModels({ baseUrl: "https://studio.dataeyes.ai", models, advancedConfig: {} } as never)).toEqual(models);
        expect(currentChannelModels({ baseUrl: "https://studio.dataeyes.ai", models, advancedConfig: { providerModels: [] } } as never)).toEqual([]);
    });
});
