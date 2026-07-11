/**
 * SillyTavern-ChatUI · temp chat pointer store
 *
 * Tracks the single live new-chat draft. `tempChat` is the persisted concrete
 * { avatar, fileName } identity; `optimisticDraft` is an in-memory marker set
 * synchronously on click before SillyTavern creates the concrete chat file.
 * This store intentionally has no ST imports; adapter/ owns all runtime access.
 */

import { createStore } from './create-store.js';

const TEMP_CHAT_STORAGE_KEY = 'chatui:tempChat';

export type TempChatPointer = { avatar: string; fileName: string };

export type TempChatPointerSnapshot = Readonly<{
    pointer: TempChatPointer | null;
    version: number;
}>;

export type TempChatDraft = {
    avatar: string;
    knownFileNames: string[];
    complete: boolean;
};

export type TempChatDraftSnapshot = Readonly<{
    draft: TempChatDraft | null;
    version: number;
}>;

type TempChatState = {
    tempChat: TempChatPointer | null;
    pointerVersion: number;
    optimisticDraft: TempChatDraft | null;
    draftVersion: number;
};

const _initialState: TempChatState = {
    tempChat: null,
    pointerVersion: 0,
    optimisticDraft: null,
    draftVersion: 0,
};

const _store = createStore<TempChatState>(_initialState);

/**
 * @returns {Storage|null}
 */
function _storage() {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
        return null;
    }
}

/**
 * @param {unknown} value
 * @returns {TempChatPointer|null}
 */
function _normalizePointer(value: unknown): TempChatPointer | null {
    const entry = (value && typeof value === 'object' ? value : null) as Record<string, unknown> | null;
    const avatar = typeof entry?.avatar === 'string' ? entry.avatar : '';
    const fileName = _normalizeFileName(entry?.fileName);
    return avatar && fileName ? { avatar, fileName } : null;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function _normalizeFileName(value: unknown): string {
    return typeof value === 'string' ? value.replace(/\.jsonl$/i, '') : '';
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function _normalizeKnownFileNames(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    for (const item of value) {
        const fileName = _normalizeFileName(item);
        if (fileName) seen.add(fileName);
    }
    return Array.from(seen);
}

/**
 * @returns {TempChatPointer|null}
 */
function _readStoredPointer() {
    const storage = _storage();
    if (!storage) return null;

    try {
        const raw = storage.getItem(TEMP_CHAT_STORAGE_KEY);
        if (!raw) return null;
        return _normalizePointer(JSON.parse(raw));
    } catch {
        return null;
    }
}

/**
 * @param {TempChatPointer|null} ptr
 * @returns {void}
 */
function _writeStoredPointer(ptr: TempChatPointer | null): void {
    const storage = _storage();
    if (!storage) return;

    try {
        if (ptr) storage.setItem(TEMP_CHAT_STORAGE_KEY, JSON.stringify(ptr));
        else storage.removeItem(TEMP_CHAT_STORAGE_KEY);
    } catch {
        // Private browsing / quota failures should not break ChatUI navigation.
    }
}

/**
 * @returns {TempChatPointer|null}
 */
export function getTempChat() {
    return _store.getState().tempChat;
}

/**
 * @returns {TempChatDraft|null}
 */
export function getTempChatDraft() {
    return _store.getState().optimisticDraft;
}

/**
 * Capture the concrete pointer together with its mutation version. Async
 * cleanup must compare this snapshot before clearing: identity alone is not
 * enough because the same file can be cleared and adopted again (ABA).
 */
export function getTempChatSnapshot(): TempChatPointerSnapshot {
    const state = _store.getState();
    return {
        pointer: state.tempChat ? { ...state.tempChat } : null,
        version: state.pointerVersion,
    };
}

/** Capture an optimistic draft intent for compare-and-set completion. */
export function getTempChatDraftSnapshot(): TempChatDraftSnapshot {
    const state = _store.getState();
    return {
        draft: state.optimisticDraft
            ? { ...state.optimisticDraft, knownFileNames: [...state.optimisticDraft.knownFileNames] }
            : null,
        version: state.draftVersion,
    };
}

/**
 * Mark draft intent before ST has created the concrete chat file.
 * @param {{ avatar: string, knownFileNames?: string[], complete?: boolean }} draft
 * @returns {void}
 */
export function beginTempChatDraft(
    draft: { avatar: string; knownFileNames?: string[]; complete?: boolean },
): TempChatDraftSnapshot {
    const avatar = typeof draft?.avatar === 'string' ? draft.avatar : '';
    if (!avatar) return getTempChatDraftSnapshot();
    const state = _store.getState();
    _store.setState({
        ...state,
        optimisticDraft: {
            avatar,
            knownFileNames: _normalizeKnownFileNames(draft.knownFileNames),
            complete: !!draft.complete,
        },
        draftVersion: state.draftVersion + 1,
    });
    return getTempChatDraftSnapshot();
}

/**
 * Drop an in-flight optimistic marker, preserving any known concrete temp chat.
 * @returns {void}
 */
export function cancelTempChatDraft() {
    const state = _store.getState();
    _store.setState({
        ...state,
        optimisticDraft: null,
        draftVersion: state.draftVersion + 1,
    });
}

/**
 * Cancel only the optimistic intent captured by the caller. A slower request
 * must never cancel a newer click's marker.
 */
export function cancelTempChatDraftIfMatches(snapshot: TempChatDraftSnapshot): boolean {
    const state = _store.getState();
    if (state.draftVersion !== snapshot.version) return false;
    _store.setState({
        ...state,
        optimisticDraft: null,
        draftVersion: state.draftVersion + 1,
    });
    return true;
}

/**
 * @param {TempChatPointer|null} ptr
 * @returns {void}
 */
export function setTempChat(ptr: TempChatPointer | null) {
    const next = _normalizePointer(ptr);
    const state = _store.getState();
    _writeStoredPointer(next);
    _store.setState({
        tempChat: next,
        pointerVersion: state.pointerVersion + 1,
        optimisticDraft: null,
        draftVersion: state.draftVersion + 1,
    });
}

/**
 * Commit a concrete temp chat created for one captured optimistic intent.
 * The pointer is always recorded, but a newer optimistic marker is preserved
 * so an older completed request cannot erase the user's latest new-chat click.
 */
export function commitTempChatDraft(
    ptr: TempChatPointer,
    draftSnapshot: TempChatDraftSnapshot,
): boolean {
    const next = _normalizePointer(ptr);
    if (!next) return false;

    const state = _store.getState();
    const ownsDraft = state.draftVersion === draftSnapshot.version;
    _writeStoredPointer(next);
    _store.setState({
        tempChat: next,
        pointerVersion: state.pointerVersion + 1,
        optimisticDraft: ownsDraft ? null : state.optimisticDraft,
        draftVersion: ownsDraft ? state.draftVersion + 1 : state.draftVersion,
    });
    return true;
}

/** Clear the concrete pointer without erasing a newer optimistic intent. */
export function clearTempChat() {
    const state = _store.getState();
    _writeStoredPointer(null);
    _store.setState({
        ...state,
        tempChat: null,
        pointerVersion: state.pointerVersion + 1,
    });
}

/**
 * Clear a concrete pointer only if it is still the exact version captured by
 * the async caller. This is the destructive-cleanup CAS boundary.
 */
export function clearTempChatIfMatches(snapshot: TempChatPointerSnapshot): boolean {
    const state = _store.getState();
    if (state.pointerVersion !== snapshot.version) return false;
    _writeStoredPointer(null);
    _store.setState({
        ...state,
        tempChat: null,
        pointerVersion: state.pointerVersion + 1,
    });
    return true;
}

/** Rename exactly the temp pointer version captured before an async host call. */
export function moveTempChatIfMatches(
    snapshot: TempChatPointerSnapshot,
    next: TempChatPointer,
): boolean {
    const state = _store.getState();
    if (
        state.pointerVersion !== snapshot.version
        || state.tempChat?.avatar !== snapshot.pointer?.avatar
        || state.tempChat?.fileName !== snapshot.pointer?.fileName
    ) return false;
    if (!snapshot.pointer) return false;
    setTempChat(next);
    return true;
}

/**
 * @param {string} avatar
 * @param {string} fileName
 * @returns {boolean}
 */
export function isTempChat(avatar: string, fileName: string) {
    const ptr = getTempChat();
    return !!ptr && ptr.avatar === avatar && ptr.fileName === _normalizeFileName(fileName);
}

/**
 * Match either the concrete temp chat or any post-click chat file that was not
 * present in the sidebar when the optimistic draft began.
 * @param {string} avatar
 * @param {string} fileName
 * @returns {boolean}
 */
export function isTempChatDraft(avatar: string, fileName: string) {
    const normalized = _normalizeFileName(fileName);
    if (isTempChat(avatar, normalized)) return true;
    const ptr = getTempChat();
    if (ptr?.avatar === avatar) return false;

    const draft = getTempChatDraft();
    if (!draft || draft.avatar !== avatar) return false;
    return normalized !== '' && !draft.knownFileNames.includes(normalized);
}

/**
 * @param {Function} cb
 * @returns {() => void}
 */
export function subscribeTempChatStore(cb: (state: TempChatState) => void) {
    return _store.subscribe(cb);
}

/**
 * Hydrate the pointer from localStorage. A stale pointer is harmless and is left
 * in place until user action replaces or clears it.
 * @returns {void}
 */
export function initTempChatStore() {
    const tempChat = _readStoredPointer();
    const state = _store.getState();
    _store.setState({
        tempChat,
        pointerVersion: state.pointerVersion + 1,
        optimisticDraft: null,
        draftVersion: state.draftVersion + 1,
    });
}
