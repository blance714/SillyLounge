/**
 * SillyTavern-ChatUI · confirm store
 *
 * Tiny ChatUI-owned confirmation store, modeled on toast-store.ts's
 * conventions (a single createStore-backed value, plain module functions, no
 * framework dependency). Holds at most one pending confirm *request* at a
 * time and exposes a promise-based request/resolve API so orchestration code
 * (store/chat-actions.ts) can `await` a user's dialog choice without owning
 * any rendering itself — a component mounted once at the app root
 * (ui/components/ConfirmDialogHost.tsx) is the only reader that turns a
 * pending request into an actual <ConfirmDialog>.
 *
 * It also owns the pieces of the dialog's keyboard model that are rules
 * rather than wiring — decideConfirmKeyAction() and the two functions it is
 * built from, shouldAcceptConfirmKey() and nextConfirmFocusIndex(). See their
 * own notes below.
 *
 * Two-way vs three-way: `variant` distinguishes a plain confirm/cancel dialog
 * from one with a third ("escalate") button — e.g. message delete's default
 * 「仅删除此条」escalating to「删除整楼」(DOM-DECOUPLING.md decision #3's Tier 2
 * resolution: a ChatUI-owned dialog, not a direct ST popup call).
 * This module is generic over that choice; it does not know anything about
 * messages or deletion.
 */

import { createStore } from './create-store.js';

export type ChatuiConfirmVariant = 'two-way' | 'three-way';
export type ChatuiConfirmOutcome = 'confirm' | 'escalate' | 'cancel';

export type ChatuiConfirmRequest = Readonly<{
    id: string;
    title: string;
    message?: string;
    danger: boolean;
    variant: ChatuiConfirmVariant;
    confirmLabel: string;
    cancelLabel: string;
    /** Present only when variant === 'three-way'. */
    escalateLabel?: string;
}>;

export type ChatuiConfirmRequestInput = Readonly<{
    title: string;
    message?: string;
    danger?: boolean;
    variant: ChatuiConfirmVariant;
    confirmLabel: string;
    cancelLabel?: string;
    escalateLabel?: string;
}>;

type PendingEntry = Readonly<{
    request: ChatuiConfirmRequest;
    resolve: (outcome: ChatuiConfirmOutcome) => void;
}>;

const _store = createStore<ChatuiConfirmRequest | null>(null);

let _seq = 0;
let _pending: PendingEntry | null = null;

/** @returns {ChatuiConfirmRequest | null} */
export function getChatuiConfirmRequest(): ChatuiConfirmRequest | null {
    return _store.getState();
}

/**
 * @param {(request: ChatuiConfirmRequest | null) => void} subscriber
 * @returns {() => void}
 */
export function subscribeChatuiConfirm(subscriber: (request: ChatuiConfirmRequest | null) => void): () => void {
    return _store.subscribe(subscriber);
}

/**
 * Request confirmation and wait for the user's choice.
 *
 * At most one request is pending at a time — the dialog host mounted at the
 * app root can only ever show one modal. A new request that arrives while an
 * older one is still unanswered pre-empts it: the older request's promise is
 * resolved with 'cancel' (never left dangling forever) and the store moves
 * straight to the new request. This is a deliberate, pinned policy (see
 * test/confirm-store.test.mjs), not an accident of last-write-wins state.
 *
 * @param {ChatuiConfirmRequestInput} input
 * @returns {Promise<ChatuiConfirmOutcome>}
 */
export function requestChatuiConfirm(input: ChatuiConfirmRequestInput): Promise<ChatuiConfirmOutcome> {
    if (_pending) {
        const stale = _pending;
        _pending = null;
        stale.resolve('cancel');
    }

    const id = `confirm-${_seq++}`;
    const request: ChatuiConfirmRequest = {
        id,
        title: input.title,
        message: input.message,
        danger: input.danger ?? false,
        variant: input.variant,
        confirmLabel: input.confirmLabel,
        // Chinese, because that is the language of the surface this renders
        // on. Every caller passes an explicit label today, so this default is
        // only ever the answer when someone forgets one — and the failure it
        // used to produce was a lone English "Cancel" under a Chinese
        // question, which is exactly the mismatch the delete dialog's wording
        // was just changed to stop producing.
        cancelLabel: input.cancelLabel ?? '取消',
        escalateLabel: input.variant === 'three-way' ? input.escalateLabel : undefined,
    };

    return new Promise<ChatuiConfirmOutcome>((resolve) => {
        _pending = { request, resolve };
        _store.setState(request);
    });
}

function _settle(id: string, outcome: ChatuiConfirmOutcome): void {
    // A stale id (already resolved, or pre-empted by a newer request) is a
    // silent no-op: the dialog host can only ever be reacting to whatever
    // request it was last rendered with, but a resolve callback captured by
    // an earlier render closure must not be able to resolve a *different*,
    // newer pending request out from under it.
    if (!_pending || _pending.request.id !== id) return;
    const entry = _pending;
    _pending = null;
    _store.setState(null);
    entry.resolve(outcome);
}

/**
 * Called by the dialog host in response to the user's actual choice.
 * @param {string} id
 * @param {ChatuiConfirmOutcome} outcome
 * @returns {void}
 */
export function resolveChatuiConfirm(id: string, outcome: ChatuiConfirmOutcome): void {
    _settle(id, outcome);
}

/**
 * Called by the dialog host on Escape / backdrop click / unmount.
 * @param {string} id
 * @returns {void}
 */
export function cancelChatuiConfirm(id: string): void {
    _settle(id, 'cancel');
}

/**
 * How long a freshly-opened confirm dialog refuses an activation keystroke
 * (design §6「确认与浮层」).
 *
 * The dialog hands focus to its *confirm* button, which is what lets a
 * keystroke answer the question without the user reaching for the mouse. That
 * is only safe because a delete is usually triggered from a keyboard-heavy
 * moment — the composer, an inline editor — and a keystroke already in flight
 * must not become the answer. 300ms is longer than any single keypress and
 * far shorter than reading a sentence.
 */
export const CHATUI_CONFIRM_KEY_GUARD_MS = 300;

/**
 * Is this keystroke the user's answer, or the tail of what they were typing
 * when the dialog appeared?
 *
 * Keyed on time, not on which key: the design names Enter, but a focused
 * <button> is activated by Space just as natively, and the accident being
 * guarded against ("a dialog appeared under hands that were already typing")
 * does not care which of the two lands. The caller decides which keys are
 * activation keys; this decides whether the window has closed.
 *
 * Pure on purpose: the component owns *when* the dialog opened and asks the
 * clock, this owns the rule. Non-finite inputs fail closed — a missing or
 * corrupt timestamp must not be able to authorize a deletion (`Infinity`
 * would otherwise sail past any elapsed-time comparison), and neither must a
 * clock that has moved backwards.
 *
 * @param {number} openedAtMs epoch ms at which the dialog was mounted
 * @param {number} nowMs epoch ms of the keystroke
 * @returns {boolean}
 */
export function shouldAcceptConfirmKey(openedAtMs: number, nowMs: number): boolean {
    if (!Number.isFinite(openedAtMs) || !Number.isFinite(nowMs)) return false;
    return nowMs - openedAtMs >= CHATUI_CONFIRM_KEY_GUARD_MS;
}

/**
 * The two keys a focused `<button>` activates itself with. Both have to be
 * part of the model: the design names only Enter because its own prototype's
 * dialog buttons were non-focusable spans, so Space could never have reached
 * them. Ours are real buttons, which Space activates just as natively, so
 * leaving Space out would leave a hole exactly one keystroke wide.
 */
const ACTIVATION_KEYS = new Set([' ', 'Enter']);

/** Where a keystroke aimed at the page is, relative to the dialog's card. */
export type ChatuiConfirmFocusZone =
    /** On a control inside the dialog — that control answers for itself. */
    | 'inside'
    /** On something behind the veil — the modal has lost focus somehow. */
    | 'outside'
    /** Nothing focusable has it (clicking the card's text leaves `<body>`). */
    | 'none';

/**
 * What the dialog should do with one keystroke. Every verdict except
 * 'ignore'/'stand-down' means "this key was the dialog's" and is swallowed
 * whole (preventDefault *and* stopPropagation) by the component.
 */
export type ChatuiConfirmKeyAction =
    /** Not part of the dialog's model — leave it entirely alone. */
    | 'ignore'
    /** Ours, but a native activation is already coming; do not double-answer. */
    | 'stand-down'
    /** Swallow it and answer nothing; the dialog stays open. */
    | 'swallow'
    | 'cancel'
    | 'confirm'
    | 'focus-next'
    | 'focus-previous';

export type ChatuiConfirmKeystroke = Readonly<{
    /** `KeyboardEvent.key`. */
    key: string;
    /** `KeyboardEvent.repeat` — true for every event after the first in one
     *  physical press's auto-repeat train. */
    repeat: boolean;
    shiftKey: boolean;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    focus: ChatuiConfirmFocusZone;
    /** Epoch ms at which the dialog was mounted. */
    openedAtMs: number;
    /** Epoch ms of the keystroke. */
    nowMs: number;
}>;

/**
 * The dialog's whole keyboard model, as one pure decision (design §6
 * 「确认与浮层」). The component owns only the two things a rule cannot know —
 * where the keystroke landed and what time it is — and then executes the
 * verdict; every "which key, from where, how long after opening, answers
 * what" question is settled here, where it can be pinned without a DOM.
 *
 * The order of the clauses is the model:
 *
 *   1. Escape cancels, always. The guard exists to stop an accidental
 *      *confirmation*; cancelling is the safe direction, so it is never worth
 *      delaying, and repeat-cancelling is harmless (a settled request ignores
 *      further answers). Modifiers are not checked either: a modified Escape
 *      reaching a modal still means "get me out".
 *   2. Tab moves focus inside the dialog and nowhere else — this is the focus
 *      trap, and it is what makes `aria-modal="true"` true rather than merely
 *      declared. It is deliberately *not* time-guarded and *not* repeat-
 *      guarded: moving focus is not an answer to anything, and holding Tab to
 *      walk a dialog is ordinary keyboard use. Alt/Ctrl/Meta+Tab belong to
 *      the browser or the window manager, so those are left alone.
 *   3. Anything that is not an activation key is none of the dialog's
 *      business.
 *   4. An auto-repeat never answers. `repeat` is the same physical press
 *      still being held, and the guard's whole premise (design §6) is that a
 *      keystroke the user did not aim at this dialog must not answer it —
 *      "held down since before it opened" is exactly that keystroke, and time
 *      alone cannot see it: hold Enter long enough and the 300ms window
 *      expires *underneath* the held key. It is swallowed rather than
 *      stood down from, because the focused confirm button would otherwise
 *      fire its own native activation on every repeat.
 *   5. Inside the guard window, likewise: swallow, answer nothing.
 *   6. Past the guard, the verdict is about who else is going to answer.
 *      A control inside the dialog answers for itself (stand down, or the
 *      answer fires twice). Something outside the dialog must not answer at
 *      all — a keystroke aimed at a control the user cannot see is not an
 *      answer to this question — and must not be allowed through either.
 *   7. With nothing focused, no native activation is coming and this is the
 *      only thing that can answer: a bare Enter does. Space does not — Space
 *      pressed at nothing in particular is not an answer to anything — and
 *      neither does a modified Enter, which is not "the answer" anywhere else
 *      in this app and must not become one here.
 */
export function decideConfirmKeyAction(keystroke: ChatuiConfirmKeystroke): ChatuiConfirmKeyAction {
    const { key, repeat, shiftKey, altKey, ctrlKey, metaKey, focus, openedAtMs, nowMs } = keystroke;

    if (key === 'Escape') return 'cancel';

    if (key === 'Tab') {
        if (altKey || ctrlKey || metaKey) return 'ignore';
        return shiftKey ? 'focus-previous' : 'focus-next';
    }

    if (!ACTIVATION_KEYS.has(key)) return 'ignore';

    if (repeat) return 'swallow';
    if (!shouldAcceptConfirmKey(openedAtMs, nowMs)) return 'swallow';

    if (focus === 'inside') return 'stand-down';
    if (focus === 'outside') return 'swallow';

    if (key !== 'Enter') return 'ignore';
    if (altKey || ctrlKey || metaKey || shiftKey) return 'ignore';
    return 'confirm';
}

/**
 * Where Tab / Shift+Tab should put focus next, given how many focusable
 * controls the dialog has and which one has focus now.
 *
 * The cycle is closed on purpose: the last control's Tab wraps to the first
 * instead of walking out into the host page behind the veil. `currentIndex`
 * outside the range (`-1` from `indexOf` when focus is on the card, on
 * `<body>`, or on something that has already escaped) means "focus is not on
 * one of the dialog's own controls", and Tab pulls it back in at the end the
 * browser itself would have entered from — the top going forwards, the bottom
 * going backwards.
 *
 * `null` means "there is nothing in here to focus": the caller still swallows
 * the keystroke, so focus stays put rather than leaving the modal.
 *
 * @param {number} count how many focusable controls the dialog currently has
 * @param {number} currentIndex index of the focused control, or -1
 * @param {boolean} backwards true for Shift+Tab
 * @returns {number | null}
 */
export function nextConfirmFocusIndex(count: number, currentIndex: number, backwards: boolean): number | null {
    if (!Number.isInteger(count) || count <= 0) return null;
    if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= count) {
        return backwards ? count - 1 : 0;
    }
    return backwards
        ? (currentIndex + count - 1) % count
        : (currentIndex + 1) % count;
}

/** Reset ephemeral UI state on full ChatUI teardown, not on settings toggles. */
export function resetChatuiConfirmStore(): void {
    if (_pending) {
        const stale = _pending;
        _pending = null;
        stale.resolve('cancel');
    }
    _store.setState(null);
}
