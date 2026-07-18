/**
 * SillyTavern-ChatUI · message edit draft store
 *
 * Draft text for an in-progress message edit belongs to (chatKey, messageId),
 * not to the lifetime of the MessageEditor component. The message list is
 * virtualized (see app.tsx's messageVirtualizer) and can unmount an editing
 * row purely because it scrolled out of the overscan window -- long before
 * the user saves or cancels. Keeping the draft here means a remount restores
 * exactly what the user typed instead of silently reverting to the
 * last-saved message text.
 */

import { createStore } from './create-store.js';

export type MessageEditDraftStoreSnapshot = Readonly<{
    drafts: Readonly<Record<string, string>>;
}>;

const _initialState: MessageEditDraftStoreSnapshot = {
    drafts: {},
};

const _store = createStore<MessageEditDraftStoreSnapshot>(_initialState);

function _draftKey(chatKey: unknown, messageId: unknown): string {
    return JSON.stringify([typeof chatKey === 'string' ? chatKey : '', messageId]);
}

/** Stable external-store snapshot for useSyncExternalStore and focused tests. */
export function getMessageEditDraftStoreSnapshot(): MessageEditDraftStoreSnapshot {
    return _store.getState();
}

/**
 * `undefined` means no draft is held for this message: callers should seed
 * from the message's last-saved text instead. An empty string IS a real
 * draft (the user selected-all-and-deleted) and must not collapse into the
 * "no draft" case, or a remount would resurrect text the user just erased.
 */
export function getMessageEditDraft(chatKey: string, messageId: number): string | undefined {
    const key = _draftKey(chatKey, messageId);
    const state = _store.getState();
    return Object.prototype.hasOwnProperty.call(state.drafts, key)
        ? state.drafts[key]
        : undefined;
}

export function setMessageEditDraft(chatKey: string, messageId: number, text: string): void {
    const key = _draftKey(chatKey, messageId);
    const nextText = typeof text === 'string' ? text : '';
    const state = _store.getState();
    if (state.drafts[key] === nextText && Object.prototype.hasOwnProperty.call(state.drafts, key)) return;
    _store.setState({ ...state, drafts: { ...state.drafts, [key]: nextText } });
}

/** Drop one message's retained draft -- called on save and on explicit cancel. */
export function clearMessageEditDraft(chatKey: string, messageId: number): void {
    const key = _draftKey(chatKey, messageId);
    const state = _store.getState();
    if (!Object.prototype.hasOwnProperty.call(state.drafts, key)) return;
    const drafts = { ...state.drafts };
    delete drafts[key];
    _store.setState({ ...state, drafts });
}

export function subscribeMessageEditDraftStore(onStoreChange: () => void): () => void {
    return _store.subscribe(() => onStoreChange());
}

/** Reset ephemeral UI state on full ChatUI teardown, not on settings toggles. */
export function resetMessageEditDraftStore(): void {
    _store.setState({ drafts: {} });
}
