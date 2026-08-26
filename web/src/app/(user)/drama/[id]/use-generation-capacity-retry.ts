"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { generationCapacityRetryDelayMs } from "@/services/api/generation-task-request-error";

export function useGenerationCapacityRetry() {
    const timers = useRef(new Map<string, number>());
    const [waitingKeys, setWaitingKeys] = useState<Set<string>>(() => new Set());

    useEffect(
        () => () => {
            timers.current.forEach((timer) => window.clearTimeout(timer));
            timers.current.clear();
        },
        [],
    );

    const schedule = useCallback((key: string, error: unknown) => {
        const retryDelayMs = generationCapacityRetryDelayMs(error);
        if (!retryDelayMs) return false;
        if (timers.current.has(key)) return true;
        setWaitingKeys((current) => new Set(current).add(key));
        const timer = window.setTimeout(() => {
            timers.current.delete(key);
            setWaitingKeys((current) => {
                const next = new Set(current);
                next.delete(key);
                return next;
            });
        }, retryDelayMs);
        timers.current.set(key, timer);
        return true;
    }, []);

    const isWaiting = useCallback((key: string) => waitingKeys.has(key), [waitingKeys]);
    return { isWaiting, schedule };
}
