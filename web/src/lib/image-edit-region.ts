export type ImageEditRegion = {
    left: number;
    top: number;
    right: number;
    bottom: number;
    centerX: number;
    centerY: number;
};

export function imageEditRegionFromRgba(data: ArrayLike<number>, width: number, height: number): ImageEditRegion | undefined {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || data.length < width * height * 4) return undefined;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            if ((data[(y * width + x) * 4 + 3] || 0) <= 0) continue;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        }
    }
    if (maxX < minX || maxY < minY) return undefined;
    const left = minX / width;
    const top = minY / height;
    const right = (maxX + 1) / width;
    const bottom = (maxY + 1) / height;
    return {
        left,
        top,
        right,
        bottom,
        centerX: (left + right) / 2,
        centerY: (top + bottom) / 2,
    };
}

export function normalizeImageEditRegion(value: unknown): ImageEditRegion | undefined {
    if (!value || typeof value !== "object") return undefined;
    const input = value as Record<keyof ImageEditRegion, unknown>;
    const leftValue = finiteNumber(input.left);
    const topValue = finiteNumber(input.top);
    const rightValue = finiteNumber(input.right);
    const bottomValue = finiteNumber(input.bottom);
    const centerXValue = finiteNumber(input.centerX);
    const centerYValue = finiteNumber(input.centerY);
    if ([leftValue, topValue, rightValue, bottomValue, centerXValue, centerYValue].some((item) => item === undefined)) return undefined;
    const left = clampUnit(leftValue!);
    const top = clampUnit(topValue!);
    const right = clampUnit(rightValue!);
    const bottom = clampUnit(bottomValue!);
    if (left >= right || top >= bottom) return undefined;
    return {
        left,
        top,
        right,
        bottom,
        centerX: centerXValue! >= left && centerXValue! <= right ? centerXValue! : (left + right) / 2,
        centerY: centerYValue! >= top && centerYValue! <= bottom ? centerYValue! : (top + bottom) / 2,
    };
}

function finiteNumber(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampUnit(value: number) {
    return Math.min(1, Math.max(0, value));
}
