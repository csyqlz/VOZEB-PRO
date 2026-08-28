"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { SystemUpdateInfo, SystemUpdateRequest } from "@/lib/system-update-contract";
import { getAdminSystemUpdate, startAdminSystemUpdate } from "@/services/api/system-update";

export type UpdateConfirmationKey = keyof SystemUpdateRequest["confirmations"];

const initialConfirmations: SystemUpdateRequest["confirmations"] = {
    databaseBackup: false,
    environmentReviewed: false,
    changelogReviewed: false,
    rollbackReviewed: false,
};

const activeStatuses = new Set(["preparing", "backing_up", "pulling", "applying", "health_check", "rolling_back"]);

export async function pollSystemUpdateUntilResponse(pollAfterMs: number, refresh: () => Promise<SystemUpdateInfo | undefined>, signal: AbortSignal, wait: (delayMs: number, signal: AbortSignal) => Promise<boolean> = waitForSystemUpdatePoll) {
    while (!signal.aborted) {
        if (!(await wait(pollAfterMs, signal)) || signal.aborted) return;
        if (await refresh()) return;
    }
}

function waitForSystemUpdatePoll(delayMs: number, signal: AbortSignal) {
    return new Promise<boolean>((resolve) => {
        const timeout = window.setTimeout(() => {
            signal.removeEventListener("abort", cancel);
            resolve(true);
        }, delayMs);
        const cancel = () => {
            window.clearTimeout(timeout);
            resolve(false);
        };
        signal.addEventListener("abort", cancel, { once: true });
    });
}

export function useAdminSystemUpdate() {
    const [info, setInfo] = useState<SystemUpdateInfo>();
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState("");
    const [confirmations, setConfirmations] = useState(initialConfirmations);

    const refresh = useCallback(async (showLoading = false) => {
        if (showLoading) setLoading(true);
        try {
            const next = await getAdminSystemUpdate();
            setInfo(next);
            setError("");
            return next;
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "版本信息读取失败");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    useEffect(() => {
        const operation = info?.onlineUpgrade.operation;
        if (!operation || !activeStatuses.has(operation.status) || !operation.pollAfterMs) return;
        const controller = new AbortController();
        void pollSystemUpdateUntilResponse(operation.pollAfterMs, refresh, controller.signal);
        return () => controller.abort();
    }, [info?.onlineUpgrade.operation, refresh]);

    const toggleConfirmation = useCallback((key: UpdateConfirmationKey) => {
        setConfirmations((current) => ({ ...current, [key]: !current[key] }));
    }, []);

    const submit = useCallback(
        async (action: "upgrade" | "rollback") => {
            const targetVersion = action === "upgrade" ? info?.latestVersion : info?.onlineUpgrade.operation.previousVersion;
            if (!targetVersion) throw new Error(action === "upgrade" ? "没有可用的新版本" : "没有可回滚版本");
            setSubmitting(true);
            try {
                const result = await startAdminSystemUpdate({ action, targetVersion, confirmations, idempotencyKey: crypto.randomUUID() });
                setInfo((current) => (current ? { ...current, onlineUpgrade: { ...current.onlineUpgrade, operation: result.operation } } : current));
                setError("");
                return result.operation;
            } catch (reason) {
                const message = reason instanceof Error ? reason.message : "升级任务启动失败";
                setError(message);
                throw reason;
            } finally {
                setSubmitting(false);
            }
        },
        [confirmations, info?.latestVersion, info?.onlineUpgrade.operation.previousVersion],
    );

    return {
        info,
        loading,
        submitting,
        error,
        confirmations,
        confirmationsComplete: useMemo(() => Object.values(confirmations).every(Boolean), [confirmations]),
        active: Boolean(info && activeStatuses.has(info.onlineUpgrade.operation.status)),
        refresh,
        submit,
        toggleConfirmation,
    };
}
