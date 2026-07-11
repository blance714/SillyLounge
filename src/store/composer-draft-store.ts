/**
 * SillyTavern-ChatUI · composer draft store
 *
 * Draft text belongs to a chat identity, not to the lifetime of the Composer
 * component. Keeping it here prevents settings-mode unmounts and chat switches
 * from losing or leaking text. The pending send is also store-owned so an
 * unmount cannot reopen the send gate while the host action is still running.
 */

import { createStore } from './create-store.js';
import {
    getHostOperationEpoch,
    resetHostOperationQueueLifecycle,
} from './host-operation-queue.js';

export type ComposerSendToken = Readonly<{
    id: number;
    chatKey: string;
    text: string;
    draftRevision: number;
    lifecycleEpoch: number;
}>;

export type ComposerDraftStoreSnapshot = Readonly<{
    drafts: Readonly<Record<string, string>>;
    draftRevisions: Readonly<Record<string, number>>;
    pendingSend: ComposerSendToken | null;
    lifecycleEpoch: number;
}>;

const _initialState: ComposerDraftStoreSnapshot = {
    drafts: {},
    draftRevisions: {},
    pendingSend: null,
    lifecycleEpoch: getHostOperationEpoch(),
};

const _store = createStore<ComposerDraftStoreSnapshot>(_initialState);
let _nextSendId = 0;
let _resetRequested = false;

function _chatKey(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

/** Stable external-store snapshot for useSyncExternalStore and focused tests. */
export function getComposerDraftStoreSnapshot(): ComposerDraftStoreSnapshot {
    return _store.getState();
}

export function getComposerDraft(chatKey: string): string {
    return _store.getState().drafts[_chatKey(chatKey)] ?? '';
}

export function setComposerDraft(chatKey: string, text: string): void {
    const key = _chatKey(chatKey);
    const nextText = typeof text === 'string' ? text : '';
    const state = _store.getState();
    if ((state.drafts[key] ?? '') === nextText) return;

    const drafts = { ...state.drafts };
    const draftRevisions = {
        ...state.draftRevisions,
        [key]: (state.draftRevisions[key] ?? 0) + 1,
    };
    if (nextText) drafts[key] = nextText;
    else delete drafts[key];
    _store.setState({ ...state, drafts, draftRevisions });
}

/** Drop one confirmed-deleted conversation's retained draft. */
export function deleteComposerDraft(chatKey: string): void {
    setComposerDraft(chatKey, '');
}

/** Move a draft after the server confirms a filename rename. */
export function moveComposerDraft(oldChatKey: string, newChatKey: string): boolean {
    const oldKey = _chatKey(oldChatKey);
    const newKey = _chatKey(newChatKey);
    if (!oldKey || !newKey || oldKey === newKey) return oldKey === newKey;

    const state = _store.getState();
    if (!Object.prototype.hasOwnProperty.call(state.drafts, oldKey)) return true;
    const drafts = { ...state.drafts, [newKey]: state.drafts[oldKey] };
    delete drafts[oldKey];
    const oldRevision = (state.draftRevisions[oldKey] ?? 0) + 1;
    const newRevision = (state.draftRevisions[newKey] ?? 0) + 1;
    const pendingCanFollowRename = state.pendingSend?.chatKey === oldKey
        && state.pendingSend.draftRevision === (state.draftRevisions[oldKey] ?? 0)
        && state.pendingSend.text === state.drafts[oldKey];
    const pendingSend = pendingCanFollowRename
        ? { ...state.pendingSend, chatKey: newKey, draftRevision: newRevision }
        : state.pendingSend;
    _store.setState({
        ...state,
        drafts,
        draftRevisions: {
            ...state.draftRevisions,
            [oldKey]: oldRevision,
            [newKey]: newRevision,
        },
        pendingSend,
    });
    return true;
}

/** Re-key every retained draft when ST renames a character avatar/directory. */
export function moveComposerDraftCharacterScope(oldAvatar: string, newAvatar: string): void {
    if (!oldAvatar || !newAvatar || oldAvatar === newAvatar) return;
    const state = _store.getState();
    const drafts = { ...state.drafts };
    const draftRevisions = { ...state.draftRevisions };
    let pendingSend = state.pendingSend;
    let changed = false;

    for (const [key, text] of Object.entries(state.drafts)) {
        let tuple: unknown;
        try {
            tuple = JSON.parse(key);
        } catch {
            continue;
        }
        if (
            !Array.isArray(tuple)
            || tuple.length !== 3
            || tuple[0] !== 'character'
            || tuple[1] !== oldAvatar
            || typeof tuple[2] !== 'string'
        ) continue;

        const nextKey = JSON.stringify(['character', newAvatar, tuple[2]]);
        drafts[nextKey] = text;
        delete drafts[key];
        draftRevisions[key] = (draftRevisions[key] ?? 0) + 1;
        draftRevisions[nextKey] = (draftRevisions[nextKey] ?? 0) + 1;
        if (
            pendingSend?.chatKey === key
            && pendingSend.draftRevision === (state.draftRevisions[key] ?? 0)
            && pendingSend.text === state.drafts[key]
        ) {
            pendingSend = {
                ...pendingSend,
                chatKey: nextKey,
                draftRevision: draftRevisions[nextKey],
            };
        }
        changed = true;
    }

    if (changed) _store.setState({ ...state, drafts, draftRevisions, pendingSend });
}

/**
 * Clear exactly the text that was submitted from exactly the chat it belonged
 * to. If the user has since replaced that draft, the newer text wins.
 */
export function clearComposerDraftIfMatches(token: ComposerSendToken): boolean {
    const state = _store.getState();
    const pending = state.pendingSend;
    if (_resetRequested) return false;
    if (!pending || pending.id !== token.id) return false;
    if (pending.lifecycleEpoch !== state.lifecycleEpoch || pending.lifecycleEpoch !== getHostOperationEpoch()) return false;
    const key = _chatKey(pending.chatKey);
    if (pending.draftRevision !== (state.draftRevisions[key] ?? 0)) return false;
    if ((state.drafts[key] ?? '') !== pending.text) return false;
    if (!(key in state.drafts)) return true;

    const drafts = { ...state.drafts };
    delete drafts[key];
    _store.setState({
        ...state,
        drafts,
        draftRevisions: {
            ...state.draftRevisions,
            [key]: (state.draftRevisions[key] ?? 0) + 1,
        },
    });
    return true;
}

/** Globally serialize composer sends across chat switches and UI unmounts. */
export function beginComposerSend(chatKey: string, text: string): ComposerSendToken | null {
    const state = _store.getState();
    if (state.pendingSend) return null;
    if (state.lifecycleEpoch !== getHostOperationEpoch()) return null;

    const key = _chatKey(chatKey);
    const token: ComposerSendToken = {
        id: ++_nextSendId,
        chatKey: key,
        text: typeof text === 'string' ? text : '',
        draftRevision: state.draftRevisions[key] ?? 0,
        lifecycleEpoch: state.lifecycleEpoch,
    };
    _store.setState({ ...state, pendingSend: token });
    return token;
}

/** Release only the send operation that owns the current gate. */
export function finishComposerSend(token: ComposerSendToken): boolean {
    const state = _store.getState();
    if (state.pendingSend?.id !== token.id) return false;
    if (_resetRequested) {
        _resetRequested = false;
        _store.setState({
            drafts: {},
            draftRevisions: {},
            pendingSend: null,
            lifecycleEpoch: getHostOperationEpoch(),
        });
        return true;
    }
    if (state.pendingSend.lifecycleEpoch !== token.lifecycleEpoch) return false;
    if (token.lifecycleEpoch !== state.lifecycleEpoch || token.lifecycleEpoch !== getHostOperationEpoch()) return false;
    _store.setState({ ...state, pendingSend: null });
    return true;
}

export function subscribeComposerDraftStore(onStoreChange: () => void): () => void {
    return _store.subscribe(() => onStoreChange());
}

/** Reset ephemeral UI state on full ChatUI teardown, not on settings toggles. */
export function resetComposerDraftStore(): void {
    const lifecycleEpoch = resetHostOperationQueueLifecycle();
    const state = _store.getState();
    if (state.pendingSend) {
        // Keep the global gate closed until the already-started submit closure
        // reaches its finally block. This prevents disable/re-enable from opening
        // a second send while ST is still processing the first one.
        _resetRequested = true;
        _store.setState({ ...state, lifecycleEpoch });
        return;
    }
    _resetRequested = false;
    _store.setState({ drafts: {}, draftRevisions: {}, pendingSend: null, lifecycleEpoch });
}
