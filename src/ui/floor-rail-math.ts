/**
 * SillyTavern-ChatUI · floor rail windowing math
 *
 * Pure geometry for the floor rail's visible tick window, extracted so the
 * centering behavior can be exercised by Node tests without a layout harness.
 */

export function clampWindowStart(value: number, maxWindowStart: number): number {
    return Math.min(Math.max(value, 0), Math.max(0, maxWindowStart));
}

/**
 * Start index of the visible tick window that keeps the active turn centered.
 *
 * Centering must bias upward on even capacities so the active tick never sits
 * below the visual midpoint, and the result is clamped to the valid window
 * range at both ends of the conversation.
 */
export function centerWindowStart(
    activeIndex: number,
    capacity: number,
    maxWindowStart: number,
): number {
    const centeredStart = activeIndex - Math.floor((capacity - 1) / 2);
    return clampWindowStart(centeredStart, maxWindowStart);
}
