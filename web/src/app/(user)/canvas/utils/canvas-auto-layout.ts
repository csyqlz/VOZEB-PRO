import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../types";

const columnGap = 92;
const rowGap = 52;
const componentGap = 112;
const startOffset = 96;

type LayoutViewport = {
    width: number;
    height: number;
};

type ArrangedComponent = {
    height: number;
    positions: Map<string, CanvasNodeData["position"]>;
    width: number;
};

type ComponentRow = {
    components: ArrangedComponent[];
    height: number;
    width: number;
};

export function autoLayoutCanvas(nodes: CanvasNodeData[], connections: CanvasConnection[], viewport: LayoutViewport = { width: 16, height: 9 }) {
    const visibleNodes = nodes.filter((node) => !isAgentInternalNode(node));
    if (!visibleNodes.length) return nodes;

    const visibleIds = new Set(visibleNodes.map((node) => node.id));
    const { adjacent, incoming, outgoing } = buildVisibleLayoutGraph(nodes, connections, visibleIds);
    const nodeIndexes = new Map(nodes.map((node, index) => [node.id, index]));
    const components = buildLayoutComponents(visibleNodes, adjacent, incoming, outgoing, nodeIndexes).map(({ buckets }) => arrangeComponent(buckets));
    const rows = chooseComponentRows(components, viewport);
    const positions = new Map<string, CanvasNodeData["position"]>();
    let y = startOffset;
    rows.forEach((row) => {
        let x = startOffset;
        row.components.forEach((component) => {
            const top = y + (row.height - component.height) / 2;
            component.positions.forEach((position, nodeId) => {
                positions.set(nodeId, { x: x + position.x, y: top + position.y });
            });
            x += component.width + componentGap;
        });
        y += row.height + componentGap;
    });
    return nodes.map((node) => (positions.has(node.id) ? { ...node, position: positions.get(node.id)! } : node));
}

export function isAgentInternalNode(node: CanvasNodeData) {
    if (node.metadata?.internalOnly) return true;
    if (!node.metadata?.agentRunId) return false;
    return node.type === CanvasNodeType.Brief || node.type === CanvasNodeType.BrandKit || node.type === CanvasNodeType.Config || node.type === CanvasNodeType.Task;
}

function disconnectedNodeDepth(type: CanvasNodeType) {
    if (type === CanvasNodeType.Config || type === CanvasNodeType.Task) return 1;
    if (type === CanvasNodeType.Image || type === CanvasNodeType.Panorama || type === CanvasNodeType.Video || type === CanvasNodeType.Audio) return 2;
    return 0;
}

function buildVisibleLayoutGraph(nodes: CanvasNodeData[], connections: CanvasConnection[], visibleIds: Set<string>) {
    const allIds = new Set(nodes.map((node) => node.id));
    const allOutgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
    connections.forEach((connection) => {
        if (allIds.has(connection.fromNodeId) && allIds.has(connection.toNodeId)) allOutgoing.get(connection.fromNodeId)!.push(connection.toNodeId);
    });

    const outgoingSets = new Map([...visibleIds].map((id) => [id, new Set<string>()]));
    visibleIds.forEach((sourceId) => {
        const hiddenVisited = new Set<string>();
        const stack = [...(allOutgoing.get(sourceId) || [])];
        while (stack.length) {
            const targetId = stack.pop()!;
            if (targetId === sourceId) continue;
            if (visibleIds.has(targetId)) {
                outgoingSets.get(sourceId)!.add(targetId);
                continue;
            }
            if (hiddenVisited.has(targetId)) continue;
            hiddenVisited.add(targetId);
            stack.push(...(allOutgoing.get(targetId) || []));
        }
    });

    const outgoing = new Map([...visibleIds].map((id) => [id, [...outgoingSets.get(id)!]]));
    const incoming = new Map([...visibleIds].map((id) => [id, [] as string[]]));
    const adjacent = new Map([...visibleIds].map((id) => [id, new Set<string>()]));
    outgoing.forEach((targets, sourceId) => {
        targets.forEach((targetId) => {
            incoming.get(targetId)!.push(sourceId);
            adjacent.get(sourceId)!.add(targetId);
            adjacent.get(targetId)!.add(sourceId);
        });
    });
    return { adjacent, incoming, outgoing };
}

function buildLayoutComponents(nodes: CanvasNodeData[], adjacent: Map<string, Set<string>>, incoming: Map<string, string[]>, outgoing: Map<string, string[]>, nodeIndexes: Map<string, number>) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const stableOrder = (first: CanvasNodeData, second: CanvasNodeData) => (nodeIndexes.get(first.id) ?? Number.MAX_SAFE_INTEGER) - (nodeIndexes.get(second.id) ?? Number.MAX_SAFE_INTEGER) || first.id.localeCompare(second.id);
    const visited = new Set<string>();
    const connected: CanvasNodeData[][] = [];
    const isolated: CanvasNodeData[] = [];
    [...nodes].sort(stableOrder).forEach((node) => {
        if (visited.has(node.id)) return;
        if (!adjacent.get(node.id)?.size) {
            visited.add(node.id);
            isolated.push(node);
            return;
        }
        const component: CanvasNodeData[] = [];
        const stack = [node.id];
        visited.add(node.id);
        while (stack.length) {
            const currentId = stack.pop()!;
            component.push(byId.get(currentId)!);
            adjacent.get(currentId)?.forEach((nextId) => {
                if (visited.has(nextId)) return;
                visited.add(nextId);
                stack.push(nextId);
            });
        }
        connected.push(component);
    });

    const groups = [...connected.map((component) => ({ component, isolated: false })), ...(isolated.length ? [{ component: isolated, isolated: true }] : [])];
    return groups
        .map(({ component, isolated: isIsolated }) => {
            const componentIds = new Set(component.map((node) => node.id));
            const depths = isIsolated ? new Map(component.map((node) => [node.id, disconnectedNodeDepth(node.type)])) : resolveDepths(component, componentIds, outgoing);
            const buckets = new Map<number, CanvasNodeData[]>();
            component.forEach((node) => {
                const depth = depths.get(node.id) || 0;
                buckets.set(depth, [...(buckets.get(depth) || []), node]);
            });
            orderBuckets(buckets, incoming, outgoing, stableOrder);
            return { buckets, order: Math.min(...component.map((node) => nodeIndexes.get(node.id) ?? Number.MAX_SAFE_INTEGER)), key: component.map((node) => node.id).sort()[0] || "" };
        })
        .sort((first, second) => first.order - second.order || first.key.localeCompare(second.key));
}

function arrangeComponent(buckets: Map<number, CanvasNodeData[]>): ArrangedComponent {
    const depths = [...buckets.keys()].sort((first, second) => first - second);
    const columnWidths = new Map(depths.map((depth) => [depth, Math.max(...buckets.get(depth)!.map((node) => node.width))]));
    const bucketHeights = new Map(depths.map((depth) => [depth, stackHeight(buckets.get(depth)!)]));
    const height = Math.max(...bucketHeights.values());
    const positions = new Map<string, CanvasNodeData["position"]>();
    let x = 0;
    depths.forEach((depth) => {
        let y = (height - bucketHeights.get(depth)!) / 2;
        buckets.get(depth)!.forEach((node) => {
            positions.set(node.id, { x, y });
            y += node.height + rowGap;
        });
        x += columnWidths.get(depth)! + columnGap;
    });
    return { positions, width: Math.max(0, x - columnGap), height };
}

function chooseComponentRows(components: ArrangedComponent[], viewport: LayoutViewport) {
    if (components.length <= 1) return components.length ? [{ components, width: components[0].width, height: components[0].height }] : [];

    const availableWidth = Math.max(1, viewport.width);
    const availableHeight = Math.max(1, viewport.height);
    const totalWidth = components.reduce((total, component) => total + component.width, 0) + Math.max(0, components.length - 1) * componentGap;
    const candidateWidths = new Set<number>();
    // Derive meaningful row targets without enumerating every contiguous component range.
    candidateWidths.add(availableWidth);
    candidateWidths.add(totalWidth);
    components.forEach((component) => candidateWidths.add(component.width));
    for (let rowCount = 2; rowCount <= components.length; rowCount += 1) candidateWidths.add(totalWidth / rowCount);

    let best: { area: number; rows: ComponentRow[]; scale: number } | null = null;
    [...candidateWidths].forEach((targetWidth) => {
        const rows = packComponentRows(components, targetWidth);
        const width = Math.max(...rows.map((row) => row.width));
        const height = rows.reduce((total, row) => total + row.height, 0) + Math.max(0, rows.length - 1) * componentGap;
        const scale = Math.min(availableWidth / width, availableHeight / height);
        const area = width * height;
        if (!best || scale > best.scale + 0.000001 || (Math.abs(scale - best.scale) <= 0.000001 && area < best.area)) best = { area, rows, scale };
    });
    return best!.rows;
}

function packComponentRows(components: ArrangedComponent[], targetWidth: number) {
    const rows: ComponentRow[] = [];
    components.forEach((component) => {
        let row = rows.at(-1);
        const nextWidth = row ? row.width + componentGap + component.width : component.width;
        if (!row || (row.components.length && nextWidth > targetWidth + 0.000001)) {
            row = { components: [], width: 0, height: 0 };
            rows.push(row);
        }
        row.components.push(component);
        row.width += (row.components.length === 1 ? 0 : componentGap) + component.width;
        row.height = Math.max(row.height, component.height);
    });
    return rows;
}

function resolveDepths(component: CanvasNodeData[], componentIds: Set<string>, outgoing: Map<string, string[]>) {
    const groups = stronglyConnectedGroups(component, componentIds, outgoing);
    const groupByNodeId = new Map(groups.flatMap((group, groupIndex) => group.map((node) => [node.id, groupIndex] as const)));
    const offsetByNodeId = new Map(groups.flatMap((group) => group.map((node, offset) => [node.id, offset] as const)));
    const groupOutgoing = new Map(groups.map((_, groupIndex) => [groupIndex, new Set<number>()]));
    groups.forEach((group, groupIndex) => {
        group.forEach((node) => {
            for (const targetId of outgoing.get(node.id) || []) {
                const targetGroup = groupByNodeId.get(targetId);
                if (targetGroup !== undefined && targetGroup !== groupIndex) groupOutgoing.get(groupIndex)!.add(targetGroup);
            }
        });
    });
    const remaining = new Map(groups.map((_, groupIndex) => [groupIndex, 0]));
    groupOutgoing.forEach((targets) => targets.forEach((target) => remaining.set(target, remaining.get(target)! + 1)));
    const depthByGroup = new Map<number, number>();
    const queue = groups
        .map((_, groupIndex) => groupIndex)
        .filter((groupIndex) => remaining.get(groupIndex) === 0)
        .sort((first, second) => groups[first][0].id.localeCompare(groups[second][0].id));
    queue.forEach((groupIndex) => depthByGroup.set(groupIndex, 0));
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const sourceGroup = queue[cursor];
        const sourceDepth = depthByGroup.get(sourceGroup) || 0;
        for (const targetGroup of groupOutgoing.get(sourceGroup) || []) {
            depthByGroup.set(targetGroup, Math.max(depthByGroup.get(targetGroup) || 0, sourceDepth + groups[sourceGroup].length));
            const nextRemaining = remaining.get(targetGroup)! - 1;
            remaining.set(targetGroup, nextRemaining);
            if (nextRemaining === 0) queue.push(targetGroup);
        }
    }
    return new Map(component.map((node) => [node.id, (depthByGroup.get(groupByNodeId.get(node.id)!) || 0) + offsetByNodeId.get(node.id)!]));
}

function stronglyConnectedGroups(component: CanvasNodeData[], componentIds: Set<string>, outgoing: Map<string, string[]>) {
    const byId = new Map(component.map((node) => [node.id, node]));
    const indexById = new Map<string, number>();
    const lowLinkById = new Map<string, number>();
    const stack: string[] = [];
    const stacked = new Set<string>();
    const groups: CanvasNodeData[][] = [];
    let nextIndex = 0;

    const visit = (nodeId: string) => {
        indexById.set(nodeId, nextIndex);
        lowLinkById.set(nodeId, nextIndex);
        nextIndex += 1;
        stack.push(nodeId);
        stacked.add(nodeId);
        [...(outgoing.get(nodeId) || [])]
            .filter((targetId) => componentIds.has(targetId))
            .sort()
            .forEach((targetId) => {
                if (!indexById.has(targetId)) {
                    visit(targetId);
                    lowLinkById.set(nodeId, Math.min(lowLinkById.get(nodeId)!, lowLinkById.get(targetId)!));
                } else if (stacked.has(targetId)) {
                    lowLinkById.set(nodeId, Math.min(lowLinkById.get(nodeId)!, indexById.get(targetId)!));
                }
            });
        if (lowLinkById.get(nodeId) !== indexById.get(nodeId)) return;
        const group: CanvasNodeData[] = [];
        let currentId = "";
        do {
            currentId = stack.pop()!;
            stacked.delete(currentId);
            group.push(byId.get(currentId)!);
        } while (currentId !== nodeId);
        groups.push(group.sort((first, second) => first.id.localeCompare(second.id)));
    };

    [...component]
        .sort((first, second) => first.id.localeCompare(second.id))
        .forEach((node) => {
            if (!indexById.has(node.id)) visit(node.id);
        });
    return groups;
}

function orderBuckets(buckets: Map<number, CanvasNodeData[]>, incoming: Map<string, string[]>, outgoing: Map<string, string[]>, stableOrder: (first: CanvasNodeData, second: CanvasNodeData) => number) {
    buckets.forEach((bucket) => bucket.sort(stableOrder));
    const depths = [...buckets.keys()].sort((first, second) => first - second);
    for (let pass = 0; pass < 2; pass += 1) {
        const forwardOrder = nodeOrder(buckets);
        depths.slice(1).forEach((depth) => sortByNeighborOrder(buckets.get(depth)!, incoming, forwardOrder, stableOrder));
        const backwardOrder = nodeOrder(buckets);
        depths
            .slice(0, -1)
            .reverse()
            .forEach((depth) => sortByNeighborOrder(buckets.get(depth)!, outgoing, backwardOrder, stableOrder));
    }
}

function sortByNeighborOrder(bucket: CanvasNodeData[], neighbors: Map<string, string[]>, order: Map<string, number>, stableOrder: (first: CanvasNodeData, second: CanvasNodeData) => number) {
    bucket.sort((first, second) => neighborCenter(first.id, neighbors, order) - neighborCenter(second.id, neighbors, order) || stableOrder(first, second));
}

function neighborCenter(nodeId: string, neighbors: Map<string, string[]>, order: Map<string, number>) {
    const values = (neighbors.get(nodeId) || []).map((id) => order.get(id)).filter((value): value is number => value !== undefined);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.POSITIVE_INFINITY;
}

function nodeOrder(buckets: Map<number, CanvasNodeData[]>) {
    const order = new Map<string, number>();
    buckets.forEach((bucket) => bucket.forEach((node, index) => order.set(node.id, index)));
    return order;
}

function stackHeight(nodes: CanvasNodeData[]) {
    return nodes.reduce((height, node) => height + node.height, 0) + Math.max(0, nodes.length - 1) * rowGap;
}
