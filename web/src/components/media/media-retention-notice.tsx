import { Clock3, Download } from "lucide-react";

export function MediaRetentionNotice({ className = "" }: { className?: string }) {
    return (
        <div
            className={`mt-3 flex max-w-[680px] items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-900 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-100 ${className}`}
            role="status"
            data-testid="media-retention-notice"
        >
            <Clock3 className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <p className="min-w-0">
                生成图片和视频仅在服务器保留 24 小时，请及时下载保存到本地。
                <span className="ml-1 inline-flex items-center gap-1 font-medium">
                    <Download className="size-3" aria-hidden="true" />
                    下载入口在结果下方或媒体右下角的下载按钮；多个结果可选择“下载全部结果”。
                </span>
                <span className="ml-1">到期后服务器会自动清理，已下载到本地的文件不受影响。</span>
            </p>
        </div>
    );
}
