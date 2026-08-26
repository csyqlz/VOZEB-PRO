import type { Metadata } from "next";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { AuthUserHydrator } from "@/components/auth/auth-user-hydrator";
import { AppWorkspaceShell } from "@/components/layout/app-workspace-shell";
import { getAuthenticatedPageAccess } from "@/lib/server/page-access";

export const metadata: Metadata = {
    robots: { index: false, follow: false, noarchive: true, noimageindex: true, nosnippet: true },
};

export default async function UserLayout({ children }: { children: ReactNode }) {
    const access = await getAuthenticatedPageAccess();
    if (!access.user) {
        if (access.install.database.configured && !access.install.database.healthy) redirect("/service-unavailable");
        if (!access.install.database.healthy || access.install.firstAdminRequired) redirect("/install");
        redirect("/login");
    }
    const user = access.user;

    return (
        <AuthUserHydrator
            user={{
                id: user.id,
                accountId: user.accountId,
                username: user.username,
                email: user.email,
                displayName: user.displayName,
                bio: user.bio,
                avatarUrl: user.avatarUrl,
                role: user.role,
                adminPermissions: user.adminPermissions,
                status: user.status,
                planId: user.planId,
                planName: user.planName,
                hasActivePlan: user.hasActivePlan,
                pointsBalance: user.pointsBalance,
                permanentPointsBalance: user.permanentPointsBalance,
                dailyPointsBalance: user.dailyPointsBalance,
                dailyPointsExpiresAt: user.dailyPointsExpiresAt,
                mfaEnabled: user.mfaEnabled,
            }}
        >
            <AppWorkspaceShell>{children}</AppWorkspaceShell>
        </AuthUserHydrator>
    );
}
