/** A channel mount is independent of the provider's operation paths. */
export function validChannelPathPrefix(value: unknown): value is string {
    if (value === "") return true;
    if (typeof value !== "string" || value.length > 120 || !/^(?:\/[A-Za-z0-9][A-Za-z0-9._~-]*)+$/.test(value)) return false;
    return value.split("/").every((segment) => segment !== "." && segment !== "..");
}

export function withChannelPathPrefix(target: string, prefix: string | undefined): string {
    if (!prefix) return target;
    const url = new URL(target);
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) url.pathname = `${prefix}${url.pathname}`;
    return url.toString();
}
