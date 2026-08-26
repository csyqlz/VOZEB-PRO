const LATEST_DISTANCE_PX = 4;
const COMPACT_DISTANCE_PX = 48;
const SCROLL_DELTA_PX = 3;

export type CreativeConversationScrollTransition = "collapse" | "expand" | "preserve";

export function creativeConversationScrollTransition(input: { scrollTop: number; previousScrollTop: number; distanceFromLatest: number; userScrollingAway: boolean }): CreativeConversationScrollTransition {
    if (input.distanceFromLatest < LATEST_DISTANCE_PX) return "expand";
    const scrollingUp = input.scrollTop < input.previousScrollTop - SCROLL_DELTA_PX;
    return input.userScrollingAway && scrollingUp && input.distanceFromLatest > COMPACT_DISTANCE_PX ? "collapse" : "preserve";
}
