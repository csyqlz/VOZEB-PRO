import { getLocalMediaRegistration, isLocalMediaRegistrationExpired } from "@/lib/server/local-media-registry";
import { localMediaStorageKeyFromValue } from "@/lib/server/local-media-references";

export async function requireManagedMediaInputOwner(value: string, actor: { id: string; role: "user" | "admin" }, scope: "reference" | "generation") {
    const storageKey = localMediaStorageKeyFromValue(value);
    const registration = storageKey ? await getLocalMediaRegistration(storageKey) : null;
    if (!registration || registration.scope !== scope || isLocalMediaRegistrationExpired(registration) || (actor.role !== "admin" && registration.ownerUserId !== actor.id)) {
        throw new Error("参考素材不存在或无权访问");
    }
    return registration.ownerUserId;
}
