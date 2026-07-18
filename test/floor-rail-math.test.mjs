// test/floor-rail-math.test.mjs
//
// dist/runtime/ui/floor-rail-math.js — pure geometry, no host/DOM needed.
// Source: src/ui/floor-rail-math.ts. Pins the exact centering contract used
// by MessageFloorRail.tsx (maxWindowStart = Math.max(0, turns.length -
// capacity), see src/ui/components/MessageFloorRail.tsx:236):
//
//   centeredStart = activeIndex - Math.floor((capacity - 1) / 2)
//   windowStart   = clamp(centeredStart, 0, max(0, maxWindowStart))
//
// Every `expected` below is a literal integer computed by hand from that
// contract, not re-derived by calling Math.floor((capacity - 1) / 2) inside
// this file — a test that recomputed the same formula would pass even if
// the source regressed to the classic off-by-one bug (Math.floor(capacity
// / 2), which places the active tick one slot too late on every even
// capacity). Hardcoding the numbers is what makes that regression visible.

import assert from 'node:assert/strict';
import test from 'node:test';

import { centerWindowStart, clampWindowStart } from '../dist/runtime/ui/floor-rail-math.js';

test('clampWindowStart: pins the min/max clamp arithmetic exactly', () => {
    const cases = [
        { name: 'value already inside range is unchanged', value: 5, maxWindowStart: 10, expected: 5 },
        { name: 'value below zero clamps up to zero', value: -3, maxWindowStart: 10, expected: 0 },
        { name: 'value above the ceiling clamps down to it', value: 15, maxWindowStart: 10, expected: 10 },
        { name: 'zero ceiling forces zero regardless of a positive value', value: 5, maxWindowStart: 0, expected: 0 },
        { name: 'zero ceiling forces zero regardless of a negative value', value: -5, maxWindowStart: 0, expected: 0 },
        { name: 'a negative ceiling is treated as zero, not as a negative bound', value: 5, maxWindowStart: -3, expected: 0 },
        { name: 'a negative value under a negative ceiling still floors at zero', value: -5, maxWindowStart: -3, expected: 0 },
        { name: 'value and ceiling both zero', value: 0, maxWindowStart: 0, expected: 0 },
    ];

    for (const { name, value, maxWindowStart, expected } of cases) {
        assert.equal(clampWindowStart(value, maxWindowStart), expected, name);
    }
});

test('centerWindowStart: odd capacities center the active tick exactly, unclamped', () => {
    // turns = 101 (indices 0..100), activeIndex = 50 sits far enough from
    // both ends that no clamping engages for any capacity in this table, so
    // the raw centering formula is what's under test here.
    const cases = [
        // capacity, expected windowStart (half = floor((capacity-1)/2))
        { capacity: 1, expected: 50 }, // half 0 -> active is the single visible tick
        { capacity: 3, expected: 49 }, // half 1 -> 1 tick before, 1 after
        { capacity: 5, expected: 48 }, // half 2 -> 2 before, 2 after
        { capacity: 7, expected: 47 }, // half 3 -> 3 before, 3 after
        { capacity: 9, expected: 46 }, // half 4 -> 4 before, 4 after
    ];

    for (const { capacity, expected } of cases) {
        const windowStart = centerWindowStart(50, capacity, 94);
        assert.equal(windowStart, expected, `capacity=${capacity}`);
        // Odd capacity: the active tick's offset within the window
        // (activeIndex - windowStart) must land exactly on the middle slot.
        const offsetInWindow = 50 - windowStart;
        assert.equal(offsetInWindow, (capacity - 1) / 2, `capacity=${capacity} must center exactly`);
    }
});

test('centerWindowStart: even capacities bias the active tick to the earlier half of the window', () => {
    // Same unclamped scenario as the odd-capacity test. For an even capacity
    // C, the correct offset-in-window is floor((C-1)/2) = C/2 - 1 (fewer
    // slots before the active tick than after it). The classic off-by-one
    // bug is using Math.floor(capacity/2) = C/2 instead, which would place
    // one MORE slot before the active tick than after — i.e. flip the bias
    // downward. Both the correct offset and the rejected buggy offset are
    // spelled out per case so the distinction is unmistakable.
    const cases = [
        // capacity, expected windowStart, correct offset, rejected buggy offset
        { capacity: 2, expected: 50, correctOffset: 0, buggyOffset: 1 },
        { capacity: 4, expected: 49, correctOffset: 1, buggyOffset: 2 },
        { capacity: 6, expected: 48, correctOffset: 2, buggyOffset: 3 },
        { capacity: 8, expected: 47, correctOffset: 3, buggyOffset: 4 },
    ];

    for (const { capacity, expected, correctOffset, buggyOffset } of cases) {
        const windowStart = centerWindowStart(50, capacity, 94);
        assert.equal(windowStart, expected, `capacity=${capacity}`);

        const offsetInWindow = 50 - windowStart;
        assert.equal(offsetInWindow, correctOffset, `capacity=${capacity} must use the upward-biased offset`);
        assert.notEqual(
            offsetInWindow,
            buggyOffset,
            `capacity=${capacity} must not match the Math.floor(capacity/2) off-by-one`,
        );
    }
});

test('centerWindowStart: clamps at the start of the conversation', () => {
    // turns = 101, capacity = 7 (half = 3), maxWindowStart = 94.
    const cases = [
        { name: 'active tick at the very first turn', activeIndex: 0, expected: 0 },
        { name: 'active tick 2 turns in — still not enough room before it', activeIndex: 2, expected: 0 },
        { name: 'active tick exactly at the first unclamped position', activeIndex: 3, expected: 0 },
        { name: 'one turn past the clamp boundary is no longer clamped', activeIndex: 4, expected: 1 },
    ];

    for (const { name, activeIndex, expected } of cases) {
        assert.equal(centerWindowStart(activeIndex, 7, 94), expected, name);
    }
});

test('centerWindowStart: clamps at the end of the conversation', () => {
    // turns = 101 (last index 100), capacity = 7 (half = 3), maxWindowStart = 94.
    const cases = [
        { name: 'one turn before the clamp boundary is not yet clamped', activeIndex: 96, expected: 93 },
        { name: 'active tick exactly at the last unclamped position', activeIndex: 97, expected: 94 },
        { name: 'active tick 2 turns from the end', activeIndex: 98, expected: 94 },
        { name: 'active tick at the very last turn', activeIndex: 100, expected: 94 },
    ];

    for (const { name, activeIndex, expected } of cases) {
        assert.equal(centerWindowStart(activeIndex, 7, 94), expected, name);
    }
});

test('centerWindowStart: capacity covering the whole conversation always yields windowStart 0', () => {
    const cases = [
        { name: 'capacity exactly equal to turn count, active at the start', activeIndex: 0, capacity: 5, maxWindowStart: 0 },
        { name: 'capacity exactly equal to turn count, active in the middle', activeIndex: 2, capacity: 5, maxWindowStart: 0 },
        { name: 'capacity exactly equal to turn count, active at the end', activeIndex: 4, capacity: 5, maxWindowStart: 0 },
        { name: 'capacity larger than the turn count', activeIndex: 1, capacity: 10, maxWindowStart: 0 },
    ];

    for (const { name, activeIndex, capacity, maxWindowStart } of cases) {
        assert.equal(centerWindowStart(activeIndex, capacity, maxWindowStart), 0, name);
    }
});

test('centerWindowStart: degenerate capacity 1 tracks the active tick exactly, one turn per window', () => {
    // turns = 5, capacity = 1 (half = 0), maxWindowStart = 4.
    const cases = [
        { activeIndex: 0, expected: 0 },
        { activeIndex: 2, expected: 2 },
        { activeIndex: 4, expected: 4 },
    ];

    for (const { activeIndex, expected } of cases) {
        assert.equal(centerWindowStart(activeIndex, 1, 4), expected, `activeIndex=${activeIndex}`);
    }
});

test('centerWindowStart: degenerate capacity 0 is still deterministic and clamps within range', () => {
    // turns = 5, capacity = 0: half = Math.floor((0 - 1) / 2) = Math.floor(-0.5) = -1,
    // so centeredStart = activeIndex - (-1) = activeIndex + 1. maxWindowStart = 5.
    const cases = [
        { name: 'active tick at the start', activeIndex: 0, expected: 1 },
        { name: 'active tick in the middle', activeIndex: 2, expected: 3 },
        { name: 'active tick at the last real turn — exactly at the ceiling, not clamped', activeIndex: 4, expected: 5 },
    ];

    for (const { name, activeIndex, expected } of cases) {
        assert.equal(centerWindowStart(activeIndex, 0, 5), expected, name);
    }
});
