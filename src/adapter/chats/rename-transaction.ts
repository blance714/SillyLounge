import {
    cancelDebouncedChatSave,
    eventSource,
    event_types,
    getRequestHeaders,
    isGenerating,
    isChatSaving,
    saveChatConditional,
} from '@st/script';
import { cancelDebouncedMetadataSave } from '@st/extensions';
import {
    createCharacterChatKey,
    createConversationLocator,
} from '../chat-key.js';
import { parseRecord } from '../schema.js';
import {
    type RenameCharacterChatResultDto,
    getCharacters,
    getCurrentChatIdentity,
    getLiveCharacter,
    getStContext,
    setLiveCharacterChatIfMatches,
    stripChatExt,
} from './state.js';
import {
    listRawCharacterChatNames,
    persistCharacterChatSelection,
    readCharacterChatSelection,
    waitForRetry,
} from './selection-protocol.js';

function renameResult(
    avatar: string,
    oldFileName: string,
    newFileName: string,
    renamed: boolean,
    reconciled: boolean,
    uncertain = false,
    reloadRequired = false,
): RenameCharacterChatResultDto {
    return {
        renamed,
        reconciled,
        uncertain,
        reloadRequired,
        avatar,
        oldFileName,
        newFileName,
        oldChatKey: createCharacterChatKey(avatar, createConversationLocator(oldFileName)),
        newChatKey: createCharacterChatKey(avatar, createConversationLocator(newFileName)),
    };
}

type RenameFileOutcome =
    | Readonly<{ status: 'renamed'; fileName: string }>
    | Readonly<{ status: 'not-renamed' }>
    | Readonly<{ status: 'conflict'; fileName: string }>
    | Readonly<{ status: 'unknown' }>;

async function renameCharacterChatFile(
    avatar: string,
    oldFileName: string,
    newFileName: string,
    beforeNames: ReadonlyArray<string>,
    resolveUnknown = false,
): Promise<RenameFileOutcome> {
    let confirmedName = '';
    let requestState: 'accepted' | 'rejected' | 'ambiguous' = 'ambiguous';
    try {
        const response = await fetch('/api/chats/rename', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                is_group: false,
                avatar_url: avatar,
                original_file: `${oldFileName}.jsonl`,
                renamed_file: `${newFileName}.jsonl`,
            }),
        });
        if (response.ok) {
            requestState = 'accepted';
            try {
                const data = parseRecord(await response.json() as unknown);
                confirmedName = stripChatExt(data.sanitizedFileName) || newFileName;
            } catch (error) {
                // The file move was accepted even if its response body was lost
                // or malformed. Resolve the actual sanitized name from raw state.
                console.error('[ChatUI] rename response body was invalid', error);
            }
        } else {
            requestState = 'rejected';
        }
    } catch (error) {
        console.error('[ChatUI] rename chat request failed', error);
    }

    const before = new Set(beforeNames);
    let loggedReadFailure = false;
    for (;;) {
        try {
            const afterNames = await listRawCharacterChatNames(avatar);
            const oldExists = afterNames.includes(oldFileName);
            if (confirmedName) {
                const newExists = afterNames.includes(confirmedName);
                if (newExists && !oldExists) return { status: 'renamed', fileName: confirmedName };
                if (newExists && oldExists) return { status: 'conflict', fileName: confirmedName };
            } else {
                const additions = afterNames.filter(name => !before.has(name));
                if (!oldExists && additions.length === 1) return { status: 'renamed', fileName: additions[0] };
                if (oldExists && additions.length === 1) return { status: 'conflict', fileName: additions[0] };
                if (oldExists && additions.length === 0 && requestState === 'rejected') {
                    return { status: 'not-renamed' };
                }
            }
        } catch (error) {
            if (!loggedReadFailure) {
                loggedReadFailure = true;
                console.error('[ChatUI] could not resolve ambiguous rename outcome', error);
            }
            if (confirmedName) return { status: 'renamed', fileName: confirmedName };
            if (requestState === 'rejected') return { status: 'not-renamed' };
        }

        if (!resolveUnknown) return { status: 'unknown' };
        // A current-chat rename must never release the host lane while the file
        // may already have moved and the live pointer still names the old file.
        // Raw readback is side-effect-free, so retry until the state is known.
        await waitForRetry();
    }
}

/**
 * Rename by stable avatar and return the server-confirmed (possibly sanitized)
 * filename. If this file is the character-card selection, persist that pointer
 * with a checked merge request before changing the matching live record.
 */
export async function renameCharacterChat(
    avatar: string,
    oldFileName: string,
    newName: string,
): Promise<RenameCharacterChatResultDto> {
    const oldBare = stripChatExt(oldFileName);
    const next = typeof newName === 'string' ? stripChatExt(newName).trim() : '';
    const invalid = renameResult(avatar, oldBare, next, false, true);
    if (!avatar || !oldBare || !next || oldBare === next) return invalid;

    let names: string[];
    try {
        names = await listRawCharacterChatNames(avatar);
    } catch (error) {
        console.error('[ChatUI] failed to verify chat before rename', error);
        return invalid;
    }
    if (!names.includes(oldBare)) return invalid;

    const currentBeforeRename = getCurrentChatIdentity();
    const renamingCurrent = currentBeforeRename?.avatar === avatar
        && currentBeforeRename.fileName === oldBare;
    if (renamingCurrent) {
        if (isGenerating() || isChatSaving) return invalid;
        await saveChatConditional();
        const currentAfterFlush = getCurrentChatIdentity();
        if (
            currentAfterFlush?.avatar !== avatar
            || currentAfterFlush.fileName !== oldBare
            || isGenerating()
            || isChatSaving
        ) return invalid;
        cancelDebouncedChatSave();
        cancelDebouncedMetadataSave();
    }

    const forward = await renameCharacterChatFile(avatar, oldBare, next, names, renamingCurrent);
    if (forward.status === 'not-renamed') return invalid;
    if (forward.status === 'unknown') {
        return renameResult(avatar, oldBare, next, false, false, true);
    }
    const actualName = forward.fileName;
    let fileConflict = forward.status === 'conflict';

    let reconciled = true;
    const pointerAfterRename = (() => {
        const latest = getStContext();
        const latestIndex = getCharacters(latest).findIndex(character => character.avatar === avatar);
        return latestIndex >= 0 ? stripChatExt(getLiveCharacter(latest, latestIndex)?.chat) : '';
    })();
    if (pointerAfterRename === oldBare) {
        const pointerWrite = await persistCharacterChatSelection(avatar, actualName, oldBare);
        if (pointerWrite.status === 'persisted') {
            const latest = getStContext();
            const latestIndex = getCharacters(latest).findIndex(character => character.avatar === avatar);
            const latestPointer = latestIndex >= 0
                ? stripChatExt(getLiveCharacter(latest, latestIndex)?.chat)
                : '';
            if (latestPointer === oldBare) {
                setLiveCharacterChatIfMatches(avatar, oldBare, actualName);
                const current = getCurrentChatIdentity();
                if (current?.avatar === avatar && current.fileName === actualName) {
                    const selector = document.getElementById('selected_chat_pole') as HTMLInputElement | null;
                    if (selector) selector.value = actualName;
                }
            } else if (latestPointer) {
                // A concurrent host navigation won the pointer after the file
                // rename. Restore that newer selection on disk; never overwrite
                // its live record with the renamed filename.
                const restore = await persistCharacterChatSelection(avatar, latestPointer, actualName);
                reconciled = restore.status === 'persisted';
            }
        } else if (pointerWrite.status === 'different' && pointerWrite.fileName !== oldBare) {
            // Another durable selection won. The renamed file is no longer the
            // card pointer, so keep the file move and align only a non-current
            // character's safe live record. Current messages must never be
            // relabelled without loading the winning chat.
            if (renamingCurrent) {
                const latest = getStContext();
                const latestIndex = getCharacters(latest).findIndex(character => character.avatar === avatar);
                const latestPointer = latestIndex >= 0
                    ? stripChatExt(getLiveCharacter(latest, latestIndex)?.chat)
                    : '';
                reconciled = latestPointer === pointerWrite.fileName;
            } else {
                setLiveCharacterChatIfMatches(avatar, oldBare, pointerWrite.fileName);
            }
        } else if (pointerWrite.status === 'unknown') {
            return renameResult(avatar, oldBare, actualName, true, false, true);
        } else {
            // The file move committed but the selected-chat pointer did not.
            // Roll the file back rather than leave a durable ghost selection.
            let rollbackBeforeNames: string[];
            try {
                rollbackBeforeNames = await listRawCharacterChatNames(avatar);
            } catch {
                rollbackBeforeNames = names.filter(name => name !== oldBare).concat(actualName);
            }
            const rollback = await renameCharacterChatFile(
                avatar,
                actualName,
                oldBare,
                rollbackBeforeNames,
                renamingCurrent,
            );
            if (rollback.status === 'renamed' && rollback.fileName === oldBare) return invalid;
            if (rollback.status === 'unknown') {
                return renameResult(avatar, oldBare, actualName, true, false, true);
            }
            if (rollback.status === 'conflict') fileConflict = true;
            reconciled = false;
        }
    }

    let reloadRequired = false;
    if (renamingCurrent) {
        const safety = await reconcileCurrentRenameSafety(avatar, oldBare, actualName);
        // "Safe to keep using the live buffer" is not the same as "the rename
        // landed on actualName". A rollback conflict can leave old+new while
        // live/durable correctly remain old; never migrate drafts in that case.
        reconciled = safety.reconciled && safety.fileName === actualName;
        reloadRequired = safety.reloadRequired;
    }
    const uncertain = fileConflict || !reconciled;
    const result = renameResult(
        avatar,
        oldBare,
        actualName,
        true,
        reconciled,
        uncertain,
        reloadRequired,
    );
    if (!uncertain) {
        try {
            await eventSource.emit(event_types.CHAT_RENAMED, {
                avatarId: avatar,
                groupId: null,
                oldFileName: `${oldBare}.jsonl`,
                newFileName: `${actualName}.jsonl`,
            });
        } catch (error) {
            console.error('[ChatUI] failed to emit CHAT_RENAMED', error);
        }
    }
    return result;
}

/**
 * Before a current rename releases the shared host lane, prove that the live
 * message buffer names an existing file. If a different durable selection won,
 * request a reload; if the live filename vanished, converge the card pointer to
 * the file containing that buffer and relabel the live record only then.
 */
async function reconcileCurrentRenameSafety(
    avatar: string,
    oldFileName: string,
    renamedFileName: string,
): Promise<Readonly<{ reconciled: boolean; reloadRequired: boolean; fileName: string }>> {
    let loggedReadFailure = false;
    for (;;) {
        let names: string[];
        let durablePointer: string;
        try {
            [names, durablePointer] = await Promise.all([
                listRawCharacterChatNames(avatar),
                readCharacterChatSelection(avatar),
            ]);
        } catch (error) {
            if (!loggedReadFailure) {
                loggedReadFailure = true;
                console.error('[ChatUI] current rename safety readback failed', error);
            }
            await waitForRetry();
            continue;
        }

        const existing = new Set(names);
        const current = getCurrentChatIdentity();
        const currentBelongsToTarget = current?.avatar === avatar;
        const liveFileName = currentBelongsToTarget ? current.fileName : '';

        if (liveFileName && existing.has(liveFileName)) {
            if (durablePointer === liveFileName) {
                return { reconciled: true, reloadRequired: false, fileName: liveFileName };
            }
            if (durablePointer && existing.has(durablePointer)) {
                // The durable winner contains a real chat, but the in-memory
                // buffer belongs to another file. Only a full reload can switch
                // messages and pointer together safely.
                return { reconciled: false, reloadRequired: true, fileName: durablePointer };
            }

            const align = await persistCharacterChatSelection(avatar, liveFileName, durablePointer);
            if (align.status === 'persisted') {
                return { reconciled: true, reloadRequired: false, fileName: liveFileName };
            }
            if (align.status === 'different' && existing.has(align.fileName)) {
                return {
                    reconciled: false,
                    reloadRequired: currentBelongsToTarget,
                    fileName: align.fileName,
                };
            }
            await waitForRetry();
            continue;
        }

        if (durablePointer && existing.has(durablePointer)) {
            if (!currentBelongsToTarget) {
                setLiveCharacterChatIfMatches(avatar, oldFileName, durablePointer);
            }
            return {
                reconciled: !currentBelongsToTarget,
                reloadRequired: currentBelongsToTarget,
                fileName: durablePointer,
            };
        }

        // The live buffer began as oldFileName. After a successful file move it
        // belongs to renamedFileName; after rollback it belongs to oldFileName.
        const recoveryFile = existing.has(renamedFileName)
            ? renamedFileName
            : existing.has(oldFileName)
                ? oldFileName
                : '';
        if (!recoveryFile) {
            // Neither side of the rename exists. Do not let a later save invent
            // a new empty file under the stale live name.
            await waitForRetry();
            continue;
        }

        const align = await persistCharacterChatSelection(avatar, recoveryFile, durablePointer);
        if (align.status === 'persisted') {
            if (currentBelongsToTarget && liveFileName) {
                setLiveCharacterChatIfMatches(avatar, liveFileName, recoveryFile);
                const selector = document.getElementById('selected_chat_pole') as HTMLInputElement | null;
                if (selector) selector.value = recoveryFile;
            } else {
                setLiveCharacterChatIfMatches(avatar, oldFileName, recoveryFile);
            }
            return { reconciled: true, reloadRequired: false, fileName: recoveryFile };
        }
        if (align.status === 'different' && existing.has(align.fileName)) {
            if (!currentBelongsToTarget) {
                setLiveCharacterChatIfMatches(avatar, oldFileName, align.fileName);
            }
            return {
                reconciled: !currentBelongsToTarget,
                reloadRequired: currentBelongsToTarget,
                fileName: align.fileName,
            };
        }
        await waitForRetry();
    }
}
