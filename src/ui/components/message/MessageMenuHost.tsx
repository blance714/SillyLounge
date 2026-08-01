import React, { createPortal, useEffect } from 'preact/compat';
import type { ComponentChild } from 'preact';
import { closeChatuiMessageMenuFor, triggerChatuiMessageAction } from '../../actions.js';
import { useActiveChatuiMenu } from '../../hooks.js';
import { estimateMenuHeight, placeMenuAgainstTrigger } from '../../menu-placement.js';
import { buildMessageMenuRows, countMessageMenuSeparators } from '../../message-menu-rows.js';
import { MenuItem } from './MenuItem.js';

/**
 * The message ⋯ menu, drawn once at the app root instead of inside the row
 * whose button opened it (ui/app.tsx, alongside <Toaster/> and
 * <ConfirmDialogHost/>).
 *
 * ── Why it moved out of the row ──
 *
 * The trigger lives in a virtualised list. Its row is not a component that
 * unmounts when the reader dismisses it; it is a component the virtualiser
 * unmounts whenever the row leaves the overscan window, mid-interaction and
 * without asking. While the menu's open state was a `useState` *inside* that
 * row, "open" and "mounted" were the same fact, so lifting the state to a
 * global slot without also lifting the rendering would have produced the worst
 * of both: a store that says a menu is open and no component left to draw it.
 * Lifting both means the row now owns only the button, and the store's anchor
 * (store/menu-store.ts) carries everything this host needs — which row, which
 * chat, whether it is a system row, and where the button was.
 *
 * ── What did not change ──
 *
 * It still portals to document.body. The class names and that exact parentage
 * are load-bearing: `body > .cui-root-menu` / `body > .cui-root-menu-backdrop`
 * are how scripts/e2e/measure-chat-switch.mjs finds this menu, and the reason
 * for the portal in the first place still holds — a non-portaled absolute menu
 * inside the scrollable list gets clipped for rows near the bottom and adds to
 * the list's own scrollHeight while open.
 *
 * It still closes on scroll or resize rather than tracking the trigger live,
 * because its position is a one-shot snapshot of a rect. That listener is now
 * one listener for the whole app instead of one per mounted row.
 */
export function MessageMenuHost(): ComponentChild {
    const activeMenu = useActiveChatuiMenu();
    const anchor = activeMenu?.id === 'message' ? activeMenu.anchor : null;

    useEffect(() => {
        if (!anchor) return;
        // Scoped, not a blanket close: by the time a stale cleanup runs, the
        // slot may already hold a different menu that has every right to stay.
        const close = () => closeChatuiMessageMenuFor(anchor.messageId, anchor.chatKey);
        window.addEventListener('scroll', close, true);
        window.addEventListener('resize', close);
        return () => {
            window.removeEventListener('scroll', close, true);
            window.removeEventListener('resize', close);
        };
    }, [anchor]);

    if (!anchor) return null;

    const rows = buildMessageMenuRows(anchor.isSystem);
    if (rows.length === 0) return null;

    // Placement is derived here rather than snapshotted into the store because
    // the rows — which decide the estimated height, and so the direction — are
    // this side's knowledge. The viewport is read at render time, one frame at
    // most after the rect was taken, and a resize closes the menu outright.
    const placement = placeMenuAgainstTrigger({
        trigger: anchor.trigger,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        estimatedHeight: estimateMenuHeight(rows.length, countMessageMenuSeparators(rows)),
    });

    const close = () => closeChatuiMessageMenuFor(anchor.messageId, anchor.chatKey);

    return createPortal(
        <>
            <button
                className="cui-root-menu-backdrop"
                type="button"
                aria-label="关闭菜单"
                onClick={close}
            />
            <div
                className="cui-root-menu cui-paper"
                /* Both offsets are always written, one of them as `auto`:
                   .cui-root-menu carries a `top` of its own for the in-flow
                   menus that share the class, and a fixed box with both top
                   and bottom set is over-constrained — it would stretch to
                   span them instead of sizing to its rows. */
                style={{
                    position: 'fixed',
                    top: placement.top == null ? 'auto' : `${placement.top}px`,
                    bottom: placement.bottom == null ? 'auto' : `${placement.bottom}px`,
                    right: `${placement.right}px`,
                }}
            >
                {rows.map(row => (
                    <React.Fragment key={row.label}>
                        {row.separatorBefore && <div className="cui-paper-sep" />}
                        <MenuItem
                            label={row.label}
                            iconClass={row.iconClass}
                            danger={row.danger}
                            onClick={() => {
                                close();
                                triggerChatuiMessageAction(anchor.messageId, row.action, anchor.chatKey);
                            }}
                        />
                    </React.Fragment>
                ))}
            </div>
        </>,
        document.body,
    );
}
