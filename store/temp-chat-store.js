/**
 * SillyTavern-ChatUI · temp chat pointer store
 *
 * Tracks the single live new-chat draft by stable { avatar, fileName } identity.
 * This store intentionally has no ST imports; adapter/ owns all runtime access.
 */

import { createStore } from './create-store.js';

const TEMP_CHAT_STORAGE_KEY = 'chatui:tempChat';

/**
 * @typedef {{ avatar: string, fileName: string }} TempChatPointer
 */

/** @type {{ tempChat: TempChatPointer|null }} */
const _initialState = {
    tempChat: null,
};

const _store = createStore(_initialState);

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
function _normalizePointer(value) {
    const entry = /** @type {Record<string, unknown>|null} */ (value && typeof value === 'object' ? value : null);
    const avatar = typeof entry?.avatar === 'string' ? entry.avatar : '';
    const fileName = typeof entry?.fileName === 'string' ? entry.fileName : '';
    return avatar && fileName ? { avatar, fileName } : null;
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
function _writeStoredPointer(ptr) {
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
 * @param {TempChatPointer|null} ptr
 * @returns {void}
 */
export function setTempChat(ptr) {
    const next = _normalizePointer(ptr);
    _writeStoredPointer(next);
    _store.setState({ tempChat: next });
}

/**
 * @returns {void}
 */
export function clearTempChat() {
    _writeStoredPointer(null);
    _store.setState({ tempChat: null });
}

/**
 * @param {string} avatar
 * @param {string} fileName
 * @returns {boolean}
 */
export function isTempChat(avatar, fileName) {
    const ptr = getTempChat();
    return !!ptr && ptr.avatar === avatar && ptr.fileName === fileName;
}

/**
 * @param {Function} cb
 * @returns {() => void}
 */
export function subscribeTempChatStore(cb) {
    return _store.subscribe(cb);
}

/**
 * Hydrate the pointer from localStorage. A stale pointer is harmless and is left
 * in place until user action replaces or clears it.
 * @returns {void}
 */
export function initTempChatStore() {
    _store.setState({ tempChat: _readStoredPointer() });
}
