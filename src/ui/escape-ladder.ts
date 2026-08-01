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
 * - `stop-generation`: nothing is on stage, but a reply is being written.
 * - `ignore`: none of ChatUI's business — do not even `preventDefault()`, or
 *   Escape would stop meaning what it means to the host and the browser.
 */
export type EscapeIntent = 'close-menu' | 'stop-generation' | 'ignore';

/**
 * The menu wins over the generation for the same reason a dialog wins over a
 * page: it is the thing the reader just put on screen, so it is the thing they
 * are answering. Stopping a reply is also the more expensive mistake of the
 * two — it cannot be undone by pressing the key again, while a menu that closed
 * one press early can simply be reopened.
 */
export function resolveEscapeIntent({
    hasOpenMenu,
    isGenerating,
}: {
    hasOpenMenu: boolean;
    isGenerating: boolean;
}): EscapeIntent {
    if (hasOpenMenu) return 'close-menu';
    if (isGenerating) return 'stop-generation';
    return 'ignore';
}
