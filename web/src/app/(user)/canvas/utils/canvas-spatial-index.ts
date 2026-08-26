import type { CanvasNodeData, Position } from "../types";

export type CanvasBounds = {
    left: number;
    top: number;
    right: number;
    bottom: number;
};

type SpatialItem = { id: string };

export type CanvasSpatialIndex<T extends SpatialItem> = {
    query: (bounds: CanvasBounds) => T[];
    queryPoint: (point: Position, padding?: number) => T[];
};

const SPATIAL_CELL_SIZE = 512;

export function buildCanvasSpatialIndex<T extends SpatialItem>(items: readonly T[], getBounds: (item: T) => CanvasBounds | null): CanvasSpatialIndex<T> {
    const cells = new Map<string, T[]>();
    const boundsById = new Map<string, CanvasBounds>();

    for (const item of items) {
        const bounds = getBounds(item);
        if (!bounds || bounds.right < bounds.left || bounds.bottom < bounds.top) continue;
        boundsById.set(item.id, bounds);
        const firstColumn = Math.floor(bounds.left / SPATIAL_CELL_SIZE);
        const lastColumn = Math.floor(bounds.right / SPATIAL_CELL_SIZE);
        const firstRow = Math.floor(bounds.top / SPATIAL_CELL_SIZE);
        const lastRow = Math.floor(bounds.bottom / SPATIAL_CELL_SIZE);
        for (let row = firstRow; row <= lastRow; row += 1) {
            for (let column = firstColumn; column <= lastColumn; column += 1) {
                const key = `${column}:${row}`;
                const bucket = cells.get(key);
                if (bucket) bucket.push(item);
                else cells.set(key, [item]);
            }
        }
    }

    const query = (bounds: CanvasBounds) => {
        const result: T[] = [];
        const seen = new Set<string>();
        const firstColumn = Math.floor(bounds.left / SPATIAL_CELL_SIZE);
        const lastColumn = Math.floor(bounds.right / SPATIAL_CELL_SIZE);
        const firstRow = Math.floor(bounds.top / SPATIAL_CELL_SIZE);
        const lastRow = Math.floor(bounds.bottom / SPATIAL_CELL_SIZE);
        for (let row = firstRow; row <= lastRow; row += 1) {
            for (let column = firstColumn; column <= lastColumn; column += 1) {
                const bucket = cells.get(`${column}:${row}`);
                if (!bucket) continue;
                for (const item of bucket) {
                    if (seen.has(item.id)) continue;
                    const itemBounds = boundsById.get(item.id);
                    if (!itemBounds || !intersects(itemBounds, bounds)) continue;
                    seen.add(item.id);
                    result.push(item);
                }
            }
        }
        return result;
    };

    return {
        query,
        queryPoint: (point, padding = 0) => query({ left: point.x - padding, top: point.y - padding, right: point.x + padding, bottom: point.y + padding }),
    };
}

export function canvasNodeBounds(node: CanvasNodeData, padding = 0): CanvasBounds {
    return { left: node.position.x - padding, top: node.position.y - padding, right: node.position.x + node.width + padding, bottom: node.position.y + node.height + padding };
}

export function canvasNodesBounds(nodes: readonly CanvasNodeData[], paddingX = 320, paddingY = 240): CanvasBounds {
    if (!nodes.length) return { left: -500, top: -400, right: 500, bottom: 400 };
    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (const node of nodes) {
        left = Math.min(left, node.position.x);
        top = Math.min(top, node.position.y);
        right = Math.max(right, node.position.x + node.width);
        bottom = Math.max(bottom, node.position.y + node.height);
    }
    return { left: left - paddingX, top: top - paddingY, right: right + paddingX, bottom: bottom + paddingY };
}

function intersects(left: CanvasBounds, right: CanvasBounds) {
    return left.left <= right.right && left.right >= right.left && left.top <= right.bottom && left.bottom >= right.top;
}
