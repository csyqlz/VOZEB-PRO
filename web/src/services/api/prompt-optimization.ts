"use client";

import type { CreativeCreationMode } from "@/lib/creative-runtime-contract";
import { refreshUserPointsIfSystem } from "@/services/api/points";
import { throwIfClientSessionExpired } from "@/services/api/session-expiration";

export async function optimizePrompt(input: { requestId: string; prompt: string; mode: CreativeCreationMode }) {
    try {
        const response = await fetch("/api/agent/prompt-optimization", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
        });
        throwIfClientSessionExpired(response);
        const payload = (await response.json().catch(() => null)) as { data?: { prompt?: string }; msg?: string } | null;
        const prompt = payload?.data?.prompt?.trim();
        if (!response.ok || !prompt) throw new Error(payload?.msg || "提示词优化失败");
        return prompt;
    } finally {
        void refreshUserPointsIfSystem("system");
    }
}
