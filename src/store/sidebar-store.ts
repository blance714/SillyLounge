/**
 * SillyTavern-ChatUI · sidebar compatibility store
 *
 * Sidebar server-state now lives in the bundled ui/ React Query layer. This raw
 * store file remains only for bootstrap/back-compat imports; it must not own
 * chat-list cache, load tokens, manual cancellation, or ST event subscriptions.
 */

import { createStore } from './create-store.js';

export type ChatuiSidebarCompatState = {
    header: {
        sessionName: string;
        characterName: string;
        avatarImgURL: string;
        isGroup: boolean;
    };
    characters: unknown[];
    chats: unknown[];
    loading: boolean;
    error: string | null;
    charGroups: unknown[];
    charGroupsLoading: boolean;
    charGroupsError: string | null;
};

const _initialState: ChatuiSidebarCompatState = {
    header: { sessionName: '', characterName: '', avatarImgURL: '', isGroup: false },
    characters: [],
    chats: [],
    loading: false,
    error: null,
    charGroups: [],
    charGroupsLoading: false,
    charGroupsError: null,
};

const _store = createStore<ChatuiSidebarCompatState>(_initialState);

/**
 * @returns {typeof _initialState}
 */
export function getSidebarState(): ChatuiSidebarCompatState {
    return _store.getState();
}

/**
 * @param {Function} subscriber
 * @returns {() => void}
 */
export function subscribeSidebarStore(subscriber: (state: ChatuiSidebarCompatState) => void) {
    return _store.subscribe(subscriber);
}

/**
 * @returns {void}
 */
export function initSidebarStore() {
    _store.setState(_initialState);
}

/**
 * @returns {void}
 */
export function teardownSidebarStore() {
    _store.setState(_initialState);
}
