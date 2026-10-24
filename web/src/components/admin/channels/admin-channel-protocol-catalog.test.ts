import { describe, expect, it } from "vitest";

import { channelProtocolDefinitions } from "@/lib/channel-protocol-registry";

import { builtInProtocolCount, visibleProtocolGroups } from "./admin-channel-protocol-catalog";

describe("admin channel protocol catalog", () => {
    it("shows every active built-in protocol exactly once without counting the custom entry", () => {
        const groups = visibleProtocolGroups("", "all");
        const shown = groups.flatMap((group) => group.definitions.map((definition) => definition.id));
        const expected = channelProtocolDefinitions.filter((definition) => !["auto", "compatible", "custom"].includes(definition.id)).map((definition) => definition.id);
        expect(shown).toHaveLength(builtInProtocolCount);
        expect(new Set(shown).size).toBe(shown.length);
        expect([...shown].sort()).toEqual([...expected].sort());
        expect(groups.map((group) => [group.title, group.definitions.length])).toEqual([
            ["网关协议", 7],
            ["平台协议", 13],
            ["不绑定平台的接口", 2],
        ]);
    });

    it("distinguishes the two Seedream routes and filters by actual model capability", () => {
        expect(visibleProtocolGroups("Seedream", "all").flatMap((group) => group.definitions.map((definition) => definition.id))).toEqual(["dataeyes-seedream", "volcengine-image"]);
        expect(visibleProtocolGroups("ByteDance-Seedream-5.0-pro", "image").flatMap((group) => group.definitions.map((definition) => definition.id))).toEqual(["dataeyes-seedream"]);
        expect(visibleProtocolGroups("Seedream", "video")).toEqual([]);
        expect(visibleProtocolGroups("sd2", "all").flatMap((group) => group.definitions.map((definition) => definition.id))).toEqual(["seedance"]);
    });
});
