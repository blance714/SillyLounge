/**
 * SillyTavern-ChatUI · vanished-chat announcements
 *
 * One ChatUI-owned fact the host will never announce: a conversation ChatUI
 * just proved is not there. ST emits CHAT_DELETED when *ST* deleted a file; a
 * file that went missing behind its back — a save that never happened, an
 * external delete — produces no event at all, and ChatUI only ever finds out
 * while settling something else: deleting a conversation whose file is already
 * gone (sidebar-actions.ts's `absent` branch), or trying to open one and being
 * told it does not exist.
 *
 * Left unsaid, that discovery strands the row instead of removing it. The
 * sidebar's per-character listing is cached server state (ui/query-client.ts)
 * that still holds the missing file, so the card the reader just deleted does
 * not disappear — it *turns into* an ordinary history row pointing at a file
 * nothing can open (真机 danglinglease 格实测).
 *
 * That cache lives in ui/ and this layer may not reach into it
 * (scripts/check-boundaries.mjs), nor should it: which queries a vanished file
 * invalidates is the query layer's business. So the store states the fact and
 * ui/use-st-query-bridge.ts translates it into invalidations, exactly as it
 * already does for ST's own domain events. Announcing it here rather than
 * letting callers invalidate after `await` is also the only honest option: the
 * sidebar actions return void, and "the file was already gone" is a decision
 * made deep inside them — a caller-side invalidation would have to fire after
 * every delete and every open, whether or not anything vanished.
 */

import { createStore } from './create-store.js';

export type VanishedChat = Readonly<{ avatar: string; fileName: string }>;

const _store = createStore<VanishedChat | null>(null);

/**
 * The most recent conversation ChatUI proved absent, or null when it has not
 * happened this session. Announcements are not replayed to late subscribers:
 * this is a live signal, and its only consumer is the cache bridge that mounts
 * long before any of these paths can run.
 *
 * @returns {VanishedChat | null}
 */
export function getLastVanishedChat(): VanishedChat | null {
    return _store.getState();
}

/**
 * @param {(vanished: VanishedChat | null) => void} subscriber
 * @returns {() => void}
 */
export function subscribeVanishedChats(subscriber: (vanished: VanishedChat | null) => void): () => void {
    return _store.subscribe(subscriber);
}

/**
 * Announce that this conversation is not on the host — established, not
 * guessed: a directory listing that does not contain it, or the host's own
 * `notfound`.
 *
 * @param {string} avatar Stable character avatar the conversation belonged to.
 * @param {string} fileName Bare chat file name.
 * @returns {void}
 */
export function publishVanishedChat(avatar: string, fileName: string): void {
    if (!avatar || !fileName) return;
    _store.setState({ avatar, fileName });
}
