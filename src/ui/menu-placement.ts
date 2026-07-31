/**
 * SillyTavern-ChatUI · floating menu placement
 *
 * DESIGN §6: 「浮层向下打开为默认，空间不足时才翻转，且不得被根容器裁切」. This is
 * the "space enough / not enough" half of that sentence, extracted so the
 * decision can be exercised by Node tests without a layout harness — same tier
 * as floor-rail-math.ts / swipe-segment-math.ts.
 *
 * ── Why an *estimated* height, when the menu's real height is right there ──
 *
 * It is not there yet. The message ⋯ menu positions itself from a one-shot
 * snapshot of the trigger's rect taken at open time (see MessageActions.tsx),
 * i.e. before the menu exists in the DOM, so nothing has measured it. Three
 * ways out were on the table:
 *
 *   1. Mount first, measure in a layout effect, then correct the position.
 *      Exact, and Preact's useLayoutEffect does run before paint, so it would
 *      not flash — but it makes the placement a two-pass effect chain instead
 *      of a value, forces a synchronous layout on every open, and leaves the
 *      component with two sources of geometric truth to keep in agreement.
 *   2. Estimate the height and place the menu at `top = viewportHeight -
 *      estimate`. Every pixel of estimate error becomes a pixel of position
 *      error: the menu floats away from the trigger it belongs to.
 *   3. What this module does: estimate the height for the *decision* only, and
 *      anchor both outcomes to an edge that was actually measured — downward
 *      by the trigger's bottom, upward by the trigger's top, expressed as a
 *      `bottom` offset so the menu grows away from that edge at whatever
 *      height it turns out to have.
 *
 * The point of (3) is the failure mode. The estimate is only ever compared
 * against the free space, so being wrong by a row changes the answer solely in
 * the narrow band where the menu *just* fits or *just* does not, and the cost
 * there is "it opened the other way", never "it opened detached from its
 * trigger" or "it opened off-screen". No frame is ever painted at a position
 * that gets corrected, because there is no correction.
 *
 * The constants below are that estimate, and they mirror .cui-paper-item /
 * .cui-paper-sep / .cui-root-menu in style.css. Measured in Chromium against
 * this stylesheet rather than derived on paper — 1/2/3/5/7 rows, with and
 * without a separator, all match the arithmetic exactly. They are the one
 * place this module can drift from the drawing; the comment on each says what
 * it is made of so a paddings change can be followed here.
 */

/**
 * One menu row: 8px padding, a `normal` line box over --cui-font-menu
 * (12.5px → 17px), 8px padding. The line box resolves against the row's own
 * font-size, not against anything the host publishes, so this height moves
 * only when our own type scale does.
 */
export const MENU_ROW_PX = 33;

/** .cui-paper-sep: a hairline with 4px of air above and below. */
export const MENU_SEPARATOR_PX = 9;

/** .cui-root-menu's own 0.25rem block padding plus .cui-paper's 1px border. */
export const MENU_CHROME_PX = 10;

/** The air the menu keeps between itself and the trigger, either side of it. */
export const MENU_TRIGGER_GAP_PX = 4;

export function estimateMenuHeight(rowCount: number, separatorCount: number): number {
    return rowCount * MENU_ROW_PX + separatorCount * MENU_SEPARATOR_PX + MENU_CHROME_PX;
}

export type MenuPlacement = {
    /**
     * 'down' hangs the menu's top edge under the trigger (the default);
     * 'up' hangs its bottom edge above the trigger.
     */
    direction: 'down' | 'up';
    /** Viewport-relative `top`, or null when the menu is bottom-anchored. */
    top: number | null;
    /** Viewport-relative `bottom`, or null when the menu is top-anchored. */
    bottom: number | null;
    /** Viewport-relative `right`: the menu's right edge tracks the trigger's. */
    right: number;
};

/**
 * Place a fixed-position menu against a trigger whose rect has already been
 * read. `estimatedHeight` decides the direction; the returned offsets are
 * derived from the trigger's own edges and are exact whichever way it goes.
 *
 * Flipping requires two things, not one: the menu must not fit below *and*
 * there must be more room above than below. Without the second test a trigger
 * near the top of a short viewport would flip into an even tighter space and
 * lose more rows than it started with. When neither side fits, the menu opens
 * downward on the same "default unless proven otherwise" reading of §6.
 */
export function placeMenuAgainstTrigger({
    trigger,
    viewport,
    estimatedHeight,
    gap = MENU_TRIGGER_GAP_PX,
}: {
    trigger: { top: number; bottom: number; right: number };
    viewport: { width: number; height: number };
    estimatedHeight: number;
    gap?: number;
}): MenuPlacement {
    const spaceBelow = viewport.height - trigger.bottom - gap;
    const spaceAbove = trigger.top - gap;
    const right = viewport.width - trigger.right;

    if (estimatedHeight > spaceBelow && spaceAbove > spaceBelow) {
        return {
            direction: 'up',
            top: null,
            bottom: viewport.height - trigger.top + gap,
            right,
        };
    }

    return {
        direction: 'down',
        top: trigger.bottom + gap,
        bottom: null,
        right,
    };
}
