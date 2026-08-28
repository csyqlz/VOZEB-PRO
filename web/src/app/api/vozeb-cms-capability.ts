import { NextResponse } from "next/server";

import { VozebCmsModuleAccessError, assertVozebCmsCapabilityEnabled, assertVozebCmsUserCapability } from "@/lib/server/vozeb-cms/module-service";
import { recordVozebCmsAccessBlock } from "@/lib/server/vozeb-cms/audit";

export async function requireVozebCmsCapability(capabilityId: string, userId?: string, request?: Request) {
    try {
        if (userId) await assertVozebCmsUserCapability(userId, capabilityId);
        else await assertVozebCmsCapabilityEnabled(capabilityId);
        return null;
    } catch (error) {
        if (error instanceof VozebCmsModuleAccessError) {
            if (request) await recordVozebCmsAccessBlock({ request, user: { id: userId }, kind: "capability", id: capabilityId, status: error.status });
            return NextResponse.json({ code: error.status, data: null, msg: error.message, error: error.message }, { status: error.status });
        }
        throw error;
    }
}
