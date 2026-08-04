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

// ---------------------------------------------------------------------------
// Chat-transaction landing credential (DESIGN §3 / evaluation §5 3.6: deleting
// a character's last chat must never strand the reader in "character selected,
// no conversation" — and must never strand them somewhere worse).
//
// delete-transaction.ts's deletingCurrent path may move the durable pointer to
// a fabricated name that does not exist on disk yet (`fallbackChatFileName` on
// its result). The mandatory reload that follows hands off to ST's own boot,
// which materializes some file there regardless (greeting or empty —
// getChatResult()'s unconditional saveChatConditional()). That file is this
// character's conversation, exactly as it would be if ST had done the whole
// thing itself.
//
// So all this credential has to carry across the reload is **who** the reader
// was in the middle of, and the boot spends it on two things (see
// store/sidebar-actions.ts's finalizeChatuiChatTransaction): recording the
// character in the session ledger so the spine can still show them — ST's
// boot-time `chat_size` snapshot was taken before its own boot wrote that
// file — and, on a stock host, seating them.
//
// That last part is not a nicety. `power_user.auto_load_chat` is **false by
// default** (power-user.js:335; this repo's e2e fixture forces it true, which
// is why every earlier piece of real-host evidence here came from a
// non-default setting). On a stock install the forced reload lands on nobody
// at all: ST does not load the character, and the reader is left on an empty
// stage — worse than the state this transaction exists to prevent.
//
// Deliberately a single slot, not a set like the CHAT_DELETED tombstones
// above: only one current-chat delete can ever be in flight across one reload.
//
// ## What used to be here
//
// The credential carried the fabricated file name too, and the boot watched
// CHAT_CHANGED until that exact file became the live chat, so it could be
// folded into the temp-chat quarantine set — keeping it a 「未完成草稿」 rather
// than history nobody had asked to keep. Getting the *timing* of that
// observation right was the hardest thing in this module: an earlier version
// ran on APP_READY and asked the chat directory whether the file existed yet,
// and it never did, because `initRossMods()` (script.js:772) does not await
// `RA_autoloadchat()` (RossAscends-mods.js:697) while APP_READY is emitted
// from a different async chain (script.js:788) — so the `saveChatConditional()`
// that materializes the file always lands after the only moment anyone was
// looking. (Measured on a real 1.18.0 host: the directory read finished at
// t≈848ms, the tombstone was dropped at t≈855ms, and POST /api/chats/save only
// went out at t≈949ms.)
//
// With the quarantine retired (DESIGN §4.2, 2026-08-02) none of that has
// anything left to decide: the fallback file needs no identity guard, because
// nothing is being withheld from the reader on the strength of it. The watch,
// the guard, the resolve/waiting/settled protocol and the file name are all
// gone, and with them the ~142ms race window they were documented as
// accepting. What remains is a name and an arm stamp.
// ---------------------------------------------------------------------------

/* The key keeps its old name on purpose. A reader who is mid-transaction when
   this version arrives — credential written by the previous build, reload
   already in flight — still gets landed: the old record carries a `fileName`
   this reader ignores and an `avatar` it needs, so it parses cleanly. Renaming
   the key would strand exactly the one reader the credential exists for. */
const PENDING_CHAT_LANDING_KEY = 'chatui:pendingDraftQuarantine';

type StoredCharacterChatLanding = Readonly<{
    avatar: string;
    /** Set by the one boot that has taken ownership of this intent. */
    armed: boolean;
}>;

function readPendingCharacterChatLanding(): StoredCharacterChatLanding | null {
    let raw: string | null;
    try {
        raw = sessionStorage.getItem(PENDING_CHAT_LANDING_KEY);
    } catch (error) {
        console.error('[ChatUI] failed to read the chat-transaction landing credential', error);
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
    return avatar ? { avatar, armed: record.armed === true } : null;
}

function writePendingCharacterChatLanding(pending: StoredCharacterChatLanding): void {
    try {
        sessionStorage.setItem(PENDING_CHAT_LANDING_KEY, JSON.stringify(pending));
    } catch (error) {
        console.error('[ChatUI] failed to persist the chat-transaction landing credential', error);
    }
}

function clearPendingCharacterChatLanding(): void {
    try {
        sessionStorage.removeItem(PENDING_CHAT_LANDING_KEY);
    } catch (error) {
        console.error('[ChatUI] failed to clear the chat-transaction landing credential', error);
    }
}

/** Persist who the reader was in the middle of, across the mandatory reload. */
export function queueCharacterChatLanding(avatar: string): void {
    if (!avatar) return;
    // Unarmed: the boot this reload is about to start is the one that owns it.
    writePendingCharacterChatLanding({ avatar, armed: false });
}

/**
 * Take the pending landing, if there is one. Call exactly once per boot.
 *
 * Expiry is counted in page loads rather than milliseconds, because the intent
 * belongs to the reload `deleteChatuiChat` forced: the honest bound is "the
 * page it was queued for, and no later". A page that ends without redeeming it
 * (the reader reloaded again, went somewhere else, never came back) must not
 * have a character selected for them on some much later boot — that would be a
 * surprise, not a repair.
 *
 * **Consumed on sight** is what enforces that now. Nothing is left to wait for
 * once the credential carries only a name, so the boot that reads it is the
 * boot that spends it, and one page is exactly one chance.
 *
 * The `armed` stamp is therefore not part of today's policy; it is read only so
 * that a record written by the *previous* build — which armed in one step and
 * redeemed in another, and could leave a claimed-but-unredeemed credential
 * behind — expires here instead of seating somebody a page late. Nothing in
 * this version ever writes `armed: true`. The field goes when the upgrade
 * window is safely past.
 *
 * @returns the character to land on, or null when there is nothing to do.
 */
export function armPendingCharacterChatLanding(): string | null {
    const pending = readPendingCharacterChatLanding();
    if (!pending) return null;
    if (pending.armed) {
        clearPendingCharacterChatLanding();
        return null;
    }
    // Consumed on sight: the boot that arms it is the boot that acts on it, and
    // there is no later signal left to wait for now that nothing has to be
    // matched against the live chat.
    clearPendingCharacterChatLanding();
    return pending.avatar;
}
