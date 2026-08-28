import { describe, expect, it } from "vitest";

import { defaultConfig } from "@/stores/use-config-store";
import { publicModelLabel } from "./model-picker";

describe("public model labels", () => {
    it("never exposes a channel name to user-facing model pickers", () => {
        const config = {
            ...defaultConfig,
            logicalModels: [],
            channels: [{ id: "secret-channel", name: "内部供应渠道", models: ["seedance-1.5-pro"] }],
        };

        const label = publicModelLabel(config as never, "secret-channel::seedance-1.5-pro");

        expect(label).toBe("seedance-1.5-pro");
        expect(label).not.toContain("内部供应渠道");
        expect(label).not.toContain("secret-channel");
    });
});
