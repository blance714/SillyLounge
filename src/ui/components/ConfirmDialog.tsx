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
 * deliberately does nothing when the keystroke is already aimed at a control
 * inside the dialog — the native activation is the one that runs, and calling
 * onConfirm() here as well would fire it twice.
 *
 * Past the guard the handler therefore sorts the keystroke by who is going to
 * answer it, and it answers only in the one case where nobody else will:
 *
 *   - focus inside the dialog — the control answers for itself; stand down.
 *   - focus outside the dialog — swallow it. This is aria-modal, and focus
 *     escapes with a single Tab (nothing traps it, and confirm is the last
 *     focusable in the portal), landing on a control hidden behind the veil.
 *     preventDefault() does not stop propagation, so without the swallow one
 *     Enter would both answer this dialog *and* reach that control — with
 *     focus in the composer, deleting a message and sending one on the same
 *     keystroke. It answers nothing; the dialog stays open.
 *   - nothing focused (clicking the card's text leaves activeElement on
 *     <body>) — nothing native is coming, so answer here. Bare Enter only:
 *     Space pressed at nothing in particular is not an answer to anything,
 *     and neither is a modified Enter.
 *
 * The escaped-focus swallow is a floor, not a fix for the missing focus trap:
 * a real trap would keep focus in the dialog in the first place, and is worth
 * having. Until then this at least guarantees one keystroke means one answer.
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

            // Past the guard, the question is who answers. The window handler
            // is only ever the *last* resort: it must run exactly when no
            // native activation is coming, and stay out of the way otherwise.
            const target = event.target;
            const nothingFocused = target === null
                || target === document.body
                || target === document.documentElement;

            if (!nothingFocused) {
                // Inside the dialog, the focused control answers for itself.
                if (target instanceof Node && cardRef.current?.contains(target)) return;

                // Outside it, focus has escaped the modal — one Tab from the
                // confirm button is enough, since nothing traps it and confirm
                // is the last focusable in the portal. Swallowing is not
                // politeness here, it is the fix for a double answer: this
                // handler runs at window *capture*, and preventDefault() alone
                // does not stop propagation, so the key would go on to reach
                // whatever sits behind the veil. With focus in the composer
                // that meant one Enter both deleting the message and sending
                // a new one (verified in Chromium). A keystroke aimed at a
                // control the user cannot see is not an answer to this
                // question either, so it answers nothing and the dialog stays.
                event.preventDefault();
                event.stopPropagation();
                return;
            }

            // Nothing is focused — clicking the card's text lands here, since
            // the card itself is not focusable — so no native activation is
            // coming and this handler is the only thing that can answer.
            // A bare Enter only: a modified Enter is not "the answer" anywhere
            // else in this app, and must not become one here.
            if (event.key !== 'Enter') return;
            if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
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
