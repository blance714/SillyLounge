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
 * It also owns the one piece of the dialog's keyboard model that is a rule
 * rather than wiring: shouldAcceptConfirmEnter(). See its own note below.
 *
 * Two-way vs three-way: `variant` distinguishes a plain confirm/cancel dialog
 * from one with a third ("escalate") button — e.g. message delete's default
 * "Delete Swipe" escalating to "Delete Message" (DOM-DECOUPLING.md decision
 * #3's Tier 2 resolution: a ChatUI-owned dialog, not a direct ST popup call).
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
        cancelLabel: input.cancelLabel ?? 'Cancel',
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
 * How long a freshly-opened confirm dialog refuses Enter (design §9).
 *
 * The dialog hands focus to its *confirm* button, which is what makes Enter
 * answer the question without the user reaching for the mouse. That is only
 * safe because a delete is usually triggered from a keyboard-heavy moment —
 * the composer, an inline editor — and a stray keystroke already in flight
 * must not become the answer. 300ms is longer than any single keypress and
 * far shorter than reading a sentence.
 */
export const CHATUI_CONFIRM_ENTER_GUARD_MS = 300;

/**
 * Is this Enter the user's answer, or the tail of what they were typing when
 * the dialog appeared?
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
export function shouldAcceptConfirmEnter(openedAtMs: number, nowMs: number): boolean {
    if (!Number.isFinite(openedAtMs) || !Number.isFinite(nowMs)) return false;
    return nowMs - openedAtMs >= CHATUI_CONFIRM_ENTER_GUARD_MS;
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
