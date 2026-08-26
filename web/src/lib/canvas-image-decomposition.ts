export const CANVAS_IMAGE_LAYER_KINDS = ["product", "person", "headline", "text", "logo", "badge", "decoration", "foreground"] as const;

export type CanvasImageLayerKind = (typeof CANVAS_IMAGE_LAYER_KINDS)[number];
export type CanvasImageDecompositionStrategy = "ecommerce" | "subject";

export type CanvasImageLayerBox = {
    x: number;
    y: number;
    width: number;
    height: number;
};

export type CanvasImageLayerPoint = {
    x: number;
    y: number;
};

export type CanvasImageLayerCandidate = {
    id: string;
    name: string;
    kind: CanvasImageLayerKind;
    bbox: CanvasImageLayerBox;
    zIndex: number;
    groupId?: string;
    confidence?: number;
    regions?: CanvasImageLayerBox[];
    focusPoints?: CanvasImageLayerPoint[];
};

export type CanvasImageDecomposition = {
    strategy: CanvasImageDecompositionStrategy;
    width: number;
    height: number;
    backgroundDescription: string;
    backgroundPreservedVisuals: string[];
    layers: CanvasImageLayerCandidate[];
};

export type CanvasImageDecompositionResponse = CanvasImageDecomposition & {
    batchGrant: string;
};

export function canvasImageLayerSlotId(layerId: string) {
    return `layer:${layerId}`;
}

const layerKinds = new Set<string>(CANVAS_IMAGE_LAYER_KINDS);

export function normalizeCanvasImageDecomposition(value: unknown, width: number, height: number): CanvasImageDecomposition | null {
    if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1 || !isRecord(value) || !Array.isArray(value.layers)) return null;
    const strategy = value.strategy === "ecommerce" || value.strategy === "subject" ? value.strategy : null;
    if (!strategy) return null;
    const seen = new Map<string, CanvasImageLayerKind>();
    const usedIds = new Set<string>();
    const layers = value.layers.flatMap((entry, index): CanvasImageLayerCandidate[] => {
        if (!isRecord(entry) || !layerKinds.has(String(entry.kind || ""))) return [];
        const bbox = normalizeBox(entry.bbox, width, height);
        if (!bbox) return [];
        if (bbox.x === 0 && bbox.y === 0 && bbox.width === width && bbox.height === height) return [];
        const kind = entry.kind as CanvasImageLayerKind;
        const key = `${bbox.x}:${bbox.y}:${bbox.width}:${bbox.height}`;
        const previousKind = seen.get(key);
        if (previousKind === kind) return [];
        if (previousKind && !isSemanticOverlayLayer(previousKind) && !isSemanticOverlayLayer(kind)) return [];
        if (!previousKind) seen.set(key, kind);
        const confidence = Number(entry.confidence);
        const focusPoints = normalizeFocusPoints(entry.focusPoints, bbox, width, height);
        const requestedId = text(entry.id) || `layer-${index + 1}`;
        const id = uniqueLayerId(requestedId, usedIds);
        return [
            {
                id,
                name: text(entry.name) || canvasImageLayerKindLabel(kind),
                kind,
                bbox,
                zIndex: Number.isFinite(Number(entry.zIndex)) ? Math.round(Number(entry.zIndex)) : index,
                ...(text(entry.groupId) ? { groupId: text(entry.groupId) } : {}),
                ...(Number.isFinite(confidence) ? { confidence: Math.min(1, Math.max(0, confidence)) } : {}),
                regions: [bbox],
                focusPoints: focusPoints.length ? focusPoints : [boxCenter(bbox)],
            },
        ];
    });
    if (!layers.length) return null;
    const mergedLayers = mergeConnectedLayers(layers);
    return {
        strategy,
        width,
        height,
        backgroundDescription: text(value.backgroundDescription),
        backgroundPreservedVisuals: stringList(value.backgroundPreservedVisuals),
        layers: mergedLayers.sort((left, right) => left.zIndex - right.zIndex),
    };
}

function uniqueLayerId(requestedId: string, usedIds: Set<string>) {
    if (!usedIds.has(requestedId)) {
        usedIds.add(requestedId);
        return requestedId;
    }
    let suffix = 2;
    while (usedIds.has(`${requestedId}-${suffix}`)) suffix += 1;
    const id = `${requestedId}-${suffix}`;
    usedIds.add(id);
    return id;
}

function isSemanticOverlayLayer(kind: CanvasImageLayerKind) {
    return kind === "headline" || kind === "text" || kind === "logo" || kind === "badge" || kind === "decoration";
}

function mergeConnectedLayers(layers: CanvasImageLayerCandidate[]) {
    const mergeable = layers.filter((layer) => layer.groupId || isPhysicalLayer(layer) || isTextLayer(layer));
    const parent = new Map<string, string>(mergeable.map((layer) => [layer.id, layer.id]));
    for (let index = 0; index < mergeable.length; index += 1) {
        for (let next = index + 1; next < mergeable.length; next += 1) {
            if (!canMergeLayers(mergeable[index], mergeable[next])) continue;
            union(parent, mergeable[index].id, mergeable[next].id);
        }
    }
    const groups = new Map<string, CanvasImageLayerCandidate[]>();
    for (const layer of mergeable) {
        const root = find(parent, layer.id);
        const group = groups.get(root) || [];
        group.push(layer);
        groups.set(root, group);
    }
    const merged = new Map<string, CanvasImageLayerCandidate>();
    for (const layer of layers) {
        if (!parent.has(layer.id)) {
            merged.set(layer.id, layer);
            continue;
        }
        const group = groups.get(find(parent, layer.id)) || [layer];
        if (merged.has(group[0].id)) continue;
        const bbox = group.reduce((result, item) => unionBox(result, item.bbox), group[0].bbox);
        merged.set(group[0].id, {
            ...group[0],
            name: group.length > 1 ? group.map((item) => item.name).join("、") : group[0].name,
            kind: group.some((item) => item.kind === "product") ? "product" : group.some((item) => item.kind === "headline") ? "headline" : group[0].kind,
            bbox,
            zIndex: Math.min(...group.map((item) => item.zIndex)),
            confidence: Math.min(...group.map((item) => item.confidence ?? 1)),
            regions: uniqueBoxes(group.flatMap((item) => item.regions || [item.bbox])),
            focusPoints: uniquePoints(group.flatMap((item) => item.focusPoints || [boxCenter(item.bbox)])),
        });
    }
    return [...merged.values()];
}

function canMergeLayers(left: CanvasImageLayerCandidate, right: CanvasImageLayerCandidate) {
    if (left.groupId && right.groupId && left.groupId === right.groupId) return true;
    if (isPhysicalLayer(left) && isPhysicalLayer(right)) return canMergePhysicalLayers(left, right) && boxesTouch(left.bbox, right.bbox);
    if (!isTextLayer(left) || !isTextLayer(right)) return false;
    return relatedTextBoxes(left.bbox, right.bbox);
}

function boxesTouch(left: CanvasImageLayerBox, right: CanvasImageLayerBox) {
    return left.x <= right.x + right.width && right.x <= left.x + left.width && left.y <= right.y + right.height && right.y <= left.y + left.height;
}

function canMergePhysicalLayers(left: CanvasImageLayerCandidate, right: CanvasImageLayerCandidate) {
    return left.kind === right.kind || left.kind === "foreground" || right.kind === "foreground";
}

function isPhysicalLayer(layer: CanvasImageLayerCandidate) {
    return layer.kind === "product" || layer.kind === "person" || layer.kind === "foreground";
}

function isTextLayer(layer: CanvasImageLayerCandidate) {
    return layer.kind === "headline" || layer.kind === "text";
}

function relatedTextBoxes(left: CanvasImageLayerBox, right: CanvasImageLayerBox) {
    const horizontalOverlap = overlapLength(left.x, left.x + left.width, right.x, right.x + right.width);
    const verticalOverlap = overlapLength(left.y, left.y + left.height, right.y, right.y + right.height);
    const horizontalGap = Math.max(left.x - (right.x + right.width), right.x - (left.x + left.width), 0);
    const verticalGap = Math.max(left.y - (right.y + right.height), right.y - (left.y + left.height), 0);
    const minHeight = Math.max(1, Math.min(left.height, right.height));
    const minWidth = Math.max(1, Math.min(left.width, right.width));
    return (verticalOverlap >= minHeight * 0.35 && horizontalGap <= Math.max(12, minHeight * 0.9)) || (horizontalOverlap >= minWidth * 0.35 && verticalGap <= Math.max(4, minHeight * 0.35));
}

function overlapLength(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number) {
    return Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart));
}

function unionBox(left: CanvasImageLayerBox, right: CanvasImageLayerBox): CanvasImageLayerBox {
    const x = Math.min(left.x, right.x);
    const y = Math.min(left.y, right.y);
    const rightEdge = Math.max(left.x + left.width, right.x + right.width);
    const bottom = Math.max(left.y + left.height, right.y + right.height);
    return { x, y, width: rightEdge - x, height: bottom - y };
}

function find(parent: Map<string, string>, id: string): string {
    const current = parent.get(id) || id;
    if (current === id) return id;
    const root = find(parent, current);
    parent.set(id, root);
    return root;
}

function union(parent: Map<string, string>, left: string, right: string) {
    const leftRoot = find(parent, left);
    const rightRoot = find(parent, right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
}

export function canvasImageLayerKindLabel(kind: CanvasImageLayerKind) {
    return {
        product: "商品",
        person: "人物",
        headline: "标题",
        text: "文字",
        logo: "Logo",
        badge: "角标",
        decoration: "装饰",
        foreground: "前景",
    }[kind];
}

export const canvasImageDecompositionTool = {
    name: "decompose_ecommerce_image",
    description: "识别电商海报中需要独立保留的前景视觉元素及其原图像素坐标",
    parameters: {
        type: "object",
        properties: {
            strategy: { type: "string", enum: ["ecommerce", "subject"] },
            backgroundDescription: { type: "string" },
            backgroundPreservedVisuals: {
                type: "array",
                items: { type: "string" },
            },
            layers: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        id: { type: "string" },
                        name: { type: "string" },
                        groupId: { type: "string" },
                        kind: { type: "string", enum: CANVAS_IMAGE_LAYER_KINDS },
                        bbox: {
                            type: "object",
                            properties: {
                                x: { type: "number" },
                                y: { type: "number" },
                                width: { type: "number" },
                                height: { type: "number" },
                            },
                            required: ["x", "y", "width", "height"],
                            additionalProperties: false,
                        },
                        focusPoints: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    x: { type: "number" },
                                    y: { type: "number" },
                                },
                                required: ["x", "y"],
                                additionalProperties: false,
                            },
                        },
                        zIndex: { type: "number" },
                        confidence: { type: "number", minimum: 0, maximum: 1 },
                    },
                    required: ["id", "name", "groupId", "kind", "bbox", "focusPoints", "zIndex"],
                    additionalProperties: false,
                },
            },
        },
        required: ["strategy", "backgroundPreservedVisuals", "layers"],
        additionalProperties: false,
    },
} as const;

export function canvasImageDecompositionInstruction(width: number, height: number) {
    return [
        "你是 VOZEB PRO 图片分层分析器。分析用户提供的完整图片，并调用 decompose_ecommerce_image。",
        `所有 bbox 必须使用原图 ${width}x${height} 的整数像素坐标，禁止使用百分比或归一化坐标。`,
        "先判断整张图片的 strategy：电商海报、营销视觉、商品设计图或包含多个可独立排版元素的图片必须是 ecommerce；普通单人物或单主体照片可以是 subject。strategy 只描述画面类型，不改变后续任务链路。",
        "完整识别所有需要独立保留的前景视觉元素：主商品和商品组合、人物、标题或艺术字、普通说明文字、品牌 Logo、促销角标或标签、棉花/光效/贴纸等装饰，以及其他独立前景物体。",
        "画面外置的标题、副标题、正文、价格、单位、按钮文案和促销底牌上的文字都必须返回 headline 或 text 层；文字按原图像素作为视觉元素处理，不需要输出 OCR 文案或可编辑字体信息。一个完整词语、短句、价格块或同一文字排版区域必须是一个 text/headline 层，禁止按单字、单笔画或每个字母拆成多个层；只有商品包装印刷文字和不可拆分的品牌字标保留在商品或 Logo 图片层中。",
        "文字、Logo、角标和装饰不能因为不是主商品而省略；不要把整张海报或整片前景合并成一个主体框。每个独立商品、人物或前景物体分别返回紧贴可见轮廓的 bbox。一个连续、相连、相互遮挡或必须一起移动的商品组合（例如同一包装的盒体、盖子、抽纸、配件和连接装饰）必须只返回一个 product/foreground 层，不能按局部包装、图案或零件重复拆开；只有彼此分离且可以独立移动的元素才分别返回。商品包装自身印刷的文字和 Logo 属于商品画面，不能再重复拆成文字层或 Logo 层。",
        "groupId 表示最终独立移动的视觉资产。属于同一个完整主体的局部即使被分别观察到，也必须使用相同 groupId；不同主体必须使用不同 groupId。一个完整词语、价格块或同一排版区域也使用同一个 groupId，禁止每个字单独成组。",
        "每个层必须提供 focusPoints，坐标同样使用原图整数像素。主体每个彼此断开的可见部分至少给一个落在实体内部、不能落在背景或透明间隙上的点：商品组合给每个独立包装或相连部件一个点，文字块给每行、每个断开的词组或独立字形一个点，Logo、角标和装饰给每个断开图形一个点。focusPoints 只用于本地语义抠图，不会形成额外节点。",
        "连续的摄影或插画场景、纹理、地面、桌面、光影、反射，以及已经融入场景的装饰属于背景，不放入 layers；把这些必须保留的背景内容简要列入 backgroundPreservedVisuals。只有可独立移动和复用的元素才返回图层。",
        "bbox 只用于定位透明资产编辑的参考范围，必须完整包住元素且不要裁掉边缘。每个最终 groupId 对应一个可独立移动的透明 PNG 元素，包括文字。相连实体的 bbox 可以覆盖整个连接组合，但不能包含大片无关背景；不要为同一实体返回相互重叠的 product/person/foreground 框。普通单主体图片也必须返回至少一个主体层，背景本身不放入 layers，backgroundDescription 只简要描述移除独立图层后应保留的背景。",
        "只返回工具参数，不输出解释、Markdown 或内部分析过程。",
    ].join("\n");
}

function normalizeBox(value: unknown, width: number, height: number): CanvasImageLayerBox | null {
    if (!isRecord(value)) return null;
    const values = [value.x, value.y, value.width, value.height].map(Number);
    if (!values.every(Number.isFinite)) return null;
    const [x, y, boxWidth, boxHeight] = values;
    const left = clamp(Math.min(x, x + boxWidth), 0, width);
    const top = clamp(Math.min(y, y + boxHeight), 0, height);
    const right = clamp(Math.max(x, x + boxWidth), 0, width);
    const bottom = clamp(Math.max(y, y + boxHeight), 0, height);
    const normalized = { x: Math.round(left), y: Math.round(top), width: Math.round(right) - Math.round(left), height: Math.round(bottom) - Math.round(top) };
    return normalized.width > 0 && normalized.height > 0 ? normalized : null;
}

function normalizeFocusPoints(value: unknown, bbox: CanvasImageLayerBox, width: number, height: number) {
    if (!Array.isArray(value)) return [];
    return uniquePoints(
        value.flatMap((entry): CanvasImageLayerPoint[] => {
            if (!isRecord(entry)) return [];
            const x = Math.round(Number(entry.x));
            const y = Math.round(Number(entry.y));
            if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= width || y >= height) return [];
            if (x < bbox.x || x > bbox.x + bbox.width || y < bbox.y || y > bbox.y + bbox.height) return [];
            return [{ x, y }];
        }),
    );
}

function boxCenter(box: CanvasImageLayerBox): CanvasImageLayerPoint {
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

function uniqueBoxes(boxes: CanvasImageLayerBox[]) {
    return [...new Map(boxes.map((box) => [`${box.x}:${box.y}:${box.width}:${box.height}`, box])).values()];
}

function uniquePoints(points: CanvasImageLayerPoint[]) {
    return [...new Map(points.map((point) => [`${point.x}:${point.y}`, point])).values()];
}

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown) {
    return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
