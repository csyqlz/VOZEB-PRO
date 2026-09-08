"use client";

import { useEffect, useRef, useState } from "react";

/** 活动期间每秒推进的已用时长（毫秒）；active 翻回 false 时保留最后一次读数。 */
export function useElapsedTimer(active: boolean, resetKey?: string) {
    const [elapsedMs, setElapsedMs] = useState(0);
    const startedAtRef = useRef(0);
    const lastRef = useRef(0);

    useEffect(() => {
        if (active) {
            startedAtRef.current = Date.now();
            setElapsedMs(0);
            const timer = window.setInterval(() => {
                lastRef.current = Date.now() - startedAtRef.current;
                setElapsedMs(lastRef.current);
            }, 1000);
            return () => {
                window.clearInterval(timer);
                lastRef.current = Date.now() - startedAtRef.current;
            };
        }
        return undefined;
    }, [active, resetKey]);

    return elapsedMs;
}

export function formatElapsed(ms: number) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes ? `${minutes} 分 ${String(seconds).padStart(2, "0")} 秒` : `${seconds} 秒`;
}
