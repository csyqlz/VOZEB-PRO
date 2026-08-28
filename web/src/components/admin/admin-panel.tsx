import type { ReactNode } from "react";

export function Panel({ children, variant = "surface" }: { children: ReactNode; variant?: "surface" | "page" }) {
    if (variant === "page") return <section className="admin-page-panel min-w-0">{children}</section>;
    return <section className="admin-panel-surface min-w-0 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">{children}</section>;
}

export function PanelHeader({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) {
    return (
        <div
            className={`admin-panel-header grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1.5 border-b border-zinc-200 px-3 py-3 sm:flex sm:flex-col sm:gap-3 sm:px-5 sm:py-4 lg:flex-row lg:items-center dark:border-zinc-800 ${actions ? "admin-panel-header-with-actions lg:justify-end" : "lg:justify-between"}`}
        >
            <div className="admin-panel-heading-copy contents sm:block sm:min-w-0">
                <h2 className="min-w-0 truncate text-sm font-semibold text-zinc-950 sm:text-[15px] dark:text-zinc-100">{title}</h2>
                <div className="col-span-2 line-clamp-2 text-[11px] leading-[18px] text-zinc-500 sm:mt-1 sm:block sm:text-xs sm:leading-5 dark:text-zinc-400">{description}</div>
            </div>
            {actions ? <div className="admin-panel-actions col-start-2 row-start-1 flex max-w-[58vw] min-w-0 flex-wrap items-center justify-end gap-1.5 sm:w-auto sm:max-w-none sm:gap-2 lg:max-w-[58%]">{actions}</div> : null}
        </div>
    );
}

const metricToneClass = {
    slate: "border-zinc-200 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
    blue: "border-blue-100 bg-blue-50 text-blue-600 dark:border-blue-900/70 dark:bg-blue-950/50 dark:text-blue-300",
    emerald: "border-emerald-100 bg-emerald-50 text-emerald-600 dark:border-emerald-900/70 dark:bg-emerald-950/50 dark:text-emerald-300",
    amber: "border-amber-100 bg-amber-50 text-amber-600 dark:border-amber-900/70 dark:bg-amber-950/50 dark:text-amber-300",
    cyan: "border-cyan-100 bg-cyan-50 text-cyan-600 dark:border-cyan-900/70 dark:bg-cyan-950/50 dark:text-cyan-300",
};

export function Metric({ label, value, detail, icon, tone }: { label: string; value: number | string; detail: string; icon: ReactNode; tone: keyof typeof metricToneClass }) {
    return (
        <div className="admin-metric-card flex min-h-[96px] items-center gap-3 rounded-lg border border-zinc-200 bg-white p-3.5 dark:border-zinc-800 dark:bg-zinc-950 sm:min-h-[112px] sm:gap-4 sm:p-5">
            <div className={"flex size-10 shrink-0 items-center justify-center rounded-lg border [&>svg]:size-[18px] sm:size-11 sm:[&>svg]:size-5 " + metricToneClass[tone]}>{icon}</div>
            <div className="min-w-0">
                <div className="text-[10px] font-medium text-zinc-500 sm:text-[11px] dark:text-zinc-400">{label}</div>
                <div className="mt-1.5 text-lg font-semibold leading-none tabular-nums text-zinc-950 sm:text-2xl dark:text-zinc-100">{value}</div>
                <div className="mt-1.5 truncate text-[9px] text-zinc-400 sm:text-[11px] dark:text-zinc-500">{detail}</div>
            </div>
        </div>
    );
}
