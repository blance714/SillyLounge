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

const MAX_VISIBLE_TICKS = 48;
const RAIL_WIDTH_PX = 30;

type RailPlacement = Readonly<{ left: number }>;
type HoveredFloor = Readonly<{ index: number; ratio: number }>;

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function useRailPlacement(root: HTMLDivElement | null): RailPlacement | null {
    const [placement, setPlacement] = useState<RailPlacement | null>(null);

    useLayoutEffect(() => {
        if (!root) {
            setPlacement(null);
            return;
        }
        const stage = root.parentElement;
        if (!stage) return;
        const preciseHover = window.matchMedia(
            '(min-width: 769px) and (hover: hover) and (pointer: fine)',
        );

        const update = () => {
            const app = stage.closest<HTMLElement>('.cui-root-app');
            const stageLeft = stage.getBoundingClientRect().left;
            const appLeft = app?.getBoundingClientRect().left ?? stageLeft;
            const availableGutter = stageLeft + root.offsetLeft - appLeft;
            const next = preciseHover.matches && availableGutter >= RAIL_WIDTH_PX
                ? { left: root.offsetLeft - RAIL_WIDTH_PX }
                : null;
            setPlacement(previous => (
                previous?.left === next?.left ? previous : next
            ));
        };

        update();
        preciseHover.addEventListener('change', update);
        window.addEventListener('resize', update, { passive: true });
        const observer = typeof ResizeObserver === 'function'
            ? new ResizeObserver(update)
            : null;
        observer?.observe(stage);
        observer?.observe(root);
        return () => {
            observer?.disconnect();
            preciseHover.removeEventListener('change', update);
            window.removeEventListener('resize', update);
        };
    }, [root]);

    return placement;
}

function messageElement(root: HTMLElement, messageId: number): HTMLElement | null {
    return root.querySelector<HTMLElement>(`[data-cui-message-id="${messageId}"]`);
}

function useActiveFloor(root: HTMLDivElement | null, messageIds: readonly number[]): number {
    const [activeIndex, setActiveIndex] = useState(0);

    useEffect(() => {
        if (!root || messageIds.length === 0) {
            setActiveIndex(0);
            return;
        }
        let frame = 0;
        const update = () => {
            frame = 0;
            const maxIndex = messageIds.length - 1;
            const bottomDistance = root.scrollHeight - root.scrollTop - root.clientHeight;
            if (bottomDistance < 4) {
                setActiveIndex(previous => (previous === maxIndex ? previous : maxIndex));
                return;
            }
            if (root.scrollTop < 4) {
                setActiveIndex(previous => (previous === 0 ? previous : 0));
                return;
            }

            const rootRect = root.getBoundingClientRect();
            const readingLine = rootRect.top + root.clientHeight * 0.26;
            let low = 0;
            let high = maxIndex;
            let nearest = 0;
            while (low <= high) {
                const middle = Math.floor((low + high) / 2);
                const element = messageElement(root, messageIds[middle]);
                if (!element) break;
                if (element.getBoundingClientRect().top <= readingLine) {
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
    }, [messageIds, root]);

    return clamp(activeIndex, 0, Math.max(0, messageIds.length - 1));
}

function FloorPreview({ messageId, floor }: { messageId: number; floor: number }): ComponentChild {
    const message = useChatuiMessage(messageId);
    if (!message) return null;
    const name = message.name || (message.isUser ? '你' : message.isSystem ? '系统' : '角色');
    const rawPreview = (message.displayText || message.text).replace(/\s+/g, ' ').trim();
    const preview = rawPreview
        || message.attachments.files[0]?.name
        || (message.attachments.media.length > 0 ? '媒体消息' : '空白消息');

    return (
        <div className="cui-root-floor-popover" aria-hidden="true">
            <span className="cui-root-floor-popover-meta">第 {floor} 楼 · {name}</span>
            <span className="cui-root-floor-popover-preview">{preview}</span>
        </div>
    );
}

export function MessageFloorRail({
    root,
    messageIds,
}: {
    root: HTMLDivElement | null;
    messageIds: readonly number[];
}): ComponentChild {
    const placement = useRailPlacement(root);
    const activeIndex = useActiveFloor(root, messageIds);
    const [hovered, setHovered] = useState<HoveredFloor | null>(null);
    const [focused, setFocused] = useState(false);
    const railRef = useRef<HTMLDivElement | null>(null);
    const hoverFrameRef = useRef(0);
    const pendingHoverRef = useRef<HoveredFloor | null>(null);

    const markers = useMemo(() => {
        const count = Math.min(MAX_VISIBLE_TICKS, messageIds.length);
        if (count < 2) return [];
        return Array.from({ length: count }, (_, index) => (
            Math.round(index * (messageIds.length - 1) / (count - 1))
        ));
    }, [messageIds.length]);

    useEffect(() => () => {
        if (hoverFrameRef.current) cancelAnimationFrame(hoverFrameRef.current);
    }, []);

    const floorFromClientY = useCallback((clientY: number, element: HTMLElement): HoveredFloor => {
        const bounds = element.getBoundingClientRect();
        const ratio = clamp((clientY - bounds.top) / Math.max(1, bounds.height), 0, 1);
        return {
            index: Math.round(ratio * (messageIds.length - 1)),
            ratio,
        };
    }, [messageIds.length]);

    const scheduleHoveredFloor = useCallback((next: HoveredFloor) => {
        pendingHoverRef.current = next;
        if (hoverFrameRef.current) return;
        hoverFrameRef.current = requestAnimationFrame(() => {
            hoverFrameRef.current = 0;
            setHovered(pendingHoverRef.current);
        });
    }, []);

    const clearHoveredFloor = useCallback(() => {
        pendingHoverRef.current = null;
        if (hoverFrameRef.current) cancelAnimationFrame(hoverFrameRef.current);
        hoverFrameRef.current = 0;
        setHovered(null);
    }, []);

    useEffect(() => {
        if (!hovered) return;
        const clearWhenPointerIsOutside = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Node && !railRef.current?.contains(target)) {
                clearHoveredFloor();
            }
        };
        const embeddedFrames = root
            ? Array.from(root.querySelectorAll<HTMLIFrameElement>('iframe'))
            : [];
        window.addEventListener('pointermove', clearWhenPointerIsOutside, true);
        embeddedFrames.forEach(frame => frame.addEventListener('pointerenter', clearHoveredFloor));
        return () => {
            window.removeEventListener('pointermove', clearWhenPointerIsOutside, true);
            embeddedFrames.forEach(frame => frame.removeEventListener('pointerenter', clearHoveredFloor));
        };
    }, [clearHoveredFloor, hovered, root]);

    const jumpToIndex = useCallback((index: number) => {
        if (!root || messageIds.length === 0) return;
        const targetIndex = clamp(index, 0, messageIds.length - 1);
        const target = messageElement(root, messageIds[targetIndex]);
        if (!target) return;
        const rootRect = root.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const top = root.scrollTop + targetRect.top - rootRect.top - 12;
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        root.scrollTo({ top, behavior: reduceMotion ? 'auto' : 'smooth' });
    }, [messageIds, root]);

    if (!root || !placement || markers.length < 2) return null;

    const focusFloor: HoveredFloor = {
        index: activeIndex,
        ratio: activeIndex / Math.max(1, messageIds.length - 1),
    };
    const previewFloor = hovered || (focused ? focusFloor : null);
    const activeMarker = markers.reduce((nearest, messageIndex, markerIndex) => (
        Math.abs(messageIndex - activeIndex) < Math.abs(markers[nearest] - activeIndex)
            ? markerIndex
            : nearest
    ), 0);
    const popoverRatio = previewFloor ? clamp(previewFloor.ratio, 0.12, 0.88) : 0.5;

    return (
        <div
            ref={railRef}
            className={`cui-root-floor-rail${previewFloor ? ' is-inspecting' : ''}`}
            style={{ left: `${placement.left}px` }}
            role="slider"
            tabIndex={0}
            aria-label="快速跳转消息楼层"
            aria-orientation="vertical"
            aria-valuemin={1}
            aria-valuemax={messageIds.length}
            aria-valuenow={activeIndex + 1}
            aria-valuetext={`第 ${activeIndex + 1} 楼`}
            title="快速跳转消息楼层"
            onPointerMove={event => {
                scheduleHoveredFloor(floorFromClientY(event.clientY, event.currentTarget));
            }}
            onPointerLeave={clearHoveredFloor}
            onPointerOut={event => {
                const nextTarget = event.relatedTarget;
                if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
                clearHoveredFloor();
            }}
            onClick={event => {
                jumpToIndex(floorFromClientY(event.clientY, event.currentTarget).index);
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={event => {
                let next = activeIndex;
                if (event.key === 'ArrowUp') next -= 1;
                else if (event.key === 'ArrowDown') next += 1;
                else if (event.key === 'PageUp') next -= 5;
                else if (event.key === 'PageDown') next += 5;
                else if (event.key === 'Home') next = 0;
                else if (event.key === 'End') next = messageIds.length - 1;
                else return;
                event.preventDefault();
                jumpToIndex(next);
            }}
            onWheel={event => {
                event.preventDefault();
                root.scrollTop += event.deltaY;
            }}
        >
            <div className="cui-root-floor-ticks" aria-hidden="true">
                {markers.map((messageIndex, markerIndex) => {
                    const markerRatio = markerIndex / Math.max(1, markers.length - 1);
                    const distance = previewFloor ? Math.abs(markerRatio - previewFloor.ratio) : 1;
                    const wave = previewFloor ? Math.pow(Math.max(0, 1 - distance * 7.5), 1.7) : 0;
                    const isCurrent = markerIndex === activeMarker;
                    const width = 0.5 + wave * 1.1 + (isCurrent ? 0.25 : 0);
                    return (
                        <span
                            key={`${messageIndex}:${markerIndex}`}
                            className={`cui-root-floor-tick${isCurrent ? ' is-current' : ''}`}
                            style={{ width: `${width}rem` }}
                        />
                    );
                })}
            </div>
            {previewFloor && (
                <div
                    className="cui-root-floor-popover-anchor"
                    style={{ top: `${popoverRatio * 100}%` }}
                >
                    <FloorPreview
                        messageId={messageIds[previewFloor.index]}
                        floor={previewFloor.index + 1}
                    />
                </div>
            )}
        </div>
    );
}
