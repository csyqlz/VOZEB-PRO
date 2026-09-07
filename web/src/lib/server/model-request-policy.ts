import type { LogicalModelCapability, LogicalModelCapabilityProfile } from "@/lib/auth/store";

const MIN_REQUEST_TIMEOUT_MS = 5_000;
const MAX_REQUEST_TIMEOUT_MS = 30 * 60_000;
export const MAX_TEXT_MODEL_REQUEST_TIMEOUT_MS = 10 * 60_000;
export const TEXT_MODEL_REQUEST_TIMEOUT_MS = 3 * 60_000;

export const DEFAULT_MODEL_REQUEST_TIMEOUT_MS: Record<LogicalModelCapability, number> = {
    text: TEXT_MODEL_REQUEST_TIMEOUT_MS,
    image: 10 * 60_000,
    video: 30 * 60_000,
    audio: 3 * 60_000,
};

type ModelRequestPolicyConfig = { capabilityProfile?: Pick<LogicalModelCapabilityProfile, "timeoutMs"> };

export function resolveModelRequestTimeoutMs(config: ModelRequestPolicyConfig | undefined, capability: LogicalModelCapability) {
    if (capability === "text") {
        // 文本默认 3 分钟，但绑定可显式声明更长超时（深度推理模型跑结构化提取可能超过 3 分钟）。
        const configured = Math.floor(Number(config?.capabilityProfile?.timeoutMs));
        if (Number.isFinite(configured) && configured > 0) return Math.max(30_000, Math.min(MAX_TEXT_MODEL_REQUEST_TIMEOUT_MS, configured));
        return TEXT_MODEL_REQUEST_TIMEOUT_MS;
    }
    const configured = Math.floor(Number(config?.capabilityProfile?.timeoutMs));
    if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_MODEL_REQUEST_TIMEOUT_MS[capability];
    return Math.max(MIN_REQUEST_TIMEOUT_MS, Math.min(MAX_REQUEST_TIMEOUT_MS, configured));
}

export function resolveModelPollingAttempts(config: ModelRequestPolicyConfig | undefined, capability: LogicalModelCapability, intervalMs: number, minimumAttempts: number) {
    return Math.max(minimumAttempts, Math.ceil(resolveModelRequestTimeoutMs(config, capability) / intervalMs));
}
