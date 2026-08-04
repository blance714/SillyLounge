/**
 * SillyTavern-ChatUI · what one Escape keystroke means
 *
 * DESIGN §6 already states a precedence for this key — 「`Escape` 优先退出编辑，
 * 其次停止生成」 — and adding 「Escape 关闭当前菜单」 puts a third rung on the
 * same ladder. The point of this module is that the ladder is *one* decision
 * with an order, not several independent listeners that happen to agree.
 *
 * ── Why not simply add another window listener ──
 *
 * The obvious shape is a second `window.addEventListener('keydown', …)` that
 * closes the open menu. It does not work, and the way it fails is instructive:
 * two listeners on the *same* target run in registration order and
 * `stopPropagation()` between them does nothing (it stops the event descending
 * or ascending the tree, and both are already at the top of it). So with a menu
 * open during generation, one Escape would close the menu *and* abort the
 * reply. The only ways to make that not happen are `stopImmediatePropagation`
 * plus a guaranteed registration order, or a capture-phase interception — both
 * of which encode the precedence in *when a listener happens to be installed*
 * rather than in what the app means. That is exactly the "works because of
 * timing luck" shape this project refuses.
 *
 * So the two rungs that are both global — close the menu, stop the generation —
 * are resolved here, by value, and dispatched by a single listener.
 *
 * The rung this module deliberately does *not* know about is 「退出编辑」.
 * MessageEditor (and the two in-place rename inputs) handle Escape on their own
 * element and call `stopPropagation()`, so the keystroke never reaches the
 * window at all while one of them has focus. That rung is settled by *where the
 * focus is*, which is a real answer to "what is this Escape for", not an
 * accident of ordering — and it means this function is only ever asked the
 * question once the editors have declined it.
 */

/**
 * - `close-menu`: a floating menu is on stage; Escape dismisses it and nothing else.
 * - `close-settings`: no menu, but the reader is in settings mode; Escape leaves it.
 * - `stop-generation`: nothing of ChatUI's is on stage, but a reply is being written.
 * - `ignore`: none of ChatUI's business — do not even `preventDefault()`, or
 *   Escape would stop meaning what it means to the host and the browser.
 */
export type EscapeIntent = 'close-menu' | 'close-settings' | 'stop-generation' | 'ignore';

/**
 * The order is by how recently the reader put the thing there, and the ladder
 * is strict: exactly one rung answers a keystroke.
 *
 * The menu wins over everything for the same reason a dialog wins over a page:
 * it is the thing the reader just put on screen, so it is the thing they are
 * answering. Settings mode is next — also something they opened, and leaving it
 * is free and instantly reversible. Stopping a reply is last because it is the
 * one mistake of the three that cannot be undone by pressing the key again.
 *
 * `close-settings` was a second `window` listener in SettingsContent.tsx until
 * 2026-08-05, which is the failure this module's header describes rather than a
 * hypothetical: with a reply streaming and settings open, one Escape ran both
 * listeners and the reader left settings *and* lost the generation. Putting the
 * rung here is what makes "one keystroke, one action" a property of the state
 * rather than of who registered first.
 */
export function resolveEscapeIntent({
    hasOpenMenu,
    isSettingsOpen,
    isGenerating,
}: {
    hasOpenMenu: boolean;
    isSettingsOpen: boolean;
    isGenerating: boolean;
}): EscapeIntent {
    if (hasOpenMenu) return 'close-menu';
    if (isSettingsOpen) return 'close-settings';
    if (isGenerating) return 'stop-generation';
    return 'ignore';
}
