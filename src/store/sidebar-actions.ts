/**
 * SillyTavern-ChatUI · sidebar actions
 *
 * UI-facing facade for sidebar intents and adapter reads. TanStack Query lives
 * in ui/; this raw-loaded module exposes adapter-backed query functions without
 * importing React Query or owning server-state cache.
 */

import { chatuiAdapter } from '../adapter/st-adapter.js';
import { createCharacterChatKey, createConversationLocator } from '../adapter/chat-key.js';
import {
    deleteComposerDraft,
    moveComposerDraft,
} from './composer-draft-store.js';
import {
    enqueueHostTask,
    enqueueLatestNavigation,
    sealHostOperationQueueForReload,
    waitForHostOperationsIdle,
} from './host-operation-queue.js';
import { rememberCharacterConversation } from './session-characters.js';
import { pushToast } from './toast-store.js';
import { publishVanishedChat } from './vanished-chat-store.js';

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

/** Deterministic completion boundary for focused store/action tests. */
export function waitForChatuiSidebarActionsIdle(): Promise<void> {
    return waitForHostOperationsIdle();
}

/**
 * Ask ST for a new chat, and record who it was for.
 *
 * This used to be the head of the quarantine: it captured a draft intent, took
 * a snapshot of the lease slot, refused outright if the reader was already
 * sitting on an unadopted chat, and on success committed the concrete file into
 * a persisted lease set that decided what the playbill was allowed to show. All
 * of that existed to keep a new chat *out* of ordinary history; a new chat is
 * ordinary history now (DESIGN §4.2), so what is left is the host call and one
 * fact worth remembering — that this character has a conversation, whatever
 * ST's boot-time `chat_size` snapshot still says (store/session-characters.ts).
 */
async function _createChatForCharacter(avatar: string): Promise<void> {
    const current = chatuiAdapter.getCurrentChatIdentity();
    if (!current || current.avatar !== avatar) return;

    await chatuiAdapter.sidebarActions.newCharacterChat();
    const created = chatuiAdapter.getCurrentChatIdentity();
    if (created?.avatar === avatar) rememberCharacterConversation(avatar);
}

/**
 * Switch the active character by stable avatar.
 * @param {string} avatar
 * @returns {Promise<void>}
 */
export function switchChatuiCharacter(avatar: string): Promise<void> {
    return enqueueLatestNavigation(async (operation) => {
        try {
            const result = await chatuiAdapter.sidebarActions.switchCharacter(avatar);
            if (result === 'notfound') {
                if (operation.isLatest()) pushToast('error', '切换角色失败');
            } else if (result === 'busy') {
                if (operation.isLatest()) pushToast('info', '正在保存或生成，请稍候');
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
    return enqueueLatestNavigation(async (operation) => {
        try {
            const owner = chatuiAdapter.getCurrentChatIdentity()?.avatar;
            await chatuiAdapter.sidebarActions.openCharacterChatByName(fileName);
            const opened = chatuiAdapter.getCurrentChatIdentity();
            const expected = typeof fileName === 'string' ? fileName.replace(/\.jsonl$/i, '') : '';
            if (!owner || opened?.avatar !== owner || opened.fileName !== expected) {
                if (operation.isLatest()) pushToast('error', '打开对话失败');
                return;
            }
        } catch (error) {
            console.error('[ChatUI] open chat failed', error);
            if (operation.isLatest()) pushToast('error', '打开对话失败');
        }
    });
}

/**
 * The terminal reload a chat transaction requires, with ST's own settings
 * landed first.
 *
 * Sealing the host queue stops new ChatUI work; it does nothing about the
 * writes ST has *already* queued behind its shared `saveSettingsDebounced()`
 * timer, and reloading inside that 1000ms window drops them. One of those
 * writes is now load-bearing for exactly this reload: the persisted
 * `active_character` the character switch wrote (adapter/chats/navigation.ts's
 * persistStActiveCharacter) is what decides which character ST's boot comes
 * back on. Losing it lands the reader on some earlier character, holding a
 * conversation list that is not the one they just acted in.
 *
 * A failed flush must not cancel the reload: the reload is what makes the
 * runtime consistent with the durable pointer this transaction already moved,
 * and staying on a stale in-memory chat is strictly worse than reloading onto
 * the wrong character.
 *
 * @returns {Promise<void>}
 */
async function _reloadForChatTransaction(): Promise<void> {
    sealHostOperationQueueForReload();
    try {
        await chatuiAdapter.configActions.flushSettings();
    } catch (error) {
        console.error('[ChatUI] failed to flush ST settings before the mandatory reload', error);
    }
    window.location.reload();
}

/**
 * Rename one of a character's chats, named by stable avatar + file name.
 *
 * The target is explicit rather than "whatever is open", because the playbill
 * renames a card, and a card is a conversation on disk — not necessarily the
 * live one. The adapter is already written for both cases: it re-reads the
 * live identity when it runs and takes the current-chat protocol (save flush,
 * cancelled debounces, post-rename safety reconciliation) only if this really
 * is the open chat. That is also why the old "the open chat moved, try again"
 * bail is gone: it turned a still-valid intent (rename *that* file) into a
 * failure whenever a navigation landed between the click and the queue slot,
 * and the honest handling of that race is the adapter's non-current path.
 *
 * @param {string} avatar
 * @param {string} oldFileName
 * @param {string} newName
 * @returns {Promise<void>}
 */
export function renameChatuiChat(avatar: string, oldFileName: string, newName: string): Promise<void> {
    return enqueueHostTask(async () => {
        try {
            if (!avatar) {
                pushToast('error', '重命名失败');
                return;
            }
            const result = await chatuiAdapter.sidebarActions.renameCharacterChat(
                avatar,
                oldFileName,
                newName,
            );
            if (!result.renamed) {
                pushToast('error', result.uncertain
                    ? '无法确认重命名结果；请刷新页面后再操作'
                    : '重命名失败');
                return;
            }
            if (result.reconciled) {
                moveComposerDraft(result.oldChatKey, result.newChatKey);
            }
            if (result.reloadRequired) {
                await _reloadForChatTransaction();
                return;
            }
            if (result.uncertain) {
                pushToast('error', result.reconciled
                    ? '重命名检测到双文件冲突；请刷新检查对话列表'
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
        try {
            const result = await chatuiAdapter.sidebarActions.deleteCharacterChat(avatar, fileName);
            if (result.absent) {
                // The conversation exists nowhere — not in the host's listing,
                // and not as the chat the runtime is standing in (the adapter
                // withholds `absent` for that one on purpose). So the reader's
                // intent ("this conversation should not exist") is satisfied
                // and only ChatUI's own bookkeeping is left. Settle it exactly
                // as a real deletion would and say so plainly.
                //
                deleteComposerDraft(createCharacterChatKey(avatar, createConversationLocator(fileName)));
                // Nothing deleted means no CHAT_DELETED, and the sidebar's
                // cached listing still holds this file: without this the card
                // does not go away, it turns into an ordinary history row
                // pointing at nothing (vanished-chat-store.ts).
                publishVanishedChat(avatar, fileName);
                pushToast('info', '该对话已不存在，已移出列表');
                return;
            }
            if (result.deleted) {
                deleteComposerDraft(createCharacterChatKey(avatar, createConversationLocator(fileName)));
            }
            if (result.reloadRequired) {
                // The adapter deliberately leaves current-chat live state
                // untouched after deletion. Reload immediately from its checked
                // durable replacement pointer; do not let another queued host
                // mutation run against the deleted in-memory conversation.
                if (result.deleted) {
                    chatuiAdapter.sidebarActions.queueCurrentCharacterChatDeletionFinalization(avatar, fileName);
                }
                if (result.fallbackChatFileName) {
                    // This character's history is now empty: the durable
                    // pointer was moved to a name nothing has written yet, and
                    // ST's reload boot will materialize something there
                    // regardless (greeting or empty). Remember *who* across the
                    // reload, so the next boot can seat the reader back on this
                    // character rather than leaving them on an empty stage
                    // (DESIGN §3, evaluation §5 3.6).
                    chatuiAdapter.sidebarActions.queueCharacterChatLanding(avatar);
                }
                // Both tombstone writes above are synchronous sessionStorage
                // writes, so they are already durable by the time the queue is
                // sealed inside this call.
                await _reloadForChatTransaction();
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
 * Finish the delete transaction on a host that deliberately came back on
 * nobody.
 *
 * `power_user.auto_load_chat` is false by default, so a stock install answers
 * the mandatory reload with an empty stage: the fallback file ST was going to
 * write is never written, the credential above waits forever, and the reader
 * is left in the "character selected, no conversation" state pr9 exists to
 * abolish — one worse, in fact, with no character selected either.
 *
 * So when — and only when — a credential is still pending and nothing at all
 * holds the stage, ChatUI selects the character that credential names. This is
 * the closing move of a transaction the reader started (they confirmed the
 * delete; the reload is ChatUI's own doing), not a vote on their autoload
 * preference: the adapter refuses the moment ST landed anywhere, group or
 * character (adapter/chats/navigation.ts's selectCharacterIfNobodyIsOnStage).
 *
 * Exactly once per page: `armPendingCharacterChatLanding` consumes the
 * credential as it reads it, so a second `finalizeChatuiChatTransaction` in the
 * same load finds nothing and never reaches here. A landing that does not
 * happen is not retried and never toasts — the reader can walk to the character
 * by hand, because the session ledger the same credential fed keeps the spine
 * able to show it (ui/spine-cast.ts).
 *
 * Runs on the shared serialized lane like every other host mutation in this
 * module — `selectCharacterById` mutates the one live chat context, so being
 * boot work earns it no exemption. Three things make the lane usable this
 * early, and all three are worth stating because the alternative was a
 * fire-and-forget call that could interleave with the reader's first click:
 *
 * 1. The lane needs no initialization. Its state is module-level and already
 *    correct at evaluation time (an idle tail, epoch 0, unsealed), so a boot
 *    enqueue is served on the very next microtask.
 * 2. The epoch it captures is still current when it runs. Only
 *    `resetHostOperationQueueLifecycle` moves it, and the only callers are the
 *    UI teardown (store/composer-draft-store.ts's reset, from app.tsx) and the
 *    terminal reload seal. Mounting the root does neither, so the mount that
 *    `index.ts` performs right after this cannot cancel the landing. A
 *    teardown *would* cancel it — correctly: a reader who switched ChatUI off
 *    in that window must not have a character selected for them afterwards,
 *    which is exactly what the un-queued version did.
 * 3. Queueing can only delay this call, never advance it, and there is no
 *    longer anything for a delay to miss. The handoff used to have an ordering
 *    constraint — a CHAT_CHANGED watch had to be registered before the landing,
 *    because the event that resolved the credential came from inside
 *    `selectCharacterById` — and that watch went with the quarantine. The
 *    credential is spent synchronously by the caller before this is ever
 *    enqueued, so the queue can only move *when* the reader is seated, never
 *    whether. index.ts's own comment carries the current version of this
 *    argument, which is about the mount rather than about a listener.
 */
async function _completePendingChatTransactionLanding(avatar: string): Promise<void> {
    try {
        const landing = await chatuiAdapter.sidebarActions.selectCharacterIfNobodyIsOnStage(avatar);
        // 'occupied' is the ordinary outcome on an autoload host and says
        // nothing is wrong; the rest are worth one line, once.
        if (landing !== 'selected' && landing !== 'occupied') {
            console.warn('[ChatUI] could not finish the pending chat transaction', landing, avatar);
        }
    } catch (error) {
        console.error('[ChatUI] failed to finish the pending chat transaction', error);
    }
}

/**
 * Finish the chat transaction `deleteChatuiChat` queues when deleting a
 * character's last chat leaves the durable pointer on a fallback file nothing
 * had written yet. Call once at boot (after ST is ready), alongside
 * `finalizePendingCharacterChatDeletion`.
 *
 * The credential carries one thing — **which character the reader was in the
 * middle of** — and this spends it on two:
 *
 * 1. The spine must show that character. ST's boot-time `chat_size` snapshot
 *    was taken before its own boot wrote the fallback file, so the snapshot
 *    still reports zero conversations and the plain membership rule would drop
 *    exactly the character the reader is trying to get back to. Recording it in
 *    the session ledger (store/session-characters.ts) is what keeps the rail
 *    able to answer.
 * 2. On a stock host it must also *seat* them. `power_user.auto_load_chat` is
 *    false by default, so the mandatory reload lands on nobody at all — a
 *    worse place than the "character selected, no conversation" state this
 *    whole transaction exists to avoid. See
 *    `_completePendingChatTransactionLanding` for why that is a completion of
 *    the reader's own action rather than a preference override, and why it goes
 *    through the shared host lane.
 *
 * Arming is what bounds the credential to the load it belongs to: an un-armed
 * one would survive into some far later boot and seat somebody a page late.
 *
 * `completeLanding: false` keeps the ledger entry and drops only the seating,
 * for the one caller that must not make that move: bootstrap mode, where
 * ChatUI's interface is switched off and the reader is looking at ST's native
 * UI. Selecting a character *there* would be an invisible extension moving a
 * stage it does not own.
 *
 * This is all that survives of a much larger handoff. The credential used to
 * carry a file name as well, and the boot used to watch CHAT_CHANGED until
 * that exact file became live so it could be folded into the quarantine set —
 * keeping the fallback file a 「未完成草稿」 rather than history nobody asked
 * to keep. With the quarantine retired (DESIGN §4.2) the fallback file is
 * simply this character's conversation, which is what ST would have done on
 * its own, so the watch, the identity guard and the file name are all gone.
 *
 * @param {{ completeLanding?: boolean }} [options]
 * @returns {void}
 */
export function finalizeChatuiChatTransaction(
    { completeLanding = true }: { completeLanding?: boolean } = {},
): void {
    let avatar: string | null = null;
    try {
        avatar = chatuiAdapter.sidebarActions.armPendingCharacterChatLanding();
    } catch (error) {
        console.error('[ChatUI] failed to arm the pending chat-transaction landing', error);
        return;
    }
    if (!avatar) return;

    rememberCharacterConversation(avatar);
    if (!completeLanding) return;
    void enqueueHostTask(() => _completePendingChatTransactionLanding(avatar));
}

/**
 * Create a new chat for the current character.
 * @returns {Promise<void>}
 */
export function newChatuiChat(): Promise<void> {
    const current = chatuiAdapter.getCurrentChatIdentity();
    if (!current) return Promise.resolve();
    return enqueueLatestNavigation(async (operation) => {
        try {
            await _createChatForCharacter(current.avatar);
        } catch (error) {
            console.error('[ChatUI] new chat failed', error);
            if (operation.isLatest()) pushToast('error', '新建对话失败');
        }
    });
}

/**
 * Switch to a character and create a new empty chat for them.
 * @param {string} avatar Stable character avatar.
 * @returns {Promise<void>}
 */
export function switchChatuiCharacterAndNewChat(avatar: string): Promise<void> {
    return enqueueLatestNavigation(async (operation) => {
        try {
            const result = await chatuiAdapter.sidebarActions.switchCharacter(avatar);
            if (result === 'notfound') {
                if (operation.isLatest()) pushToast('error', '切换角色失败');
                return;
            }
            if (result === 'busy') {
                if (operation.isLatest()) pushToast('info', '正在保存或生成，请稍候');
                return;
            }
            await _createChatForCharacter(avatar);
        } catch (error) {
            console.error('[ChatUI] switchChatuiCharacterAndNewChat failed', error);
            if (operation.isLatest()) pushToast('error', '操作失败');
        }
    });
}

/**
 * Open a specific past chat, switching character if necessary.
 * @param {string} avatar Stable character avatar identifier.
 * @param {string} fileName Bare chat file name.
 * @returns {Promise<void>}
 */
export function openChatuiChatForCharacter(avatar: string, fileName: string): Promise<void> {
    return enqueueLatestNavigation(async (operation) => {
        try {
            // A pre-flight existence check used to run here, but only for a
            // quarantined draft: a lease could name a file ST's own
            // `saveChatConditional()` never wrote, and 「恢复」 had to answer
            // that the same way 「丢弃」 did rather than leave the shelf's two
            // buttons disagreeing about one missing file. There are no leases
            // any more, so there is no longer a class of row this repo knows
            // might be missing — and paying a listing read on every open to
            // find out would be a request per click. Rows whose file vanished
            // by other means remain ROADMAP.md G4, exactly as before.
            const result = await chatuiAdapter.sidebarActions.openChatForCharacter(avatar, fileName);
            if (result === 'notfound') {
                // Do not leave an immortal row the cached listing may still be
                // serving (vanished-chat-store.ts). Note what the
                // host actually means by `notfound` here, because it is
                // narrower than it reads: navigation.ts returns it when the
                // *character card* is not in the roster, or the file name is
                // blank — never for a chat file that vanished. Opening a
                // missing chat on the character already on stage is not an
                // error to ST at all; it loads an empty conversation. So an
                // ordinary history row whose file disappeared does **not**
                // arrive here — see ROADMAP.md G4.
                publishVanishedChat(avatar, fileName);
                if (operation.isLatest()) pushToast('error', '角色或对话不存在');
            } else if (result === 'busy') {
                if (operation.isLatest()) pushToast('info', '正在保存或生成，请稍候');
            }
        } catch (error) {
            console.error('[ChatUI] open chat for character failed', error);
            if (operation.isLatest()) pushToast('error', '打开对话失败');
        }
    });
}
