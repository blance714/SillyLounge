/**
 * SillyTavern-ChatUI · swipe segment windowing math
 *
 * Pure geometry for the message action bar's swipe tick row (design §43):
 * at most SWIPE_SEGMENT_CAPACITY ticks are ever on screen for one message,
 * centered on whichever swipe is currently showing. Extracted so the window
 * can be exercised by Node tests without mounting MessageActions.
 *
 * This is deliberately *not* a rewrite of src/ui/floor-rail-math.ts's
 * centering formula — it calls centerWindowStart directly. The prototype's
 * own windowing (长廊剧场 原型.dc.html, `segs` computed property):
 *
 *   const total = m.swipes.length, win = 5;
 *   let start = 0;
 *   if (total > win) start = Math.max(0, Math.min(m.swipeIdx - 2, total - win));
 *
 * is the exact same shape as floor-rail-math's contract with capacity fixed
 * at 5 (half = Math.floor((5-1)/2) = 2, and clamping to
 * [0, max(0, total-5)] reduces to "0 whenever total <= win"). Reusing the
 * one implementation means a centering fix in either rail benefits both,
 * and a regression test on one formula guards both call sites.
 */

import { centerWindowStart } from './floor-rail-math.js';

/** README §43 / the prototype's `win`: the tick row never shows more than 5. */
export const SWIPE_SEGMENT_CAPACITY = 5;

export type SwipeSegmentWindow = Readonly<{
    /** First swipe index the visible ticks cover (inclusive). */
    start: number;
    /** One past the last swipe index the visible ticks cover (exclusive). */
    end: number;
    /**
     * True once `total` exceeds the cap and the ticks alone can no longer
     * stand for every version — the "current/total" count label is shown
     * alongside them only in this case (design §43).
     */
    windowed: boolean;
}>;

/**
 * @param activeIndex The swipe currently shown (0-based, i.e. message.swipe.id).
 * @param total Total swipe count for the message (message.swipe.count).
 */
export function computeSwipeSegmentWindow(activeIndex: number, total: number): SwipeSegmentWindow {
    if (total <= 0) return { start: 0, end: 0, windowed: false };
    const maxWindowStart = Math.max(0, total - SWIPE_SEGMENT_CAPACITY);
    const start = centerWindowStart(activeIndex, SWIPE_SEGMENT_CAPACITY, maxWindowStart);
    const end = Math.min(total, start + SWIPE_SEGMENT_CAPACITY);
    return { start, end, windowed: total > SWIPE_SEGMENT_CAPACITY };
}
