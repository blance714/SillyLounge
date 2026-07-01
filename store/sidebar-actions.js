/**
 * SillyTavern-ChatUI · sidebar actions
 *
 * UI-facing facade for sidebar intents and adapter reads. TanStack Query lives
 * in ui/; this raw-loaded module exposes adapter-backed query functions without
 * importing React Query or owning server-state cache.
 */

import { chatuiAdapter } from '../adapter/st-adapter.js';
import { getSidebarState, subscribeSidebarStore } from './sidebar-store.js';
import {
    beginTempChatDraft,
    cancelTempChatDraft,
    clearTempChat,
    getTempChat,
    getTempChatDraft,
    setTempChat,
} from './temp-chat-store.js';
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
 * @returns {ReturnType<typeof chatuiAdapter.sidebarActions.getCurrentChatHeader>}
 */
export function getChatuiCurrentChatHeader() {
    return chatuiAdapter.sidebarActions.getCurrentChatHeader();
}

/**
 * @returns {ReturnType<typeof chatuiAdapter.sidebarActions.listCharacters>}
 */
export function listChatuiCharacters() {
    return chatuiAdapter.sidebarActions.listCharacters();
}

/**
 * @param {{ max?: number, signal?: AbortSignal }} [options]
 * @returns {ReturnType<typeof chatuiAdapter.sidebarActions.listRecentCharacterChatRows>}
 */
export function listChatuiRecentCharacterChatRows(options) {
    return chatuiAdapter.sidebarActions.listRecentCharacterChatRows(options);
}

/**
 * @param {string} avatar
 * @param {{ limit?: number|null, signal?: AbortSignal }} [options]
 * @returns {ReturnType<typeof chatuiAdapter.sidebarActions.listChatsForCharacterAvatar>}
 */
export function listChatuiChatsForCharacterAvatar(avatar, options) {
    return chatuiAdapter.sidebarActions.listChatsForCharacterAvatar(avatar, options);
}

function _sameChatIdentity(a, b) {
    return !!a && !!b && a.avatar === b.avatar && a.fileName === b.fileName;
}

let _draftInFlight = false;

async function _createTempDraft() {
    if (_draftInFlight) return;

    const current = chatuiAdapter.getCurrentChatIdentity();
    if (!current) {
        cancelTempChatDraft();
        return;
    }

    const old = getTempChat();
    if (_sameChatIdentity(old, current)) return;

    _draftInFlight = true;
    const existingDraft = getTempChatDraft();
    if (existingDraft?.avatar !== current.avatar) {
        beginTempChatDraft({ avatar: current.avatar });
    }
    try {
        await chatuiAdapter.sidebarActions.newCharacterChat();
        const created = chatuiAdapter.getCurrentChatIdentity();
        if (!created) {
            cancelTempChatDraft();
            return;
        }

        setTempChat(created);

        if (old && !_sameChatIdentity(old, created)) {
            await chatuiAdapter.sidebarActions.deleteChatFileIfSafe(old.avatar, old.fileName);
        }
    } catch (error) {
        cancelTempChatDraft();
        throw error;
    } finally {
        _draftInFlight = false;
    }
}

async function _gcAbandonedTempChat() {
    if (_draftInFlight) return;
    const ptr = getTempChat();
    if (!ptr) return;

    const current = chatuiAdapter.getCurrentChatIdentity();
    if (current && _sameChatIdentity(ptr, current)) return;

    try {
        await chatuiAdapter.sidebarActions.deleteChatFileIfSafe(ptr.avatar, ptr.fileName);
    } catch (error) {
        console.error('[ChatUI] abandoned temp-chat GC failed', error);
    } finally {
        clearTempChat();
    }
}

/**
 * Switch the active character by stable avatar.
 * @param {string} avatar
 * @returns {Promise<void>}
 */
export async function switchChatuiCharacter(avatar) {
    try {
        const result = await chatuiAdapter.sidebarActions.switchCharacter(avatar);
        if (result === 'notfound') pushToast('error', '切换角色失败');
        else if (result === 'busy') pushToast('info', '正在保存或生成，请稍候');
        else await _gcAbandonedTempChat();
    } catch (error) {
        console.error('[ChatUI] switch character failed', error);
        pushToast('error', '切换角色失败');
    }
}

/**
 * Open one of the current character's past chats.
 * @param {string} fileName
 * @returns {Promise<void>}
 */
export async function openChatuiChat(fileName) {
    try {
        await chatuiAdapter.sidebarActions.openCharacterChatByName(fileName);
        await _gcAbandonedTempChat();
    } catch (error) {
        console.error('[ChatUI] open chat failed', error);
        pushToast('error', '打开对话失败');
    }
}

/**
 * Rename one of the current character's chats.
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
 * Delete one of a character's chats.
 * @param {string} avatar
 * @param {string} fileName
 * @returns {Promise<void>}
 */
export async function deleteChatuiChat(avatar, fileName) {
    try {
        const ok = await chatuiAdapter.sidebarActions.deleteCharacterChat(avatar, fileName);
        if (ok) {
            const tempChat = getTempChat();
            if (tempChat?.avatar === avatar && tempChat?.fileName === fileName) clearTempChat();
        }
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
        await _createTempDraft();
    } catch (error) {
        console.error('[ChatUI] new chat failed', error);
        cancelTempChatDraft();
        pushToast('error', '新建对话失败');
    }
}

/**
 * Switch to a character and create a new empty chat for them.
 * @param {string} avatar Stable character avatar.
 * @returns {Promise<void>}
 */
export async function switchChatuiCharacterAndNewChat(avatar) {
    try {
        const result = await chatuiAdapter.sidebarActions.switchCharacter(avatar);
        if (result === 'notfound') { cancelTempChatDraft(); pushToast('error', '切换角色失败'); return; }
        if (result === 'busy')     { cancelTempChatDraft(); pushToast('info',  '正在保存或生成，请稍候'); return; }

        await _createTempDraft();
    } catch (error) {
        console.error('[ChatUI] switchChatuiCharacterAndNewChat failed', error);
        cancelTempChatDraft();
        pushToast('error', '操作失败');
    }
}

/**
 * Open a specific past chat, switching character if necessary.
 * @param {string} avatar Stable character avatar identifier.
 * @param {string} fileName Bare chat file name.
 * @returns {Promise<void>}
 */
export async function openChatuiChatForCharacter(avatar, fileName) {
    try {
        const result = await chatuiAdapter.sidebarActions.openChatForCharacter(avatar, fileName);
        if (result === 'notfound') pushToast('error', '角色或对话不存在');
        else if (result === 'busy') pushToast('info', '正在保存或生成，请稍候');
        else await _gcAbandonedTempChat();
    } catch (error) {
        console.error('[ChatUI] open chat for character failed', error);
        pushToast('error', '打开对话失败');
    }
}
