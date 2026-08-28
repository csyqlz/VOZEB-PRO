import { NextResponse } from "next/server";

import { DEFAULT_SITE_SETTINGS, getAuthSettings } from "@/lib/auth/store";
import { getCurrentUser, serializeCurrentUser, serializePublicSettings, serializePublicSiteSettings } from "@/lib/auth/session";
import { getInstallStatus } from "@/lib/server/install-status";

export const runtime = "nodejs";

const SESSION_HEADERS = { "Cache-Control": "private, no-store" };

export async function GET() {
    let user = null;
    try {
        user = await getCurrentUser();
    } catch {
        user = null;
    }

    if (user) {
        try {
            const settings = await getAuthSettings();
            return NextResponse.json(
                {
                    user: serializeCurrentUser(user),
                    settings: serializePublicSettings(settings),
                    install: { ready: true, firstAdminRequired: false, database: { healthy: true, schemaReady: true } },
                },
                { headers: SESSION_HEADERS },
            );
        } catch {
            user = null;
        }
    }

    const install = await getInstallStatus();
    if (!install.database.healthy || !install.database.schemaReady) {
        return NextResponse.json({ user: null, settings: { site: DEFAULT_SITE_SETTINGS }, install }, { headers: SESSION_HEADERS });
    }

    const settings = await getAuthSettings();
    return NextResponse.json(
        {
            user: null,
            // Anonymous clients only need branding. Model/channel configuration is an authenticated concern.
            settings: { site: serializePublicSiteSettings(settings.site) },
            install,
        },
        { headers: SESSION_HEADERS },
    );
}
