import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresRepositories, ensurePostgresSchema, postgresQuery, withPostgresTransaction } from "@/lib/server/database";
import { getFreshAuthSettings, setAuthSettings } from "./store-settings-actions";
import { encryptAuthSettingsSecrets } from "./store-normalizers";
import { upsertPostgresSettings } from "./store-repository";

const enabled = process.env.VOZEB_PRO_RUN_POSTGRES_INTEGRATION === "1" && process.env.VOZEB_PRO_ECOMMERCE_ISOLATED_DATABASE === "1";

describe.skipIf(!enabled)("isolated PostgreSQL optional visual quality settings", () => {
    let originalValue: boolean | undefined;
    beforeAll(async () => {
        const target = new URL(process.env.DATABASE_URL || "");
        if (process.env.VOZEB_PRO_DATABASE_PROVIDER !== "postgres" || !["127.0.0.1", "localhost"].includes(target.hostname) || target.port !== "32782" || !target.pathname.endsWith("_e2e"))
            throw new Error("An explicitly isolated PostgreSQL fixture is required");
        await ensurePostgresSchema();
        originalValue = (await getFreshAuthSettings()).ecommerceVisualQualityCheckEnabled;
    });
    afterAll(async () => {
        if (originalValue === undefined) return;
        await setAuthSettings({ ecommerceVisualQualityCheckEnabled: originalValue });
        await assertSaved(originalValue);
    });
    it.each([true, false])("immediately persists %s through targeted writes and a complete settings upsert", async (value) => {
        await setAuthSettings({ ecommerceVisualQualityCheckEnabled: value });
        await assertSaved(value);
        const settings = await getFreshAuthSettings();
        await withPostgresTransaction((db) => upsertPostgresSettings(db, encryptAuthSettingsSecrets(settings)));
        await assertSaved(value);
    });
});

async function assertSaved(value: boolean) {
    expect((await getFreshAuthSettings()).ecommerceVisualQualityCheckEnabled).toBe(value);
    const result = await postgresQuery<{ ecommerce_visual_quality_check_enabled: boolean }>("SELECT ecommerce_visual_quality_check_enabled FROM app_settings WHERE id=$1", ["default"]);
    expect(result.rows[0]?.ecommerce_visual_quality_check_enabled).toBe(value);
    expect((await createPostgresRepositories().settings.getSettings()).settings?.ecommerceVisualQualityCheckEnabled).toBe(value);
}
