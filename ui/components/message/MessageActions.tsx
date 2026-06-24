import React from 'preact/compat';
import type { ComponentChild } from 'preact';
import {
    swipeChatuiMessage,
    triggerChatuiMessageAction,
} from '../../actions.js';
import type { ChatuiAction, ChatuiMessage } from '../../types.js';
import { ActionButton } from './ActionButton.js';
import { MenuItem } from './MenuItem.js';

function dispatchMessageAction(messageId: ChatuiMessage['id'], action: ChatuiAction): void {
    triggerChatuiMessageAction(messageId, action);
}

function MoreMenu({
    message,
    onEdit,
}: {
    message: ChatuiMessage;
    onEdit: () => void;
}): ComponentChild {
    if (message.isSystem) return null;

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
                <MenuItem
                    label="Edit"
                    iconClass="fa-solid fa-pencil"
                    onClick={onEdit}
                />
                <MenuItem
                    label="Branch"
                    iconClass="fa-solid fa-code-branch"
                    onClick={() => dispatchMessageAction(message.id, 'branch')}
                />
                <MenuItem
                    label="Checkpoint"
                    iconClass="fa-solid fa-flag-checkered"
                    onClick={() => dispatchMessageAction(message.id, 'checkpoint')}
                />
                <MenuItem
                    label="Hide"
                    iconClass="fa-solid fa-eye-slash"
                    onClick={() => dispatchMessageAction(message.id, 'hide')}
                />
                <MenuItem
                    label="Delete"
                    iconClass="fa-solid fa-trash"
                    onClick={() => dispatchMessageAction(message.id, 'delete')}
                />
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
    return (
        <div className="cui-root-message-actions">
            <ActionButton
                label="Copy"
                iconClass="fa-regular fa-copy"
                onClick={() => dispatchMessageAction(message.id, 'copy')}
            />
            {message.ui.isLast && message.isChar && (
                <ActionButton
                    label="Regenerate"
                    iconClass="fa-solid fa-rotate-right"
                    onClick={() => dispatchMessageAction(message.id, 'regen')}
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
            <MoreMenu message={message} onEdit={onEdit} />
        </div>
    );
}
