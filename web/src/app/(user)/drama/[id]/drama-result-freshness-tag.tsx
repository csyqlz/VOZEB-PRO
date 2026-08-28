import { Tag } from "antd";

import type { DramaShot } from "../types";

export function DramaResultFreshnessTag({ shot }: { shot: DramaShot }) {
    const reasons = [shot.storyboardStaleReason, shot.storyboardEndStaleReason, shot.videoStaleReason].filter((reason): reason is string => Boolean(reason));
    if (!reasons.length) return null;
    return (
        <Tag className="!m-0 !border-amber-300 !bg-amber-50 !text-amber-800 dark:!border-amber-700/70 dark:!bg-amber-950/35 dark:!text-amber-200" title={reasons.join("；")} data-drama-stale-result>
            旧结果 · 需更新
        </Tag>
    );
}
