import React, { useEffect, useRef } from 'preact/compat';
import type { ComponentChild } from 'preact';
import {
    closeChatuiMessageMenuFor,
    swipeChatuiMessage,
    toggleChatuiMessageMenu,
    triggerChatuiMessageAction,
} from '../../actions.js';
import { useActiveChatuiMenu } from '../../hooks.js';
import { buildMessageMenuRows } from '../../message-menu-rows.js';
import type { ChatuiAction, ChatuiMessage } from '../../types.js';
import { ActionButton } from './ActionButton.js';
import { SwipeSegments } from './SwipeSegments.js';

type TiledAction = {
    label: string;
    iconClass: string;
    onClick: () => void;
    danger?: boolean;
};

/**
 * The ⋯ button, and nothing else: the menu it opens is drawn by
 * MessageMenuHost at the app root, from the anchor this press writes into
 * store/menu-store.ts. See that host's module doc for why the rendering had to
 * leave the row — in short, the virtualiser unmounts this component whenever
 * the row leaves the overscan window, which is not a moment the reader chose.
 *
 * The rect is still read here and only here: the button is the thing being
 * measured, and it is about to stop being under the cursor.
 */
function MoreMenuTrigger({ message }: { message: ChatuiMessage }): ComponentChild {
    const messageId = message.id;
    const chatKey = message.chatKey;
    const activeMenu = useActiveChatuiMenu();
    const triggerRef = useRef<HTMLButtonElement>(null);
    const isOpen = activeMenu?.id === 'message'
        && activeMenu.anchor.messageId === messageId
        && activeMenu.anchor.chatKey === chatKey;

    // The cleanup path the lift created a need for. An open menu is anchored to
    // a rect this row no longer occupies once it is gone, so the row taking its
    // menu with it is not tidiness — it is the same contract "close on scroll"
    // has always kept, now covering the case where the row leaves without a
    // scroll event of its own (a chat switch, entering settings, the range
    // extractor dropping it). Scoped to this row so a neighbour's unmount in
    // the same commit cannot close a menu that was just opened elsewhere.
    useEffect(() => () => closeChatuiMessageMenuFor(messageId, chatKey), [messageId, chatKey]);

    if (buildMessageMenuRows(message.isSystem).length === 0) return null;

    const toggle = () => {
        const rect = triggerRef.current?.getBoundingClientRect();
        if (!rect) return;
        toggleChatuiMessageMenu({
            messageId,
            chatKey,
            isSystem: message.isSystem,
            trigger: { top: rect.top, bottom: rect.bottom, right: rect.right },
        });
    };

    return (
        <div className="cui-root-action-menu">
            <button
                ref={triggerRef}
                className="cui-root-action-btn cui-root-menu-trigger"
                type="button"
                aria-haspopup="menu"
                aria-expanded={isOpen}
                aria-label="更多操作"
                title="更多操作"
                onClick={(event) => { event.stopPropagation(); toggle(); }}
            >
                <i className="fa-solid fa-ellipsis" />
            </button>
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
    const dispatch = (action: ChatuiAction) => triggerChatuiMessageAction(message.id, action, message.chatKey);

    // The split is by *kind of act*, not by who spoke (design §42/§45), so both
    // roles read the same way and nothing has to be learned twice.
    //
    // Tiled — what you do *to* this turn, one click, no menu in the way. 重写
    // only exists for the message ST would actually regenerate: the trailing
    // character reply. Every other row therefore tiles three, not four.
    //
    // The other half of the split — what you do *with* the turn — is the ⋯
    // menu, and it is not built here: those rows have to be readable by the
    // root-level host that draws the menu as well, so they live in
    // ui/message-menu-rows.ts. A system row is not a turn anyone speaks, so it
    // tiles nothing at all; that same test picks its (shorter) menu over there.
    const regen: TiledAction = { label: '重写', iconClass: 'fa-solid fa-rotate-right', onClick: () => dispatch('regen') };
    const edit: TiledAction = { label: '编辑', iconClass: 'fa-solid fa-pen', onClick: onEdit };
    const del: TiledAction = { label: '删除', iconClass: 'fa-solid fa-trash-can', onClick: () => dispatch('delete'), danger: true };

    const isTurn = !message.isSystem;
    const tiled: TiledAction[] = isTurn
        ? [...(message.ui.isLast && message.isChar ? [regen] : []), edit, del]
        : [];

    return (
        <div className="cui-root-message-actions">
            {tiled.map(item => (
                <ActionButton
                    key={item.label}
                    label={item.label}
                    iconClass={item.iconClass}
                    danger={item.danger}
                    onClick={item.onClick}
                />
            ))}
            <MoreMenuTrigger message={message} />
            {message.ui.canShowSwipe && (
                <>
                    {/* Design §43 draws the swipe group after 重写/编辑/删除/⋯,
                        ruled off from them — what you do to this turn, then a
                        seam, then which candidate reply you're looking at.
                        The seam is drawn on the candidate count, not on
                        canShowSwipe: the trailing character reply keeps its ›
                        even at one candidate (that is how you ask for a second
                        one, chat-store.ts), but with one candidate there is no
                        "which version you're reading" on the far side — just a
                        lone arrow — and a rule with nothing on one side of it
                        reads as a mistake rather than a division. Neither the
                        store's canShowSwipe nor the ‹ button's own swipe.id > 0
                        test changes; this is the third, separate question of
                        whether the two groups need telling apart at all. */}
                    {message.swipe.hasMultiple && (
                        <span className="cui-root-action-divider" aria-hidden="true" />
                    )}
                    {message.swipe.id > 0 && (
                        <ActionButton
                            label="上一版本"
                            iconClass="fa-solid fa-chevron-left"
                            onClick={() => swipeChatuiMessage(message.id, 'left', message.chatKey)}
                        />
                    )}
                    <SwipeSegments message={message} />
                    <ActionButton
                        label="下一版本"
                        iconClass="fa-solid fa-chevron-right"
                        onClick={() => swipeChatuiMessage(message.id, 'right', message.chatKey)}
                    />
                </>
            )}
        </div>
    );
}
