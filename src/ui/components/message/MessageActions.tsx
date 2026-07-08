import React, { createPortal, useEffect, useRef, useState } from 'preact/compat';
import type { ComponentChild } from 'preact';
import {
    swipeChatuiMessage,
    triggerChatuiMessageAction,
} from '../../actions.js';
import type { ChatuiAction, ChatuiMessage } from '../../types.js';
import { ActionButton } from './ActionButton.js';
import { MenuItem } from './MenuItem.js';

type MenuAction = { label: string; iconClass: string; onClick: () => void };

/**
 * Portals its dropdown to document.body: this button lives inside the
 * scrollable message list, and a non-portaled position:absolute menu there
 * both gets clipped for messages near the bottom of the list (nothing to
 * scroll it into view) and adds to the list's own scrollHeight while open.
 * Position is a one-shot snapshot of the trigger's rect taken on open; the
 * menu closes on scroll/resize instead of tracking the trigger live, same
 * trade-off ConfirmDialog/SelectorChip make for their own portaled/fixed UI.
 */
function MoreMenu({ items }: { items: MenuAction[] }): ComponentChild {
    const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (!anchor) return;
        const close = () => setAnchor(null);
        window.addEventListener('scroll', close, true);
        window.addEventListener('resize', close);
        return () => {
            window.removeEventListener('scroll', close, true);
            window.removeEventListener('resize', close);
        };
    }, [anchor]);

    if (items.length === 0) return null;

    const toggle = () => {
        if (anchor) { setAnchor(null); return; }
        const rect = triggerRef.current?.getBoundingClientRect();
        if (!rect) return;
        setAnchor({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    };

    return (
        <div className="cui-root-action-menu">
            <button
                ref={triggerRef}
                className="cui-root-action-btn cui-root-menu-trigger"
                type="button"
                aria-haspopup="menu"
                aria-expanded={anchor != null}
                aria-label="More actions"
                title="More actions"
                onClick={(event) => { event.stopPropagation(); toggle(); }}
            >
                <i className="fa-solid fa-ellipsis" />
            </button>
            {anchor && createPortal(
                <>
                    <button
                        className="cui-root-menu-backdrop"
                        type="button"
                        aria-label="Close"
                        onClick={() => setAnchor(null)}
                    />
                    <div
                        className="cui-root-menu"
                        style={{ position: 'fixed', top: `${anchor.top}px`, right: `${anchor.right}px` }}
                    >
                        {items.map(item => (
                            <MenuItem
                                key={item.label}
                                label={item.label}
                                iconClass={item.iconClass}
                                onClick={() => { setAnchor(null); item.onClick(); }}
                            />
                        ))}
                    </div>
                </>,
                document.body,
            )}
        </div>
    );
}

export function MessageActions({
    message,
    onEdit,
}: {
    message: ChatuiMessage;
    onEdit: () => void;
}): ComponentChild {
    const dispatch = (action: ChatuiAction) => triggerChatuiMessageAction(message.id, action);

    // Each action is defined once and routed to either the tiled row or the
    // overflow menu, so the two presentations never drift apart.
    const edit: MenuAction = { label: 'Edit', iconClass: 'fa-solid fa-pencil', onClick: onEdit };
    const branch: MenuAction = { label: 'Branch', iconClass: 'fa-solid fa-code-branch', onClick: () => dispatch('branch') };
    const checkpoint: MenuAction = { label: 'Checkpoint', iconClass: 'fa-solid fa-flag-checkered', onClick: () => dispatch('checkpoint') };
    const hide: MenuAction = { label: 'Hide', iconClass: 'fa-solid fa-eye-slash', onClick: () => dispatch('hide') };
    const del: MenuAction = { label: 'Delete', iconClass: 'fa-solid fa-trash', onClick: () => dispatch('delete') };

    // User messages tile every action inline — 平铺全显，无 overflow (DESIGN §5.C):
    // Copy is always rendered below, so the rest join it as flat buttons. Character
    // messages keep their secondary actions behind ⋯; system messages get neither.
    const tiled: MenuAction[] = message.ui.canShowUserMenu ? [edit, del, branch, checkpoint, hide] : [];
    const overflow: MenuAction[] = message.isSystem || message.ui.canShowUserMenu
        ? []
        : [edit, branch, checkpoint, hide, del];

    return (
        <div className="cui-root-message-actions">
            <ActionButton
                label="Copy"
                iconClass="fa-regular fa-copy"
                onClick={() => dispatch('copy')}
            />
            {message.ui.isLast && message.isChar && (
                <ActionButton
                    label="Regenerate"
                    iconClass="fa-solid fa-rotate-right"
                    onClick={() => dispatch('regen')}
                />
            )}
            {message.ui.canShowSwipe && (
                <>
                    {message.swipe.id > 0 && (
                        <ActionButton
                            label="Previous swipe"
                            iconClass="fa-solid fa-chevron-left"
                            onClick={() => swipeChatuiMessage(message.id, 'left')}
                        />
                    )}
                    {message.swipe.hasMultiple && (
                        <span className="cui-root-message-swipe">{message.swipe.label}</span>
                    )}
                    <ActionButton
                        label="Next swipe"
                        iconClass="fa-solid fa-chevron-right"
                        onClick={() => swipeChatuiMessage(message.id, 'right')}
                    />
                </>
            )}
            {tiled.map(item => (
                <ActionButton
                    key={item.label}
                    label={item.label}
                    iconClass={item.iconClass}
                    onClick={item.onClick}
                />
            ))}
            <MoreMenu items={overflow} />
        </div>
    );
}
