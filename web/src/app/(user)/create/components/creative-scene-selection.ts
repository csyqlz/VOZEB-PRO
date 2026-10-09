export type SceneSelectionPoint = { x: number; y: number };
export function sceneSelectionPoint(client: SceneSelectionPoint, image: { left: number; top: number; width: number; height: number }, source: { width: number; height: number }): SceneSelectionPoint | undefined {
    if (
        ![client.x, client.y, image.left, image.top, image.width, image.height, source.width, source.height].every(Number.isFinite) ||
        image.width <= 0 ||
        image.height <= 0 ||
        !Number.isSafeInteger(source.width) ||
        !Number.isSafeInteger(source.height) ||
        source.width <= 0 ||
        source.height <= 0
    )
        return undefined;
    return { x: Math.max(0, Math.min(source.width, Math.round(((client.x - image.left) / image.width) * source.width))), y: Math.max(0, Math.min(source.height, Math.round(((client.y - image.top) / image.height) * source.height))) };
}
export function sceneSelectionRegion(start: SceneSelectionPoint, end: SceneSelectionPoint) {
    const width = Math.abs(end.x - start.x);
    const height = Math.abs(end.y - start.y);
    if (!width || !height) return undefined;
    return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width, height };
}
