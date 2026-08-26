import { describe, expect, it } from "vitest";

import { creativeConversationScrollTransition } from "./create-conversation-scroll";

describe("creative conversation scroll transition", () => {
    it("ignores layout reflow after submitting a message", () => {
        expect(creativeConversationScrollTransition({ scrollTop: 760, previousScrollTop: 800, distanceFromLatest: 120, userScrollingAway: false })).toBe("preserve");
    });

    it("only collapses after an intentional upward scroll moves meaningfully away", () => {
        expect(creativeConversationScrollTransition({ scrollTop: 760, previousScrollTop: 800, distanceFromLatest: 20, userScrollingAway: true })).toBe("preserve");
        expect(creativeConversationScrollTransition({ scrollTop: 720, previousScrollTop: 800, distanceFromLatest: 100, userScrollingAway: true })).toBe("collapse");
    });

    it("expands whenever the viewport reaches the latest message", () => {
        expect(creativeConversationScrollTransition({ scrollTop: 996, previousScrollTop: 900, distanceFromLatest: 3, userScrollingAway: false })).toBe("expand");
    });
});
