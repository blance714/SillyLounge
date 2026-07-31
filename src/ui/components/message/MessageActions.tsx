import React, { createPortal, useEffect, useRef, useState } from 'preact/compat';
import type { ComponentChild } from 'preact';
import {
    swipeChatuiMessage,
    triggerChatuiMessageAction,
} from '../../actions.js';
import type { ChatuiAction, ChatuiMessage } from '../../types.js';
import { ActionButton } from './ActionButton.js';
import { MenuItem } from './MenuItem.js';

type MenuAction = {
    label: string;
    iconClass: string;
    onClick: () => void;
    danger?: boolean;
    /** Design §45 rules a dashed line off before the destructive row. */
    separatorBefore?: boolean;
};

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
                aria-label="更多操作"
                title="更多操作"
                onClick={(event) => { event.stopPropagation(); toggle(); }}
            >
                <i className="fa-solid fa-ellipsis" />
            </button>
            {anchor && createPortal(
                <>
                    <button
                        className="cui-root-menu-backdrop"
                        type="button"
                        aria-label="关闭菜单"
                        onClick={() => setAnchor(null)}
                    />
                    <div
                        className="cui-root-menu cui-paper"
                        style={{ position: 'fixed', top: `${anchor.top}px`, right: `${anchor.right}px` }}
                    >
                        {items.map(item => (
                            <React.Fragment key={item.label}>
                                {item.separatorBefore && <div className="cui-paper-sep" />}
                                <MenuItem
                                    label={item.label}
                                    iconClass={item.iconClass}
                                    danger={item.danger}
                                    onClick={() => { setAnchor(null); item.onClick(); }}
                                />
                            </React.Fragment>
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
    const dispatch = (action: ChatuiAction) => triggerChatuiMessageAction(message.id, action, message.chatKey);

    // The split is by *kind of act*, not by who spoke (design §42/§45), so both
    // roles read the same way and nothing has to be learned twice.
    //
    // Tiled — what you do *to* this turn, one click, no menu in the way. 重写
    // only exists for the message ST would actually regenerate: the trailing
    // character reply. Every other row therefore tiles three, not four.
    const regen: MenuAction = { label: '重写', iconClass: 'fa-solid fa-rotate-right', onClick: () => dispatch('regen') };
    const edit: MenuAction = { label: '编辑', iconClass: 'fa-solid fa-pen', onClick: onEdit };
    const del: MenuAction = { label: '删除', iconClass: 'fa-solid fa-trash-can', onClick: () => dispatch('delete'), danger: true };

    // Menu — what you do *with* it: take it somewhere else, or take it out of
    // the conversation. 隐藏此楼 is ruled off below the rest because it is the
    // only one that changes what the model is told.
    const copy: MenuAction = { label: '复制', iconClass: 'fa-solid fa-copy', onClick: () => dispatch('copy') };
    const copySource: MenuAction = { label: '复制原文', iconClass: 'fa-solid fa-clipboard', onClick: () => dispatch('copySource') };
    const branch: MenuAction = { label: '从此楼开分支', iconClass: 'fa-solid fa-code-branch', onClick: () => dispatch('branch') };
    const checkpoint: MenuAction = { label: '在此楼设检查点', iconClass: 'fa-solid fa-flag-checkered', onClick: () => dispatch('checkpoint') };
    const hide: MenuAction = { label: '隐藏此楼', iconClass: 'fa-solid fa-eye-slash', onClick: () => dispatch('hide'), danger: true, separatorBefore: true };

    // System rows are not a turn anyone speaks: nothing may be written to them
    // or branched from them, but their text is still text you may want. Which
    // rows count as a turn is unchanged from before the regroup — only where
    // each action is presented changed.
    const isTurn = !message.isSystem;
    const tiled: MenuAction[] = isTurn
        ? [...(message.ui.isLast && message.isChar ? [regen] : []), edit, del]
        : [];
    const overflow: MenuAction[] = isTurn
        ? [copy, copySource, branch, checkpoint, hide]
        : [copy, copySource];

    return (
        <div className="cui-root-message-actions">
            {message.ui.canShowSwipe && (
                <>
                    {message.swipe.id > 0 && (
                        <ActionButton
                            label="上一版本"
                            iconClass="fa-solid fa-chevron-left"
                            onClick={() => swipeChatuiMessage(message.id, 'left', message.chatKey)}
                        />
                    )}
                    {message.swipe.hasMultiple && (
                        <span className="cui-root-message-swipe">{message.swipe.label}</span>
                    )}
                    <ActionButton
                        label="下一版本"
                        iconClass="fa-solid fa-chevron-right"
                        onClick={() => swipeChatuiMessage(message.id, 'right', message.chatKey)}
                    />
                </>
            )}
            {tiled.map(item => (
                <ActionButton
                    key={item.label}
                    label={item.label}
                    iconClass={item.iconClass}
                    danger={item.danger}
                    onClick={item.onClick}
                />
            ))}
            <MoreMenu items={overflow} />
        </div>
    );
}
