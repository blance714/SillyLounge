/**
 * SillyTavern-ChatUI · sidebar actions
 *
 * Store-facing facade for the navigation sidebar (Region 5). UI modules dispatch
 * sidebar intents here instead of reaching into the adapter or ST internals.
 */

import { chatuiAdapter } from '../adapter/st-adapter.js';
import { getSidebarState, refreshCharGroupForCharacter, refreshSidebarChats, setSidebarChatEventRefreshSuppressed, subscribeSidebarStore } from './sidebar-store.js';
import { clearTempChat, getTempChat, setTempChat } from './temp-chat-store.js';
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

function _sameChatIdentity(a, b) {
    return !!a && !!b && a.avatar === b.avatar && a.fileName === b.fileName;
}

let _draftInFlight = false;

async function _createTempDraft() {
    if (_draftInFlight) return;
    const current = chatuiAdapter.getCurrentChatIdentity();
    if (!current) return;
    const old = getTempChat();
    if (_sameChatIdentity(old, current)) return;

    _draftInFlight = true;
    try {
        let created = null;
        setSidebarChatEventRefreshSuppressed(true);
        try {
            await chatuiAdapter.sidebarActions.newCharacterChat();
            created = chatuiAdapter.getCurrentChatIdentity();
            if (created) setTempChat(created);
        } finally {
            setSidebarChatEventRefreshSuppressed(false);
        }
        await refreshSidebarChats();
        const currentAvatar = getSidebarState().characters.find(char => char.isCurrent)?.avatar;
        if (currentAvatar) await refreshCharGroupForCharacter(currentAvatar);
        if (old && created && !_sameChatIdentity(old, created)) {
            await chatuiAdapter.sidebarActions.deleteChatFileIfSafe(old.avatar, old.fileName);
            if (currentAvatar === old.avatar) await refreshSidebarChats();
            await refreshCharGroupForCharacter(old.avatar);
        }
    } finally {
        _draftInFlight = false;
    }
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
        if (ok) {
            const tempChat = getTempChat();
            if (tempChat?.avatar === avatar && tempChat?.fileName === fileName) clearTempChat();
            const currentAvatar = getSidebarState().characters.find(char => char.isCurrent)?.avatar;
            if (currentAvatar === avatar) await refreshSidebarChats();
            await refreshCharGroupForCharacter(avatar);
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
        pushToast('error', '新建对话失败');
    }
}

/**
 * Switch to the character identified by stable avatar, then immediately create
 * a new empty chat for them. Used by NewChatCharacterPicker for the "pick →
 * atomic switch + new chat" UX.
 *
 * If avatar is already the current character, skips the switch (avoiding a
 * redundant CHAT_CHANGED + getChat() round-trip) and only creates the new chat.
 *
 * No success toast — the blank new chat is its own visual confirmation.
 *
 * @param {string} avatar Stable character avatar (e.g. "char.png")
 * @returns {Promise<void>}
 */
export async function switchChatuiCharacterAndNewChat(avatar) {
    try {
        const result = await chatuiAdapter.sidebarActions.switchCharacter(avatar);
        if (result === 'notfound') { pushToast('error', '切换角色失败'); return; }
        if (result === 'busy')     { pushToast('info',  '正在保存或生成，请稍候'); return; }

        await _createTempDraft();
    } catch (error) {
        console.error('[ChatUI] switchChatuiCharacterAndNewChat failed', error);
        pushToast('error', '操作失败');
    }
}

/**
 * Open a specific past chat, switching character if necessary.
 * Works cross-character. ST fires CHAT_CHANGED on success → sidebar auto-refresh.
 * @param {string} avatar  Stable character avatar identifier
 * @param {string} fileName  Bare chat file name (no .jsonl)
 * @returns {Promise<void>}
 */
export async function openChatuiChatForCharacter(avatar, fileName) {
    try {
        const result = await chatuiAdapter.sidebarActions.openChatForCharacter(avatar, fileName);
        if (result === 'notfound') pushToast('error', '角色或对话不存在');
        else if (result === 'busy') pushToast('info', '正在保存或生成，请稍候');
        // 'ok' and 'already-open' are otherwise silent
    } catch (error) {
        console.error('[ChatUI] open chat for character failed', error);
        pushToast('error', '打开对话失败');
    }
}
