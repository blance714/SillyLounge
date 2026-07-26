import React, {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'preact/compat';
import type { ComponentChild } from 'preact';
import { useChatuiMessage } from '../hooks.js';
import { centerWindowStart } from '../floor-rail-math.js';

const APP_EDGE_INSET_PX = 16;
const RAIL_WIDTH_PX = 30;
const CONTENT_CLEARANCE_PX = 12;
const VERTICAL_SAFE_AREA_PX = 40;
const TICK_HEIGHT_PX = 2;
const TICK_GAP_PX = 8;
const TICK_PITCH_PX = TICK_HEIGHT_PX + TICK_GAP_PX;
const WHEEL_STEP_PX = 24;
const RANGE_LABEL_IDLE_MS = 800;
const POPOVER_EDGE_GUARD_PX = 56;

type UserTurn = Readonly<{
    userMessageId: number;
    responseMessageId: number | null;
}>;
type RailLayout = Readonly<{ capacity: number; left: number }>;
type HoveredTurn = Readonly<{ slot: number }>;

export type MessageFloorNavigation = Readonly<{
    messageIds: readonly number[];
    indexAtOffset: (offset: number) => number | null;
    scrollToMessage: (messageId: number, behavior: ScrollBehavior) => void;
}>;

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function useRailLayout(root: HTMLDivElement | null): RailLayout | null {
    const [layout, setLayout] = useState<RailLayout | null>(null);

    useLayoutEffect(() => {
        if (!root) {
            setLayout(null);
            return;
        }
        const stage = root.parentElement;
        if (!stage) return;
        const desktop = window.matchMedia('(min-width: 769px)');
        const preciseHover = window.matchMedia('(any-hover: hover) and (any-pointer: fine)');
        let observedMouse = false;

        const update = () => {
            const stageRect = stage.getBoundingClientRect();
            const appRect = stage.closest<HTMLElement>('.cui-root-app')?.getBoundingClientRect();
            const contentLeft = root.getBoundingClientRect().left;
            const availableHeight = Math.max(0, stageRect.height - VERTICAL_SAFE_AREA_PX * 2);
            const capacity = Math.max(1, Math.floor(
                (availableHeight + TICK_GAP_PX) / TICK_PITCH_PX,
            ));
            const hasDesktopPointer = preciseHover.matches
                || observedMouse
                || navigator.maxTouchPoints === 0;
            const appLeft = appRect?.left ?? stageRect.left;
            const railLeft = appLeft + APP_EDGE_INSET_PX;
            const hasReadingGutter = contentLeft - railLeft >= RAIL_WIDTH_PX + CONTENT_CLEARANCE_PX;
            const next = desktop.matches
                && hasDesktopPointer
                && hasReadingGutter
                && availableHeight >= TICK_HEIGHT_PX
                ? {
                    capacity,
                    left: railLeft - stageRect.left,
                }
                : null;
            setLayout(previous => (
                previous?.capacity === next?.capacity && previous?.left === next?.left
                    ? previous
                    : next
            ));
        };
        const observeMouse = (event: PointerEvent) => {
            if (event.pointerType !== 'mouse') return;
            observedMouse = true;
            update();
            window.removeEventListener('pointermove', observeMouse, true);
        };

        update();
        desktop.addEventListener('change', update);
        preciseHover.addEventListener('change', update);
        window.addEventListener('pointermove', observeMouse, { capture: true, passive: true });
        window.addEventListener('resize', update, { passive: true });
        const observer = typeof ResizeObserver === 'function'
            ? new ResizeObserver(update)
            : null;
        observer?.observe(stage);
        observer?.observe(root);
        return () => {
            observer?.disconnect();
            desktop.removeEventListener('change', update);
            preciseHover.removeEventListener('change', update);
            window.removeEventListener('pointermove', observeMouse, true);
            window.removeEventListener('resize', update);
        };
    }, [root]);

    return layout;
}

function useActiveTurn(
    root: HTMLDivElement | null,
    turns: readonly UserTurn[],
    navigation: MessageFloorNavigation,
): number {
    const [activeIndex, setActiveIndex] = useState(0);
    const turnMessageIndexes = useMemo(() => {
        const indexesById = new Map(navigation.messageIds.map((messageId, index) => [messageId, index]));
        return turns.map(turn => indexesById.get(turn.userMessageId) ?? 0);
    }, [navigation.messageIds, turns]);

    useEffect(() => {
        if (!root || turns.length === 0) {
            setActiveIndex(0);
            return;
        }
        let frame = 0;
        const update = () => {
            frame = 0;
            const maxIndex = turns.length - 1;
            const bottomDistance = root.scrollHeight - root.scrollTop - root.clientHeight;
            if (bottomDistance < 4) {
                setActiveIndex(previous => (previous === maxIndex ? previous : maxIndex));
                return;
            }
            if (root.scrollTop < 4) {
                setActiveIndex(previous => (previous === 0 ? previous : 0));
                return;
            }

            const readingOffset = root.scrollTop + root.clientHeight * 0.26;
            const readingMessageIndex = navigation.indexAtOffset(readingOffset) ?? 0;
            let low = 0;
            let high = maxIndex;
            let nearest = 0;
            while (low <= high) {
                const middle = Math.floor((low + high) / 2);
                if ((turnMessageIndexes[middle] ?? 0) <= readingMessageIndex) {
                    nearest = middle;
                    low = middle + 1;
                } else {
                    high = middle - 1;
                }
            }
            setActiveIndex(previous => (previous === nearest ? previous : nearest));
        };
        const schedule = () => {
            if (frame) return;
            frame = requestAnimationFrame(update);
        };

        root.addEventListener('scroll', schedule, { passive: true });
        schedule();
        return () => {
            root.removeEventListener('scroll', schedule);
            if (frame) cancelAnimationFrame(frame);
        };
    }, [navigation, root, turnMessageIndexes, turns]);

    return clamp(activeIndex, 0, Math.max(0, turns.length - 1));
}

function messagePreview(
    message: ReturnType<typeof useChatuiMessage>,
    fallback: string,
    stripReasoning = false,
): string {
    if (!message) return fallback;
    let source = message.displayText || message.text;
    if (stripReasoning) {
        source = source
            .replace(/^\s*<(thinking|think|analysis)>[\s\S]*?<\/\1>\s*/i, '')
            .replace(/^\s*<(?:thinking|think|analysis)>[\s\S]*$/i, '');
        const content = source.match(/<content>([\s\S]*?)<\/content>/i);
        if (content) source = content[1];
        source = source
            .replace(/<!--[\s\S]*?-->/g, ' ')
            .replace(/<[^>]+>/g, ' ');
    }
    return source.replace(/\s+/g, ' ').trim()
        || message.attachments.files[0]?.name
        || (message.attachments.media.length > 0 ? '媒体消息' : fallback);
}

function TurnPreview({ turn }: { turn: UserTurn }): ComponentChild {
    const userMessage = useChatuiMessage(turn.userMessageId);
    const responseMessage = useChatuiMessage(turn.responseMessageId ?? -1);
    const title = messagePreview(userMessage, '空白消息');
    const response = messagePreview(responseMessage, '等待回复……', true);

    return (
        <div className="cui-root-floor-popover" aria-hidden="true">
            <span className="cui-root-floor-popover-title">{title}</span>
            <span className="cui-root-floor-popover-preview">{response}</span>
        </div>
    );
}

export function MessageFloorRail({
    root,
    turns,
    navigation,
}: {
    root: HTMLDivElement | null;
    turns: readonly UserTurn[];
    navigation: MessageFloorNavigation;
}): ComponentChild {
    const layout = useRailLayout(root);
    const activeIndex = useActiveTurn(root, turns, navigation);
    const [windowStart, setWindowStart] = useState(0);
    const [hovered, setHovered] = useState<HoveredTurn | null>(null);
    const [keyboardFocused, setKeyboardFocused] = useState(false);
    const [rangeVisible, setRangeVisible] = useState(false);
    const railRef = useRef<HTMLDivElement | null>(null);
    const hoverFrameRef = useRef(0);
    const pendingHoverRef = useRef<HoveredTurn | null>(null);
    // Firefox may match :focus-visible for a pointer-focused custom slider, so
    // retain the actual focus origin instead of inferring it from CSS state.
    const pointerFocusRef = useRef(false);
    const rangeHideTimerRef = useRef<number | null>(null);
    const wheelDeltaRef = useRef(0);

    const capacity = Math.min(layout?.capacity ?? 0, turns.length);
    const maxWindowStart = Math.max(0, turns.length - capacity);
    const visibleTurns = useMemo(
        () => turns.slice(windowStart, windowStart + capacity),
        [capacity, turns, windowStart],
    );
    const railHeight = visibleTurns.length > 0
        ? visibleTurns.length * TICK_HEIGHT_PX + (visibleTurns.length - 1) * TICK_GAP_PX
        : 0;

    useEffect(() => {
        setWindowStart(centerWindowStart(activeIndex, capacity, maxWindowStart));
    }, [activeIndex, capacity, maxWindowStart]);

    useEffect(() => () => {
        if (hoverFrameRef.current) cancelAnimationFrame(hoverFrameRef.current);
        if (rangeHideTimerRef.current !== null) window.clearTimeout(rangeHideTimerRef.current);
    }, []);

    const revealWindowRange = useCallback(() => {
        setRangeVisible(true);
        if (rangeHideTimerRef.current !== null) window.clearTimeout(rangeHideTimerRef.current);
        rangeHideTimerRef.current = window.setTimeout(() => {
            rangeHideTimerRef.current = null;
            setRangeVisible(false);
        }, RANGE_LABEL_IDLE_MS);
    }, []);

    const turnFromClientY = useCallback((clientY: number, element: HTMLElement): HoveredTurn => {
        const bounds = element.getBoundingClientRect();
        const slot = clamp(
            Math.round((clientY - bounds.top - TICK_HEIGHT_PX / 2) / TICK_PITCH_PX),
            0,
            Math.max(0, visibleTurns.length - 1),
        );
        return { slot };
    }, [visibleTurns.length]);

    const scheduleHoveredTurn = useCallback((next: HoveredTurn) => {
        pendingHoverRef.current = next;
        if (hoverFrameRef.current) return;
        hoverFrameRef.current = requestAnimationFrame(() => {
            hoverFrameRef.current = 0;
            setHovered(pendingHoverRef.current);
        });
    }, []);

    const clearHoveredTurn = useCallback(() => {
        pendingHoverRef.current = null;
        if (hoverFrameRef.current) cancelAnimationFrame(hoverFrameRef.current);
        hoverFrameRef.current = 0;
        setHovered(null);
    }, []);

    useEffect(() => {
        if (!hovered) return;
        const clearWhenPointerIsOutside = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Node && !railRef.current?.contains(target)) clearHoveredTurn();
        };
        const embeddedFrames = root
            ? Array.from(root.querySelectorAll<HTMLIFrameElement>('iframe'))
            : [];
        window.addEventListener('pointermove', clearWhenPointerIsOutside, true);
        embeddedFrames.forEach(frame => frame.addEventListener('pointerenter', clearHoveredTurn));
        return () => {
            window.removeEventListener('pointermove', clearWhenPointerIsOutside, true);
            embeddedFrames.forEach(frame => frame.removeEventListener('pointerenter', clearHoveredTurn));
        };
    }, [clearHoveredTurn, hovered, root]);

    const jumpToTurn = useCallback((index: number) => {
        if (!root || turns.length === 0) return;
        const targetIndex = clamp(index, 0, turns.length - 1);
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        navigation.scrollToMessage(
            turns[targetIndex].userMessageId,
            reduceMotion ? 'auto' : 'smooth',
        );
    }, [navigation, root, turns]);

    if (!root || !layout || visibleTurns.length === 0) return null;

    const previewIndex = hovered
        ? windowStart + hovered.slot
        : (keyboardFocused ? activeIndex : null);
    const previewTurn = previewIndex === null ? null : turns[previewIndex];
    const previewSlot = previewIndex === null
        ? 0
        : clamp(previewIndex - windowStart, 0, visibleTurns.length - 1);
    const rawPopoverTop = previewSlot * TICK_PITCH_PX + TICK_HEIGHT_PX / 2;
    const popoverTop = railHeight <= POPOVER_EDGE_GUARD_PX * 2
        ? railHeight / 2
        : clamp(rawPopoverTop, POPOVER_EDGE_GUARD_PX, railHeight - POPOVER_EDGE_GUARD_PX);

    return (
        <div
            ref={railRef}
            className={`cui-root-floor-rail${previewTurn ? ' is-inspecting' : ''}`}
            style={{ left: `${layout.left}px`, height: `${railHeight}px` }}
            role="slider"
            tabIndex={0}
            aria-label="快速跳转用户回合"
            aria-orientation="vertical"
            aria-valuemin={1}
            aria-valuemax={turns.length}
            aria-valuenow={activeIndex + 1}
            aria-valuetext={`第 ${activeIndex + 1} 个用户回合`}
            title="快速跳转用户回合"
            onPointerMove={event => {
                scheduleHoveredTurn(turnFromClientY(event.clientY, event.currentTarget));
            }}
            onPointerDown={() => {
                pointerFocusRef.current = true;
                setKeyboardFocused(false);
            }}
            onPointerUp={() => {
                pointerFocusRef.current = false;
            }}
            onPointerCancel={() => {
                pointerFocusRef.current = false;
            }}
            onPointerLeave={clearHoveredTurn}
            onPointerOut={event => {
                const nextTarget = event.relatedTarget;
                if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
                clearHoveredTurn();
            }}
            onClick={event => {
                const target = turnFromClientY(event.clientY, event.currentTarget);
                jumpToTurn(windowStart + target.slot);
            }}
            onFocus={() => {
                if (!pointerFocusRef.current) setKeyboardFocused(true);
            }}
            onBlur={() => setKeyboardFocused(false)}
            onKeyDown={event => {
                let next = activeIndex;
                if (event.key === 'ArrowUp') next -= 1;
                else if (event.key === 'ArrowDown') next += 1;
                else if (event.key === 'PageUp') next -= Math.max(1, capacity);
                else if (event.key === 'PageDown') next += Math.max(1, capacity);
                else if (event.key === 'Home') next = 0;
                else if (event.key === 'End') next = turns.length - 1;
                else return;
                event.preventDefault();
                setKeyboardFocused(true);
                if (maxWindowStart > 0) revealWindowRange();
                jumpToTurn(next);
            }}
            onWheel={event => {
                event.preventDefault();
                if (maxWindowStart === 0) {
                    root.scrollTop += event.deltaY;
                    return;
                }
                revealWindowRange();
                wheelDeltaRef.current += event.deltaY;
                const steps = Math.trunc(wheelDeltaRef.current / WHEEL_STEP_PX);
                if (steps === 0) return;
                wheelDeltaRef.current -= steps * WHEEL_STEP_PX;
                setWindowStart(previous => clamp(previous + steps, 0, maxWindowStart));
            }}
        >
            <div className="cui-root-floor-ticks" aria-hidden="true">
                {visibleTurns.map((turn, slot) => {
                    const index = windowStart + slot;
                    const distance = previewIndex === null ? Number.POSITIVE_INFINITY : Math.abs(index - previewIndex);
                    const wave = Math.pow(Math.max(0, 1 - distance / 5), 1.65);
                    const isCurrent = index === activeIndex;
                    const width = 8 + wave * 18;
                    return (
                        <span
                            key={turn.userMessageId}
                            className={`cui-root-floor-tick${isCurrent ? ' is-current' : ''}`}
                            style={{ width: `${width}px` }}
                        />
                    );
                })}
            </div>
            {maxWindowStart > 0 && (
                <div
                    className={`cui-root-floor-range${rangeVisible ? ' is-visible' : ''}`}
                    aria-hidden="true"
                >
                    <span className="cui-root-floor-range-label is-start">{windowStart + 1}</span>
                    <span className="cui-root-floor-range-label is-end">
                        {windowStart + visibleTurns.length}
                    </span>
                </div>
            )}
            {previewTurn && (
                <div
                    className="cui-root-floor-popover-anchor"
                    style={{ top: `${popoverTop}px` }}
                >
                    <TurnPreview turn={previewTurn} />
                </div>
            )}
        </div>
    );
}
