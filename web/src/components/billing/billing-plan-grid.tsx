"use client";

import { Button } from "antd";
import { ArrowUpRight, Check } from "lucide-react";
import { useEffect, useState } from "react";

import { CreditSymbol, formatCreditAmount } from "@/constant/credits";
import type { BillingProduct } from "@/services/api/billing";

type BillingPlanGridProps = {
    products: BillingProduct[];
    onSelect: (product: BillingProduct) => void;
    variant?: "modal" | "page";
};

export function BillingPlanGrid({ products, onSelect, variant = "page" }: BillingPlanGridProps) {
    const recommendedId = products.find((product) => productMetadata(product).recommended)?.id || products[Math.min(1, products.length - 1)]?.id;
    const [activeProductId, setActiveProductId] = useState(recommendedId);

    useEffect(() => {
        if (!products.some((product) => product.id === activeProductId)) setActiveProductId(recommendedId);
    }, [activeProductId, products, recommendedId]);

    const activeProduct = products.find((product) => product.id === activeProductId) || products[0];
    const activeProductIndex = Math.max(
        0,
        products.findIndex((product) => product.id === activeProduct?.id),
    );
    return (
        <>
            <div className="mb-2 sm:hidden">
                <div className="mb-2 flex items-center justify-between px-1 text-xs">
                    <span className="font-medium text-stone-500 dark:text-stone-400">选择方案</span>
                    <span className="tabular-nums text-stone-400 dark:text-stone-500">
                        {products.length ? activeProductIndex + 1 : 0} / {products.length}
                    </span>
                </div>
                <div className="-mx-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                    <div className="flex min-w-full gap-1.5" role="tablist" aria-label="套餐选择">
                        {products.map((product) => {
                            const selected = product.id === activeProduct?.id;
                            const pricing = productPricing(product);
                            return (
                                <button
                                    key={product.id}
                                    type="button"
                                    role="tab"
                                    aria-selected={selected}
                                    className={`relative min-w-0 overflow-hidden rounded-lg border px-2 py-1.5 text-left transition ${products.length === 1 ? "w-full" : "w-36 shrink-0"} ${
                                        selected
                                            ? "border-[#aebdce] bg-[#e9eef5] text-[#263141] shadow-[0_5px_16px_rgba(71,85,105,0.09)] dark:border-[#536173] dark:bg-[#252d37] dark:text-white"
                                            : "border-stone-200 bg-stone-50 text-stone-600 hover:border-[#cbd4df] hover:bg-white dark:border-stone-800 dark:bg-stone-900/70 dark:text-stone-300 dark:hover:border-[#3d4856] dark:hover:bg-[#1f252c]"
                                    }`}
                                    onClick={(event) => {
                                        setActiveProductId(product.id);
                                        event.currentTarget.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
                                    }}
                                >
                                    <span className="block truncate text-sm font-semibold">{product.name}</span>
                                    <span className={`mt-1 flex min-w-0 items-center gap-1.5 truncate text-xs ${selected ? "font-medium text-[#52627a] dark:text-[#d8dee8]" : "text-stone-400 dark:text-stone-500"}`}>
                                        <span>¥ {formatYuan(pricing.saleUnitAmountCents)}</span>
                                        {pricing.discountCents > 0 ? <span className="truncate text-[10px] text-stone-400 line-through dark:text-stone-500">¥ {formatYuan(pricing.listUnitAmountCents)}</span> : null}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            </div>

            <div className="sm:hidden" data-billing-plan-layout={variant}>
                {activeProduct ? <PlanCard product={activeProduct} index={products.findIndex((item) => item.id === activeProduct.id)} recommended={activeProduct.id === recommendedId} variant={variant} onSelect={onSelect} /> : null}
            </div>

            <div className={`hidden sm:grid ${gridClass(products.length, variant)}`} data-billing-plan-layout={variant}>
                {products.map((product, index) => {
                    return <PlanCard key={product.id} product={product} index={index} recommended={product.id === recommendedId} variant={variant} onSelect={onSelect} />;
                })}
            </div>
        </>
    );
}

function PlanCard({ product, index, recommended, variant, onSelect }: { product: BillingProduct; index: number; recommended: boolean; variant: "modal" | "page"; onSelect: (product: BillingProduct) => void }) {
    if (variant === "modal") return <CompactPlanCard product={product} recommended={recommended} onSelect={onSelect} />;

    const metadata = productMetadata(product);
    const pricing = productPricing(product);
    const promotion = pricing.discountCents > 0 ? pricing.promotion : undefined;
    const isPointsProduct = product.productKind === "points";
    const features = featureLines(product, metadata.features).slice(0, 4);
    return (
        <article
            data-billing-plan-card={product.id}
            className={`relative flex h-full min-w-0 flex-col overflow-hidden rounded-2xl border bg-white p-4 text-stone-950 shadow-[0_8px_24px_rgba(15,23,42,0.05)] transition hover:-translate-y-0.5 hover:shadow-[0_18px_48px_rgba(15,23,42,0.10)] sm:rounded-[1.4rem] sm:p-5 dark:bg-stone-950 dark:text-white dark:shadow-black/25 ${
                recommended ? "border-[#9aa7ba] ring-1 ring-[#9aa7ba]/45 dark:border-[#74839a] dark:ring-[#74839a]/45" : "border-stone-200 hover:border-stone-300 dark:border-stone-800 dark:hover:border-stone-700"
            }`}
        >
            <div className="relative flex min-h-7 items-center justify-between gap-3">
                <span className="text-[10px] font-semibold tracking-[0.14em] text-stone-400 sm:text-[11px] sm:tracking-[0.16em] dark:text-stone-500">星启智域方案 · {String(index + 1).padStart(2, "0")}</span>
                {promotion ? (
                    <span className="rounded-md border border-rose-200 bg-rose-50 px-2 py-0.5 text-[10px] font-semibold text-rose-700 sm:px-3 sm:py-1 sm:text-[11px] dark:border-rose-900/60 dark:bg-rose-950/35 dark:text-rose-200">{promotion.label}</span>
                ) : recommended ? (
                    <span className="rounded-full border border-[#cfd7e3] bg-[#eef2f7] px-2 py-0.5 text-[10px] font-semibold text-[#52627a] sm:px-3 sm:py-1 sm:text-[11px] dark:border-[#52627a]/60 dark:bg-[#66758e]/15 dark:text-[#d8dee8]">推荐方案</span>
                ) : metadata.highlight ? (
                    <span className="rounded-full border border-stone-200 px-3 py-1 text-[11px] font-medium text-stone-500 dark:border-stone-700 dark:text-stone-400">{metadata.highlight}</span>
                ) : null}
            </div>

            <div className="relative mt-4 sm:mt-5">
                <h3 className="line-clamp-2 text-xl font-semibold leading-tight tracking-tight sm:min-h-[4.25rem] sm:text-[1.7rem]">{product.name}</h3>
                <p className="mt-2 hidden min-h-12 line-clamp-2 text-sm leading-6 text-stone-500 sm:block dark:text-stone-400">{product.description || "适合持续完成多媒体创作与商业项目交付。"}</p>
            </div>

            <div className="relative mt-4 flex flex-col gap-4 border-t border-stone-200 pt-4 sm:mt-5 sm:flex-row sm:items-end sm:justify-between sm:gap-3 sm:pt-5 dark:border-stone-800">
                <div data-billing-plan-price className="flex min-w-0 flex-wrap items-end gap-x-1 gap-y-1">
                    <span className="pb-1 text-sm font-medium">¥</span>
                    <span className="min-w-0 break-all text-3xl font-semibold leading-none sm:text-[2.35rem]">{formatYuan(pricing.saleUnitAmountCents)}</span>
                    <span className="pb-1 text-sm text-stone-500 dark:text-stone-400">/ {isPointsProduct ? "一次性" : periodLabel(product.periodDays)}</span>
                </div>
                <Button type="primary" data-billing-plan-action className="profile-primary-button !h-10 w-full shrink-0 !rounded-xl px-5 text-sm sm:w-auto sm:min-w-28" onClick={() => onSelect(product)}>
                    <span className="inline-flex items-center gap-2">
                        {isPointsProduct ? "立即充值" : "购买套餐"} <ArrowUpRight className="size-4" />
                    </span>
                </Button>
            </div>

            <div aria-hidden={promotion ? undefined : true} className={`relative mt-2 flex min-h-5 flex-wrap items-center gap-x-2 text-xs text-stone-500 dark:text-stone-400 ${promotion ? "" : "invisible"}`}>
                {promotion ? (
                    <>
                        <span className="line-through">日常价 ¥ {formatYuan(pricing.listUnitAmountCents)}</span>
                        <span className="font-medium text-rose-600 dark:text-rose-300">省 ¥ {formatYuan(pricing.discountCents)}</span>
                    </>
                ) : (
                    <span>标准价格</span>
                )}
            </div>

            <ul className="relative mt-4 flex-1 space-y-2.5 border-t border-stone-200 pt-4 sm:mt-5 sm:pt-5 dark:border-stone-800">
                <li className="flex gap-2 text-xs leading-5 text-stone-600 dark:text-stone-300 sm:gap-2.5 sm:text-sm">
                    <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-[#eef2f7] text-[#66758e] dark:bg-[#66758e]/15 dark:text-[#d8dee8]">
                        <CreditSymbol className="text-[10px]" />
                    </span>
                    <span>
                        <strong className="font-semibold text-stone-950 dark:text-white">¥{formatCreditAmount(product.pointsAmount)}</strong> 人民币余额
                    </span>
                </li>
                {features.map((line) => (
                    <li key={line} className="hidden gap-2.5 text-sm leading-5 text-stone-600 sm:flex dark:text-stone-300">
                        <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-[#eef2f7] text-[#66758e] dark:bg-[#66758e]/15 dark:text-[#d8dee8]">
                            <Check className="size-3" />
                        </span>
                        <span>{line}</span>
                    </li>
                ))}
            </ul>
        </article>
    );
}

function CompactPlanCard({ product, recommended, onSelect }: { product: BillingProduct; recommended: boolean; onSelect: (product: BillingProduct) => void }) {
    const metadata = productMetadata(product);
    const pricing = productPricing(product);
    const promotion = pricing.discountCents > 0 ? pricing.promotion : undefined;
    const isPointsProduct = product.productKind === "points";
    const features = featureLines(product, metadata.features).slice(0, 2);
    return (
        <article
            data-billing-plan-card={product.id}
            data-billing-plan-density="compact"
            className={`relative min-w-0 overflow-hidden rounded-lg border bg-white p-3.5 text-stone-950 shadow-[0_3px_12px_rgba(15,23,42,0.04)] transition hover:border-stone-400 hover:shadow-[0_8px_24px_rgba(15,23,42,0.08)] sm:p-4 dark:bg-stone-950 dark:text-white dark:shadow-black/20 ${
                recommended ? "border-[#8e9caf] ring-1 ring-[#8e9caf]/40 dark:border-[#78879d] dark:ring-[#78879d]/40" : "border-stone-200 dark:border-stone-800 dark:hover:border-stone-600"
            }`}
        >
            <div className="flex min-h-7 items-start justify-between gap-2">
                <h3 className="line-clamp-1 min-w-0 text-base font-semibold leading-6">{product.name}</h3>
                {promotion ? (
                    <span className="max-w-[60%] truncate rounded-md border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/35 dark:text-rose-200">{promotion.label}</span>
                ) : recommended ? (
                    <span className="rounded-md border border-[#cfd7e3] bg-[#eef2f7] px-1.5 py-0.5 text-[10px] font-semibold text-[#52627a] dark:border-[#52627a]/60 dark:bg-[#66758e]/15 dark:text-[#d8dee8]">推荐</span>
                ) : metadata.highlight ? (
                    <span className="max-w-[60%] truncate text-[10px] font-medium text-stone-500 dark:text-stone-400">{metadata.highlight}</span>
                ) : null}
            </div>
            <p className="mt-0.5 line-clamp-2 text-xs leading-[18px] text-stone-500 dark:text-stone-400">{product.description || "适合持续完成多媒体创作与项目交付。"}</p>

            <div className="mt-3 flex flex-wrap items-end justify-between gap-3 border-y border-stone-200 py-3 dark:border-stone-800">
                <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-end gap-x-1 gap-y-1" data-billing-plan-price>
                        <span className="pb-0.5 text-xs font-medium">¥</span>
                        <span className="min-w-0 break-all text-2xl font-semibold leading-none">{formatYuan(pricing.saleUnitAmountCents)}</span>
                        <span className="pb-0.5 text-xs text-stone-500 dark:text-stone-400">/ {isPointsProduct ? "一次性" : periodLabel(product.periodDays)}</span>
                    </div>
                    {promotion ? (
                        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[10px] text-stone-500 dark:text-stone-400">
                            <span className="line-through">¥ {formatYuan(pricing.listUnitAmountCents)}</span>
                            <span className="font-medium text-rose-600 dark:text-rose-300">省 ¥ {formatYuan(pricing.discountCents)}</span>
                        </div>
                    ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1.5 text-xs text-stone-600 dark:text-stone-300">
                    <span className="grid size-5 place-items-center rounded-md bg-[#eef2f7] text-[#66758e] dark:bg-[#66758e]/15 dark:text-[#d8dee8]">
                        <CreditSymbol className="text-[11px]" />
                    </span>
                    <span className="whitespace-nowrap font-semibold text-stone-950 dark:text-white">{formatCreditAmount(product.pointsAmount)}</span>
                    <span className="hidden text-stone-500 lg:inline dark:text-stone-400">余额</span>
                </div>
            </div>

            <ul className="mt-3 space-y-1.5">
                {features.map((line) => (
                    <li key={line} className="flex min-w-0 gap-2 text-xs leading-5 text-stone-600 dark:text-stone-300">
                        <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full bg-[#eef2f7] text-[#66758e] dark:bg-[#66758e]/15 dark:text-[#d8dee8]">
                            <Check className="size-3" />
                        </span>
                        <span className="line-clamp-1">{line}</span>
                    </li>
                ))}
            </ul>

            <Button type="primary" data-billing-plan-action className="profile-primary-button mt-3 !h-9 w-full !rounded-md text-sm" onClick={() => onSelect(product)}>
                <span className="inline-flex items-center gap-1.5">
                    {isPointsProduct ? "立即充值" : "选择套餐"} <ArrowUpRight className="size-3.5" />
                </span>
            </Button>
        </article>
    );
}

function gridClass(count: number, variant: "modal" | "page") {
    if (variant === "modal") {
        if (count === 1) return "mx-auto max-w-sm items-start gap-3";
        if (count === 2) return "mx-auto w-full grid-cols-2 items-start gap-3";
        if (count === 3) return "mx-auto w-full items-start gap-3 md:grid-cols-3";
        return "mx-auto w-full items-start gap-3 md:grid-cols-2 lg:grid-cols-4";
    }
    if (count === 1) return "mx-auto grid max-w-lg items-stretch gap-5";
    if (count === 2) return "mx-auto grid w-full max-w-[920px] items-stretch gap-5 md:grid-cols-2";
    return "mx-auto grid w-full max-w-6xl items-stretch gap-5 md:grid-cols-2 xl:grid-cols-3";
}

function productMetadata(product: BillingProduct) {
    const metadata = product.metadata && typeof product.metadata === "object" && !Array.isArray(product.metadata) ? (product.metadata as Record<string, unknown>) : {};
    const features = Array.isArray(metadata.features) ? metadata.features.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, 6) : [];
    return {
        recommended: metadata.recommended === true,
        highlight: typeof metadata.highlight === "string" ? metadata.highlight.trim().slice(0, 24) : "",
        features,
    };
}

function featureLines(product: BillingProduct, configured: string[]) {
    if (configured.length) return configured;
    if (product.productKind === "points") return ["订单完成后一次性到账", "人民币余额不会按日过期", "订单与余额流水可查"];
    return ["图片、视频与智能创作", "适用于个人创作与商业项目交付", "订单、套餐和余额流水统一管理", product.periodDays ? `${product.periodDays} 天完整套餐权益` : "长期有效套餐权益"];
}

function periodLabel(periodDays: number) {
    if (!periodDays) return "长期";
    if (periodDays === 30) return "月";
    if (periodDays === 365) return "年";
    return `${periodDays} 天`;
}

function formatYuan(amountCents: number) {
    return (Math.max(0, amountCents) / 100).toLocaleString("zh-CN", { minimumFractionDigits: amountCents % 100 ? 2 : 0, maximumFractionDigits: 2 });
}

function productPricing(product: BillingProduct): BillingProduct["pricing"] {
    return (
        product.pricing || {
            listUnitAmountCents: product.amountCents,
            saleUnitAmountCents: product.amountCents,
            discountCents: 0,
        }
    );
}
