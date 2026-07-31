import {
    eventSource,
    event_types,
} from '@st/script';
import {
    parseRecord,
    stringValue,
} from '../schema.js';
import { listRawCharacterChatNames } from './selection-protocol.js';
import { getCurrentChatIdentity, stripChatExt } from './state.js';

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

// ---------------------------------------------------------------------------
// Draft quarantine handoff (DESIGN §3 / evaluation §5 3.6: deleting a
// character's last chat must never strand it in "character selected, no
// conversation" — it must land on a recoverable draft, the same as ＋新对话).
//
// delete-transaction.ts's deletingCurrent path may move the durable pointer
// to a fabricated name that does not exist on disk yet (`fallbackChatFileName`
// on its result). The mandatory reload that follows hands off to ST's own
// boot, which always materializes *some* file there (greeting or empty —
// getChatResult()'s unconditional saveChatConditional()). Left alone, that
// file is an ordinary saved chat like any other: this tombstone lets the
// next boot fold it into the same quarantine set every other new chat goes
// through instead.
//
// Deliberately a single slot, not a set like the CHAT_DELETED tombstones
// above: only one current-chat delete can ever be in flight across one
// reload, and a stale second entry would risk quarantining an unrelated
// later file that happens to reuse the name.
// ---------------------------------------------------------------------------

const PENDING_DRAFT_QUARANTINE_KEY = 'chatui:pendingDraftQuarantine';

export type PendingCharacterChatDraftQuarantine = Readonly<{ avatar: string; fileName: string }>;

function readPendingCharacterChatDraftQuarantine(): PendingCharacterChatDraftQuarantine | null {
    let raw: string | null;
    try {
        raw = sessionStorage.getItem(PENDING_DRAFT_QUARANTINE_KEY);
    } catch (error) {
        console.error('[ChatUI] failed to read draft-quarantine tombstone', error);
        return null;
    }
    if (!raw) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw) as unknown;
    } catch {
        return null;
    }
    const record = parseRecord(parsed);
    const avatar = stringValue(record.avatar);
    const fileName = stripChatExt(record.fileName);
    return avatar && fileName ? { avatar, fileName } : null;
}

function clearPendingCharacterChatDraftQuarantine(): void {
    try {
        sessionStorage.removeItem(PENDING_DRAFT_QUARANTINE_KEY);
    } catch (error) {
        console.error('[ChatUI] failed to clear draft-quarantine tombstone', error);
    }
}

/** Persist the fallback file's identity across the mandatory reload. */
export function queueCharacterChatDraftQuarantine(avatar: string, fileName: string): void {
    const bareName = stripChatExt(fileName);
    if (!avatar || !bareName) return;
    try {
        sessionStorage.setItem(
            PENDING_DRAFT_QUARANTINE_KEY,
            JSON.stringify({ avatar, fileName: bareName }),
        );
    } catch (error) {
        console.error('[ChatUI] failed to persist draft-quarantine tombstone', error);
    }
}

/**
 * Confirm and consume the pending draft-quarantine tombstone. Returns the
 * pointer to quarantine only once the fallback file is verified live: it now
 * exists on disk (ST's boot materialized it) *and* it is still this
 * character's actual current chat — nothing else claimed the slot between
 * queuing and this boot. Any other outcome drops the tombstone; a later,
 * unrelated chat that happens to reuse the fallback name must never be
 * quarantined by an old intent.
 *
 * Read-only over adapter state on purpose: the temp-chat quarantine set
 * itself is store-layer state (temp-chat-store.ts), which the adapter must
 * not reach into (ARCHITECTURE.md's layering). The caller — sidebar-actions.ts,
 * the one place allowed to touch that store — commits the confirmed pointer.
 */
export async function takePendingCharacterChatDraftQuarantine(): Promise<PendingCharacterChatDraftQuarantine | null> {
    const pending = readPendingCharacterChatDraftQuarantine();
    if (!pending) return null;

    let names: string[];
    try {
        names = await listRawCharacterChatNames(pending.avatar);
    } catch (error) {
        console.error('[ChatUI] failed to verify pending draft-quarantine target', error);
        // Transient read failure: keep the tombstone for a later boot rather
        // than dropping a target that may still need quarantining.
        return null;
    }
    if (!names.includes(pending.fileName)) {
        // ST's boot did not (yet, or ever) materialize the fallback file —
        // nothing to quarantine.
        clearPendingCharacterChatDraftQuarantine();
        return null;
    }

    const current = getCurrentChatIdentity();
    clearPendingCharacterChatDraftQuarantine();
    if (current?.avatar !== pending.avatar || current.fileName !== pending.fileName) return null;
    return pending;
}
