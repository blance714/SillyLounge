/**
 * SillyTavern-ChatUI · sidebar store
 *
 * View-model store for the navigation sidebar (Region 5). Slice 1 owns the
 * current character's conversation list (Mode A): a time-sorted chat list plus
 * the active-chat header. Mirrors chat-store.js: it talks only to the adapter,
 * emits plain DTOs, and knows nothing about ST selectors.
 */

import { chatuiAdapter, stEventKeys } from '../adapter/st-adapter.js';

/**
 * @typedef {object} ChatListItemDto
 * @property {string} fileName
 * @property {string} displayName
 * @property {number} messageCount
 * @property {string} preview
 * @property {number} lastMesTs
 * @property {string} lastMesLabel
 * @property {boolean} isCurrent
 */

/** @type {{ header: { sessionName: string, characterName: string, avatarImgURL: string, isGroup: boolean }, chats: Array<ChatListItemDto>, loading: boolean, error: string|null }} */
let _state = {
    header: { sessionName: '', characterName: '', avatarImgURL: '', isGroup: false },
    chats: [],
    loading: false,
    error: null,
};

/** @type {Set<Function>} */
const _subscribers = new Set();

/** @type {Array<() => void>} */
let _unsubscribers = [];

/** Monotonic token so an out-of-order async chat fetch can't clobber a newer one. */
let _loadToken = 0;

/**
 * @returns {typeof _state}
 */
export function getSidebarState() {
    return _state;
}

/**
 * @param {Function} subscriber
 * @returns {() => void}
 */
export function subscribeSidebarStore(subscriber) {
    _subscribers.add(subscriber);
    return () => _subscribers.delete(subscriber);
}

/**
 * @returns {void}
 */
function _emit() {
    for (const subscriber of _subscribers) {
        subscriber(_state);
    }
}

/**
 * Rebuild the active character/chat header from the adapter (synchronous).
 * @returns {void}
 */
function _refreshHeader() {
    _state = { ..._state, header: chatuiAdapter.sidebarActions.getCurrentChatHeader() };
}

/**
 * Fetch the current character's chats (async — getPastCharacterChats hits the
 * server). Guards loading/error and drops stale responses via _loadToken.
 * @returns {Promise<void>}
 */
export async function refreshSidebarChats() {
    const token = ++_loadToken;
    _state = { ..._state, loading: true, error: null };
    _emit();

    try {
        const chats = await chatuiAdapter.sidebarActions.listCharacterChats();
        if (token !== _loadToken) return;
        _state = { ..._state, chats, loading: false };
    } catch (error) {
        if (token !== _loadToken) return;
        console.error('[ChatUI] sidebar chat refresh failed', error);
        _state = { ..._state, chats: [], loading: false, error: 'load-failed' };
    }
    _emit();
}

/**
 * Refresh header (sync) + chats (async). The async fetch emits the new header
 * alongside its loading flag, so the header updates immediately.
 * @returns {void}
 */
export function refreshSidebarStore() {
    _refreshHeader();
    void refreshSidebarChats();
}

/**
 * @returns {void}
 */
export function initSidebarStore() {
    if (_unsubscribers.length) return;

    refreshSidebarStore();

    // CHAT_CHANGED fires mid-switch, so debounce to the next tick like chat-store.
    const refreshSoon = () => setTimeout(() => refreshSidebarStore(), 0);
    _unsubscribers = [
        chatuiAdapter.subscribe(stEventKeys.CHAT_CHANGED, refreshSoon),
        chatuiAdapter.subscribe(stEventKeys.CHAT_RENAMED, refreshSoon),
        chatuiAdapter.subscribe(stEventKeys.CHAT_DELETED, refreshSoon),
    ];
}

/**
 * @returns {void}
 */
export function teardownSidebarStore() {
    for (const unsubscribe of _unsubscribers) {
        unsubscribe();
    }
    _unsubscribers = [];
    _subscribers.clear();
}
