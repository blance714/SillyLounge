// test/follow-scroll-math.test.mjs
//
// dist/runtime/ui/follow-scroll-math.js — pure arithmetic, no host/DOM needed.
// Source: src/ui/follow-scroll-math.ts. Pins the two gates useAutoScroll reads
// off one scroll container (src/ui/hooks.ts, useAutoScroll):
//
//   distanceFromBottom = scrollHeight - scrollTop - clientHeight
//   pinned             = distanceFromBottom < 80
//   awayFromLatest     = distanceFromBottom > 240
//
// These were a single constant (AT_BOTTOM_THRESHOLD = 80) doing two unrelated
// jobs, so 「回到最新」 appeared the moment auto-follow let go — 80px up, with
// the latest message still fully on screen. Splitting them is only safe if the
// split itself is pinned, which is what this file does:
//
//   1. Every `expected` is a literal computed by hand, never re-derived by
//      calling the same expression the source uses — a test that recomputed
//      `h - t - c` would pass even if the source dropped a term.
//   2. The boundaries are asserted from both sides at 1px resolution, because
//      both comparisons are strict and each has an opposite failure mode: a
//      follow gate that turned `<` into `<=` would yank a reader who stopped
//      exactly 80px up back to the bottom mid-generation, and a jump gate that
//      turned `>` into `>=` would be invisible in every screenshot.
//   3. The dead zone between them is asserted as a state in its own right,
//      not as a gap. It is the whole point of the split: not following, and
//      not offering a way back either.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CHATUI_FOLLOW_THRESHOLD_PX,
    CHATUI_JUMP_LATEST_THRESHOLD_PX,
    readFollowGates,
} from '../dist/runtime/ui/follow-scroll-math.js';

/** A container whose bottom edge sits `distance` px above the end of the content. */
function extentAtDistance(distance) {
    // clientHeight 600, scrollTop 1000 → scrollHeight 1600 + distance.
    return { scrollHeight: 1600 + distance, scrollTop: 1000, clientHeight: 600 };
}

test('follow-scroll gates: the two thresholds are 80px and 240px, and the jump gate is the far one', () => {
    assert.equal(CHATUI_FOLLOW_THRESHOLD_PX, 80);
    assert.equal(CHATUI_JUMP_LATEST_THRESHOLD_PX, 240);
    // The dead zone only exists because of this ordering; if the two ever
    // crossed, `pinned` and `awayFromLatest` could both be true at once and the
    // capsule would float over a view that is still auto-following.
    assert.ok(
        CHATUI_FOLLOW_THRESHOLD_PX < CHATUI_JUMP_LATEST_THRESHOLD_PX,
        'the follow gate must stay below the jump gate',
    );
});

test('readFollowGates: distance is the content below the viewport, not the scroll offset', () => {
    const cases = [
        { name: 'top of a 3-screen conversation', scrollHeight: 1800, scrollTop: 0, clientHeight: 600, expected: 1200 },
        { name: 'one screen down', scrollHeight: 1800, scrollTop: 600, clientHeight: 600, expected: 600 },
        { name: 'exactly at the end', scrollHeight: 1800, scrollTop: 1200, clientHeight: 600, expected: 0 },
        { name: 'content shorter than the viewport', scrollHeight: 400, scrollTop: 0, clientHeight: 600, expected: -200 },
        { name: 'fractional scrollTop leaves a fractional distance', scrollHeight: 1800, scrollTop: 1199.5, clientHeight: 600, expected: 0.5 },
    ];

    for (const { name, scrollHeight, scrollTop, clientHeight, expected } of cases) {
        const gates = readFollowGates({ scrollHeight, scrollTop, clientHeight });
        assert.equal(gates.distanceFromBottom, expected, name);
    }
});

test('readFollowGates: the follow gate holds up to but not at 80px', () => {
    const cases = [
        { name: 'pinned to the very end', distance: 0, pinned: true },
        { name: 'a line of body copy up', distance: 30, pinned: true },
        { name: 'one pixel inside the gate', distance: 79, pinned: true },
        { name: 'exactly at the gate is already outside it', distance: 80, pinned: false },
        { name: 'one pixel outside the gate', distance: 81, pinned: false },
        { name: 'far outside the gate', distance: 900, pinned: false },
    ];

    for (const { name, distance, pinned } of cases) {
        assert.equal(readFollowGates(extentAtDistance(distance)).pinned, pinned, name);
    }
});

test('readFollowGates: the 「回到最新」 gate opens past 240px, never at it', () => {
    const cases = [
        { name: 'still at the end', distance: 0, awayFromLatest: false },
        { name: 'just past the follow gate', distance: 81, awayFromLatest: false },
        { name: 'one pixel short of the jump gate', distance: 239, awayFromLatest: false },
        { name: 'exactly at the jump gate is still quiet', distance: 240, awayFromLatest: false },
        { name: 'one pixel past the jump gate', distance: 241, awayFromLatest: true },
        { name: 'deep in the history', distance: 4000, awayFromLatest: true },
    ];

    for (const { name, distance, awayFromLatest } of cases) {
        assert.equal(readFollowGates(extentAtDistance(distance)).awayFromLatest, awayFromLatest, name);
    }
});

test('readFollowGates: the 80–240px dead zone follows nothing and offers nothing', () => {
    // The reader has stopped the auto-follow but can still see where they were,
    // so neither gate is open. Asserted across the whole band, not just at its
    // edges, so collapsing the two thresholds back into one constant fails here
    // whichever of the two values the survivor takes.
    for (const distance of [80, 100, 160, 200, 239, 240]) {
        const gates = readFollowGates(extentAtDistance(distance));
        assert.equal(gates.pinned, false, `distance=${distance} must not auto-follow`);
        assert.equal(gates.awayFromLatest, false, `distance=${distance} must not show the capsule`);
    }
});

test('readFollowGates: the two gates are never open at the same time', () => {
    const distances = [-400, -1, 0, 1, 79, 80, 81, 239, 240, 241, 1000, 100000];

    for (const distance of distances) {
        const { pinned, awayFromLatest } = readFollowGates(extentAtDistance(distance));
        assert.ok(
            !(pinned && awayFromLatest),
            `distance=${distance} opened both gates — the capsule would float over a following view`,
        );
    }
});

test('readFollowGates: over-scroll and unscrollable containers both count as pinned', () => {
    const cases = [
        // Rubber-band / elastic over-scroll past the end reports a negative distance.
        { name: 'over-scrolled past the end', extent: { scrollHeight: 1800, scrollTop: 1400, clientHeight: 600 }, distance: -200 },
        // A conversation shorter than the viewport: nothing to scroll, and the
        // latest message is on screen by definition.
        { name: 'content shorter than the viewport', extent: { scrollHeight: 300, scrollTop: 0, clientHeight: 600 }, distance: -300 },
        // Container not laid out yet (display:none, or measured before mount).
        { name: 'zero-sized container', extent: { scrollHeight: 0, scrollTop: 0, clientHeight: 0 }, distance: 0 },
    ];

    for (const { name, extent, distance } of cases) {
        const gates = readFollowGates(extent);
        assert.equal(gates.distanceFromBottom, distance, name);
        assert.equal(gates.pinned, true, `${name} must stay pinned`);
        assert.equal(gates.awayFromLatest, false, `${name} must not show the capsule`);
    }
});
