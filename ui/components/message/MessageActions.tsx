import React from 'preact/compat';
import type { ComponentChild } from 'preact';
import {
    swipeChatuiMessage,
    triggerChatuiMessageAction,
} from '../../actions.js';
import type { ChatuiAction, ChatuiMessage } from '../../types.js';
import { ActionButton } from './ActionButton.js';
import { MenuItem } from './MenuItem.js';

type MenuAction = { label: string; iconClass: string; onClick: () => void };

function MoreMenu({ items }: { items: MenuAction[] }): ComponentChild {
    if (items.length === 0) return null;

    return (
        <details className="cui-root-action-menu">
            <summary
                className="cui-root-action-btn cui-root-menu-trigger"
                aria-label="More actions"
                title="More actions"
            >
                <i className="fa-solid fa-ellipsis" />
            </summary>
            <div className="cui-root-menu">
                {items.map(item => (
                    <MenuItem
                        key={item.label}
                        label={item.label}
                        iconClass={item.iconClass}
                        onClick={item.onClick}
                    />
                ))}
            </div>
        </details>
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
