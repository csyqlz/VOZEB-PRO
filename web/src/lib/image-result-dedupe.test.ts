import { describe, expect, it } from "vitest";

import { dedupeImageResults } from "./image-result-dedupe";

describe("image result dedupe", () => {
    it("keeps one result when provider aliases point to the same media", () => {
        const proxy = "/api/ai/system/channel/_media?url=https%3A%2F%2Fcdn.example.com%2Fimage.png";
        const results = dedupeImageResults([{ dataUrl: proxy, remoteUrl: "https://cdn.example.com/image.png" }, { dataUrl: proxy }, { dataUrl: "https://cdn.example.com/image.png" }]);

        expect(results).toHaveLength(1);
    });

    it("keeps genuinely different upstream images", () => {
        expect(dedupeImageResults([{ remoteUrl: "https://cdn.example.com/one.png" }, { remoteUrl: "https://cdn.example.com/two.png" }])).toHaveLength(2);
    });

    it("keeps separate upstream results even when their inline bytes match", () => {
        const bytes = "data:image/png;base64,aGVsbG8=";
        expect(
            dedupeImageResults([
                { dataUrl: bytes, remoteUrl: "https://cdn.example.com/one.png" },
                { dataUrl: bytes, remoteUrl: "https://cdn.example.com/two.png" },
            ]),
        ).toHaveLength(2);
        expect(dedupeImageResults([{ dataUrl: bytes }, { dataUrl: bytes }])).toHaveLength(1);
    });
});
