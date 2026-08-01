import React, { createPortal, useEffect, useRef } from 'preact/compat';
import type { ComponentChild } from 'preact';
import { decideConfirmKeyAction, nextConfirmFocusIndex } from '../actions.js';
import type { ChatuiConfirmFocusZone } from '../actions.js';

/**
 * What counts as a stop on the dialog's own Tab cycle. Today the card only
 * ever contains buttons, but hard-coding that would quietly break the trap
 * the first time a dialog grows a link or a checkbox, so the selector asks
 * the same question the browser does.
 */
const FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Moves focus one stop around the dialog's own cycle. The *arithmetic* — wrap
 * at both ends, enter from the right end when focus is not in the dialog at
 * all — is nextConfirmFocusIndex()'s pure rule; this only reads the live DOM
 * and applies the answer.
 */
function moveFocusWithin(card: HTMLElement | null, backwards: boolean): void {
    if (!card) return;
    const focusable = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    const active = document.activeElement;
    const currentIndex = active instanceof HTMLElement ? focusable.indexOf(active) : -1;
    const nextIndex = nextConfirmFocusIndex(focusable.length, currentIndex, backwards);
    if (nextIndex === null) return;
    focusable[nextIndex]?.focus();
}

/**
 * Takes the rest of the page out of the tab order and off the accessibility
 * tree for as long as the dialog is open, and puts it back exactly as found.
 *
 * `inert` rather than `aria-hidden` because only `inert` also stops focus and
 * pointer events, which is what "modal" actually means. The scope is narrow
 * on purpose: this is an extension injected into somebody else's page, so it
 * marks only `document.body`'s *direct* children, only for the lifetime of
 * one dialog, and only the ones it set itself — a sibling that was already
 * inert belongs to whoever made it so (a second dialog stacked on top of this
 * one, for instance) and is left alone in both directions. The dialog's own
 * portal is a body child too, hence the skip: it must stay live.
 *
 * @returns the exact undo for what it just did
 */
function isolateBackground(portalRoot: Node): () => void {
    const isolated: HTMLElement[] = [];
    for (const child of Array.from(document.body.children)) {
        if (!(child instanceof HTMLElement)) continue;
        if (child === portalRoot || child.contains(portalRoot)) continue;
        if (child.inert) continue;
        child.inert = true;
        isolated.push(child);
    }
    return () => {
        for (const element of isolated) element.inert = false;
    };
}

/**
 * ChatUI-owned confirm dialog (no native ST popup). Portals to document.body:
 * callers render this inline inside arbitrary rows (e.g. NestedChatRow), and
 * some of those ancestors carry their own `transform` (the sidebar's slide
 * animation) — a `transform` anywhere up the tree makes that ancestor the
 * containing block for this dialog's `position:fixed` overlay instead of the
 * viewport, so the "modal" ends up sized/positioned against a small,
 * possibly off-screen box. Portaling sidesteps that regardless of where a
 * caller mounts it. stopPropagation everywhere so it can still be rendered
 * inside a clickable row without triggering it.
 *
 * Safety model (design §6「确认与浮层」). The old one was "focus cancel": Enter did
 * whatever the focused button did, so the default answer to a destructive
 * question was "no". That bought its safety by making the *common* answer
 * cost a reach for the mouse or a Tab, and it leaned on the confirm button
 * being loud enough (a solid red fill) to make the asymmetry read. Both ends
 * of that trade are now inverted: the confirm button is a quiet outline, and
 * focus lands on it, so Enter answers the question.
 *
 * What replaces the safety is a time guard rather than a focus trick: an
 * activation keystroke is refused for the first 300ms and accepted after,
 * because the dangerous case was never "the user pressed Enter deliberately"
 * but "the user was mid-keystroke in the composer when a dialog appeared
 * under their hands".
 *
 * *Which* keystroke answers what is not decided here. decideConfirmKeyAction()
 * in store/confirm-store.ts owns the whole model as one pure function — Enter
 * and Space as activation keys, the 300ms window, auto-repeat, Tab, Escape,
 * and who answers when focus is inside / outside / nowhere — so the model can
 * be pinned without a DOM. This component supplies the two things a rule
 * cannot know (where the keystroke landed, what time it is) and carries out
 * the verdict. Read that function for the reasoning behind each clause; what
 * lives here is only what needs a live document:
 *
 *   - "Swallow" means preventDefault *and* stopPropagation. preventDefault
 *     alone kills the focused button's native activation but not the event's
 *     travel: this listener runs at window capture, so without the stop the
 *     key would go on to reach whatever sits behind the veil (with focus in
 *     the composer that meant one Enter both deleting a message and sending
 *     one — verified in Chromium).
 *   - Which buttons the Tab cycle contains, and moving focus around it.
 *   - Taking the background out of the tab order while the dialog is open
 *     (isolateBackground) and putting it back untouched afterwards.
 *
 * The focus trap is what makes `aria-modal="true"` above a fact rather than a
 * claim. Without it, one Tab from the confirm button — the last focusable in
 * the portal — walked focus straight onto a host control behind the veil,
 * invisible under the overlay. The window-level swallow of keys arriving from
 * outside the dialog stays as a floor beneath the trap (a body child that
 * appears *after* mount is not covered by isolateBackground), but it is no
 * longer the only thing standing between a user and a keystroke they cannot
 * see the target of.
 *
 * One consequence, taken on purpose: if the user has tabbed to cancel, Enter
 * cancels rather than confirms. The design says "Enter confirms" of a dialog
 * whose buttons are non-focusable spans; ours are real buttons, and a focused
 * control that does not do what it says when activated is a worse bargain
 * than the literal reading — especially since this deviation only ever errs
 * toward *not* deleting. Escape still cancels, unchanged.
 */
export function ConfirmDialog({
    title,
    message,
    confirmLabel = '确定',
    cancelLabel = '取消',
    danger = false,
    escalateLabel,
    onConfirm,
    onCancel,
    onEscalate,
}: {
    title: string;
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
    /** Optional third ("escalate") button, rendered to the *left* of cancel and
     * confirm — e.g. message delete's「删除整楼」upgrade from the default
     * 「仅删除此条」(DOM-DECOUPLING.md decision #3's three-way delete confirm).
     * Omitted (with onEscalate) means a plain two-button dialog, unchanged for
     * every other existing caller of this component. */
    escalateLabel?: string;
    onConfirm: () => void;
    onCancel: () => void;
    onEscalate?: () => void;
}): ComponentChild {
    const confirmRef = useRef<HTMLButtonElement>(null);
    const cardRef = useRef<HTMLDivElement>(null);
    const overlayRef = useRef<HTMLDivElement>(null);
    // Set once per mounted dialog. ConfirmDialogHost keys its <ConfirmDialog>
    // by request id precisely so a request that pre-empts another gets a new
    // instance — and therefore a fresh guard window — instead of inheriting an
    // already-expired one.
    const openedAtRef = useRef(Date.now());

    useEffect(() => {
        const portalRoot = overlayRef.current;
        // Read before isolating: applying `inert` to an ancestor of the
        // focused element blurs it, so this is the last moment the page can
        // still say where focus came from.
        const previouslyFocused = document.activeElement;
        const releaseBackground = portalRoot ? isolateBackground(portalRoot) : () => {};
        confirmRef.current?.focus();

        return () => {
            // Order matters both ways: focus cannot enter a subtree that is
            // still inert, so the background is handed back first.
            releaseBackground();
            // Hand focus back where it came from, so answering a dialog does
            // not silently strand a keyboard user on <body>. Skipped when the
            // origin is gone — the common case after a confirmed delete is
            // that the button that opened the dialog no longer exists.
            if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
                previouslyFocused.focus();
            }
        };
    }, []);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            const card = cardRef.current;
            const target = event.target;
            // Clicking the card's own text leaves activeElement on <body>,
            // which is neither "a control answered this" nor "focus escaped".
            const focus: ChatuiConfirmFocusZone = target === null
                || target === document.body
                || target === document.documentElement
                ? 'none'
                : target instanceof Node && card?.contains(target) ? 'inside' : 'outside';

            const action = decideConfirmKeyAction({
                key: event.key,
                repeat: event.repeat,
                shiftKey: event.shiftKey,
                altKey: event.altKey,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                focus,
                openedAtMs: openedAtRef.current,
                nowMs: Date.now(),
            });

            // Not ours, or ours but already being answered natively by the
            // focused control — in both cases the one thing that must not
            // happen is this handler acting as well.
            if (action === 'ignore' || action === 'stand-down') return;

            // Every remaining verdict means the keystroke belonged to the
            // dialog: it dies here, whether or not it also answers something.
            event.preventDefault();
            event.stopPropagation();

            switch (action) {
                case 'cancel': onCancel(); break;
                case 'confirm': onConfirm(); break;
                case 'focus-next': moveFocusWithin(card, false); break;
                case 'focus-previous': moveFocusWithin(card, true); break;
                case 'swallow': break;
            }
        };
        // Capture, so the swallow above happens before any other listener sees
        // the key rather than after.
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [onCancel, onConfirm]);

    return createPortal(
        <div
            ref={overlayRef}
            className="cui-root-dialog-overlay"
            onClick={(event) => { event.stopPropagation(); onCancel(); }}
        >
            <div
                ref={cardRef}
                className="cui-paper cui-root-dialog"
                role="dialog"
                aria-modal="true"
                aria-label={title}
                onClick={(event) => event.stopPropagation()}
            >
                <div className="cui-root-dialog-title">{title}</div>
                {message && <div className="cui-root-dialog-message">{message}</div>}
                {/* Source order is the reading order the design lays out —
                    escalate on the left, then cancel, then confirm — so focus
                    order follows the eye without any tabindex juggling. */}
                <div className="cui-root-dialog-actions">
                    {escalateLabel && onEscalate && (
                        <button
                            className="cui-root-dialog-btn cui-root-dialog-escalate"
                            type="button"
                            onClick={(event) => { event.stopPropagation(); onEscalate(); }}
                        >
                            {escalateLabel}
                        </button>
                    )}
                    <button
                        className="cui-root-dialog-btn cui-root-dialog-cancel"
                        type="button"
                        onClick={(event) => { event.stopPropagation(); onCancel(); }}
                    >
                        {cancelLabel}
                    </button>
                    <button
                        ref={confirmRef}
                        className={`cui-root-dialog-btn cui-root-dialog-confirm${danger ? ' is-danger' : ''}`}
                        type="button"
                        onClick={(event) => { event.stopPropagation(); onConfirm(); }}
                    >
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
