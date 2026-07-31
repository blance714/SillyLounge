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
    commitTempChatDraft,
    deactivateTempChatIfMatches,
    getTempChatDraft,
    getTempChatDraftSnapshot,
    getTempChatSnapshot,
    isTempChat,
    isTempChatSnapshotCurrent,
    markTempChatActive,
    moveTempChatIfMatches,
    removeTempChat,
    retainTempChatRenameCandidateIfMatches,
} from './temp-chat-store.js';
import type {
    TempChatDraftSnapshot,
    TempChatPointer,
} from './temp-chat-store.js';
import { createCharacterChatKey, createConversationLocator } from '../adapter/chat-key.js';
import {
    deleteComposerDraft,
    getComposerDraft,
    getComposerDraftStoreSnapshot,
    moveComposerDraft,
} from './composer-draft-store.js';
import {
    enqueueHostTask,
    enqueueLatestNavigation,
    sealHostOperationQueueForReload,
    waitForHostOperationsIdle,
} from './host-operation-queue.js';
import {
    finishTempChatDeparture,
    prepareTempChatDeparture,
} from './temp-chat-navigation.js';
import { pushToast } from './toast-store.js';
import { publishVanishedChat } from './vanished-chat-store.js';

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

function _chatKey(pointer: TempChatPointer): string {
    return createCharacterChatKey(pointer.avatar, createConversationLocator(pointer.fileName));
}

function _hasLocalTempWork(pointer: TempChatPointer): boolean {
    const chatKey = _chatKey(pointer);
    const composer = getComposerDraftStoreSnapshot();
    try {
        return getComposerDraft(chatKey) !== ''
            || composer.pendingSend?.chatKey === chatKey
            || chatuiAdapter.menuActions.getPendingAttachments().length > 0;
    } catch (error) {
        // Failure to inspect unsaved UI state must retain the file.
        console.error('[ChatUI] failed to inspect temp-chat local work', error);
        return true;
    }
}

/**
 * Capture immediately before entering ST, after older queued work has finished.
 * This sees a concrete pointer even when the user clicked away while new-chat
 * creation was still materializing. Local composer work adopts the chat before
 * ST's CHAT_CHANGED listeners can reset pending attachment state.
 */
function _captureDepartingTempChat() {
    return prepareTempChatDeparture(
        chatuiAdapter.getCurrentChatIdentity(),
        _hasLocalTempWork,
    );
}

function _restoreLoadedTempChatActivity(): void {
    const current = chatuiAdapter.getCurrentChatIdentity();
    if (current) markTempChatActive(current.avatar, current.fileName);
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
        _restoreLoadedTempChatActivity();
        return;
    }

    let old = getTempChatSnapshot();
    if (old.pointer && !_sameChatIdentity(old.pointer, current)) {
        deactivateTempChatIfMatches(old);
        old = getTempChatSnapshot();
    }
    if (_sameChatIdentity(old.pointer, current)) {
        cancelTempChatDraftIfMatches(draftIntent);
        return;
    }

    try {
        await chatuiAdapter.sidebarActions.newCharacterChat();
        const created = chatuiAdapter.getCurrentChatIdentity();
        if (!created || created.avatar !== avatar) {
            cancelTempChatDraftIfMatches(draftIntent);
            _restoreLoadedTempChatActivity();
            return;
        }

        // The host lane excludes a newer local creation, while storage events
        // may legitimately add/remove unrelated dormant leases. Claim the
        // concrete result unless another active temp actually took this slot.
        if (!isTempChatSnapshotCurrent(old)) {
            cancelTempChatDraftIfMatches(draftIntent);
            _restoreLoadedTempChatActivity();
            return;
        }
        commitTempChatDraft(created, draftIntent);
    } catch (error) {
        cancelTempChatDraftIfMatches(draftIntent);
        _restoreLoadedTempChatActivity();
        throw error;
    }
}

/**
 * Switch the active character by stable avatar.
 * @param {string} avatar
 * @returns {Promise<void>}
 */
export function switchChatuiCharacter(avatar: string): Promise<void> {
    if (getTempChatDraft()) cancelTempChatDraft();
    return enqueueLatestNavigation(async (operation) => {
        const departing = _captureDepartingTempChat();
        try {
            const result = await chatuiAdapter.sidebarActions.switchCharacter(avatar);
            if (result === 'notfound') {
                if (operation.isLatest()) pushToast('error', '切换角色失败');
            } else if (result === 'busy') {
                if (operation.isLatest()) pushToast('info', '正在保存或生成，请稍候');
            } else {
                finishTempChatDeparture(departing, chatuiAdapter.getCurrentChatIdentity());
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
    return enqueueLatestNavigation(async (operation) => {
        const departing = _captureDepartingTempChat();
        try {
            const owner = chatuiAdapter.getCurrentChatIdentity()?.avatar;
            await chatuiAdapter.sidebarActions.openCharacterChatByName(fileName);
            const opened = chatuiAdapter.getCurrentChatIdentity();
            const expected = typeof fileName === 'string' ? fileName.replace(/\.jsonl$/i, '') : '';
            if (!owner || opened?.avatar !== owner || opened.fileName !== expected) {
                if (operation.isLatest()) pushToast('error', '打开对话失败');
                return;
            }
            finishTempChatDeparture(departing, opened);
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
            const tempSnapshot = getTempChatSnapshot();
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
            if (_sameChatIdentity(tempSnapshot.pointer, {
                avatar: result.avatar,
                fileName: result.oldFileName,
            })) {
                if (result.uncertain) {
                    // A file conflict means old and new may both exist even if
                    // the selected pointer reconciled to new. Quarantine both;
                    // only the authoritative live identity becomes active.
                    const retained = retainTempChatRenameCandidateIfMatches(tempSnapshot, {
                        avatar: result.avatar,
                        fileName: result.newFileName,
                    });
                    if (retained && result.reconciled) {
                        markTempChatActive(result.avatar, result.newFileName);
                    }
                } else if (result.reconciled) {
                    moveTempChatIfMatches(tempSnapshot, {
                        avatar: result.avatar,
                        fileName: result.newFileName,
                    });
                }
            }
            if (result.reloadRequired) {
                // Persist quarantine migration before the reload: the durable
                // pointer names a real winner while the live buffer does not.
                await _reloadForChatTransaction();
                return;
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
                // Reading this as a failure is what stranded a quarantined
                // draft whose file had vanished: 丢弃 is this call, so the one
                // path that could drop the lease refused to, and the card
                // stayed on the shelf for the rest of the session. (Restoring
                // such a draft already recovered — openChatuiChatForCharacter
                // checks the file first and drops the lease — which made the
                // shelf's two buttons disagree about the same missing file.)
                deleteComposerDraft(createCharacterChatKey(avatar, createConversationLocator(fileName)));
                removeTempChat(avatar, fileName);
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
                removeTempChat(avatar, fileName);
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
                    // pointer was moved to a name nothing has written yet.
                    // ST's reload boot will materialize *something* there
                    // regardless (greeting or empty) — queue it for the next
                    // boot to fold into the same draft quarantine ＋新对话
                    // uses, so it never becomes a permanent history entry the
                    // reader never asked to keep (DESIGN §3, evaluation §5 3.6).
                    chatuiAdapter.sidebarActions.queueCharacterChatDraftQuarantine(
                        avatar,
                        result.fallbackChatFileName,
                    );
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
 * One look at the live chat: fold the fallback file into the quarantine set if
 * this is the moment the tombstone names.
 *
 * @returns {boolean} true once there is nothing left to watch for — either the
 *   pointer was committed, or no tombstone is queued at all.
 */
function _resolveChatuiDraftQuarantine(): boolean {
    let match;
    try {
        match = chatuiAdapter.sidebarActions.resolvePendingCharacterChatDraftQuarantine();
    } catch (error) {
        console.error('[ChatUI] failed to resolve draft-quarantine handoff', error);
        // Keep watching: an unreadable tombstone this instant is not proof
        // there is nothing to quarantine.
        return false;
    }
    if (match.status === 'waiting') return false;
    if (match.status === 'quarantine') {
        try {
            commitTempChatDraft(match.pointer, getTempChatDraftSnapshot());
        } catch (error) {
            console.error('[ChatUI] failed to commit draft-quarantine handoff', error);
        }
    }
    return true;
}

/**
 * The character a queued-but-unresolved draft-quarantine credential is about,
 * or null when nothing is pending.
 *
 * For the spine's membership rule (ui/spine-cast.ts): while this credential is
 * waiting, ST's boot-time disk snapshot still reports zero conversations for
 * that character, and hiding it is precisely what makes the transaction
 * unfinishable by hand.
 *
 * @returns {string | null}
 */
export function getChatuiPendingDraftQuarantineCharacter(): string | null {
    try {
        return chatuiAdapter.sidebarActions.peekPendingCharacterChatDraftQuarantine()?.avatar ?? null;
    } catch (error) {
        console.error('[ChatUI] failed to read the pending draft-quarantine credential', error);
        return null;
    }
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
 * Exactly once per page: `armPendingCharacterChatDraftQuarantine` stamps the
 * credential, so a second `finalizeChatuiDraftQuarantine` in the same load
 * finds nothing to arm and never reaches here. A landing that does not happen
 * is not retried and never toasts — the credential simply keeps its ordinary
 * meaning and the reader can now walk to the character by hand, because the
 * spine shows it (ui/spine-cast.ts).
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
 * 3. Queueing can only delay this call, never advance it, so the one ordering
 *    constraint the handoff has — the CHAT_CHANGED watch is registered before
 *    the landing, because the event that resolves the credential is emitted
 *    from inside `selectCharacterById` — is strengthened rather than lost. The
 *    watch is registered synchronously below, before this is enqueued.
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
 * Complete the draft-quarantine handoff `deleteChatuiChat` queues when
 * deleting a character's last chat leaves it pointed at a fallback file
 * nothing had written yet. Call once at boot (after ST is ready), alongside
 * `finalizePendingCharacterChatDeletion`.
 *
 * This does not assume ST's boot has already got there. It cannot: ST
 * materializes that file on a fire-and-forget chain that APP_READY does not
 * wait for (deletion-finalization.ts's section comment has the full ordering,
 * with the byte-level trace of the boot where this used to lose every time).
 * So the handoff arms itself for this page and then watches for the fallback
 * file to *become* the live chat — immediately, in case ST's autoload already
 * finished, and on every CHAT_CHANGED after that, which ST emits at the end of
 * loading a chat. The listener stops the moment the intent is either committed
 * or gone; while it is neither, an unrelated chat change is simply not the
 * event we are waiting for.
 *
 * If nothing at all holds the stage once that watch is armed, this also
 * finishes the transaction itself rather than waiting for a signal a stock
 * (auto_load_chat: false) host will never send — see
 * `_completePendingChatTransactionLanding` above for why that is a completion
 * and not a preference override, and why it goes through the shared host lane.
 * The watch is registered *before* the landing is enqueued, because the
 * CHAT_CHANGED that resolves the credential is emitted from inside that very
 * call.
 *
 * `completeLanding: false` keeps everything above except that last move, and
 * exists for the one caller that must not make it: bootstrap mode, where
 * ChatUI's own interface is switched off and the reader is looking at ST's
 * native UI. Selecting a character *there* would be an invisible extension
 * moving a stage it does not own, so the reader keeps the empty stage ST gave
 * them. Everything else still has to run, and for reasons that outlive this
 * page: arming is what bounds the credential to the load it belongs to (an
 * un-armed one would survive into some far later boot and retroactively
 * quarantine a file the reader has been treating as ordinary history), and the
 * watch is what keeps the fallback file — if ST's autoload does write it — a
 * recoverable draft instead of permanent history nobody asked to keep. The
 * lease is persisted, so it is still a draft whenever ChatUI comes back.
 *
 * That is also the whole of the credential's fate when the reader switches
 * ChatUI off, reloads, and switches it back on. Turning it back on does not
 * re-run this (`index.ts` only mounts), and would change nothing if it did:
 * the credential is already armed for this page. If the fallback file went
 * live, the lease is waiting in the quarantine set; if nobody ever took the
 * stage, the credential is still pending and the spine seats that character
 * the moment ChatUI's UI is back (ui/spine-cast.ts reads it through `peek`),
 * so the reader can walk over and finish the transaction by hand. The next
 * reload after that expires it, exactly as it expires any credential the page
 * that owned it never redeemed.
 *
 * @param {{ completeLanding?: boolean }} [options]
 * @returns {void}
 */
export function finalizeChatuiDraftQuarantine(
    { completeLanding = true }: { completeLanding?: boolean } = {},
): void {
    let pending: TempChatPointer | null = null;
    try {
        pending = chatuiAdapter.sidebarActions.armPendingCharacterChatDraftQuarantine();
    } catch (error) {
        console.error('[ChatUI] failed to arm draft-quarantine handoff', error);
        return;
    }
    if (!pending) return;
    if (_resolveChatuiDraftQuarantine()) return;

    let stopWatching: (() => void) | null = null;
    // `subscribe` registers synchronously, so the handler cannot run before
    // stopWatching is assigned below.
    stopWatching = chatuiAdapter.subscribe('CHAT_CHANGED', () => {
        if (!_resolveChatuiDraftQuarantine()) return;
        stopWatching?.();
        stopWatching = null;
    });

    if (!completeLanding) return;
    void enqueueHostTask(() => _completePendingChatTransactionLanding(pending.avatar));
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
        const departing = _captureDepartingTempChat();
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

            // This action intentionally replaces the current chat next.
            finishTempChatDeparture(departing, null);
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
    const wasQuarantined = isTempChat(avatar, fileName);
    if (getTempChatDraft()) cancelTempChatDraft();
    return enqueueLatestNavigation(async (operation) => {
        const departing = _captureDepartingTempChat();
        try {
            if (
                wasQuarantined
                && !await chatuiAdapter.sidebarActions.hasCharacterChatFile(avatar, fileName)
            ) {
                removeTempChat(avatar, fileName);
                publishVanishedChat(avatar, fileName);
                if (operation.isLatest()) pushToast('error', '草稿文件已不存在');
                return;
            }
            const result = await chatuiAdapter.sidebarActions.openChatForCharacter(avatar, fileName);
            if (result === 'notfound') {
                // The host is authoritative: a stale quarantined lease whose
                // file vanished must not become an immortal shelf row.
                removeTempChat(avatar, fileName);
                // Nor an immortal row of any other kind the cached listing may
                // still be serving (vanished-chat-store.ts). Note what the
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
            } else {
                finishTempChatDeparture(departing, chatuiAdapter.getCurrentChatIdentity());
            }
        } catch (error) {
            console.error('[ChatUI] open chat for character failed', error);
            if (operation.isLatest()) pushToast('error', '打开对话失败');
        }
    });
}
