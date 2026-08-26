"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { App, Button, Pagination, Tag } from "antd";
import { Copy, Gift, Link2, RefreshCw, ShieldCheck, UserPlus } from "lucide-react";

import { useCopyText } from "@/hooks/use-copy-text";
import { getReferralCenter, type ReferralCenter, type ReferralRewardStatus, type ReferralRiskStatus } from "@/services/api/referrals";
import { AccountPanel, LoadingBlock, profilePrimaryButtonClass, profileSecondaryButtonClass } from "./profile-elements";

const REFERRAL_PAGE_SIZE = 8;

export function ProfileReferralCenter() {
    const { message } = App.useApp();
    const copyText = useCopyText();
    const [data, setData] = useState<ReferralCenter | null>(null);
    const [loading, setLoading] = useState(true);
    const referralsPage = useRef(1);
    const rewardsPage = useRef(1);

    const load = useCallback(
        async (input: { referralsPage?: number; rewardsPage?: number } = {}) => {
            setLoading(true);
            try {
                const next = await getReferralCenter({ referralsPage: input.referralsPage || referralsPage.current, rewardsPage: input.rewardsPage || rewardsPage.current, pageSize: REFERRAL_PAGE_SIZE });
                referralsPage.current = next.referralsPage;
                rewardsPage.current = next.rewardsPage;
                setData(next);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "加载邀请中心失败");
            } finally {
                setLoading(false);
            }
        },
        [message],
    );

    useEffect(() => {
        void load();
    }, [load]);

    if (loading && !data) return <LoadingBlock />;
    if (!data)
        return (
            <AccountPanel title="邀请有礼" description="邀请中心暂时不可用，请稍后重试。">
                <Button className={profileSecondaryButtonClass} icon={<RefreshCw className="size-4" />} onClick={() => void load()}>
                    重新加载
                </Button>
            </AccountPanel>
        );

    const enabled = data.program.enabled;
    return (
        <div className="space-y-1.5 sm:space-y-5">
            <AccountPanel
                title="邀请有礼"
                description="分享邀请链接，新用户完成首笔有效支付并度过冷静期后发放奖励。"
                action={
                    <Button className={profileSecondaryButtonClass} icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void load()}>
                        <span className="hidden sm:inline">刷新</span>
                    </Button>
                }
            >
                <div className="rounded-xl border border-border bg-muted/25 p-3 sm:p-5">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                                <Gift className="size-4" />
                                我的邀请码
                                <Tag className="m-0" color={enabled ? "green" : "default"}>
                                    {enabled ? "活动进行中" : "活动未开启"}
                                </Tag>
                            </div>
                            <div className="mt-2 break-all text-2xl font-semibold text-foreground sm:text-3xl">{data.code}</div>
                            <p className="mt-2 text-xs leading-5 text-muted-foreground">禁止自邀、循环邀请和事后改绑；异常关系会暂停结算并进入人工复核。</p>
                        </div>
                        <div className="grid shrink-0 grid-cols-2 gap-2 sm:flex">
                            <Button disabled={!enabled} className={profileSecondaryButtonClass} icon={<Copy className="size-4" />} onClick={() => copyText(data.code, "邀请码已复制")}>
                                复制邀请码
                            </Button>
                            <Button disabled={!enabled} type="primary" className={profilePrimaryButtonClass} icon={<Link2 className="size-4" />} onClick={() => copyText(data.link, "邀请链接已复制")}>
                                复制链接
                            </Button>
                        </div>
                    </div>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2 sm:mt-5 sm:grid-cols-4">
                    <Metric label="链接访问" value={data.stats.clicks} />
                    <Metric label="成功注册" value={data.stats.registrations} />
                    <Metric label="首单触发" value={data.stats.qualified} />
                    <Metric label="已发奖励" value={data.stats.settled} />
                </div>

                <div className="mt-3 grid gap-2 text-xs sm:mt-5 sm:grid-cols-3">
                    <Rule icon={<UserPlus className="size-4" />} label="邀请人奖励" value={`¥${data.program.inviterPoints} 余额`} />
                    <Rule icon={<Gift className="size-4" />} label="新用户奖励" value={data.program.inviteeRewardType === "coupon" ? "新客优惠券" : `¥${data.program.inviteePoints} 余额`} />
                    <Rule icon={<ShieldCheck className="size-4" />} label="结算条件" value={`实付满 ¥${(data.program.minimumPaidCents / 100).toFixed(2)} · 冷静期 ${data.program.coolingOffDays} 天`} />
                </div>
            </AccountPanel>

            <div className="grid gap-1.5 sm:gap-5 lg:grid-cols-2">
                <AccountPanel title="邀请进度" description="只展示脱敏昵称和当前风险状态，不公开受邀用户隐私。">
                    {data.referrals.length ? (
                        <div className="divide-y divide-border">
                            {data.referrals.map((item) => (
                                <div key={item.id} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0 sm:py-3">
                                    <div className="min-w-0">
                                        <div className="truncate text-sm font-semibold text-foreground">{item.inviteeName}</div>
                                        <div className="mt-1 text-xs text-muted-foreground">{formatTime(item.registeredAt)}</div>
                                    </div>
                                    <Tag className="m-0" color={riskColor(item.riskStatus)}>
                                        {riskLabel(item.riskStatus)}
                                    </Tag>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <Empty label="暂无成功注册的受邀用户" />
                    )}
                    {data.referralsTotal > data.referralsPageSize ? (
                        <div className="mt-3 flex justify-center sm:justify-end">
                            <Pagination
                                size="small"
                                current={data.referralsPage}
                                pageSize={data.referralsPageSize}
                                total={data.referralsTotal}
                                showLessItems
                                showSizeChanger={false}
                                disabled={loading}
                                onChange={(page) => void load({ referralsPage: page })}
                            />
                        </div>
                    ) : null}
                </AccountPanel>

                <AccountPanel title="奖励记录" description="待结算、已发放、已撤销和人工复核状态均可追踪。">
                    {data.rewards.length ? (
                        <div className="divide-y divide-border">
                            {data.rewards.map((reward) => (
                                <div key={reward.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-2 first:pt-0 last:pb-0 sm:py-3">
                                    <div className="min-w-0">
                                        <div className="truncate text-sm font-semibold text-foreground">{reward.beneficiaryRole === "inviter" ? "邀请人奖励" : "新用户奖励"}</div>
                                        <div className="mt-1 truncate text-xs text-muted-foreground">
                                            {formatTime(reward.createdAt)}
                                            {reward.reason ? ` · ${reward.reason}` : ""}
                                        </div>
                                    </div>
                                    <div className="text-right">
                                        <Tag className="m-0" color={rewardColor(reward.status)}>
                                            {rewardLabel(reward.status)}
                                        </Tag>
                                        <div className="mt-1 text-xs font-semibold text-foreground">{reward.rewardType === "coupon" ? "优惠券" : `¥${reward.pointsAmount} 余额`}</div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <Empty label="暂无邀请奖励记录" />
                    )}
                    {data.rewardsTotal > data.rewardsPageSize ? (
                        <div className="mt-3 flex justify-center sm:justify-end">
                            <Pagination size="small" current={data.rewardsPage} pageSize={data.rewardsPageSize} total={data.rewardsTotal} showLessItems showSizeChanger={false} disabled={loading} onChange={(page) => void load({ rewardsPage: page })} />
                        </div>
                    ) : null}
                </AccountPanel>
            </div>
        </div>
    );
}

function Metric({ label, value }: { label: string; value: number }) {
    return (
        <div className="rounded-lg border border-border bg-card px-3 py-2.5">
            <div className="text-[11px] text-muted-foreground sm:text-xs">{label}</div>
            <div className="mt-1 text-lg font-semibold tabular-nums text-foreground sm:text-xl">{value}</div>
        </div>
    );
}

function Rule({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
    return (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-card p-3">
            <span className="mt-0.5 text-muted-foreground">{icon}</span>
            <div className="min-w-0">
                <div className="text-muted-foreground">{label}</div>
                <div className="mt-1 font-semibold text-foreground">{value}</div>
            </div>
        </div>
    );
}

function Empty({ label }: { label: string }) {
    return <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">{label}</div>;
}

function riskLabel(status: ReferralRiskStatus) {
    return status === "clear" ? "正常" : status === "review" ? "待复核" : status === "frozen" ? "已冻结" : "已拒绝";
}

function riskColor(status: ReferralRiskStatus) {
    return status === "clear" ? "green" : status === "review" ? "gold" : status === "frozen" ? "orange" : "red";
}

function rewardLabel(status: ReferralRewardStatus) {
    return status === "pending" ? "待结算" : status === "settled" ? "已发放" : status === "revoked" ? "已撤销" : status === "reversal_pending" ? "撤销待复核" : "已拒绝";
}

function rewardColor(status: ReferralRewardStatus) {
    return status === "settled" ? "green" : status === "pending" ? "gold" : status === "reversal_pending" ? "orange" : "red";
}

function formatTime(value: string) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "-";
}
