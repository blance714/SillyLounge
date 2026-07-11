import {
    eventSource,
    event_types,
} from '@st/script';
import {
    parseRecord,
    stringValue,
} from '../schema.js';
import { listRawCharacterChatNames } from './selection-protocol.js';
import { stripChatExt } from './state.js';

const PENDING_CHAT_DELETED_KEY = 'chatui:pendingChatDeleted';

type PendingCharacterChatDeletion = Readonly<{ id: string; avatar: string; fileName: string }>;

function parsePendingCharacterChatDeletions(raw: string | null): PendingCharacterChatDeletion[] {
    if (!raw) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw) as unknown;
    } catch {
        return [];
    }
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    const pending: PendingCharacterChatDeletion[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
        const record = parseRecord(entry);
        const avatar = stringValue(record.avatar);
        const fileName = stripChatExt(record.fileName);
        const id = stringValue(record.id) || `legacy:${avatar}:${fileName}`;
        if (!avatar || !fileName || seen.has(id)) continue;
        seen.add(id);
        pending.push({ id, avatar, fileName });
    }
    return pending;
}

function writePendingCharacterChatDeletions(pending: ReadonlyArray<PendingCharacterChatDeletion>): void {
    if (pending.length > 0) {
        sessionStorage.setItem(PENDING_CHAT_DELETED_KEY, JSON.stringify(pending));
    } else {
        sessionStorage.removeItem(PENDING_CHAT_DELETED_KEY);
    }
}

/** Remove only the captured generation; never erase a newer tombstone (ABA). */
function removePendingCharacterChatDeletion(id: string): void {
    const latest = parsePendingCharacterChatDeletions(sessionStorage.getItem(PENDING_CHAT_DELETED_KEY));
    writePendingCharacterChatDeletions(latest.filter(entry => entry.id !== id));
}

/** Persist cleanup identity across the mandatory current-chat reload. */
export function queueCurrentCharacterChatDeletionFinalization(avatar: string, fileName: string): void {
    const bareName = stripChatExt(fileName);
    if (!avatar || !bareName) return;
    try {
        const pending = parsePendingCharacterChatDeletions(sessionStorage.getItem(PENDING_CHAT_DELETED_KEY));
        pending.push({
            id: typeof crypto.randomUUID === 'function'
                ? crypto.randomUUID()
                : `${Date.now()}-${Math.random()}`,
            avatar,
            fileName: bareName,
        });
        writePendingCharacterChatDeletions(pending);
    } catch (error) {
        console.error('[ChatUI] failed to persist CHAT_DELETED tombstone', error);
    }
}

/**
 * Replay cleanup only after reload has reconstructed a safe live chat. ST's
 * EventEmitter swallows listener failures, so absence is rechecked and the
 * tombstone intentionally remains for idempotent retry on later reloads. If a
 * new file reuses the old name, existence clears the tombstone before emission.
 */
export async function finalizePendingCharacterChatDeletion(): Promise<void> {
    let pending: PendingCharacterChatDeletion[] = [];
    try {
        pending = parsePendingCharacterChatDeletions(sessionStorage.getItem(PENDING_CHAT_DELETED_KEY));
    } catch (error) {
        console.error('[ChatUI] failed to read CHAT_DELETED tombstone', error);
        return;
    }
    for (const entry of pending) {
        try {
            const names = await listRawCharacterChatNames(entry.avatar);
            if (names.includes(entry.fileName)) {
                // DELETE did not commit, or a new chat deliberately reused the
                // name. Remove only this generation; a concurrent newer delete
                // has a different id and remains queued.
                removePendingCharacterChatDeletion(entry.id);
                continue;
            }
        } catch (error) {
            console.error('[ChatUI] failed to verify pending CHAT_DELETED', error);
            continue;
        }

        try {
            await eventSource.emit(event_types.CHAT_DELETED, entry.fileName);
            // Do not clear: individual listeners catch/swallow their own failures
            // and EventEmitter offers no aggregate acknowledgement. Re-emission
            // on a later reload is idempotent and absence-guarded above.
        } catch (error) {
            console.error('[ChatUI] failed to emit pending CHAT_DELETED', error);
        }
    }
}
