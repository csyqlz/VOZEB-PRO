import { describe, expect, it } from "vitest";
import { sceneSelectionPoint, sceneSelectionRegion } from "./creative-scene-selection";
describe("scene selection source pixels", () => {
    it("maps the image rectangle rather than preview pixels or surrounding whitespace", () => {
        const image = { left: 31, top: 81, width: 418, height: 209 };
        const source = { width: 1254, height: 627 };
        expect(sceneSelectionPoint({ x: 240, y: 185.5 }, image, source)).toEqual({ x: 627, y: 314 });
        expect(sceneSelectionPoint({ x: 20, y: 300 }, image, source)).toEqual({ x: 0, y: 627 });
        expect(sceneSelectionPoint({ x: 100, y: 100 }, { ...image, width: 0 }, source)).toBeUndefined();
    });
    it("keeps reverse dragging in integer source bounds and leaves an empty click unconfirmed", () => {
        expect(sceneSelectionRegion({ x: 1003, y: 501 }, { x: 201, y: 100 })).toEqual({ x: 201, y: 100, width: 802, height: 401 });
        expect(sceneSelectionRegion({ x: 201, y: 100 }, { x: 201, y: 100 })).toBeUndefined();
    });
});
