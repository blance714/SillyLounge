/**
 * SillyTavern-ChatUI · toast store
 *
 * Tiny ChatUI-owned feedback store. Holds transient toast notifications so the
 * UI can surface success/error/info without leaning on SillyTavern's global
 * toastr or the console. Pure data + timers; no dependencies.
 */

import { createStore } from './create-store.js';

export type ChatuiToast = {
    id: string;
    kind: 'info' | 'success' | 'error';
    text: string;
};

const _initialToasts: ChatuiToast[] = [];

const _store = createStore<ChatuiToast[]>(_initialToasts);

/** @type {number} */
let _seq = 0;

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const _timers = new Map();

/**
 * @returns {Array<ChatuiToast>}
 */
export function getToasts() {
    return _store.getState();
}

/**
 * @param {(toasts: Array<ChatuiToast>) => void} subscriber
 * @returns {() => void}
 */
export function subscribeToasts(subscriber: (toasts: ChatuiToast[]) => void) {
    return _store.subscribe(subscriber);
}

/**
 * Push a toast. Auto-dismisses after ttl ms (0 = sticky).
 *
 * @param {'info'|'success'|'error'} kind
 * @param {string} text
 * @param {number} [ttl=4000]
 * @returns {string} the toast id
 */
export function pushToast(kind: ChatuiToast['kind'], text: string, ttl = 4000) {
    const id = `toast-${_seq++}`;
    _store.setState([...getToasts(), { id, kind, text }]);

    if (ttl > 0) {
        _timers.set(id, setTimeout(() => dismissToast(id), ttl));
    }
    return id;
}

/**
 * @param {string} id
 * @returns {void}
 */
export function dismissToast(id: string) {
    const timer = _timers.get(id);
    if (timer) {
        clearTimeout(timer);
        _timers.delete(id);
    }
    _store.setState(getToasts().filter(toast => toast.id !== id));
}

/**
 * @returns {void}
 */
export function clearToasts() {
    for (const timer of _timers.values()) {
        clearTimeout(timer);
    }
    _timers.clear();
    _store.setState([]);
}
