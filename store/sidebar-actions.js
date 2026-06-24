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
 * Switch the active character by stable avatar. ST fires CHAT_CHANGED on
 * success → sidebar auto-refresh; toast on a failed/no-op switch.
 * @param {string} avatar
 * @returns {Promise<void>}
 */
export async function switchChatuiCharacter(avatar) {
    try {
        const result = await chatuiAdapter.sidebarActions.switchCharacter(avatar);
        if (result === 'notfound') pushToast('error', '切换角色失败');
        else if (result === 'busy') pushToast('info', '正在保存或生成，请稍候');
    } catch (error) {
        console.error('[ChatUI] switch character failed', error);
        pushToast('error', '切换角色失败');
    }
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
 * Rename one of the current character's chats. No success toast — ST shows its
 * own error popup on failure and the list refreshes via CHAT_RENAMED.
 * @param {string} oldFileName
 * @param {string} newName
 * @returns {Promise<void>}
 */
export async function renameChatuiChat(oldFileName, newName) {
    try {
        const ok = await chatuiAdapter.sidebarActions.renameCharacterChat(oldFileName, newName);
        if (!ok) pushToast('error', '重命名失败');
    } catch (error) {
        console.error('[ChatUI] rename chat failed', error);
        pushToast('error', '重命名失败');
    }
}

/**
 * Delete one of a character's chats (caller confirms first via ChatUI dialog).
 * @param {string} avatar
 * @param {string} fileName
 * @returns {Promise<void>}
 */
export async function deleteChatuiChat(avatar, fileName) {
    try {
        const ok = await chatuiAdapter.sidebarActions.deleteCharacterChat(avatar, fileName);
        pushToast(ok ? 'success' : 'error', ok ? '已删除对话' : '删除失败');
    } catch (error) {
        console.error('[ChatUI] delete chat failed', error);
        pushToast('error', '删除失败');
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
