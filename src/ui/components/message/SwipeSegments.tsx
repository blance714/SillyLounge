import React, { useRef } from 'preact/compat';
import type { ComponentChild } from 'preact';
import { swipeChatuiMessageToIndex } from '../../actions.js';
import { computeSwipeSegmentWindow } from '../../swipe-segment-math.js';
import type { ChatuiMessage } from '../../types.js';

/**
 * The swipe version tick row (design §43): a small mark per candidate reply,
 * the active one wider, click any to jump straight there. Windowing math
 * (which ≤5 of possibly-many swipes are on screen) lives in
 * ui/swipe-segment-math.ts; this component only turns that window into
 * markup and wires clicks/arrow keys to swipeChatuiMessageToIndex.
 *
 * role="radiogroup"/"radio" rather than "slider": these are up to 5 *named*,
 * mutually-exclusive stops ("the 3rd version", "the 4th version"), not a
 * scalar range, and every stop is already its own small hit target — there
 * is nothing to drag or page through the way the floor rail's one big
 * scrub surface has (MessageFloorRail.tsx's `role="slider"`). A slider would
 * also have to advertise aria-valuemin/max against whichever 5-wide slice
 * happens to be visible, which misstates the true range the moment the
 * window doesn't start at swipe 1. Roving tabindex (only the checked radio
 * is a tab stop; arrow keys move both focus and the pick) follows the ARIA
 * APG radiogroup pattern rather than leaving all ≤5 ticks individually
 * tabbable, which would read as five separate "radio button" announcements
 * for one control.
 */
export function SwipeSegments({ message }: { message: ChatuiMessage }): ComponentChild {
    const buttonRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

    if (!message.swipe.hasMultiple) return null;

    const activeIndex = message.swipe.id;
    const total = message.swipe.count;
    const { start, end, windowed } = computeSwipeSegmentWindow(activeIndex, total);

    const pick = (index: number) => {
        if (index !== activeIndex) swipeChatuiMessageToIndex(message.id, index, message.chatKey);
    };
    const focusIndex = (index: number) => buttonRefs.current.get(index)?.focus();

    const segments: ComponentChild[] = [];
    for (let index = start; index < end; index += 1) {
        const isCurrent = index === activeIndex;
        const label = `第 ${index + 1} 个版本`;
        segments.push(
            <button
                key={index}
                ref={(el: HTMLButtonElement | null) => {
                    if (el) buttonRefs.current.set(index, el);
                    else buttonRefs.current.delete(index);
                }}
                type="button"
                role="radio"
                aria-checked={isCurrent}
                aria-label={label}
                title={label}
                tabIndex={isCurrent ? 0 : -1}
                className={`cui-root-swipe-segment${isCurrent ? ' is-current' : ''}`}
                onClick={(event) => { event.stopPropagation(); pick(index); }}
                onKeyDown={(event) => {
                    let next = index;
                    if (event.key === 'ArrowRight') next = Math.min(end - 1, index + 1);
                    else if (event.key === 'ArrowLeft') next = Math.max(start, index - 1);
                    else if (event.key === 'Home') next = start;
                    else if (event.key === 'End') next = end - 1;
                    else return;
                    event.preventDefault();
                    event.stopPropagation();
                    focusIndex(next);
                    pick(next);
                }}
            />,
        );
    }

    return (
        <>
            <div className="cui-root-swipe-segments" role="radiogroup" aria-label="切换版本">
                {segments}
            </div>
            {windowed && <span className="cui-root-swipe-count">{message.swipe.label}</span>}
        </>
    );
}
