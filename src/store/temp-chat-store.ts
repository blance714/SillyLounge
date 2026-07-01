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

export type TempChatDraft = {
    avatar: string;
    knownFileNames: string[];
    complete: boolean;
};

type TempChatState = {
    tempChat: TempChatPointer | null;
    optimisticDraft: TempChatDraft | null;
};

const _initialState: TempChatState = {
    tempChat: null,
    optimisticDraft: null,
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
 * Mark draft intent before ST has created the concrete chat file.
 * @param {{ avatar: string, knownFileNames?: string[], complete?: boolean }} draft
 * @returns {void}
 */
export function beginTempChatDraft(draft: { avatar: string; knownFileNames?: string[]; complete?: boolean }) {
    const avatar = typeof draft?.avatar === 'string' ? draft.avatar : '';
    if (!avatar) return;
    _store.setState({
        ..._store.getState(),
        optimisticDraft: {
            avatar,
            knownFileNames: _normalizeKnownFileNames(draft.knownFileNames),
            complete: !!draft.complete,
        },
    });
}

/**
 * Drop an in-flight optimistic marker, preserving any known concrete temp chat.
 * @returns {void}
 */
export function cancelTempChatDraft() {
    _store.setState({
        ..._store.getState(),
        optimisticDraft: null,
    });
}

/**
 * @param {TempChatPointer|null} ptr
 * @returns {void}
 */
export function setTempChat(ptr: TempChatPointer | null) {
    const next = _normalizePointer(ptr);
    _writeStoredPointer(next);
    _store.setState({
        tempChat: next,
        optimisticDraft: null,
    });
}

/**
 * @returns {void}
 */
export function clearTempChat() {
    _writeStoredPointer(null);
    _store.setState({ tempChat: null, optimisticDraft: null });
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
    _store.setState({
        tempChat,
        optimisticDraft: null,
    });
}
