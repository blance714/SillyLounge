/**
 * SillyTavern-ChatUI · toast store
 *
 * Tiny ChatUI-owned feedback store. Holds transient toast notifications so the
 * UI can surface success/error/info without leaning on SillyTavern's global
 * toastr or the console. Pure data + timers; no dependencies.
 */

/**
 * @typedef {object} ChatuiToast
 * @property {string} id
 * @property {'info'|'success'|'error'} kind
 * @property {string} text
 */

/** @type {Array<ChatuiToast>} */
let _toasts = [];

/** @type {number} */
let _seq = 0;

/** @type {Set<(toasts: Array<ChatuiToast>) => void>} */
const _subscribers = new Set();

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const _timers = new Map();

/**
 * @returns {void}
 */
function _emit() {
    for (const subscriber of _subscribers) {
        subscriber(_toasts);
    }
}

/**
 * @returns {Array<ChatuiToast>}
 */
export function getToasts() {
    return _toasts;
}

/**
 * @param {(toasts: Array<ChatuiToast>) => void} subscriber
 * @returns {() => void}
 */
export function subscribeToasts(subscriber) {
    _subscribers.add(subscriber);
    return () => _subscribers.delete(subscriber);
}

/**
 * Push a toast. Auto-dismisses after ttl ms (0 = sticky).
 *
 * @param {'info'|'success'|'error'} kind
 * @param {string} text
 * @param {number} [ttl=4000]
 * @returns {string} the toast id
 */
export function pushToast(kind, text, ttl = 4000) {
    const id = `toast-${_seq++}`;
    _toasts = [..._toasts, { id, kind, text }];
    _emit();

    if (ttl > 0) {
        _timers.set(id, setTimeout(() => dismissToast(id), ttl));
    }
    return id;
}

/**
 * @param {string} id
 * @returns {void}
 */
export function dismissToast(id) {
    const timer = _timers.get(id);
    if (timer) {
        clearTimeout(timer);
        _timers.delete(id);
    }
    _toasts = _toasts.filter(toast => toast.id !== id);
    _emit();
}

/**
 * @returns {void}
 */
export function clearToasts() {
    for (const timer of _timers.values()) {
        clearTimeout(timer);
    }
    _timers.clear();
    _toasts = [];
    _emit();
}
