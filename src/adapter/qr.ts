/**
 * SillyTavern-ChatUI · quick-reply adapter
 *
 * Mirrors ST's #qr--bar buttons as plain DTOs so the UI can display them
 * without touching ST internals. Live HTMLElements never leave this module.
 *
 * Out of scope: QR context-menu / .qr--hasCtx secondary actions (the ⋮
 * expander that opens a sub-menu of linked sets). Only primary click is proxied.
 */

import { _dispatchClick, buildLiveElementRegistry, resolveLiveElement } from './internals.js';

type QuickReplyDto = {
    id: string;
    label: string;
    title: string;
    iconHtml: string;
};

/** @type {Map<string, HTMLElement>} */
const _qrItemMap = new Map<string, HTMLElement>();

function quickReplyCandidates(bar: Element): Element[] {
    // QR buttons live inside .qr--buttons holders or directly in #qr--bar.
    const buttonHolders = bar.querySelectorAll('.qr--buttons');
    if (buttonHolders.length > 0) {
        return Array.from(buttonHolders).flatMap(holder => (
            Array.from(holder.children).filter(child => child.classList.contains('qr--button'))
        ));
    }

    // Fallback: buttons appended directly (non-combined layout).
    return Array.from(bar.children).filter(child => child.classList.contains('qr--button'));
}

/**
 * Enumerate visible quick-reply buttons from ST's #qr--bar. Rebuilds the
 * internal id→liveElement map on every call (ST rebuilds the bar on chat /
 * set changes). The live elements stay private; the UI only receives plain DTOs.
 *
 * @returns {{ id: string, label: string, title: string, iconHtml: string }[]}
 */
export function listQuickReplies() {
    // Docked bar lives in #send_form; when the user pops it out ST moves it to
    // #qr--popout on document.body. Read whichever is present.
    const bar = document.getElementById('qr--bar') || document.getElementById('qr--popout');
    return buildLiveElementRegistry<QuickReplyDto>(bar, _qrItemMap, {
        idPrefix: 'qr',
        elements: quickReplyCandidates,
        toDto: (el, id) => {
            // Each QR button has .qr--button-label and optionally .qr--button-icon.
            const labelEl = el.querySelector('.qr--button-label');
            const label = (labelEl?.textContent || el.textContent || '').trim();

            const btnTitle = el.getAttribute('title') || label;

            // Icon: prefer .qr--button-icon; fall back to any Font Awesome element.
            const iconEl = el.querySelector('.qr--button-icon, [class*="fa-"]');
            // Only include the icon outerHTML if the icon is not itself hidden.
            const iconHtml = (iconEl instanceof HTMLElement && !iconEl.classList.contains('qr--hidden'))
                ? iconEl.outerHTML
                : '';

            return { id, label, title: btnTitle, iconHtml };
        },
    });
}

/**
 * Proxy a click onto the live mapped QR button (never a clone).
 * Only fires the primary click — context-menu / linked-set actions
 * (.qr--hasCtx secondary menus) are out of scope.
 *
 * @param {string} id opaque id from listQuickReplies()
 * @returns {boolean} true if the element was found and clicked
 */
export function triggerQuickReply(id: any) {
    const el = resolveLiveElement(_qrItemMap, id);
    if (!el) return false;
    _dispatchClick(el);
    return true;
}

/**
 * Subscribe to changes in #qr--bar (ST rebuilds the bar on chat / set changes).
 * Uses a MutationObserver on #send_form (the bar's mount parent) coalesced via
 * requestAnimationFrame so a burst of DOM mutations fires `cb` only once.
 *
 * @param {() => void} cb
 * @returns {() => void} unsubscribe
 */
export function subscribeQuickReplies(cb: any) {
    /** @type {number|null} */
    let pendingFrame: number | null = null;

    const flush = () => {
        pendingFrame = null;
        try {
            cb();
        } catch (err) {
            console.error('[ChatUI/adapter] subscribeQuickReplies cb threw', err);
        }
    };

    const schedule = () => {
        if (pendingFrame !== null) return;
        pendingFrame = requestAnimationFrame(flush);
    };

    /** @type {MutationObserver[]} */
    const observers: MutationObserver[] = [];

    // Docked bar: ST rebuilds #qr--bar inside #send_form on chat / set changes.
    const sendForm = document.getElementById('send_form');
    if (sendForm) {
        const o = new MutationObserver(schedule);
        o.observe(sendForm, { childList: true, subtree: true });
        observers.push(o);
    }

    // Popout: ST appends/removes #qr--popout directly under document.body, which
    // the #send_form observer can't see — watch body's direct children too.
    const bodyObserver = new MutationObserver(schedule);
    bodyObserver.observe(document.body, { childList: true });
    observers.push(bodyObserver);

    return () => {
        for (const o of observers) o.disconnect();
        if (pendingFrame !== null) {
            cancelAnimationFrame(pendingFrame);
            pendingFrame = null;
        }
    };
}
