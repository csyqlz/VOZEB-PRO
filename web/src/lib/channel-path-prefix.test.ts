import { describe, expect, it } from "vitest";

import { validChannelPathPrefix, withChannelPathPrefix } from "./channel-path-prefix";

describe("channel path prefix", () => {
    it("mounts provider paths once while preserving the query", () => {
        expect(withChannelPathPrefix("https://platform.dataeyes.ai/v1/videos/text2video?x=1", "/kling")).toBe("https://platform.dataeyes.ai/kling/v1/videos/text2video?x=1");
        expect(withChannelPathPrefix("https://platform.dataeyes.ai/kling/v1/videos/text2video", "/kling")).toBe("https://platform.dataeyes.ai/kling/v1/videos/text2video");
    });

    it("rejects traversal, encoded separators, URL components and double slashes", () => {
        for (const prefix of ["kling", "/../v1", "/kling//v1", "/kling?x=1", "/kling%2fadmin", "/kling\\admin"]) expect(validChannelPathPrefix(prefix)).toBe(false);
        expect(validChannelPathPrefix("/kling")).toBe(true);
        expect(validChannelPathPrefix("")).toBe(true);
    });
});
