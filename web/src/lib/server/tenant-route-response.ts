import { NextResponse } from "next/server";

import { isAuthInputError } from "@/lib/auth/store";
import { isTenantAccessError } from "@/lib/server/tenant-context";
import { isTenantServiceError } from "@/lib/server/tenant-service";

export function tenantErrorResponse(error: unknown, fallback: string) {
    if (isTenantAccessError(error) || isTenantServiceError(error) || isAuthInputError(error)) return NextResponse.json({ code: error.status, data: null, msg: error.message }, { status: error.status });
    if (isUniqueViolation(error)) return NextResponse.json({ code: 409, data: null, msg: "租户标识、用户名或邮箱已存在" }, { status: 409 });
    console.error(fallback, error);
    return NextResponse.json({ code: 500, data: null, msg: fallback }, { status: 500 });
}

function isUniqueViolation(error: unknown) {
    return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505");
}
