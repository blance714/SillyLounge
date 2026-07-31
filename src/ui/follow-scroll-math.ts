/**
 * SillyTavern-ChatUI · message-stream follow gates
 *
 * Pure arithmetic for the two independent decisions the message list makes
 * from one number — how far the viewport's bottom edge is from the end of the
 * conversation. Extracted from useAutoScroll so both gates can be pinned by
 * Node tests: the hook itself owns only DOM wiring (listeners, refs, state),
 * which is why it still has no test of its own (INVARIANTS.md §16 logs the
 * dual-scroll-ownership gap this extraction starts paying down).
 *
 * The two gates used to be one constant doing two jobs, which meant the
 * 「回到最新」 capsule appeared the instant auto-follow disengaged — 80px up,
 * barely half a message, while the latest text was still on screen. They are
 * separate decisions with separate reasons:
 *
 *   - The FOLLOW gate is a scroll-behaviour promise: inside it, new content
 *     pulls the view down. It is deliberately tight (80px, one line of body
 *     copy plus its leading) because a reader who has moved at all has said
 *     they want to stay put, and it is kept in step with the virtualizer's own
 *     `scrollEndThreshold: 80` so the two never disagree about "at the end".
 *   - The JUMP gate is an affordance: the capsule is only worth its ink once
 *     the latest message is genuinely out of sight (design §47 — 240px).
 *
 * Between them lies a deliberate dead zone: 80–240px is "I have stopped
 * following you, but you can still see where you were", so nothing appears.
 */

/**
 * Distance (px) from the bottom within which the view counts as pinned and
 * new content keeps pulling it down. Not a design value — a scroll-behaviour
 * one, shared with @tanstack/react-virtual's `scrollEndThreshold`.
 */
export const CHATUI_FOLLOW_THRESHOLD_PX = 80;

/**
 * Distance (px) the reader has to be above the end before 「回到最新」 floats
 * up over the composer. Design handoff §47: 「向上滚动超过 240px 后」 — past,
 * not at, so the boundary itself is still quiet.
 */
export const CHATUI_JUMP_LATEST_THRESHOLD_PX = 240;

/**
 * The three scroll metrics both gates are read from. Structurally satisfied by
 * any HTMLElement, so the hook passes its container straight in and the tests
 * pass plain objects — this module never touches the DOM.
 */
export type ScrollExtent = Readonly<{
    scrollHeight: number;
    scrollTop: number;
    clientHeight: number;
}>;

export type FollowGates = Readonly<{
    /** scrollHeight - scrollTop - clientHeight. Negative while over-scrolling. */
    distanceFromBottom: number;
    /** Inside the follow gate: new content may pull the view to the bottom. */
    pinned: boolean;
    /** Past the jump gate: the 「回到最新」 capsule is worth showing. */
    awayFromLatest: boolean;
}>;

/**
 * Read both gates off one set of scroll metrics.
 *
 * `pinned` and `awayFromLatest` are mutually exclusive by construction (the
 * follow threshold is below the jump threshold), but neither is the other's
 * negation — the dead zone between them is a third, unnamed state where the
 * list has stopped following and the capsule stays hidden.
 */
export function readFollowGates(extent: ScrollExtent): FollowGates {
    const distanceFromBottom = extent.scrollHeight - extent.scrollTop - extent.clientHeight;
    return {
        distanceFromBottom,
        pinned: distanceFromBottom < CHATUI_FOLLOW_THRESHOLD_PX,
        awayFromLatest: distanceFromBottom > CHATUI_JUMP_LATEST_THRESHOLD_PX,
    };
}
