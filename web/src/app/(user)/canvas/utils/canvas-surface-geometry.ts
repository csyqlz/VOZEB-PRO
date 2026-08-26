import { CanvasNodeType, type CanvasNodeData, type Position, type ViewportTransform } from "../types";

const HANDLE_CLEARANCE = 32;
const FORWARD_GAP = HANDLE_CLEARANCE * 2;
const CORNER_RADIUS = 14;
const NODE_ROUTE_CLEARANCE = 12;

export function worldFromScreen(clientX: number, clientY: number, viewport: ViewportTransform, rect: Pick<DOMRect, "left" | "top">): Position {
    return { x: (clientX - rect.left - viewport.x) / viewport.k, y: (clientY - rect.top - viewport.y) / viewport.k };
}

export function isCanvasVideoControlPoint(rect: Pick<DOMRect, "bottom" | "height">, clientY: number) {
    const controlsHeight = Math.max(40, Math.min(72, rect.height * 0.22));
    return clientY >= rect.bottom - controlsHeight;
}

export function nodeAnchor(node: CanvasNodeData, handleType: "source" | "target"): Position {
    return { x: handleType === "source" ? node.position.x + node.width : node.position.x, y: node.position.y + node.height / 2 };
}

export function edgePath(from: CanvasNodeData, to: CanvasNodeData, obstacles: CanvasNodeData[] = []) {
    const start = nodeAnchor(from, "source");
    const end = nodeAnchor(to, "target");
    const forwardDistance = end.x - start.x;
    const blockingNodes = obstacles.filter((node) => node.id !== from.id && node.id !== to.id);

    if (forwardDistance >= FORWARD_GAP) {
        const curve = forwardCurve(start, end, 1, forwardDistance);
        if (!blockingNodes.length || curveIsClear(curve, blockingNodes)) return curve.path;

        const routeAbove = Math.min(from.position.y, to.position.y, ...blockingNodes.map((node) => node.position.y)) - HANDLE_CLEARANCE;
        const routeBelow = Math.max(from.position.y + from.height, to.position.y + to.height, ...blockingNodes.map((node) => node.position.y + node.height)) + HANDLE_CLEARANCE;
        const startPortX = start.x + HANDLE_CLEARANCE;
        const endPortX = end.x - HANDLE_CLEARANCE;
        const candidates = [routeAbove, routeBelow].map((routeY) => [start, { x: startPortX, y: start.y }, { x: startPortX, y: routeY }, { x: endPortX, y: routeY }, { x: endPortX, y: end.y }, end]);
        const clear = candidates.filter((candidate) => routeIsClear(candidate, blockingNodes)).sort((left, right) => routeLength(left) - routeLength(right));
        return clear.length ? roundedPolyline(clear[0]) : curve.path;
    }

    const base = baseEdgeRoute(from, to, start, end);
    if (!blockingNodes.length || routeIsClear(base, blockingNodes)) return roundedPolyline(base);

    const routeAbove = Math.min(from.position.y, to.position.y, ...blockingNodes.map((node) => node.position.y)) - HANDLE_CLEARANCE;
    const routeBelow = Math.max(from.position.y + from.height, to.position.y + to.height, ...blockingNodes.map((node) => node.position.y + node.height)) + HANDLE_CLEARANCE;
    const startPortX = start.x + HANDLE_CLEARANCE;
    const endPortX = end.x - HANDLE_CLEARANCE;
    const candidates = [routeAbove, routeBelow].map((routeY) => [start, { x: startPortX, y: start.y }, { x: startPortX, y: routeY }, { x: endPortX, y: routeY }, { x: endPortX, y: end.y }, end]);
    const clear = candidates.filter((candidate) => routeIsClear(candidate, blockingNodes)).sort((left, right) => routeLength(left) - routeLength(right));
    return roundedPolyline(clear[0] || base);
}

function baseEdgeRoute(from: CanvasNodeData, to: CanvasNodeData, start: Position, end: Position) {
    const fromBottom = from.position.y + from.height;
    const toBottom = to.position.y + to.height;
    if (fromBottom <= to.position.y) return gapRoutePoints(start, end, (fromBottom + to.position.y) / 2);
    if (toBottom <= from.position.y) return gapRoutePoints(start, end, (toBottom + from.position.y) / 2);

    const routeAbove = Math.min(from.position.y, to.position.y) - HANDLE_CLEARANCE;
    const routeBelow = Math.max(fromBottom, toBottom) + HANDLE_CLEARANCE;
    const routeY = Math.abs(start.y - routeAbove) + Math.abs(end.y - routeAbove) <= Math.abs(start.y - routeBelow) + Math.abs(end.y - routeBelow) ? routeAbove : routeBelow;
    const outerRight = Math.max(start.x, to.position.x + to.width) + HANDLE_CLEARANCE;
    const outerLeft = Math.min(end.x, from.position.x) - HANDLE_CLEARANCE;
    return [start, { x: outerRight, y: start.y }, { x: outerRight, y: routeY }, { x: outerLeft, y: routeY }, { x: outerLeft, y: end.y }, end];
}

export function previewPath(start: Position, end: Position, handleType: "source" | "target") {
    const direction = handleType === "source" ? 1 : -1;
    const forwardDistance = (end.x - start.x) * direction;
    if (forwardDistance >= FORWARD_GAP) return forwardCurve(start, end, direction, forwardDistance).path;

    const routeY = (start.y + end.y) / 2;
    return roundedPolyline([
        start,
        { x: start.x + direction * HANDLE_CLEARANCE, y: start.y },
        { x: start.x + direction * HANDLE_CLEARANCE, y: routeY },
        { x: end.x - direction * HANDLE_CLEARANCE, y: routeY },
        { x: end.x - direction * HANDLE_CLEARANCE, y: end.y },
        end,
    ]);
}

export function samePosition(a: Position, b: Position) {
    return Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
}

export function selectNodesInBounds(nodes: CanvasNodeData[], start: Position, end: Position, initialNodeIds: Iterable<string> = []) {
    const minX = Math.min(start.x, end.x);
    const maxX = Math.max(start.x, end.x);
    const minY = Math.min(start.y, end.y);
    const maxY = Math.max(start.y, end.y);
    const selected = new Set(initialNodeIds);
    for (const node of nodes) {
        if (node.position.x < maxX && node.position.x + node.width > minX && node.position.y < maxY && node.position.y + node.height > minY) selected.add(node.id);
    }
    return selected;
}

export function expandCanvasDragNodeIds(nodes: CanvasNodeData[], selectedNodeIds: Iterable<string>) {
    const dragNodeIds = new Set(selectedNodeIds);
    for (const node of nodes) {
        if (!dragNodeIds.has(node.id)) continue;
        node.metadata?.batchChildIds?.forEach((childId) => dragNodeIds.add(childId));
    }
    return [...dragNodeIds];
}

export function findConnectionTarget(world: Position, draft: { nodeId: string; handleType: "source" | "target" }, nodes: CanvasNodeData[], scale: number) {
    const tolerance = 52 / Math.max(scale, 0.1);
    let best: { id: string; distance: number } | null = null;
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const node = nodes[index];
        if (node.id === draft.nodeId || (draft.handleType === "target" && node.type === CanvasNodeType.Config)) continue;
        const anchor = nodeAnchor(node, draft.handleType === "source" ? "target" : "source");
        const inside = world.x >= node.position.x && world.x <= node.position.x + node.width && world.y >= node.position.y && world.y <= node.position.y + node.height;
        const distance = Math.hypot(world.x - anchor.x, world.y - anchor.y);
        if (!inside && distance > tolerance) continue;
        if (!best || distance < best.distance) best = { id: node.id, distance };
    }
    return best?.id || null;
}

export function isBlockedConnectionDrop(world: Position, draft: { nodeId: string; handleType: "source" | "target" }, nodes: CanvasNodeData[], scale: number) {
    const tolerance = 52 / Math.max(scale, 0.1);
    return nodes.some((node) => {
        const blocked = node.id === draft.nodeId || (draft.handleType === "target" && node.type === CanvasNodeType.Config);
        if (!blocked) return false;
        const anchor = nodeAnchor(node, draft.handleType === "source" ? "target" : "source");
        const inside = world.x >= node.position.x && world.x <= node.position.x + node.width && world.y >= node.position.y && world.y <= node.position.y + node.height;
        return inside || Math.hypot(world.x - anchor.x, world.y - anchor.y) <= tolerance;
    });
}

function forwardCurve(start: Position, end: Position, direction: 1 | -1, forwardDistance: number) {
    const curvature = Math.min(Math.max(forwardDistance * 0.5, 50), 240);
    const controlStart = { x: start.x + direction * curvature, y: start.y };
    const controlEnd = { x: end.x - direction * curvature, y: end.y };
    return { path: `M ${format(start.x)} ${format(start.y)} C ${format(controlStart.x)} ${format(controlStart.y)}, ${format(controlEnd.x)} ${format(controlEnd.y)}, ${format(end.x)} ${format(end.y)}`, start, controlStart, controlEnd, end };
}

function gapRoutePoints(start: Position, end: Position, routeY: number) {
    return [start, { x: start.x + HANDLE_CLEARANCE, y: start.y }, { x: start.x + HANDLE_CLEARANCE, y: routeY }, { x: end.x - HANDLE_CLEARANCE, y: routeY }, { x: end.x - HANDLE_CLEARANCE, y: end.y }, end];
}

function routeIsClear(points: Position[], nodes: CanvasNodeData[]) {
    return points.slice(1).every((point, index) => nodes.every((node) => !segmentIntersectsNode(points[index], point, node)));
}

function curveIsClear(curve: ReturnType<typeof forwardCurve>, nodes: CanvasNodeData[]) {
    return nodes.every((node) => !cubicIntersectsNode(curve.start, curve.controlStart, curve.controlEnd, curve.end, node));
}

function cubicIntersectsNode(start: Position, controlStart: Position, controlEnd: Position, end: Position, node: CanvasNodeData): boolean {
    const bounds = {
        left: node.position.x - NODE_ROUTE_CLEARANCE,
        right: node.position.x + node.width + NODE_ROUTE_CLEARANCE,
        top: node.position.y - NODE_ROUTE_CLEARANCE,
        bottom: node.position.y + node.height + NODE_ROUTE_CLEARANCE,
    };
    const points = [start, controlStart, controlEnd, end];
    if (points.every((point) => point.x < bounds.left) || points.every((point) => point.x > bounds.right) || points.every((point) => point.y < bounds.top) || points.every((point) => point.y > bounds.bottom)) return false;
    if (pointInBounds(start, bounds) || pointInBounds(end, bounds)) return true;

    const flatness = Math.max(pointLineDistance(controlStart, start, end), pointLineDistance(controlEnd, start, end));
    if (flatness <= NODE_ROUTE_CLEARANCE / 6) return segmentIntersectsBounds(start, end, bounds, flatness);

    const startControlMid = midpoint(start, controlStart);
    const controlMid = midpoint(controlStart, controlEnd);
    const endControlMid = midpoint(controlEnd, end);
    const leftControl = midpoint(startControlMid, controlMid);
    const rightControl = midpoint(controlMid, endControlMid);
    const center = midpoint(leftControl, rightControl);
    return cubicIntersectsNode(start, startControlMid, leftControl, center, node) || cubicIntersectsNode(center, rightControl, endControlMid, end, node);
}

function pointLineDistance(point: Position, start: Position, end: Position) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    return length ? Math.abs(dy * point.x - dx * point.y + end.x * start.y - end.y * start.x) / length : Math.hypot(point.x - start.x, point.y - start.y);
}

function midpoint(left: Position, right: Position): Position {
    return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
}

function pointInBounds(point: Position, bounds: { left: number; right: number; top: number; bottom: number }) {
    return point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom;
}

function segmentIntersectsBounds(start: Position, end: Position, bounds: { left: number; right: number; top: number; bottom: number }, tolerance = 0) {
    let near = 0;
    let far = 1;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    for (const [origin, delta, minimum, maximum] of [
        [start.x, dx, bounds.left - tolerance, bounds.right + tolerance],
        [start.y, dy, bounds.top - tolerance, bounds.bottom + tolerance],
    ] as const) {
        if (delta === 0) {
            if (origin < minimum || origin > maximum) return false;
            continue;
        }
        const first = (minimum - origin) / delta;
        const second = (maximum - origin) / delta;
        const entry = Math.min(first, second);
        const exit = Math.max(first, second);
        near = Math.max(near, entry);
        far = Math.min(far, exit);
        if (near > far || far < 0 || near > 1) return false;
    }
    return true;
}

function segmentIntersectsNode(start: Position, end: Position, node: CanvasNodeData) {
    return segmentIntersectsBounds(start, end, {
        left: node.position.x - NODE_ROUTE_CLEARANCE,
        right: node.position.x + node.width + NODE_ROUTE_CLEARANCE,
        top: node.position.y - NODE_ROUTE_CLEARANCE,
        bottom: node.position.y + node.height + NODE_ROUTE_CLEARANCE,
    });
}

function routeLength(points: Position[]) {
    return points.slice(1).reduce((length, point, index) => length + Math.abs(point.x - points[index].x) + Math.abs(point.y - points[index].y), 0);
}

function roundedPolyline(points: Position[]) {
    const compact = points.filter((point, index) => index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y);
    if (compact.length < 2) return "";

    let path = `M ${format(compact[0].x)} ${format(compact[0].y)}`;
    for (let index = 1; index < compact.length - 1; index += 1) {
        const previous = compact[index - 1];
        const current = compact[index];
        const next = compact[index + 1];
        const incomingLength = Math.hypot(current.x - previous.x, current.y - previous.y);
        const outgoingLength = Math.hypot(next.x - current.x, next.y - current.y);
        const radius = Math.min(CORNER_RADIUS, incomingLength / 2, outgoingLength / 2);
        const before = moveToward(current, previous, radius);
        const after = moveToward(current, next, radius);
        path += ` L ${format(before.x)} ${format(before.y)} Q ${format(current.x)} ${format(current.y)} ${format(after.x)} ${format(after.y)}`;
    }
    const end = compact[compact.length - 1];
    return `${path} L ${format(end.x)} ${format(end.y)}`;
}

function moveToward(from: Position, to: Position, distance: number) {
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    if (!length) return from;
    return { x: from.x + ((to.x - from.x) / length) * distance, y: from.y + ((to.y - from.y) / length) * distance };
}

function format(value: number) {
    return Number(value.toFixed(2));
}
