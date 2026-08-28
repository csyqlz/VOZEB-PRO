export function formatGenerationDuration(ms: number) {
    if (!Number.isFinite(ms) || ms <= 0) return "0 秒";
    const totalSeconds = Math.max(1, Math.round(ms / 1000));
    if (totalSeconds < 60) return `${totalSeconds} 秒`;
    return `${Math.floor(totalSeconds / 60)} 分 ${totalSeconds % 60} 秒`;
}
