/**
 * SillyTavern-ChatUI · session character ledger
 *
 * Characters ChatUI knows have a conversation, in cases where ST's own answer
 * says otherwise.
 *
 * ST reports `chat_size` per character, and the spine's membership rule reads
 * it to answer 「has this character ever been opened」 (ui/spine-cast.ts). But
 * that number is a **disk snapshot**, taken once per boot while ST enumerates
 * each character's chats directory (`calculateChatSize`,
 * src/endpoints/characters.js), and never refreshed inside the page. Anything
 * that gives a character its first conversation *after* that scan is invisible
 * to it, and a character the snapshot cannot speak for is a character the
 * reader cannot walk to — the spine is ChatUI's only way to change character,
 * since ST's own list is under the shield.
 *
 * Two things create that gap, and both are ChatUI's own doing:
 *
 * - ＋新对话 for a character who had none;
 * - the reload that follows deleting a character's *last* conversation, where
 *   ST writes a fresh fallback file during the very boot whose snapshot was
 *   taken before it existed.
 *
 * So ChatUI records them here as it does them. The ledger is deliberately
 * **in-memory and page-scoped**: it exists only to paper over one stale
 * snapshot, and the next boot's scan is authoritative on its own. This is what
 * replaced the persisted quarantine lease set that used to answer the same
 * question as a side effect of tracking unadopted drafts (retired 2026-08-02);
 * an answer about disk staleness has no business outliving the page whose
 * snapshot went stale.
 */

import { createStore } from './create-store.js';

type SessionCharacterState = Readonly<{ avatars: readonly string[] }>;

const _store = createStore<SessionCharacterState>({ avatars: [] });

/**
 * Record that this character has a conversation now, whatever the boot-time
 * snapshot says. Idempotent, and a no-op for an empty avatar.
 */
export function rememberCharacterConversation(avatar: unknown): void {
    if (typeof avatar !== 'string' || avatar === '') return;
    const { avatars } = _store.getState();
    if (avatars.includes(avatar)) return;
    _store.setState({ avatars: [...avatars, avatar] });
}

/** Stable external-store snapshot for the spine. */
export function getSessionCharacterConversations(): readonly string[] {
    return _store.getState().avatars;
}

export function subscribeSessionCharacters(
    callback: (state: SessionCharacterState) => void,
): () => void {
    return _store.subscribe(callback);
}

/** Test/lifecycle reset; the ledger never outlives a page in production. */
export function resetSessionCharacters(): void {
    if (_store.getState().avatars.length === 0) return;
    _store.setState({ avatars: [] });
}
