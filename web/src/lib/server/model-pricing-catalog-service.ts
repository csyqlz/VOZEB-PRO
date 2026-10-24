import { randomUUID } from "node:crypto";

import { PricingConflictError, PricingInputError, type OfficialPriceCatalogEntry, type OfficialPriceInput } from "@/lib/model-pricing";

import { listOfficialPriceCatalog, insertOfficialPriceCatalog, updateOfficialPriceCatalog, deleteOfficialPriceCatalog, getOfficialPriceCatalogUsage } from "./model-pricing-catalog-store";
import { listOfficialPriceSources } from "./model-pricing-store";

type CatalogInput = { manufacturer?: unknown; kind?: unknown; parentId?: unknown; name?: unknown; capability?: unknown; sku?: unknown; sourceUrl?: unknown; evidence?: unknown };

const required = (value: unknown, label: string, max: number) => {
    if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new PricingInputError(`请填写有效的${label}`);
    return value.trim();
};

export async function getOfficialPriceCatalog(manufacturer: string) {
    const name = required(manufacturer, "厂商", 80);
    return listOfficialPriceCatalog(name);
}

export async function getOfficialPriceCatalogImpact(manufacturer: string, id: string) {
    const entries = await getOfficialPriceCatalog(manufacturer);
    const entry = entries.find((item) => item.id === required(id, "目录项", 80));
    if (!entry) throw new PricingInputError("目录项不存在，请刷新后重试");
    const usage = await getOfficialPriceCatalogUsage(entry);
    return { ...usage, childVersions: entries.filter((item) => item.parentId === entry.id).length };
}

export async function resolveOfficialPriceCatalogLink(input: OfficialPriceInput, capability?: string): Promise<OfficialPriceInput> {
    if (!input.catalogVersionId) return input;
    const entries = await listOfficialPriceCatalog(input.manufacturer);
    const version = entries.find((item) => item.id === input.catalogVersionId && item.kind === "version");
    const series = entries.find((item) => item.id === version?.parentId && item.kind === "series");
    if (!version || (version.parentId && !series) || version.sku !== input.sku || (capability && (series?.capability || version.capability) !== capability)) {
        throw new PricingInputError("官方目录型号、厂商、能力或模型 ID 已变化，请重新选择；手动录入可不关联目录");
    }
    return { ...input, series: series?.name || "", officialVersion: version.name };
}

async function catalogFields(raw: CatalogInput) {
    const manufacturer = required(raw.manufacturer, "厂商", 80);
    if (!(await listOfficialPriceSources()).some((source) => source.manufacturer === manufacturer)) throw new PricingInputError("请先在官网来源链接中登记厂商");
    if (raw.kind !== "series" && raw.kind !== "version") throw new PricingInputError("目录类型无效");
    const name = required(raw.name, raw.kind === "series" ? "系列名称" : "官网型号", 120);
    const sourceUrl = required(raw.sourceUrl, "官网来源", 2048);
    let url: URL;
    try {
        url = new URL(sourceUrl);
    } catch {
        throw new PricingInputError("官网来源必须是 HTTPS 地址");
    }
    if (url.protocol !== "https:" || url.username || url.password) throw new PricingInputError("官网来源必须是 HTTPS 地址");
    const evidence = required(raw.evidence, "官网命名依据", 10000);
    let parentId: string | null = null;
    let capability: string | null = null;
    let sku: string | null = null;
    if (raw.kind === "series") {
        capability = required(raw.capability, "适用能力", 20);
        if (!["text", "image", "video", "audio"].includes(capability)) throw new PricingInputError("适用能力无效");
    } else {
        parentId = typeof raw.parentId === "string" && raw.parentId.trim() ? required(raw.parentId, "所属系列", 80) : null;
        sku = required(raw.sku, "官方模型 ID", 120);
        if (parentId) {
            const parent = (await listOfficialPriceCatalog(manufacturer)).find((item) => item.id === parentId && item.kind === "series");
            if (!parent) throw new PricingInputError("所属系列不存在或不属于该厂商");
        } else {
            capability = required(raw.capability, "适用能力", 20);
            if (!["text", "image", "video", "audio"].includes(capability)) throw new PricingInputError("适用能力无效");
        }
    }
    return { manufacturer, kind: raw.kind as "series" | "version", parentId, name, capability, sku, sourceUrl: url.toString(), evidence };
}

export async function createOfficialPriceCatalog(raw: CatalogInput, actorId: string): Promise<OfficialPriceCatalogEntry> {
    const fields = await catalogFields(raw);
    return insertOfficialPriceCatalog({ id: randomUUID(), ...fields, createdAt: new Date().toISOString(), createdBy: actorId });
}

export async function editOfficialPriceCatalog(raw: CatalogInput & { id?: unknown; expected?: unknown }, actorId: string): Promise<OfficialPriceCatalogEntry> {
    const id = required(raw.id, "目录项", 80);
    const fields = await catalogFields(raw);
    const expected = raw.expected as OfficialPriceCatalogEntry | undefined;
    if (!expected || expected.id !== id || expected.manufacturer !== fields.manufacturer || expected.kind !== fields.kind) throw new PricingInputError("请提供当前目录项以核对修改");
    const current = (await listOfficialPriceCatalog(fields.manufacturer)).find((item) => item.id === id);
    if (!current || JSON.stringify(current) !== JSON.stringify(expected)) throw new PricingConflictError("目录项已变化，请刷新后重试");
    if (current.kind === "series" && current.capability !== fields.capability) {
        const children = (await listOfficialPriceCatalog(fields.manufacturer)).filter((item) => item.parentId === id);
        for (const child of children) {
            const usage = await getOfficialPriceCatalogUsage(child);
            if (usage.pending || usage.approved || usage.called) throw new PricingConflictError("该系列下的型号已有价目或调用引用，不能修改系列能力；可修改展示名称和证据");
        }
    }
    return updateOfficialPriceCatalog({ ...current, ...fields, updatedAt: new Date().toISOString(), updatedBy: actorId }, expected);
}

export async function removeOfficialPriceCatalog(raw: { id?: unknown; manufacturer?: unknown; expected?: unknown }): Promise<void> {
    const id = required(raw.id, "目录项", 80);
    const manufacturer = required(raw.manufacturer, "厂商", 80);
    const expected = raw.expected as OfficialPriceCatalogEntry | undefined;
    if (!expected || expected.id !== id || expected.manufacturer !== manufacturer) throw new PricingInputError("请提供当前目录项以核对删除");
    const entries = await listOfficialPriceCatalog(manufacturer);
    const current = entries.find((item) => item.id === id);
    if (!current || JSON.stringify(current) !== JSON.stringify(expected)) throw new PricingConflictError("目录项已变化，请刷新后重试");
    if (entries.some((item) => item.parentId === id)) throw new PricingConflictError("请先删除或调整该系列下的型号");
    await deleteOfficialPriceCatalog(expected);
}
