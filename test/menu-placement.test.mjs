// test/menu-placement.test.mjs
//
// dist/runtime/ui/menu-placement.js — pure geometry, no host/DOM needed.
// Source: src/ui/menu-placement.ts. Pins the flip contract DESIGN §6 states
// (「浮层向下打开为默认，空间不足时才翻转」) and the height estimate the
// decision runs on, as consumed by MessageActions.tsx's MoreMenu.
//
// The height constants were measured in Chromium against style.css (a menu of
// 1/2/3/5/7 rows, with and without a separator: 43 / 76 / 109 / 175 / 250px,
// and 85 / 184px with one separator). The `expected` numbers below are those
// measurements written out as literals rather than recomputed from the
// exported constants — a test that multiplied MENU_ROW_PX itself would still
// pass if the row height silently stopped matching the stylesheet, which is
// the only way this module can go wrong.
//
// The geometry assertions are the other half: whichever way the menu opens, the
// offset it returns is derived from an edge of the trigger that was actually
// measured, so an estimate that is off by a row can change the *direction* but
// can never leave the menu floating away from the button it belongs to.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    MENU_CHROME_PX,
    MENU_ROW_PX,
    MENU_SEPARATOR_PX,
    MENU_TRIGGER_GAP_PX,
    estimateMenuHeight,
    placeMenuAgainstTrigger,
} from '../dist/runtime/ui/menu-placement.js';

/** The ⋯ menu of an ordinary turn: 5 rows, one separator above 隐藏此楼. */
const TURN_MENU_HEIGHT = 184;
/** A system row's ⋯ menu: 复制 + 复制原文, no separator. */
const SYSTEM_MENU_HEIGHT = 76;

test('the menu box constants are the ones measured against style.css, not round numbers', () => {
    assert.equal(MENU_ROW_PX, 33, '.cui-paper-item: 8px + 17px line box + 8px');
    assert.equal(MENU_SEPARATOR_PX, 9, '.cui-paper-sep: 4px + 1px hairline + 4px');
    assert.equal(MENU_CHROME_PX, 10, '.cui-root-menu 0.25rem block padding + .cui-paper 1px border');
    assert.equal(MENU_TRIGGER_GAP_PX, 4, 'the air between trigger and menu, either side');
});

test('estimateMenuHeight reproduces every menu size measured in the browser', () => {
    const cases = [
        { rows: 1, separators: 0, expected: 43 },
        { rows: 2, separators: 0, expected: SYSTEM_MENU_HEIGHT },
        { rows: 3, separators: 0, expected: 109 },
        { rows: 5, separators: 0, expected: 175 },
        { rows: 2, separators: 1, expected: 85 },
        { rows: 5, separators: 1, expected: TURN_MENU_HEIGHT },
        { rows: 7, separators: 1, expected: 250 },
        // Degenerate, but it must still be the chrome rather than 0 or NaN:
        // an empty menu is not rendered at all (MoreMenu returns null), and a
        // height of 0 here would silently claim "fits anywhere".
        { rows: 0, separators: 0, expected: 10 },
    ];

    for (const { rows, separators, expected } of cases) {
        assert.equal(estimateMenuHeight(rows, separators), expected, `${rows} rows / ${separators} separators`);
    }
});

test('placeMenuAgainstTrigger: room below opens downward, hung off the trigger bottom', () => {
    // A ⋯ button halfway down a 900px desktop viewport: 184px of menu, 462px
    // of room below it. Nothing to decide.
    const placement = placeMenuAgainstTrigger({
        trigger: { top: 401, bottom: 434, right: 900 },
        viewport: { width: 1440, height: 900 },
        estimatedHeight: TURN_MENU_HEIGHT,
    });

    assert.equal(placement.direction, 'down');
    assert.equal(placement.top, 438, 'trigger bottom + the 4px gap');
    assert.equal(placement.bottom, null, 'a downward menu must not also anchor its bottom edge');
    assert.equal(placement.right, 540, 'viewport width - trigger right');
});

test('placeMenuAgainstTrigger: the desktop bug — a trigger near the viewport floor flips up', () => {
    // The reported case: 1440x900, the ⋯ of the last message sits at y≈800, so
    // only 96px of the 184px menu would have fitted and 隐藏此楼 — the one
    // destructive row — was the part cut off.
    const placement = placeMenuAgainstTrigger({
        trigger: { top: 767, bottom: 800, right: 900 },
        viewport: { width: 1440, height: 900 },
        estimatedHeight: TURN_MENU_HEIGHT,
    });

    assert.equal(placement.direction, 'up');
    assert.equal(placement.top, null, 'a flipped menu must not also anchor its top edge');
    assert.equal(placement.bottom, 137, 'viewport height - trigger top + the 4px gap');
    assert.equal(placement.right, 540, 'the horizontal anchor is unaffected by the flip');
});

test('placeMenuAgainstTrigger: the flip boundary is "taller than the space", not "as tall as"', () => {
    // 900px tall viewport, trigger bottom at 712 → spaceBelow = 900-712-4 = 184.
    const exactly = placeMenuAgainstTrigger({
        trigger: { top: 679, bottom: 712, right: 900 },
        viewport: { width: 1440, height: 900 },
        estimatedHeight: TURN_MENU_HEIGHT,
    });
    assert.equal(exactly.direction, 'down', 'a menu that exactly fills the space below still opens down');
    assert.equal(exactly.top, 716);

    // One pixel taller than the space and it must flip.
    const oneMore = placeMenuAgainstTrigger({
        trigger: { top: 679, bottom: 712, right: 900 },
        viewport: { width: 1440, height: 900 },
        estimatedHeight: TURN_MENU_HEIGHT + 1,
    });
    assert.equal(oneMore.direction, 'up');
    assert.equal(oneMore.bottom, 225);
});

test('placeMenuAgainstTrigger: never flips into a space that is tighter than the one it left', () => {
    // A short viewport (a phone in landscape, 380px tall) with the trigger
    // high up, and a menu (307px = 9 rows) that fits on neither side: below
    // has 283px, above has 56px. Flipping here would cost rows instead of
    // saving them, so the default direction stands.
    const highUp = placeMenuAgainstTrigger({
        trigger: { top: 60, bottom: 93, right: 370 },
        viewport: { width: 390, height: 380 },
        estimatedHeight: 307,
    });
    assert.equal(highUp.direction, 'down', 'more room below than above → stay down even though it does not fit');
    assert.equal(highUp.top, 97);

    // Same viewport, trigger low: now above is the better of two bad options.
    const lowDown = placeMenuAgainstTrigger({
        trigger: { top: 300, bottom: 333, right: 370 },
        viewport: { width: 390, height: 380 },
        estimatedHeight: TURN_MENU_HEIGHT,
    });
    assert.equal(lowDown.direction, 'up');
    assert.equal(lowDown.bottom, 84);

    // And the exact tie — 171px free on both sides — resolves to the default
    // direction, because §6 makes downward the default and only 「空间不足」
    // overrides it.
    const tie = placeMenuAgainstTrigger({
        trigger: { top: 175, bottom: 205, right: 370 },
        viewport: { width: 390, height: 380 },
        estimatedHeight: TURN_MENU_HEIGHT,
    });
    assert.equal(tie.direction, 'down', 'equal room on both sides is not "空间不足" enough to flip');
});

test('placeMenuAgainstTrigger: a two-row system menu keeps opening down where a five-row one flips', () => {
    // Same trigger, same viewport, different menu: the decision is about this
    // menu's own height, not about where the button happens to sit.
    const trigger = { top: 767, bottom: 800, right: 900 };
    const viewport = { width: 1440, height: 900 };

    const short = placeMenuAgainstTrigger({ trigger, viewport, estimatedHeight: SYSTEM_MENU_HEIGHT });
    assert.equal(short.direction, 'down', '76px fits in the 96px below');
    assert.equal(short.top, 804);

    const tall = placeMenuAgainstTrigger({ trigger, viewport, estimatedHeight: TURN_MENU_HEIGHT });
    assert.equal(tall.direction, 'up', '184px does not');
});

test('placeMenuAgainstTrigger: both directions stay welded to an edge of the trigger', () => {
    // The property that makes an estimated height safe: whichever branch runs,
    // the returned offset is a function of a measured trigger edge and the
    // gap alone — the estimate never reaches the geometry. Sweep a trigger
    // down a viewport and assert exactly that at every step.
    const viewport = { width: 1200, height: 700 };
    for (let top = 0; top <= 660; top += 20) {
        const trigger = { top, bottom: top + 33, right: 1000 };
        const placement = placeMenuAgainstTrigger({ trigger, viewport, estimatedHeight: TURN_MENU_HEIGHT });
        if (placement.direction === 'down') {
            assert.equal(placement.top, trigger.bottom + MENU_TRIGGER_GAP_PX, `top=${top}`);
            assert.equal(placement.bottom, null, `top=${top}`);
        } else {
            assert.equal(placement.bottom, viewport.height - trigger.top + MENU_TRIGGER_GAP_PX, `top=${top}`);
            assert.equal(placement.top, null, `top=${top}`);
        }
        assert.equal(placement.right, viewport.width - trigger.right, `top=${top}`);
    }
});

test('placeMenuAgainstTrigger: an explicit gap of 0 removes the air on whichever side is used', () => {
    const down = placeMenuAgainstTrigger({
        trigger: { top: 100, bottom: 133, right: 500 },
        viewport: { width: 800, height: 900 },
        estimatedHeight: TURN_MENU_HEIGHT,
        gap: 0,
    });
    assert.deepEqual(down, { direction: 'down', top: 133, bottom: null, right: 300 });

    const up = placeMenuAgainstTrigger({
        trigger: { top: 800, bottom: 833, right: 500 },
        viewport: { width: 800, height: 900 },
        estimatedHeight: TURN_MENU_HEIGHT,
        gap: 0,
    });
    assert.deepEqual(up, { direction: 'up', top: null, bottom: 100, right: 300 });
});
