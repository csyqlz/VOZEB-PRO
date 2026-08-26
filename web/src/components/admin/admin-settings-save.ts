import type { AuthSettings } from "@/lib/auth/store";

export type AdminSettingsSaveSnapshot = {
    keys: Array<keyof AuthSettings>;
    values: Partial<AuthSettings>;
};

export type AdminSettingsSaveQueue = {
    run<T>(operation: () => Promise<T>): Promise<T>;
};

export function createAdminSettingsSaveQueue(): AdminSettingsSaveQueue {
    let pending: Promise<unknown> = Promise.resolve();
    return {
        run<T>(operation: () => Promise<T>) {
            const result = pending.then(operation, operation);
            pending = result.then(
                () => undefined,
                () => undefined,
            );
            return result;
        },
    };
}

export function beginAdminSettingsSave(activeSaves: number) {
    return activeSaves + 1;
}

export function finishAdminSettingsSave(activeSaves: number) {
    const remaining = Math.max(0, activeSaves - 1);
    return { remaining, loading: remaining > 0 };
}

export function createAdminSettingsSaveSnapshot(patch: Partial<AuthSettings>): AdminSettingsSaveSnapshot {
    const keys = (Object.keys(patch) as Array<keyof AuthSettings>).filter((key) => patch[key] !== undefined);
    const values: Partial<AuthSettings> = {};
    for (const key of keys) Object.assign(values, { [key]: structuredClone(patch[key]) });
    return { keys, values };
}

export function applyAdminSettingsSaveSnapshot(current: AuthSettings, snapshot: AdminSettingsSaveSnapshot) {
    return replaceSnapshotValues(current, snapshot.values, snapshot.keys);
}

export function mergeAdminSettingsSaveResponse(current: AuthSettings, response: AuthSettings, snapshot: AdminSettingsSaveSnapshot) {
    let next = current;
    for (const key of snapshot.keys) {
        if (!sameSettingValue(current[key], snapshot.values[key])) continue;
        if (next === current) next = { ...current };
        Object.assign(next, { [key]: response[key] });
    }
    return next;
}

export function restoreAdminSettingsSaveFailure(current: AuthSettings, previous: AdminSettingsSaveSnapshot, submitted: AdminSettingsSaveSnapshot) {
    let next = current;
    for (const key of submitted.keys) {
        if (!sameSettingValue(current[key], submitted.values[key])) continue;
        if (next === current) next = { ...current };
        Object.assign(next, { [key]: previous.values[key] });
    }
    return next;
}

function replaceSnapshotValues(current: AuthSettings, values: Partial<AuthSettings>, keys: Array<keyof AuthSettings>) {
    if (!keys.length) return current;
    const next = { ...current };
    for (const key of keys) Object.assign(next, { [key]: values[key] });
    return next;
}

function sameSettingValue(left: unknown, right: unknown) {
    return Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right);
}
