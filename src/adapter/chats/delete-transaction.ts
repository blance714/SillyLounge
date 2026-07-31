import {
    cancelDebouncedChatSave,
    eventSource,
    event_types,
    getRequestHeaders,
    isGenerating,
    isChatSaving,
} from '@st/script';
import { cancelDebouncedMetadataSave } from '@st/extensions';
import { humanizedDateTime } from '@st/scripts/RossAscends-mods';
import { listChatsForCharacterAvatar } from './queries.js';
import {
    type DeleteCharacterChatResultDto,
    getCharacters,
    getCurrentChatIdentity,
    getLiveCharacter,
    getStContext,
    setLiveCharacterChatIfMatches,
    stripChatExt,
} from './state.js';
import {
    RECONCILIATION_RETRY_BUDGET,
    listRawCharacterChatNames,
    persistCharacterChatSelection,
    waitForRetry,
} from './selection-protocol.js';

/**
 * Delete a chat by stable avatar. The destructive request never crosses an
 * async boundary with a numeric character index. If the deleted file is still
 * the character's selected chat, choose and persist a replacement; reload only
 * while that same avatar and deleted chat are still current.
 */
export async function deleteCharacterChat(
    avatar: string,
    fileName: string,
): Promise<DeleteCharacterChatResultDto> {
    const bareName = stripChatExt(fileName);
    const unchanged = {
        deleted: false,
        reconciled: true,
        uncertain: false,
        reloadRequired: false,
        absent: false,
        fallbackChatFileName: null,
    } as const;
    if (!avatar || !bareName) return unchanged;

    let chatNames: string[];
    try {
        chatNames = await listRawCharacterChatNames(avatar);
    } catch (error) {
        // Deliberately not `absent`: a directory we could not read says
        // nothing about whether the file is in it, and treating that as
        // absence would drop a quarantine lease still holding a real file.
        console.error('[ChatUI] failed to verify chat before deletion', error);
        return unchanged;
    }
    // Nothing to delete, and nothing failed. Reporting this as an ordinary
    // failure was a dead end for the caller: a quarantined draft whose file
    // had gone could never be discarded, because discarding *is* this call,
    // so the card and its lease stayed on the shelf forever.
    if (!chatNames.includes(bareName)) return { ...unchanged, absent: true };

    // Resolve the replacement from the raw directory listing. Unlike chat
    // search, this does not silently omit malformed JSONL files.
    const latestCharacter = getCharacters().find(character => character.avatar === avatar);
    const fallbackBase = `${latestCharacter?.name || 'Chat'} - ${humanizedDateTime()}`;
    let fallbackName = fallbackBase;
    let fallbackSuffix = 2;
    while (chatNames.includes(fallbackName)) fallbackName = `${fallbackBase} (${fallbackSuffix++})`;
    let preferredNames: string[] = [];
    try {
        preferredNames = (await listChatsForCharacterAvatar(avatar)).chats.map(chat => chat.fileName);
    } catch (error) {
        console.warn('[ChatUI] could not rank replacement chats; using raw directory order', error);
    }
    const nextName = preferredNames.find(name => name !== bareName && chatNames.includes(name))
        || chatNames.find(name => name !== bareName)
        || fallbackName;
    const selectedPointer = (() => {
        const context = getStContext();
        const index = getCharacters(context).findIndex(character => character.avatar === avatar);
        return index >= 0 ? stripChatExt(getLiveCharacter(context, index)?.chat) : '';
    })();
    const currentBeforeDelete = getCurrentChatIdentity();
    const deletingCurrent = currentBeforeDelete?.avatar === avatar
        && currentBeforeDelete.fileName === bareName;
    let movedPointerToReplacement = false;

    if (deletingCurrent) {
        // There is no stable-avatar chat loader or shared host mutex upstream.
        // Never move the live pointer while its in-memory messages still belong
        // to the target. Persist the replacement by stable avatar, delete, then
        // force a reload so ST reconstructs all live state from that durable
        // pointer. This is the only client-side path that cannot write target
        // messages into a replacement chat after an await-time character switch.
        if (isGenerating() || isChatSaving) return unchanged;
        cancelDebouncedChatSave();
        cancelDebouncedMetadataSave();
        const pointerWrite = await persistCharacterChatSelection(avatar, nextName, bareName);
        if (pointerWrite.status !== 'persisted') {
            if (pointerWrite.status === 'different' && pointerWrite.fileName !== bareName) {
                // The durable card no longer selects the live chat. Rebuild the
                // whole host context before accepting any further mutation.
                return { ...unchanged, reconciled: false, uncertain: true, reloadRequired: true };
            }
            return {
                ...unchanged,
                reconciled: pointerWrite.status === 'rejected',
                uncertain: pointerWrite.status === 'unknown',
            };
        }
        movedPointerToReplacement = true;

        const currentAfterPersist = getCurrentChatIdentity();
        if (
            currentAfterPersist?.avatar !== avatar
            || currentAfterPersist.fileName !== bareName
            || isGenerating()
            || isChatSaving
        ) {
            const context = getStContext();
            const index = getCharacters(context).findIndex(character => character.avatar === avatar);
            const livePointer = index >= 0 ? stripChatExt(getLiveCharacter(context, index)?.chat) : '';
            const rollbackName = livePointer || bareName;
            const rollback = await persistCharacterChatSelection(avatar, rollbackName, nextName);
            const reconciled = rollback.status === 'persisted'
                || (rollback.status === 'different' && rollback.fileName === livePointer);
            return {
                ...unchanged,
                reconciled,
                uncertain: rollback.status === 'unknown',
                reloadRequired: !reconciled,
            };
        }
    } else if (selectedPointer === bareName) {
        // A non-current character may still select the target on its card.
        // Move that durable pointer before deleting; update the matching live
        // record only after the checked HTTP write succeeds.
        const pointerWrite = await persistCharacterChatSelection(avatar, nextName, bareName);
        if (pointerWrite.status === 'persisted') {
            movedPointerToReplacement = true;
            setLiveCharacterChatIfMatches(avatar, bareName, nextName);
        } else if (pointerWrite.status === 'different' && pointerWrite.fileName !== bareName) {
            // A different durable selection won before DELETE. It is safe to
            // remove the target, but keep the in-memory card pointer aligned.
            setLiveCharacterChatIfMatches(avatar, bareName, pointerWrite.fileName);
        } else {
            return {
                ...unchanged,
                reconciled: pointerWrite.status === 'rejected',
                uncertain: pointerWrite.status === 'unknown',
            };
        }
    }

    try {
        const response = await fetch('/api/chats/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                chatfile: `${bareName}.jsonl`,
                avatar_url: avatar,
            }),
        });
        if (!response.ok) console.warn('[ChatUI] delete chat request was not accepted', response.status);
    } catch (error) {
        console.error('[ChatUI] delete chat request failed', error);
    }

    // A transport failure can happen after the server committed DELETE, and a
    // delayed writer can recreate the file after a 200. Always resolve the
    // outcome against the raw filename endpoint instead of trusting status or
    // lossy search results.
    if (deletingCurrent) {
        cancelDebouncedChatSave();
        cancelDebouncedMetadataSave();
    }
    let deleted = false;
    let loggedDeleteReadFailure = false;
    let deletionUncertain = false;
    for (let attempt = 1; ; attempt++) {
        try {
            const afterNames = await listRawCharacterChatNames(avatar);
            deleted = !afterNames.includes(bareName);
            break;
        } catch (error) {
            if (!loggedDeleteReadFailure) {
                loggedDeleteReadFailure = true;
                console.error('[ChatUI] could not determine whether chat deletion committed', error);
            }
            // DELETE may already have committed. Releasing the lane would either
            // miss cleanup or let the stale current buffer recreate the file.
            // Resolve from raw state before deciding rollback/reload.
            if (attempt >= RECONCILIATION_RETRY_BUDGET.maxAttempts) {
                deletionUncertain = true;
                break;
            }
            await waitForRetry();
        }
    }

    if (deletionUncertain) {
        // A sustained outage leaves DELETE's outcome permanently ambiguous.
        // Attempting the usual rollback below would be actively wrong if the
        // delete actually committed: it would durably repoint the character
        // card at a file that no longer exists. Leave any already-moved
        // pointer exactly where it is (it was moved to a real replacement
        // file before DELETE was even sent, so it stays valid either way) and
        // report the honest uncertain outcome instead of guessing.
        return {
            deleted: false,
            reconciled: false,
            uncertain: true,
            reloadRequired: deletingCurrent,
            absent: false,
            fallbackChatFileName: null,
        };
    }

    if (!deleted) {
        let reconciled = true;
        let uncertain = false;
        if (movedPointerToReplacement) {
            const rollback = await persistCharacterChatSelection(avatar, bareName, nextName);
            reconciled = rollback.status === 'persisted';
            uncertain = rollback.status === 'unknown';
            if (reconciled) setLiveCharacterChatIfMatches(avatar, nextName, bareName);
        }
        return {
            deleted: false,
            reconciled,
            uncertain,
            reloadRequired: deletingCurrent && !reconciled,
            absent: false,
            fallbackChatFileName: null,
        };
    }

    if (deletingCurrent) {
        // Do not emit into the stale current-chat runtime: arbitrary listeners
        // may save it again. The caller reloads synchronously on this result.
        return {
            deleted: true,
            reconciled: true,
            uncertain: false,
            reloadRequired: true,
            absent: false,
            // nextName is the fabricated fallback exactly when no real chat
            // (preferred or otherwise) survived to replace the one just
            // deleted — i.e. this character's history is now empty. Report
            // it so the caller can quarantine whatever ST's reload boot
            // materializes there, instead of it becoming the character's
            // one permanent chat by accident.
            fallbackChatFileName: nextName === fallbackName ? nextName : null,
        };
    }

    try {
        await eventSource.emit(event_types.CHAT_DELETED, bareName);
    } catch (error) {
        console.error('[ChatUI] failed to emit CHAT_DELETED', error);
    }
    return {
        deleted: true,
        reconciled: true,
        uncertain: false,
        reloadRequired: false,
        absent: false,
        fallbackChatFileName: null,
    };
}
