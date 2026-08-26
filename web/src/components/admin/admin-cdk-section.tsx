"use client";

import { AdminAccountId } from "@/components/admin/admin-user-identity";
import { Panel, PanelHeader } from "@/components/admin/admin-panel";
import { LabeledControl, SectionTitle } from "@/components/admin/admin-settings-controls";
import { toNumberOrZero } from "@/components/admin/admin-values";
import { formatCreditAmount } from "@/constant/credits";
import { Button, Checkbox, Input, InputNumber, Pagination, Popconfirm, Select, Space, Table, Tag } from "antd";
import { Copy, Database, Download, Eye, Gift, KeyRound, RefreshCw, Search, ShieldCheck, Trash2 } from "lucide-react";

import type { AdminDashboardController } from "./use-admin-dashboard-controller";
import { cdkStatusLabel, cdkStatusTone, clampInteger } from "./admin-dashboard-elements";
import { CDK_PAGE_SIZE } from "./use-admin-dashboard-controller";

export function AdminCdkSection({ controller }: { controller: AdminDashboardController }) {
    const {
        message,
        setViewingCdkCode,
        cdkCodes,
        cdkLoading,
        cdkGenerating,
        createdCdkCodes,
        selectedCreatedCdkIds,
        setSelectedCreatedCdkIds,
        cdkForm,
        setCdkForm,
        cdkSearch,
        setCdkSearch,
        cdkFilter,
        setCdkFilter,
        cdkPage,
        setCdkPage,
        cdkTotal,
        cdkStats,
        selectedCdkIds,
        setSelectedCdkIds,
        bulkDeletingCdk,
        activeSection,
        selectedCreatedCdkCodes,
        createdCdkActionCodes,
        allCreatedCdkSelected,
        loadCdkCodes,
        generateCdkCodes,
        deleteCdkById,
        deleteCreatedCdkCodes,
        bulkDeleteCdkCodes,
        copyCreatedCdkCodes,
        copyCdkPlainCode,
        exportCreatedCdkCodes,
        cdkColumns,
    } = controller;
    if (activeSection !== "cdk") return null;
    return (
        <Panel>
            <PanelHeader
                title="CDK 兑换"
                description="生成人民币余额或套餐兑换码，用于活动发放、客服补偿和私域转化；后台可复制、导出、查看兑换明细并删除密钥。"
                actions={
                    <Button icon={<RefreshCw className="size-4" />} loading={cdkLoading} onClick={() => void loadCdkCodes()}>
                        刷新
                    </Button>
                }
            />
            <div className="space-y-3 p-2.5 sm:space-y-5 sm:p-5">
                <div className="grid items-start gap-3 sm:gap-4 xl:grid-cols-[minmax(360px,0.85fr)_minmax(0,1.15fr)]">
                    <section className="rounded-lg border border-stone-200 bg-stone-50/70 p-3 sm:p-4 dark:border-stone-800 dark:bg-stone-900/40">
                        <SectionTitle icon={<KeyRound className="size-4" />} title="生成 CDK" />
                        <div className="mt-3 grid grid-cols-[repeat(2,minmax(0,1fr))] gap-2.5 sm:mt-4 sm:gap-3">
                            <LabeledControl label="生成数量">
                                <InputNumber className="!w-full" min={1} max={100} precision={0} value={cdkForm.count} onChange={(value) => setCdkForm((current) => ({ ...current, count: clampInteger(value, 1, 100, 1) }))} />
                            </LabeledControl>
                            <LabeledControl label="每次兑换人民币余额">
                                <InputNumber className="!w-full" min={0} precision={8} prefix="¥" value={cdkForm.points} onChange={(value) => setCdkForm((current) => ({ ...current, points: toNumberOrZero(value) }))} />
                            </LabeledControl>
                            <LabeledControl label="每个密钥可兑换次数">
                                <InputNumber className="!w-full" min={1} max={10000} precision={0} value={cdkForm.maxRedemptions} onChange={(value) => setCdkForm((current) => ({ ...current, maxRedemptions: clampInteger(value, 1, 10000, 1) }))} />
                            </LabeledControl>
                            <LabeledControl label="有效天数">
                                <InputNumber
                                    className="!w-full"
                                    min={1}
                                    max={3650}
                                    precision={0}
                                    value={cdkForm.expiresInDays}
                                    placeholder="留空为永久"
                                    onChange={(value) => setCdkForm((current) => ({ ...current, expiresInDays: value === null ? null : clampInteger(value, 1, 3650, 1) }))}
                                />
                            </LabeledControl>
                            <p className="col-span-2 -mt-0.5 text-xs leading-5 text-stone-500 dark:text-stone-400">有效天数留空时长期有效，填写数字则从生成当日起计算。</p>
                            <div className="col-span-2">
                                <LabeledControl label="备注">
                                    <Input value={cdkForm.note} maxLength={120} placeholder="例如：活动赠送 / 测试兑换" onChange={(event) => setCdkForm((current) => ({ ...current, note: event.target.value }))} />
                                </LabeledControl>
                            </div>
                        </div>
                        <div className="mt-4 flex justify-end sm:mt-5">
                            <Button className="!h-9 w-full sm:w-auto" type="primary" icon={<Gift className="size-4" />} loading={cdkGenerating} onClick={() => void generateCdkCodes()}>
                                随机生成 CDK
                            </Button>
                        </div>
                    </section>
                    <section className="rounded-lg border border-stone-200 bg-white p-3 sm:p-4 dark:border-stone-800 dark:bg-stone-950">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0">
                                <SectionTitle icon={<ShieldCheck className="size-4" />} title="本次生成结果" />
                                <p className="mt-2 text-xs leading-5 text-stone-500 dark:text-stone-400">新生成会显示完整明文；删除后会从密钥管理移除，用户不能再兑换。</p>
                            </div>
                            <div className="flex shrink-0 flex-wrap gap-2">
                                <Button size="small" disabled={!createdCdkActionCodes.length} onClick={() => void copyCreatedCdkCodes()}>
                                    {selectedCreatedCdkCodes.length ? "复制选中" : "复制全部"}
                                </Button>
                                <Button size="small" icon={<Download className="size-3.5" />} disabled={!createdCdkActionCodes.length} onClick={() => exportCreatedCdkCodes()}>
                                    {selectedCreatedCdkCodes.length ? "导出选中" : "导出 TXT"}
                                </Button>
                                <Popconfirm
                                    title={selectedCreatedCdkCodes.length ? "删除选中的 CDK？" : "删除本次生成的 CDK？"}
                                    description="删除后这些密钥不能再兑换，也不会继续显示在密钥管理里。建议先复制或导出明文。"
                                    okText="删除"
                                    cancelText="取消"
                                    onConfirm={() => void deleteCreatedCdkCodes(createdCdkActionCodes.map((code) => code.id))}
                                >
                                    <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!createdCdkActionCodes.length}>
                                        {selectedCreatedCdkCodes.length ? "删除选中" : "删除本次"}
                                    </Button>
                                </Popconfirm>
                            </div>
                        </div>
                        {createdCdkCodes.length ? (
                            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-stone-200 bg-stone-50/80 px-3 py-2 text-sm dark:border-stone-800 dark:bg-stone-900/40">
                                <Checkbox
                                    checked={allCreatedCdkSelected}
                                    indeterminate={Boolean(selectedCreatedCdkIds.length) && !allCreatedCdkSelected}
                                    onChange={(event) => setSelectedCreatedCdkIds(event.target.checked ? createdCdkCodes.map((code) => code.id) : [])}
                                >
                                    全选当前结果
                                </Checkbox>
                                <span className="text-xs text-stone-500 dark:text-stone-400">
                                    已选 {selectedCreatedCdkIds.length} 个 / 共 {createdCdkCodes.length} 个；新生成会追加在顶部并自动选中
                                </span>
                            </div>
                        ) : null}
                        <div className="mt-4 max-h-72 space-y-2 overflow-y-auto">
                            {createdCdkCodes.length ? (
                                createdCdkCodes.map((code) => (
                                    <div key={code.id} className="grid gap-3 rounded-md border border-stone-200 p-3 dark:border-stone-800 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
                                        <Checkbox
                                            checked={selectedCreatedCdkIds.includes(code.id)}
                                            onChange={(event) => setSelectedCreatedCdkIds((current) => (event.target.checked ? Array.from(new Set([...current, code.id])) : current.filter((id) => id !== code.id)))}
                                            aria-label={`选择 ${code.codePreview}`}
                                        />
                                        <div className="min-w-0">
                                            <div className="break-all font-mono text-sm font-semibold text-stone-900 dark:text-stone-100">{code.code}</div>
                                            <div className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                                                ¥{formatCreditAmount(code.points)} 余额 / 可兑 {code.maxRedemptions} 次{code.expiresAt ? ` / ${new Date(code.expiresAt).toLocaleDateString("zh-CN")} 过期` : " / 长期有效"}
                                            </div>
                                        </div>
                                        <Space size={6}>
                                            <Button size="small" onClick={() => void navigator.clipboard?.writeText(code.code).then(() => message.success("已复制 CDK"))}>
                                                复制
                                            </Button>
                                            <Popconfirm title="删除这个 CDK？" description="删除后会从密钥管理移除，用户不能再兑换。" okText="删除" cancelText="取消" onConfirm={() => void deleteCreatedCdkCodes([code.id])}>
                                                <Button size="small" danger icon={<Trash2 className="size-3.5" />}>
                                                    删除
                                                </Button>
                                            </Popconfirm>
                                        </Space>
                                    </div>
                                ))
                            ) : (
                                <div className="rounded-md border border-dashed border-stone-200 px-3 py-6 text-center text-sm text-stone-500 sm:py-10 dark:border-stone-800">生成后会在这里显示明文，请及时复制。</div>
                            )}
                        </div>
                    </section>
                </div>
                <section className="rounded-lg border border-stone-200 bg-white p-3 sm:p-4 dark:border-stone-800 dark:bg-stone-950">
                    <div className="mb-4 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                        <div className="min-w-0">
                            <SectionTitle icon={<Database className="size-4" />} title="CDK 密钥管理" />
                            <p className="mt-2 text-xs leading-5 text-stone-500 dark:text-stone-400">这里管理的是可兑换密钥本身；可搜索、复制、查看明细、勾选批量删除，已兑换流水会保留在用户余额记录中。</p>
                            <div className="mt-2 flex flex-wrap gap-2 text-xs text-stone-500 dark:text-stone-400">
                                <Tag className="m-0">总数 {cdkStats.total}</Tag>
                                <Tag className="m-0">已兑换 {cdkStats.redeemed}</Tag>
                                <Tag className="m-0">未兑换 {cdkStats.unused}</Tag>
                                <Tag className="m-0">已过期 {cdkStats.expired}</Tag>
                            </div>
                        </div>
                        <div className="flex w-full flex-col gap-2 xl:w-auto xl:min-w-[520px] xl:flex-row xl:justify-end">
                            <Input
                                allowClear
                                className="w-full xl:max-w-64"
                                prefix={<Search className="size-4 text-stone-400" />}
                                placeholder="搜索明文、备注、兑换用户或用户 ID"
                                value={cdkSearch}
                                onChange={(event) => {
                                    setCdkSearch(event.target.value);
                                    setCdkPage(1);
                                }}
                            />
                            <div className="w-full xl:w-36 xl:shrink-0">
                                <Select
                                    className="w-full"
                                    value={cdkFilter}
                                    onChange={(value) => {
                                        setCdkFilter(value);
                                        setCdkPage(1);
                                    }}
                                    options={[
                                        { value: "all", label: "全部" },
                                        { value: "redeemed", label: "已兑换" },
                                        { value: "unused", label: "未兑换" },
                                        { value: "expired", label: "已过期" },
                                    ]}
                                />
                            </div>
                            <Popconfirm title="批量删除选中 CDK？" description="删除后用户将不能再兑换这些密钥，已有余额流水不会被删除。" okText="删除" cancelText="取消" onConfirm={() => void bulkDeleteCdkCodes()}>
                                <Button danger disabled={!selectedCdkIds.length} loading={bulkDeletingCdk} icon={<Trash2 className="size-4" />}>
                                    批量删除
                                </Button>
                            </Popconfirm>
                        </div>
                    </div>
                    <div className="rounded-lg border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-950">
                        <div className="md:hidden">
                            {cdkLoading ? (
                                <div className="px-3 py-8 text-center text-sm text-stone-500 dark:text-stone-400">加载中...</div>
                            ) : cdkCodes.length ? (
                                <div className="divide-y divide-stone-200 dark:divide-stone-800">
                                    {cdkCodes.map((code) => {
                                        const latest = [...code.redemptions].sort((a, b) => Date.parse(b.redeemedAt) - Date.parse(a.redeemedAt))[0];
                                        const selected = selectedCdkIds.includes(code.id);
                                        return (
                                            <article key={code.id} className="space-y-3 px-3 py-4">
                                                <div className="flex min-w-0 items-start gap-2">
                                                    <Checkbox
                                                        className="mt-0.5 shrink-0"
                                                        checked={selected}
                                                        onChange={(event) => setSelectedCdkIds((current) => (event.target.checked ? Array.from(new Set([...current, code.id])) : current.filter((id) => id !== code.id)))}
                                                        aria-label={`选择 ${code.code}`}
                                                    />
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                                                            <span className="min-w-0 max-w-full break-all font-mono text-sm font-semibold leading-5 text-stone-950 dark:text-stone-100">{code.code || "CDK"}</span>
                                                            <Tag className="m-0" color={cdkStatusTone(code)}>
                                                                {cdkStatusLabel(code)}
                                                            </Tag>
                                                        </div>
                                                        {code.note ? <div className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">备注：{code.note}</div> : null}
                                                    </div>
                                                </div>
                                                <div className="grid grid-cols-2 gap-2 rounded-md bg-stone-50/80 p-3 text-xs leading-5 dark:bg-stone-900/50">
                                                    <div>
                                                        <div className="text-stone-400 dark:text-stone-500">兑换规则</div>
                                                        <div className="mt-0.5 font-medium text-stone-800 dark:text-stone-100">
                                                            ¥{formatCreditAmount(code.points)} 余额 · {code.redeemedCount}/{code.maxRedemptions}
                                                        </div>
                                                    </div>
                                                    <div>
                                                        <div className="text-stone-400 dark:text-stone-500">有效期</div>
                                                        <div className="mt-0.5 font-medium text-stone-800 dark:text-stone-100">{code.expiresAt ? new Date(code.expiresAt).toLocaleDateString("zh-CN") : "长期有效"}</div>
                                                    </div>
                                                    <div className="col-span-2">
                                                        <div className="text-stone-400 dark:text-stone-500">最近兑换</div>
                                                        {latest ? (
                                                            <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 font-medium text-stone-800 dark:text-stone-100">
                                                                <span className="truncate">
                                                                    {latest.displayName} @{latest.username}
                                                                </span>
                                                                <AdminAccountId accountId={latest.accountId} className="shrink-0" />
                                                            </div>
                                                        ) : (
                                                            <div className="mt-0.5 font-medium text-stone-800 dark:text-stone-100">暂无兑换</div>
                                                        )}
                                                    </div>
                                                </div>
                                                <div className="flex flex-wrap justify-end gap-2">
                                                    <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => void copyCdkPlainCode(code)}>
                                                        复制
                                                    </Button>
                                                    <Button size="small" type="text" icon={<Eye className="size-3.5" />} onClick={() => setViewingCdkCode(code)}>
                                                        明细
                                                    </Button>
                                                    <Popconfirm title="删除这个 CDK？" okText="删除" cancelText="取消" onConfirm={() => void deleteCdkById(code.id)}>
                                                        <Button size="small" danger icon={<Trash2 className="size-3.5" />}>
                                                            删除
                                                        </Button>
                                                    </Popconfirm>
                                                </div>
                                            </article>
                                        );
                                    })}
                                </div>
                            ) : (
                                <div className="px-3 py-8 text-center text-sm text-stone-500 dark:text-stone-400">暂无符合条件的 CDK</div>
                            )}
                        </div>
                        <div className="hidden md:block">
                            <Table
                                rowKey="id"
                                columns={cdkColumns}
                                dataSource={cdkCodes}
                                loading={cdkLoading}
                                pagination={false}
                                scroll={{ x: 1080 }}
                                rowSelection={{
                                    selectedRowKeys: selectedCdkIds,
                                    onChange: (keys) => setSelectedCdkIds(keys.map(String)),
                                }}
                                locale={{ emptyText: "暂无符合条件的 CDK" }}
                            />
                        </div>
                        <div className="flex flex-col gap-3 border-t border-stone-200 px-3 py-3 sm:flex-row sm:items-center sm:justify-between dark:border-stone-800">
                            <div className="text-sm text-stone-500 dark:text-stone-400">
                                已选 <span className="font-semibold text-stone-950 dark:text-stone-100">{selectedCdkIds.length}</span> 个，当前页 <span className="font-semibold text-stone-950 dark:text-stone-100">{cdkCodes.length}</span> 条，共{" "}
                                <span className="font-semibold text-stone-950 dark:text-stone-100">{cdkTotal}</span> 条
                            </div>
                            <Pagination current={cdkPage} pageSize={CDK_PAGE_SIZE} total={cdkTotal} showSizeChanger={false} onChange={(page) => setCdkPage(page)} />
                        </div>
                    </div>
                </section>
            </div>
        </Panel>
    );
}
