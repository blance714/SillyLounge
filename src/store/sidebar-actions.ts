/**
 * SillyTavern-ChatUI · sidebar actions
 *
 * UI-facing facade for sidebar intents and adapter reads. TanStack Query lives
 * in ui/; this raw-loaded module exposes adapter-backed query functions without
 * importing React Query or owning server-state cache.
 */

import { chatuiAdapter } from '../adapter/st-adapter.js';
import {
    beginTempChatDraft,
    cancelTempChatDraft,
    cancelTempChatDraftIfMatches,
    clearTempChatIfMatches,
    commitTempChatDraft,
    getTempChatDraft,
    getTempChatDraftSnapshot,
    getTempChatSnapshot,
    moveTempChatIfMatches,
} from './temp-chat-store.js';
import type { TempChatDraftSnapshot, TempChatPointerSnapshot } from './temp-chat-store.js';
import { createCharacterChatKey, createConversationLocator } from '../adapter/chat-key.js';
import { deleteComposerDraft, moveComposerDraft } from './composer-draft-store.js';
import {
    enqueueHostTask,
    enqueueLatestNavigation,
    sealHostOperationQueueForReload,
    waitForHostOperationsIdle,
} from './host-operation-queue.js';
import { pushToast } from './toast-store.js';

type ChatIdentity = { avatar: string; fileName: string } | null | undefined;
type RecentRowsOptions = { max?: number; signal?: AbortSignal };
type CharacterChatsOptions = { limit?: number | null; signal?: AbortSignal };

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
export function listChatuiRecentCharacterChatRows(options?: RecentRowsOptions) {
    return chatuiAdapter.sidebarActions.listRecentCharacterChatRows(options);
}

/**
 * @param {string} avatar
 * @param {{ limit?: number|null, signal?: AbortSignal }} [options]
 * @returns {ReturnType<typeof chatuiAdapter.sidebarActions.listChatsForCharacterAvatar>}
 */
export function listChatuiChatsForCharacterAvatar(avatar: string, options?: CharacterChatsOptions) {
    return chatuiAdapter.sidebarActions.listChatsForCharacterAvatar(avatar, options);
}

function _sameChatIdentity(a: ChatIdentity, b: ChatIdentity) {
    return !!a && !!b && a.avatar === b.avatar && a.fileName === b.fileName;
}

/** Deterministic completion boundary for focused store/action tests. */
export function waitForChatuiSidebarActionsIdle(): Promise<void> {
    return waitForHostOperationsIdle();
}

function _captureDraftIntent(avatar: string): TempChatDraftSnapshot {
    const existing = getTempChatDraftSnapshot();
    if (existing.draft?.avatar === avatar) {
        return beginTempChatDraft({
            avatar,
            knownFileNames: existing.draft.knownFileNames,
            complete: existing.draft.complete,
        });
    }
    return beginTempChatDraft({ avatar });
}

async function _createTempDraft(avatar: string, draftIntent: TempChatDraftSnapshot) {
    const current = chatuiAdapter.getCurrentChatIdentity();
    if (!current || current.avatar !== avatar) {
        cancelTempChatDraftIfMatches(draftIntent);
        return;
    }

    const old = getTempChatSnapshot();
    if (_sameChatIdentity(old.pointer, current)) {
        cancelTempChatDraftIfMatches(draftIntent);
        return;
    }

    try {
        await chatuiAdapter.sidebarActions.newCharacterChat();
        const created = chatuiAdapter.getCurrentChatIdentity();
        if (!created || created.avatar !== avatar) {
            cancelTempChatDraftIfMatches(draftIntent);
            return;
        }

        // Transfer ownership only if the concrete pointer is still the version
        // captured before ST created this chat. An older operation must never
        // overwrite a newer pointer; the unadopted file simply remains a normal
        // visible conversation.
        if (getTempChatSnapshot().version !== old.version) {
            cancelTempChatDraftIfMatches(draftIntent);
            return;
        }
        commitTempChatDraft(created, draftIntent);
    } catch (error) {
        cancelTempChatDraftIfMatches(draftIntent);
        throw error;
    }
}

function _releaseAbandonedTempChat(snapshot: TempChatPointerSnapshot) {
    const ptr = snapshot.pointer;
    if (!ptr) return;

    const current = chatuiAdapter.getCurrentChatIdentity();
    if (current && _sameChatIdentity(ptr, current)) return;
    // Releasing temp ownership never deletes the file. The abandoned draft is
    // retained as an ordinary conversation and the version CAS protects a newer
    // pointer from stale navigation completion.
    clearTempChatIfMatches(snapshot);
}

/**
 * Switch the active character by stable avatar.
 * @param {string} avatar
 * @returns {Promise<void>}
 */
export function switchChatuiCharacter(avatar: string): Promise<void> {
    if (getTempChatDraft()) cancelTempChatDraft();
    const tempSnapshot = getTempChatSnapshot();
    return enqueueLatestNavigation(async (operation) => {
        try {
            const result = await chatuiAdapter.sidebarActions.switchCharacter(avatar);
            if (result === 'notfound') {
                if (operation.isLatest()) pushToast('error', '切换角色失败');
            } else if (result === 'busy') {
                if (operation.isLatest()) pushToast('info', '正在保存或生成，请稍候');
            } else {
                _releaseAbandonedTempChat(tempSnapshot);
            }
        } catch (error) {
            console.error('[ChatUI] switch character failed', error);
            if (operation.isLatest()) pushToast('error', '切换角色失败');
        }
    });
}

/**
 * Open one of the current character's past chats.
 * @param {string} fileName
 * @returns {Promise<void>}
 */
export function openChatuiChat(fileName: string): Promise<void> {
    if (getTempChatDraft()) cancelTempChatDraft();
    const tempSnapshot = getTempChatSnapshot();
    return enqueueLatestNavigation(async (operation) => {
        try {
            await chatuiAdapter.sidebarActions.openCharacterChatByName(fileName);
            _releaseAbandonedTempChat(tempSnapshot);
        } catch (error) {
            console.error('[ChatUI] open chat failed', error);
            if (operation.isLatest()) pushToast('error', '打开对话失败');
        }
    });
}

/**
 * Rename one of the current character's chats.
 * @param {string} oldFileName
 * @param {string} newName
 * @returns {Promise<void>}
 */
export function renameChatuiChat(oldFileName: string, newName: string): Promise<void> {
    const expectedAvatar = chatuiAdapter.getCurrentChatIdentity()?.avatar ?? null;
    const tempSnapshot = getTempChatSnapshot();
    return enqueueHostTask(async () => {
        try {
            if (!expectedAvatar || chatuiAdapter.getCurrentChatIdentity()?.avatar !== expectedAvatar) {
                pushToast('info', '对话已切换，请重试');
                return;
            }
            const result = await chatuiAdapter.sidebarActions.renameCharacterChat(
                expectedAvatar,
                oldFileName,
                newName,
            );
            if (result.reloadRequired) {
                // The durable pointer names a real winning chat, but the active
                // message buffer still belongs to the vanished/other filename.
                // No queued mutation may run before ST rebuilds them together.
                sealHostOperationQueueForReload();
                window.location.reload();
                return;
            }
            if (!result.renamed) {
                pushToast('error', result.uncertain
                    ? '无法确认重命名结果；请刷新页面后再操作'
                    : '重命名失败');
                return;
            }
            if (result.reconciled) {
                moveComposerDraft(result.oldChatKey, result.newChatKey);
                if (_sameChatIdentity(tempSnapshot.pointer, {
                    avatar: result.avatar,
                    fileName: result.oldFileName,
                })) {
                    moveTempChatIfMatches(tempSnapshot, {
                        avatar: result.avatar,
                        fileName: result.newFileName,
                    });
                }
            }
            if (result.uncertain) {
                pushToast('error', result.reconciled
                    ? '重命名检测到双文件冲突；已保留草稿，请刷新检查对话列表'
                    : '重命名后的文件与角色指针未能安全对齐；请刷新检查对话列表');
            } else if (!result.reconciled) {
                pushToast('error', '文件已重命名，但角色对话指针同步失败；请刷新页面');
            }
        } catch (error) {
            console.error('[ChatUI] rename chat failed', error);
            pushToast('error', '重命名失败');
        }
    });
}

/**
 * Delete one of a character's chats.
 * @param {string} avatar
 * @param {string} fileName
 * @returns {Promise<void>}
 */
export function deleteChatuiChat(avatar: string, fileName: string): Promise<void> {
    return enqueueHostTask(async () => {
        const snapshot = getTempChatSnapshot();
        try {
            const result = await chatuiAdapter.sidebarActions.deleteCharacterChat(avatar, fileName);
            if (result.deleted) {
                deleteComposerDraft(createCharacterChatKey(avatar, createConversationLocator(fileName)));
                if (_sameChatIdentity(snapshot.pointer, { avatar, fileName })) {
                    clearTempChatIfMatches(snapshot);
                }
            }
            if (result.reloadRequired) {
                // The adapter deliberately leaves current-chat live state
                // untouched after deletion. Reload immediately from its checked
                // durable replacement pointer; do not let another queued host
                // mutation run against the deleted in-memory conversation.
                sealHostOperationQueueForReload();
                if (result.deleted) {
                    chatuiAdapter.sidebarActions.queueCurrentCharacterChatDeletionFinalization(avatar, fileName);
                }
                window.location.reload();
            } else if (result.uncertain) {
                pushToast('error', '无法确认删除结果，请刷新对话列表');
            } else if (!result.reconciled) {
                pushToast('error', result.deleted
                    ? '对话已删除，但角色指针同步失败；请刷新页面'
                    : '删除失败，且角色指针未能恢复；请刷新页面');
            } else if (!result.deleted) {
                pushToast('error', '删除失败');
            } else {
                pushToast('success', '已删除对话');
            }
        } catch (error) {
            console.error('[ChatUI] delete chat failed', error);
            pushToast('error', '删除失败');
        }
    });
}

/**
 * Create a new chat for the current character.
 * @returns {Promise<void>}
 */
export function newChatuiChat(): Promise<void> {
    const current = chatuiAdapter.getCurrentChatIdentity();
    if (!current) {
        cancelTempChatDraft();
        return Promise.resolve();
    }
    const draftIntent = _captureDraftIntent(current.avatar);
    return enqueueLatestNavigation(async (operation) => {
        try {
            await _createTempDraft(current.avatar, draftIntent);
        } catch (error) {
            console.error('[ChatUI] new chat failed', error);
            cancelTempChatDraftIfMatches(draftIntent);
            if (operation.isLatest()) pushToast('error', '新建对话失败');
        }
    }, () => cancelTempChatDraftIfMatches(draftIntent));
}

/**
 * Switch to a character and create a new empty chat for them.
 * @param {string} avatar Stable character avatar.
 * @returns {Promise<void>}
 */
export function switchChatuiCharacterAndNewChat(avatar: string): Promise<void> {
    const draftIntent = _captureDraftIntent(avatar);
    return enqueueLatestNavigation(async (operation) => {
        try {
            const result = await chatuiAdapter.sidebarActions.switchCharacter(avatar);
            if (result === 'notfound') {
                cancelTempChatDraftIfMatches(draftIntent);
                if (operation.isLatest()) pushToast('error', '切换角色失败');
                return;
            }
            if (result === 'busy') {
                cancelTempChatDraftIfMatches(draftIntent);
                if (operation.isLatest()) pushToast('info', '正在保存或生成，请稍候');
                return;
            }

            await _createTempDraft(avatar, draftIntent);
        } catch (error) {
            console.error('[ChatUI] switchChatuiCharacterAndNewChat failed', error);
            cancelTempChatDraftIfMatches(draftIntent);
            if (operation.isLatest()) pushToast('error', '操作失败');
        }
    }, () => cancelTempChatDraftIfMatches(draftIntent));
}

/**
 * Open a specific past chat, switching character if necessary.
 * @param {string} avatar Stable character avatar identifier.
 * @param {string} fileName Bare chat file name.
 * @returns {Promise<void>}
 */
export function openChatuiChatForCharacter(avatar: string, fileName: string): Promise<void> {
    if (getTempChatDraft()) cancelTempChatDraft();
    const tempSnapshot = getTempChatSnapshot();
    return enqueueLatestNavigation(async (operation) => {
        try {
            const result = await chatuiAdapter.sidebarActions.openChatForCharacter(avatar, fileName);
            if (result === 'notfound') {
                if (operation.isLatest()) pushToast('error', '角色或对话不存在');
            } else if (result === 'busy') {
                if (operation.isLatest()) pushToast('info', '正在保存或生成，请稍候');
            } else {
                _releaseAbandonedTempChat(tempSnapshot);
            }
        } catch (error) {
            console.error('[ChatUI] open chat for character failed', error);
            if (operation.isLatest()) pushToast('error', '打开对话失败');
        }
    });
}
