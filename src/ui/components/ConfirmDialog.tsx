import React, { createPortal, useEffect, useRef } from 'preact/compat';
import type { ComponentChild } from 'preact';
import { shouldAcceptConfirmKey } from '../actions.js';

/** The two keys a focused <button> activates itself with. Both have to be
 *  guarded: the design only names Enter because its own dialog's buttons were
 *  non-focusable spans, so Space could never have reached them. */
const ACTIVATION_KEYS = new Set([' ', 'Enter']);

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
 * Safety model (design §9). The old one was "focus cancel": Enter did
 * whatever the focused button did, so the default answer to a destructive
 * question was "no". That bought its safety by making the *common* answer
 * cost a reach for the mouse or a Tab, and it leaned on the confirm button
 * being loud enough (a solid red fill) to make the asymmetry read. Both ends
 * of that trade are now inverted: the confirm button is a quiet outline, and
 * focus lands on it, so Enter answers the question.
 *
 * What replaces the safety is a time guard rather than a focus trick. The
 * dangerous case was never "the user pressed Enter deliberately"; it was "the
 * user was mid-keystroke in the composer when a dialog appeared under their
 * hands". So an activation keystroke is refused for the first 300ms and
 * accepted after — see shouldAcceptConfirmKey() in store/confirm-store.ts,
 * which owns that rule as a pure function so it can be tested without a DOM.
 * This component only records when it mounted and asks.
 *
 * "Activation keystroke" is Enter *and* Space. The design names only Enter,
 * but its dialog's buttons are non-focusable spans; ours are real buttons,
 * which Space activates just as natively, so leaving Space out would have
 * left the guard with a hole exactly the width of one keystroke.
 *
 * Note the guard has to *swallow* the key, not merely decline to act on it:
 * the focused confirm button would otherwise fire its own native click.
 * (preventDefault on keydown cancels the activation for both keys — verified
 * in a browser rather than assumed.) That is also why the accept path
 * deliberately does nothing when the keystroke is already aimed at a button
 * inside the dialog — the native activation is the one that runs, and calling
 * onConfirm() here as well would fire it twice. The window handler is
 * therefore only a fallback, for when focus has left the buttons entirely and
 * nothing native would answer; and it is an Enter-only fallback, since Space
 * pressed at nothing in particular is not an answer to anything.
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
    /** Optional third ("escalate") button rendered between cancel and confirm —
     * e.g. message delete's "Delete Message" upgrade from the default "Delete
     * Swipe" (DOM-DECOUPLING.md decision #3's three-way delete confirm).
     * Omitted (with onEscalate) means a plain two-button dialog, unchanged for
     * every other existing caller of this component. */
    escalateLabel?: string;
    onConfirm: () => void;
    onCancel: () => void;
    onEscalate?: () => void;
}): ComponentChild {
    const confirmRef = useRef<HTMLButtonElement>(null);
    const cardRef = useRef<HTMLDivElement>(null);
    // Set once per mounted dialog. ConfirmDialogHost keys its <ConfirmDialog>
    // by request id precisely so a request that pre-empts another gets a new
    // instance — and therefore a fresh guard window — instead of inheriting an
    // already-expired one.
    const openedAtRef = useRef(Date.now());

    useEffect(() => { confirmRef.current?.focus(); }, []);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                onCancel();
                return;
            }
            if (!ACTIVATION_KEYS.has(event.key)) return;

            if (!shouldAcceptConfirmKey(openedAtRef.current, Date.now())) {
                // Swallow it whole: preventDefault kills the native activation
                // of the focused confirm button, stopPropagation keeps the
                // keystroke from reaching whatever the user was typing into.
                event.preventDefault();
                event.stopPropagation();
                return;
            }

            // Past the guard, a button inside the dialog activates itself.
            const target = event.target;
            if (target instanceof HTMLButtonElement && cardRef.current?.contains(target)) return;

            // Focus left the buttons (the user clicked the card's text, say),
            // so nothing native will answer — do it here, for Enter only.
            if (event.key !== 'Enter') return;
            event.preventDefault();
            onConfirm();
        };
        // Capture, so the swallow above happens before any other listener sees
        // the key rather than after.
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [onCancel, onConfirm]);

    return createPortal(
        <div
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
