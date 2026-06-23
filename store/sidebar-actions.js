/**
 * SillyTavern-ChatUI · sidebar actions
 *
 * Store-facing facade for the navigation sidebar (Region 5). UI modules dispatch
 * sidebar intents here instead of reaching into the adapter or ST internals.
 */

import { chatuiAdapter } from '../adapter/st-adapter.js';
import { getSidebarState, subscribeSidebarStore } from './sidebar-store.js';
import { pushToast } from './toast-store.js';

/**
 * @returns {ReturnType<typeof getSidebarState>}
 */
export function getChatuiSidebarState() {
    return getSidebarState();
}

/**
 * @param {Function} cb
 * @returns {() => void}
 */
export function subscribeChatuiSidebar(cb) {
    return subscribeSidebarStore(cb);
}

/**
 * Open one of the current character's past chats. ST fires CHAT_CHANGED on
 * success, which the sidebar store is subscribed to (auto-refresh).
 * @param {string} fileName
 * @returns {Promise<void>}
 */
export async function openChatuiChat(fileName) {
    try {
        await chatuiAdapter.sidebarActions.openCharacterChatByName(fileName);
    } catch (error) {
        console.error('[ChatUI] open chat failed', error);
        pushToast('error', '打开对话失败');
    }
}

/**
 * Create a new chat for the current character.
 * @returns {Promise<void>}
 */
export async function newChatuiChat() {
    try {
        await chatuiAdapter.sidebarActions.newCharacterChat();
        pushToast('success', '已新建对话');
    } catch (error) {
        console.error('[ChatUI] new chat failed', error);
        pushToast('error', '新建对话失败');
    }
}
