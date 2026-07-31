// test/swipe-segment-math.test.mjs
//
// dist/runtime/ui/swipe-segment-math.js — pure geometry, no host/DOM needed.
// Source: src/ui/swipe-segment-math.ts. Pins the exact windowing contract
// used by SwipeSegments.tsx: at most 5 ticks on screen, centered on the
// active swipe, matching the prototype's own `segs` windowing verbatim
// (长廊剧场 原型.dc.html):
//
//   const total = m.swipes.length, win = 5;
//   let start = 0;
//   if (total > win) start = Math.max(0, Math.min(m.swipeIdx - 2, total - win));
//   const end = Math.min(total, start + win);
//
// Every `expected` below is a literal integer, not re-derived by calling the
// prototype's own formula inside this file — a test that recomputed the same
// arithmetic would pass even if computeSwipeSegmentWindow regressed to a
// different (wrong) centering bias.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    computeSwipeSegmentWindow,
    SWIPE_SEGMENT_CAPACITY,
} from '../dist/runtime/ui/swipe-segment-math.js';

test('SWIPE_SEGMENT_CAPACITY is 5 — the design\'s fixed tick-row width', () => {
    assert.equal(SWIPE_SEGMENT_CAPACITY, 5);
});

test('computeSwipeSegmentWindow: total at or under the cap always shows every swipe, unwindowed', () => {
    const cases = [
        { total: 1, activeIndex: 0 },
        { total: 2, activeIndex: 0 },
        { total: 2, activeIndex: 1 },
        { total: 5, activeIndex: 0 },
        { total: 5, activeIndex: 2 },
        { total: 5, activeIndex: 4 },
    ];

    for (const { total, activeIndex } of cases) {
        const window_ = computeSwipeSegmentWindow(activeIndex, total);
        assert.equal(window_.start, 0, `total=${total} activeIndex=${activeIndex} start`);
        assert.equal(window_.end, total, `total=${total} activeIndex=${activeIndex} end`);
        assert.equal(window_.windowed, false, `total=${total} activeIndex=${activeIndex} windowed`);
    }
});

test('computeSwipeSegmentWindow: total 0 is deterministic and yields an empty, unwindowed window', () => {
    const window_ = computeSwipeSegmentWindow(0, 0);
    assert.deepEqual(window_, { start: 0, end: 0, windowed: false });
});

test('computeSwipeSegmentWindow: total just past the cap (6) centers the active tick and reports windowed', () => {
    // total=6, capacity=5, maxWindowStart = max(0, 6-5) = 1.
    const cases = [
        // activeIndex, expected start, expected end
        { activeIndex: 0, start: 0, end: 5 }, // centeredStart = 0-2 = -2, clamped to 0
        { activeIndex: 1, start: 0, end: 5 }, // centeredStart = -1, clamped to 0
        { activeIndex: 2, start: 0, end: 5 }, // centeredStart = 0
        { activeIndex: 3, start: 1, end: 6 }, // centeredStart = 1
        { activeIndex: 4, start: 1, end: 6 }, // centeredStart = 2, clamped down to maxWindowStart 1
        { activeIndex: 5, start: 1, end: 6 }, // centeredStart = 3, clamped down to maxWindowStart 1
    ];

    for (const { activeIndex, start, end } of cases) {
        const window_ = computeSwipeSegmentWindow(activeIndex, 6);
        assert.equal(window_.start, start, `activeIndex=${activeIndex} start`);
        assert.equal(window_.end, end, `activeIndex=${activeIndex} end`);
        assert.equal(window_.windowed, true, `activeIndex=${activeIndex} windowed`);
        assert.equal(window_.end - window_.start, SWIPE_SEGMENT_CAPACITY, `activeIndex=${activeIndex} window size stays at the cap`);
    }
});

test('computeSwipeSegmentWindow: a long swipe history (total=101) mirrors the prototype\'s Math.max/Math.min formula exactly', () => {
    // Hand-evaluated against: start = max(0, min(activeIndex - 2, total - 5)).
    // maxWindowStart = 101 - 5 = 96.
    const total = 101;
    const cases = [
        { activeIndex: 0, expectedStart: 0 },
        { activeIndex: 1, expectedStart: 0 },
        { activeIndex: 2, expectedStart: 0 },
        { activeIndex: 3, expectedStart: 1 },
        { activeIndex: 50, expectedStart: 48 },
        { activeIndex: 95, expectedStart: 93 },
        { activeIndex: 97, expectedStart: 95 },
        { activeIndex: 98, expectedStart: 96 }, // exactly at maxWindowStart — not yet clamped
        { activeIndex: 99, expectedStart: 96 }, // one turn past the boundary — now clamped
        { activeIndex: 100, expectedStart: 96 },
    ];

    for (const { activeIndex, expectedStart } of cases) {
        const window_ = computeSwipeSegmentWindow(activeIndex, total);
        assert.equal(window_.start, expectedStart, `activeIndex=${activeIndex} start`);
        assert.equal(window_.end, expectedStart + SWIPE_SEGMENT_CAPACITY, `activeIndex=${activeIndex} end`);
        assert.equal(window_.windowed, true, `activeIndex=${activeIndex} windowed`);
        // The active swipe itself must always be inside the reported window —
        // a windowing bug that centers on the wrong tick would still pass a
        // bare "size stays 5" check but silently exclude the active swipe.
        assert.ok(
            activeIndex >= window_.start && activeIndex < window_.end,
            `activeIndex=${activeIndex} must fall within [${window_.start}, ${window_.end})`,
        );
    }
});

test('computeSwipeSegmentWindow: never returns a window wider than the total, even for tiny totals above the cap', () => {
    // total=6 is the smallest total that both exceeds the cap and can be
    // clamped at either edge — the boundary case most likely to overshoot.
    for (let activeIndex = 0; activeIndex < 6; activeIndex += 1) {
        const window_ = computeSwipeSegmentWindow(activeIndex, 6);
        assert.ok(window_.end <= 6, `activeIndex=${activeIndex} end must not exceed total`);
        assert.ok(window_.start >= 0, `activeIndex=${activeIndex} start must not go negative`);
    }
});
