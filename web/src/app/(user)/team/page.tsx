import { notFound, redirect } from "next/navigation";

import { TeamConsole } from "@/components/team/team-console";
import { getCurrentUser } from "@/lib/auth/session";
import { isTenantAccessError, requireTenantContext } from "@/lib/server/tenant-context";

export default async function TeamPage() {
    const user = await getCurrentUser();
    if (!user) redirect("/login");
    let tenant;
    try {
        tenant = await requireTenantContext(user.id, ["owner", "admin"]);
    } catch (error) {
        if (isTenantAccessError(error) && (error.status === 403 || error.status === 404)) notFound();
        throw error;
    }
    return <TeamConsole initialTenant={tenant} currentUserId={user.id} />;
}
