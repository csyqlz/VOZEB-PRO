import { parse } from "parse5";

import { fetchSafeOutbound, UnsafeOutboundUrlError } from "@/lib/server/safe-outbound-fetch";

const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;

export type ProtocolDocumentGroup = {
    key: string;
    label: string;
    sourceUrls: string[];
    text: string;
};

export type ProtocolDocumentSource = {
    groups: ProtocolDocumentGroup[];
    warnings: string[];
    sourcePages: number;
};

type HtmlNode = {
    nodeName?: string;
    tagName?: string;
    value?: string;
    attrs?: Array<{ name: string; value: string }>;
    childNodes?: HtmlNode[];
};

type ProtocolLink = {
    url: string;
    groupKey: string;
    groupLabel: string;
    selectionKey: string;
};

export class ProtocolDocumentFetchError extends Error {
    constructor(
        message: string,
        readonly status = 422,
    ) {
        super(message);
    }
}

export async function readProtocolDocumentSource(documentationUrl: string): Promise<ProtocolDocumentSource> {
    const root = await fetchProtocolPage(documentationUrl);
    if (!root.html) {
        return {
            groups: [{ key: "document", label: "文档", sourceUrls: [root.url], text: root.text }],
            warnings: [],
            sourcePages: 1,
        };
    }

    const rootDocument = extractProtocolHtmlDocument(root.text, root.url);
    const links = selectProtocolDocumentLinks(rootDocument.links, root.url);
    if (!links.length) {
        return {
            groups: [{ key: "document", label: "文档", sourceUrls: [root.url], text: rootDocument.text }],
            warnings: [],
            sourcePages: 1,
        };
    }

    const pages = await Promise.all(
        links.map(async (link) => {
            try {
                const page = await fetchProtocolPage(link.url, new URL(root.url).origin);
                const document = page.html ? extractProtocolHtmlDocument(page.text, page.url) : { text: page.text, links: [] };
                return { link, url: page.url, text: document.text, error: "" };
            } catch (error) {
                return { link, url: link.url, text: "", error: error instanceof Error ? error.message : "读取失败" };
            }
        }),
    );
    const grouped = new Map<string, ProtocolDocumentGroup>();
    const warnings: string[] = [];
    for (const page of pages) {
        if (!page.text.trim()) {
            warnings.push(`${new URL(page.url).pathname}：${page.error || "没有可识别正文"}`);
            continue;
        }
        const current = grouped.get(page.link.groupKey) || { key: page.link.groupKey, label: page.link.groupLabel, sourceUrls: [], text: "" };
        current.sourceUrls.push(page.url);
        current.text = [current.text, `SOURCE ${page.url}\n${page.text}`].filter(Boolean).join("\n\n");
        grouped.set(page.link.groupKey, current);
    }
    return {
        groups: Array.from(grouped.values()),
        warnings,
        sourcePages: 1 + pages.filter((page) => page.text.trim()).length,
    };
}

export function extractProtocolHtmlDocument(source: string, sourceUrl = "http://documentation.local/") {
    const root = parse(source) as unknown as HtmlNode;
    const article = findFirstTag(root, "article");
    return {
        text: visibleNodeText(article || root),
        links: discoverDocumentLinks(root, source, sourceUrl),
    };
}

export function selectProtocolDocumentLinks(urls: string[], rootUrl: string) {
    const root = new URL(rootUrl);
    const selected = new Map<string, ProtocolLink>();
    for (const value of urls) {
        let url: URL;
        try {
            url = new URL(value, root);
        } catch {
            continue;
        }
        if (url.origin !== root.origin) continue;
        const descriptor = describeProtocolLink(url);
        if (descriptor && !selected.has(descriptor.selectionKey)) selected.set(descriptor.selectionKey, descriptor);
    }
    return Array.from(selected.values());
}

async function fetchProtocolPage(url: string, requiredOrigin?: string) {
    let current = url;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
        let response: Response;
        try {
            response = await fetchSafeOutbound(current, {
                headers: { accept: "text/markdown,text/plain,application/json,text/html;q=0.8" },
                cache: "no-store",
                redirect: "manual",
                signal: AbortSignal.timeout(15_000),
            });
        } catch (error) {
            if (error instanceof UnsafeOutboundUrlError) throw new ProtocolDocumentFetchError("文档地址不允许访问内网、保留地址或携带凭据", 400);
            throw error;
        }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get("location");
            if (!location || redirects === MAX_REDIRECTS) throw new ProtocolDocumentFetchError("文档重定向次数过多", 400);
            current = new URL(location, current).toString();
            if (requiredOrigin && new URL(current).origin !== requiredOrigin) throw new ProtocolDocumentFetchError("文档子页面不能重定向到其他站点", 400);
            continue;
        }
        if (!response.ok) throw new ProtocolDocumentFetchError(`读取文档失败（${response.status}）`);
        const length = Number(response.headers.get("content-length") || 0);
        if (length > MAX_DOCUMENT_BYTES) throw new ProtocolDocumentFetchError("单个文档页面超过 512KB 限制", 413);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > MAX_DOCUMENT_BYTES) throw new ProtocolDocumentFetchError("单个文档页面超过 512KB 限制", 413);
        const contentType = response.headers.get("content-type")?.toLowerCase() || "";
        return { url: current, text: bytes.toString("utf8"), html: contentType.includes("text/html") };
    }
    throw new ProtocolDocumentFetchError("读取文档失败");
}

function discoverDocumentLinks(root: HtmlNode, source: string, sourceUrl: string) {
    const links: string[] = [];
    const visit = (node: HtmlNode) => {
        const href = node.attrs?.find((attribute) => attribute.name.toLowerCase() === "href")?.value;
        if (href) links.push(href);
        node.childNodes?.forEach(visit);
    };
    visit(root);
    for (const match of source.matchAll(/(?:\\?["'])href(?:\\?["'])\s*:\s*(?:\\?["'])((?:https?:\/\/|\/)[^"'\\<\s]+)(?:\\?["'])/gi)) {
        links.push(match[1].replace(/\\u0026/gi, "&"));
    }
    return Array.from(
        new Set(
            links.flatMap((value) => {
                try {
                    const url = new URL(value, sourceUrl);
                    url.hash = "";
                    return [url.toString()];
                } catch {
                    return [];
                }
            }),
        ),
    );
}

function describeProtocolLink(url: URL): ProtocolLink | null {
    const segments = url.pathname.split("/").filter(Boolean);
    const documentIndex = segments.findLastIndex((segment) => /^(?:api[-_]?reference|api[-_]?docs?|docs?|documentation|reference|developer)$/i.test(segment));
    const path = segments.slice(documentIndex + 1);
    const lower = path.map((segment) => segment.toLowerCase());
    const modelHub = lower.length === 1 && /^(?:model[-_]?center|models?)$/i.test(lower[0]);
    if (modelHub) {
        return {
            url: url.toString(),
            groupKey: "model-center",
            groupLabel: "模型中心",
            selectionKey: "model-center:hub",
        };
    }
    const capability = documentCapability(lower);
    if (!capability) return null;
    const leaf = lower.at(-1) || "";
    const role = /(?:query|status|detail)(?:$|[-_])/i.test(leaf) ? "query" : /(?:cancel|delete)(?:$|[-_])/i.test(leaf) ? "cancel" : /(?:upload|asset)/i.test(leaf) ? "asset" : "create";
    if (role === "asset") return null;
    const modelCenter = lower[0] === "model-center";
    const family = modelCenter ? "model-center" : lower.length >= 3 ? lower[1] : leaf.replace(/[-_](?:create|query|completions|chat)$/i, "") || capability;
    const groupKey = modelCenter ? "model-center" : `${capability}:${family}`;
    return {
        url: url.toString(),
        groupKey,
        groupLabel: modelCenter ? "模型中心" : `${capabilityLabel(capability)} · ${family}`,
        selectionKey: `${groupKey}:${capability}:${role}`,
    };
}

function documentCapability(path: string[]) {
    const joined = `/${path.join("/")}/`;
    if (/\/(?:text|llm|chat)\//i.test(joined)) return "text";
    if (/\/(?:image|image-gen|images)\//i.test(joined)) return "image";
    if (/\/(?:video|video-gen|digital-human)\//i.test(joined)) return "video";
    if (/\/(?:audio|sound|speech|music|sound-clone)\//i.test(joined)) return "audio";
    return "";
}

function capabilityLabel(capability: string) {
    return capability === "text" ? "文本" : capability === "image" ? "图片" : capability === "video" ? "视频" : "音频";
}

function findFirstTag(node: HtmlNode, tagName: string): HtmlNode | null {
    if (node.tagName?.toLowerCase() === tagName) return node;
    for (const child of node.childNodes || []) {
        const found = findFirstTag(child, tagName);
        if (found) return found;
    }
    return null;
}

function visibleNodeText(root: HtmlNode) {
    const values: string[] = [];
    const blocks = new Set(["article", "aside", "blockquote", "br", "code", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "p", "pre", "section", "table", "td", "th", "tr"]);
    const visit = (node: HtmlNode) => {
        const tag = node.tagName?.toLowerCase();
        if (tag && ["script", "style", "template", "noscript"].includes(tag)) return;
        if (tag && blocks.has(tag)) values.push("\n");
        if (node.nodeName === "#text" && node.value) values.push(node.value);
        node.childNodes?.forEach(visit);
        if (tag && blocks.has(tag)) values.push("\n");
    };
    visit(root);
    return values
        .join("")
        .split(/\r?\n/)
        .map((line) => line.replace(/[\t ]+/g, " ").trim())
        .filter(Boolean)
        .join("\n");
}
