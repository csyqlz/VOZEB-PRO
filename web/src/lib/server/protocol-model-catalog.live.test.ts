import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyAdvancedConfig, protocolAuthHeaders, registeredChannelProtocolDefinitions } from "@/lib/channel-protocol-registry";
import { modelCapabilitiesRecord, parseModelCatalog, parseModelConfigs } from "@/lib/server/admin-model-catalog";
import { createProtocolFixtureServer } from "../../../scripts/protocol-fixture-server.mjs";

const CATALOG_CASES = registeredChannelProtocolDefinitions.flatMap((definition) => definition.modelCatalogPaths.map((path) => ({ definition, path })));

describe("registered protocol model catalogs over a local TCP interface", () => {
    let fixture: ReturnType<typeof createProtocolFixtureServer>;
    let origin = "";

    beforeAll(async () => {
        fixture = createProtocolFixtureServer();
        await new Promise<void>((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
        const address = fixture.server.address();
        if (!address || typeof address === "string") throw new Error("Protocol fixture did not expose a TCP port");
        origin = `http://127.0.0.1:${address.port}`;
    });

    afterAll(async () => {
        await new Promise<void>((resolve, reject) => fixture.server.close((error?: Error) => (error ? reject(error) : resolve())));
    });

    it.each(CATALOG_CASES)("receives the $definition.id catalog response from $path", async ({ definition, path }) => {
        const advanced = { ...emptyAdvancedConfig(), protocol: definition.id, authMode: definition.authMode };
        const response = await fetch(`${origin}${path}?protocol=${encodeURIComponent(definition.id)}`, { headers: protocolAuthHeaders("fixture-key", advanced, definition.apiFormat) });
        const payload = await response.json();

        expect(response.ok).toBe(true);
        const catalog = parseModelCatalog(payload, "provider", definition.id);
        const configs = parseModelConfigs(payload, definition.id);
        const expectedIds = (
            definition.id === "dataeyes-gemini"
                ? []
                : definition.id === "dataeyes-flux"
                  ? ["flux-2-pro"]
                  : definition.id === "dataeyes-seedream"
                    ? ["ByteDance-Seedream-5.0-pro"]
                    : definition.id === "dataeyes-seedance"
                      ? ["seedance-1.5-pro", "seedance-2.0-fast", "provider-scoped-video"]
                      : path === "/sdapi/v1/sd-models"
                        ? ["mock-image", "opaque-catalog-model"]
                        : ["mock-audio", "mock-image", "mock-text", "mock-video", "opaque-catalog-model"]
        ).sort((left, right) => left.localeCompare(right));
        expect(catalog.map((entry) => entry.id)).toEqual(expectedIds);
        expect(Object.keys(configs).sort()).toEqual(expectedIds.map((id) => id.toLowerCase()).sort());
        expect(modelCapabilitiesRecord(catalog, configs)).toEqual(
            Object.fromEntries(
                expectedIds.map((id) => [
                    id.toLowerCase(),
                    definition.id === "dataeyes-seedance"
                        ? "video"
                        : definition.id === "dataeyes-flux" || definition.id === "dataeyes-seedream"
                          ? "image"
                          : id === "opaque-catalog-model"
                            ? definition.capabilities.length === 1
                                ? definition.capabilities[0]
                                : "text"
                            : id.replace("mock-", ""),
                ]),
            ),
        );
        const request = fixture.requests.at(-1);
        expect(request?.path).toBe(path);
        if (definition.authMode === "none") expect(request?.headers.authorization).toBeUndefined();
        else if (definition.id === "gemini") expect(request?.headers["x-goog-api-key"]).toBe("fixture-key");
        else if (definition.id === "anthropic") expect(request?.headers).toMatchObject({ "x-api-key": "fixture-key", "anthropic-version": "2023-06-01" });
        else if (definition.id === "bfl") expect(request?.headers["x-key"]).toBe("fixture-key");
        else if (definition.id === "vidu") expect(request?.headers.authorization).toBe("Token fixture-key");
        else expect(request?.headers.authorization).toBe("Bearer fixture-key");
    });
});
