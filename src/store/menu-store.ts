/**
 * SillyTavern-ChatUI · floating-menu state machine
 *
 * DESIGN §6: 「菜单互斥：打开任一菜单关闭其余；点击外部关闭全部」. Mutual
 * exclusion is not a rule this store enforces — it is the shape of the state.
 * There is exactly one slot, so "open B" *is* "close A"; no menu can be told to
 * close, and no menu can forget to.
 *
 * Before this store there were four independent open/closed flags — a native
 * `<details>` on the topbar ⋯, one `useState` per selector chip, one in the ＋
 * menu, and one inside the message ⋯ menu — which is why two menus could hang
 * open at once and why the `<details>` answered to neither Escape nor an
 * outside click. Collapsing them into one slot is what makes all three halves
 * of the contract a single fact rather than four agreements.
 *
 * ── Why the message menu carries a payload and the other four do not ──
 *
 * The other four menus are rendered by the component that owns their trigger,
 * which is permanently mounted; "open" is the whole state. The message ⋯ menu
 * is different in kind: its trigger lives inside a virtualised row that the
 * list is free to unmount at any moment, so its menu is rendered by a host at
 * the app root instead (components/message/MessageMenuHost.tsx). Everything
 * that host needs to draw the menu therefore has to travel with the open
 * state — which row it belongs to, and where on screen its trigger was — and
 * that is exactly what `ChatuiMessageMenuAnchor` is.
 *
 * The anchor holds the trigger's *measured rect*, not a computed placement:
 * measuring is the only thing that must happen at click time (the button is
 * about to stop being under the cursor), while deciding which way the menu
 * opens is a pure function of that rect plus the menu's own rows, and belongs
 * with the code that knows the rows (ui/menu-placement.ts, applied in the
 * host). Keeping the split here means the store never has to be taught what a
 * menu looks like.
 *
 * ── Why closes are id-scoped ──
 *
 * A component that unmounts while its own menu is open must take the menu with
 * it, but an unmounting component must never close *someone else's* menu. That
 * is not a hypothetical ordering: a virtualised row can be unmounted in the
 * same commit that another row's menu opens, and an unscoped close would then
 * shut a menu that had just been asked for. Hence `closeChatuiMenuById` and
 * `closeChatuiMessageMenuFor` — both no-ops unless the caller is the one
 * currently on stage.
 */

import { createStore } from './create-store.js';

/**
 * Every floating menu in the app, as a closed set. A new menu must be named
 * here to participate, which is the point: a menu that is not in this union
 * cannot be opened through this store, and so cannot be the one that stays
 * open when everything else closes.
 *
 * The selector ids are `selector:<kind>` because the three chips are one
 * component rendered three times (composer: 预设/模型, topbar: 人设) and each
 * instance needs its own identity.
 */
export const CHATUI_MENU_IDS = Object.freeze([
    'topbar',
    'selector:preset',
    'selector:model',
    'selector:persona',
    'plus',
    'message',
] as const);

export type ChatuiMenuId = (typeof CHATUI_MENU_IDS)[number];

/** Every menu whose open state is nothing but "open" — see the module doc. */
export type ChatuiSimpleMenuId = Exclude<ChatuiMenuId, 'message'>;

/** The one-shot snapshot the message ⋯ menu's host renders from. */
export type ChatuiMessageMenuAnchor = Readonly<{
    /** Which row's ⋯ was pressed. */
    messageId: number;
    /** The chat that row belonged to, so a chat switch can never mismatch. */
    chatKey: string;
    /** System rows carry a shorter menu; the host builds the rows from this. */
    isSystem: boolean;
    /** Viewport rect of the trigger, read once at open time. */
    trigger: Readonly<{ top: number; bottom: number; right: number }>;
}>;

export type ChatuiActiveMenu =
    | Readonly<{ id: ChatuiSimpleMenuId }>
    | Readonly<{ id: 'message'; anchor: ChatuiMessageMenuAnchor }>;

const _store = createStore<ChatuiActiveMenu | null>(null);

/** @returns The menu currently on stage, or null when none is. */
export function getActiveChatuiMenu(): ChatuiActiveMenu | null {
    return _store.getState();
}

/**
 * @param {(menu: ChatuiActiveMenu | null) => void} fn
 * @returns {() => void} Unsubscribe function.
 */
export function subscribeChatuiMenu(fn: (menu: ChatuiActiveMenu | null) => void): () => void {
    return _store.subscribe(fn);
}

/**
 * Open one of the payload-free menus, closing whatever else was open. Opening
 * the menu that is already open is a no-op rather than a re-notification —
 * callers that mean "toggle" say so.
 */
export function openChatuiMenu(id: ChatuiSimpleMenuId): void {
    const current = _store.getState();
    if (current && current.id === id) return;
    _store.setState({ id });
}

/** The trigger-button semantics: press once to open, press again to close. */
export function toggleChatuiMenu(id: ChatuiSimpleMenuId): void {
    const current = _store.getState();
    if (current && current.id === id) {
        _store.setState(null);
        return;
    }
    _store.setState({ id });
}

/**
 * Open (or re-aim) the message ⋯ menu. Re-opening on the same row with a fresh
 * rect is a real update, not a no-op: the row may have moved under the reader
 * between the two presses.
 */
export function openChatuiMessageMenu(anchor: ChatuiMessageMenuAnchor): void {
    _store.setState({ id: 'message', anchor });
}

/** Trigger-button semantics for the message ⋯ menu, keyed on the row it belongs to. */
export function toggleChatuiMessageMenu(anchor: ChatuiMessageMenuAnchor): void {
    const current = _store.getState();
    if (
        current
        && current.id === 'message'
        && current.anchor.messageId === anchor.messageId
        && current.anchor.chatKey === anchor.chatKey
    ) {
        _store.setState(null);
        return;
    }
    _store.setState({ id: 'message', anchor });
}

/** Close whichever menu is open. The backdrop and the Escape ladder both land here. */
export function closeChatuiMenu(): void {
    if (_store.getState() === null) return;
    _store.setState(null);
}

/**
 * Close `id`, but only if `id` is the menu currently open — see the module doc
 * on why an unmounting component must not close a menu it does not own.
 */
export function closeChatuiMenuById(id: ChatuiMenuId): void {
    const current = _store.getState();
    if (!current || current.id !== id) return;
    _store.setState(null);
}

/**
 * The virtualised-row cleanup path: close the message ⋯ menu iff it belongs to
 * this exact row of this exact chat. Both halves of the identity are checked —
 * message ids are per-chat indices, so id alone would let a row of the chat the
 * reader just left close a menu opened on the chat they arrived at.
 */
export function closeChatuiMessageMenuFor(messageId: number, chatKey: string): void {
    const current = _store.getState();
    if (!current || current.id !== 'message') return;
    if (current.anchor.messageId !== messageId || current.anchor.chatKey !== chatKey) return;
    _store.setState(null);
}

/** Teardown hook: ui/app.tsx clears this alongside the other ephemeral stores. */
export function resetChatuiMenuStore(): void {
    if (_store.getState() === null) return;
    _store.setState(null);
}
