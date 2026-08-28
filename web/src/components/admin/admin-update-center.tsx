"use client";

import { App, Button, Tag } from "antd";
import { BookOpen, Bug, Check, CheckCircle2, Circle, ExternalLink, GitBranch, History, LoaderCircle, MessageCircle, RefreshCw, ShieldCheck } from "lucide-react";

import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import { GitHubLink } from "@/components/layout/github-link";
import { VersionReleaseModal } from "@/components/layout/version-release-modal";
import { VOZEB_QQ_GROUP_URL } from "@/constant/community";
import { APP_VERSION } from "@/constant/env";
import { compareSystemVersions } from "@/lib/system-update-contract";
import { useAdminSystemUpdate, type UpdateConfirmationKey } from "./use-admin-system-update";

const operationLabels = {
    idle: "等待检查",
    preparing: "正在校验 Release",
    backing_up: "正在创建灾备恢复点",
    pulling: "正在拉取官方镜像",
    applying: "正在切换应用版本",
    health_check: "正在执行健康检查",
    completed: "升级操作已完成",
    failed: "升级操作失败",
    rolling_back: "正在回滚上一版本",
} as const;

const releaseLinks = [
    { label: "Release", href: "https://github.com/csyqlz/VOZEB-PRO/releases", description: "正式版本与升级说明", icon: GitBranch },
    { label: "Issues", href: "https://github.com/csyqlz/VOZEB-PRO/issues", description: "部署问题与功能反馈", icon: Bug },
    { label: "Docs", href: "https://github.com/csyqlz/VOZEB-PRO", description: "部署文档与源码仓库", icon: BookOpen },
    { label: "QQ 群", href: VOZEB_QQ_GROUP_URL, description: "社区支持与版本交流", icon: MessageCircle },
];

export function UpdateCenterPanel() {
    const { modal, message } = App.useApp();
    const update = useAdminSystemUpdate();
    const upgradeChecks: Array<{ key: UpdateConfirmationKey; label: string }> = [
        { key: "databaseBackup", label: "允许升级器创建 PostgreSQL 灾备恢复点" },
        { key: "environmentReviewed", label: "已确认 .env / Docker 环境变量" },
        { key: "changelogReviewed", label: "已阅读 CHANGELOG 破坏性变更" },
        { key: "rollbackReviewed", label: "已了解应用回滚与数据库恢复边界" },
    ];
    const operation = update.info?.onlineUpgrade.operation;
    const releaseCheckUnavailable = update.info?.releaseCheck.status === "unavailable";
    const canRollback = Boolean(operation?.previousVersion && update.info && compareSystemVersions(operation.previousVersion, update.info.currentVersion) < 0);
    const statusMessage = update.error || (operation && operation.status !== "idle" ? operationLabels[operation.status] : update.info?.onlineUpgrade.reason || update.info?.releaseCheck.reason || "版本服务已连接，可以检查 GitHub 正式 Release。");
    const requestOperation = (action: "upgrade" | "rollback") => {
        const target = action === "upgrade" ? update.info?.latestVersion : operation?.previousVersion;
        modal.confirm({
            title: action === "upgrade" ? `升级到 ${target}` : `回滚到 ${target}`,
            content: action === "upgrade" ? "升级器会先停止创作 Worker 与应用，创建灾备恢复点，再拉取并切换官方签名镜像。期间页面会短暂不可访问。" : "回滚只切换到上一应用镜像；如新版执行过不兼容数据变更，应使用升级前灾备恢复点执行离线数据库恢复。",
            okText: action === "upgrade" ? "确认开始升级" : "确认回滚",
            okButtonProps: { danger: action === "rollback" },
            cancelText: "取消",
            onOk: async () => {
                await update.submit(action);
                message.success(action === "upgrade" ? "升级任务已启动" : "回滚任务已启动");
            },
        });
    };
    return (
        <Panel variant="page">
            <PanelHeader title="更新中心" description="版本检查、升级准备、更新日志和 GitHub 仓库入口集中放在这里。" actions={<GitHubLink className="rounded-xl" />} />
            <div className="space-y-4 p-3 sm:p-5">
                <section className="admin-panel-surface min-w-0 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950" aria-labelledby="update-status-title">
                    <div className="flex min-w-0 flex-col gap-3 border-b border-zinc-100 px-4 py-4 sm:flex-row sm:items-center sm:justify-between dark:border-zinc-900">
                        <div className="flex min-w-0 items-center gap-3">
                            <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
                                <RefreshCw className={`size-[18px] ${update.loading ? "animate-spin" : ""}`} aria-hidden="true" />
                            </span>
                            <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                    <h3 id="update-status-title" className="text-sm font-semibold text-zinc-950 dark:text-zinc-100">
                                        版本状态
                                    </h3>
                                    {update.loading ? <Tag>检查中</Tag> : releaseCheckUnavailable ? <Tag color="orange">检查失败</Tag> : update.info?.hasUpdate ? <Tag color="green">发现新版本</Tag> : <Tag>已是最新</Tag>}
                                </div>
                                <p className="mt-0.5 text-xs leading-5 text-zinc-500 dark:text-zinc-400">检查正式 Release、升级监督器与最近一次操作状态。</p>
                            </div>
                        </div>
                        <Button className="w-full sm:w-auto" icon={<RefreshCw className="size-4" />} loading={update.loading} disabled={update.active} onClick={() => void update.refresh(true)}>
                            检查更新
                        </Button>
                    </div>
                    <div className="grid divide-y divide-zinc-100 sm:grid-cols-3 sm:divide-x sm:divide-y-0 dark:divide-zinc-900">
                        <VersionMetric label="当前版本" value={APP_VERSION} detail="当前运行中的应用版本" />
                        <VersionMetric label="最新 Release" value={update.loading ? "检查中" : update.info?.latestVersion || "-"} detail={update.info?.hasUpdate ? "存在可升级版本" : "正式发布通道"} />
                        <VersionMetric label="升级方式" value={update.info?.onlineUpgrade.supported ? "在线升级" : "手动升级"} detail={update.info?.onlineUpgrade.supported ? "升级监督器已就绪" : "按部署文档执行"} />
                    </div>
                    <div className="flex min-w-0 flex-col gap-3 border-t border-zinc-100 bg-zinc-50/70 px-4 py-3 lg:flex-row lg:items-center lg:justify-between dark:border-zinc-900 dark:bg-zinc-900/35">
                        <div className={`min-w-0 text-xs leading-5 ${update.error || operation?.status === "failed" ? "text-red-600 dark:text-red-400" : "text-zinc-600 dark:text-zinc-300"}`}>{statusMessage}</div>
                        <div className="flex shrink-0 flex-wrap items-center gap-2">
                            <Button
                                type="primary"
                                icon={update.active ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                                loading={update.submitting}
                                disabled={!update.info?.hasUpdate || !update.info.onlineUpgrade.supported || !update.confirmationsComplete || update.active}
                                onClick={() => requestOperation("upgrade")}
                            >
                                {update.active ? "升级处理中" : update.loading ? "正在检查" : releaseCheckUnavailable ? "检查更新失败" : update.info?.hasUpdate ? `升级到 ${update.info.latestVersion}` : "已是最新版本"}
                            </Button>
                            <VersionReleaseModal
                                className="inline-flex h-8 items-center justify-center rounded-md border border-zinc-300 bg-white px-3 text-xs font-medium text-zinc-700 transition hover:border-zinc-400 hover:text-zinc-950 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:border-zinc-600 dark:hover:text-white"
                                label="查看更新日志"
                            />
                            {canRollback && operation?.previousVersion && !update.active ? (
                                <Button icon={<History className="size-4" />} disabled={!update.confirmationsComplete || update.submitting} onClick={() => requestOperation("rollback")}>
                                    回滚到 {operation.previousVersion}
                                </Button>
                            ) : null}
                        </div>
                    </div>
                </section>

                <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
                    <section className="admin-panel-surface min-w-0 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950" aria-labelledby="update-readiness-title">
                        <div className="flex items-center justify-between gap-3 border-b border-zinc-100 px-4 py-4 dark:border-zinc-900">
                            <div>
                                <h3 id="update-readiness-title" className="text-sm font-semibold text-zinc-950 dark:text-zinc-100">
                                    升级准备
                                </h3>
                                <p className="mt-0.5 text-xs leading-5 text-zinc-500 dark:text-zinc-400">四项确认全部完成后，在线升级操作才会解锁。</p>
                            </div>
                            <ShieldCheck className="size-5 shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
                        </div>
                        <div className="divide-y divide-zinc-100 px-4 dark:divide-zinc-900">
                            {upgradeChecks.map((item) => (
                                <button
                                    type="button"
                                    key={item.key}
                                    className="flex min-h-12 w-full items-center gap-3 py-2.5 text-left text-xs text-zinc-700 transition hover:text-zinc-950 sm:text-sm dark:text-zinc-200 dark:hover:text-white"
                                    onClick={() => update.toggleConfirmation(item.key)}
                                >
                                    {update.confirmations[item.key] ? <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600 sm:size-4" /> : <Circle className="size-3.5 shrink-0 text-stone-400 sm:size-4" />}
                                    <span className="min-w-0 flex-1">{item.label}</span>
                                    {update.confirmations[item.key] ? <Check className="size-3.5 shrink-0 text-emerald-600" /> : null}
                                </button>
                            ))}
                        </div>
                    </section>
                    <section className="admin-panel-surface min-w-0 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950" aria-labelledby="release-resources-title">
                        <div className="border-b border-zinc-100 px-4 py-4 dark:border-zinc-900">
                            <h3 id="release-resources-title" className="text-sm font-semibold text-zinc-950 dark:text-zinc-100">
                                发布资源
                            </h3>
                            <p className="mt-0.5 text-xs leading-5 text-zinc-500 dark:text-zinc-400">版本说明、问题反馈和部署资料。</p>
                        </div>
                        <div className="divide-y divide-zinc-100 px-4 dark:divide-zinc-900">
                            {releaseLinks.map((item) => {
                                const Icon = item.icon;
                                return (
                                    <a key={item.label} href={item.href} target="_blank" rel="noreferrer" className="group flex min-h-14 items-center gap-3 py-2.5">
                                        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-zinc-100 text-zinc-600 transition group-hover:bg-zinc-950 group-hover:text-white dark:bg-zinc-900 dark:text-zinc-300 dark:group-hover:bg-zinc-100 dark:group-hover:text-zinc-950">
                                            <Icon className="size-4" aria-hidden="true" />
                                        </span>
                                        <span className="min-w-0 flex-1">
                                            <span className="block text-xs font-medium text-zinc-800 sm:text-sm dark:text-zinc-200">{item.label}</span>
                                            <span className="mt-0.5 block truncate text-[11px] text-zinc-500 dark:text-zinc-400">{item.description}</span>
                                        </span>
                                        <ExternalLink className="size-3.5 shrink-0 text-zinc-400 transition group-hover:text-zinc-700 dark:group-hover:text-zinc-200" aria-hidden="true" />
                                    </a>
                                );
                            })}
                        </div>
                    </section>
                </div>
            </div>
        </Panel>
    );
}

function VersionMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
    return (
        <div className="min-w-0 px-4 py-4">
            <div className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">{label}</div>
            <div className="mt-1.5 truncate text-lg font-semibold tabular-nums text-zinc-950 dark:text-zinc-100" title={value}>
                {value}
            </div>
            <div className="mt-1 truncate text-[11px] text-zinc-400 dark:text-zinc-500" title={detail}>
                {detail}
            </div>
        </div>
    );
}
