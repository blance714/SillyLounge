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
//
// *When* this may be observed is the whole difficulty, and getting it wrong
// is what made the first version of this handoff a race it could only lose.
// That version ran on APP_READY and asked the chat directory whether the
// fallback file existed yet. It never did: `initRossMods()` (script.js:772)
// does not await `RA_autoloadchat()` (RossAscends-mods.js:697), and APP_READY
// is emitted from a different async chain further down the same boot
// (script.js:788), so the `saveChatConditional()` that materializes the file
// always lands after APP_READY. (Measured on a real 1.18.0 host: the listing
// read finished at t≈848ms, the tombstone was dropped at t≈855ms, and
// POST /api/chats/save only went out at t≈949ms.) The check was asking about
// something ST guarantees will happen but guarantees to do *after* the only
// moment we were looking — it was never an invariant this repo owns.
//
// So the disk check is gone, and with it every network request this handoff
// used to make. What remains is one guard, and it is an identity guard only:
// "this character's current chat is the exact name we fabricated". Observation
// moves off APP_READY entirely and onto "the live chat became this file",
// whenever that happens: at boot if ST's autoload got there first, on a
// CHAT_CHANGED later in the same page if it did not (or if autoload is off and
// the reader opens the character by hand — either themselves, or through the
// transaction completion sidebar-actions.ts runs when ST's boot came back on
// nobody at all).
//
// Be precise about what that guard does and does not prove, because the two
// paths differ and the first version of this comment claimed the stronger fact
// for both. On the CHAT_CHANGED path the file really is on disk already:
// `getChatResult()` (script.js:7625) awaits `saveChatConditional()` before it
// emits the event, so the event cannot arrive early. The *immediate* check —
// the one a real 1.18.0 boot actually takes, because autoload finishes before
// APP_READY — reads `getCurrentChatDetails().sessionName`, which is
// `characters[this_chid].chat` (script.js:8478): the durable pointer *we*
// wrote before forcing the reload. It is proof of identity, not of a file.
// Measured on that host, the lease was written at t=843ms and
// POST /api/chats/save only went out at t=985ms — the quarantine leads the
// file by ~142ms.
//
// Two consequences, both accepted deliberately rather than overlooked:
//
//  (a) if that `saveChatConditional()` fails outright, the lease is left
//      pointing at a file that never appears. That is a recoverable state, not
//      a corrupt one, and the recovery is deliberately routed through the
//      *dormant* card rather than the live one. While the reader is still
//      standing in that chat the conversation exists (unsaved) and the delete
//      transaction refuses to call it absent, precisely so the lease survives
//      the next save that writes the file back; the moment the reader is
//      somewhere else, restoring the card checks the raw listing first and
//      drops the lease (sidebar-actions.ts's openChatuiChatForCharacter), and
//      discarding it reports `absent` and drops the lease too
//      (delete-transaction.ts). Nothing is lost and nothing is stuck.
//  (b) within that ~142ms window, a 丢弃 would send DELETE before ST's CREATE,
//      so the file would materialize afterwards holding no lease — the exact
//      "fallback file becomes ordinary history" outcome this handoff exists to
//      prevent. It is accepted because the window is not humanly reachable:
//      the draft card has to render, be found and be clicked, and its confirm
//      dialog accepted, inside a tenth of a second of the page appearing.
//
// Closing (b) properly would mean moving the immediate check onto a signal
// that is guaranteed to be later than the save — which is precisely the
// CHAT_CHANGED path — and that signal is the one a real boot has already
// emitted before this code first runs. Waiting for the *next* one would strand
// every ordinary autoload boot. The honest position is the one written here:
// the immediate branch is an identity check, the window is documented, and no
// claim is made that it proves the file exists.
//
// The tombstone is consequently *kept*, not destroyed, while the live chat is
// something else — its meaning is "if this file name goes live, it is a
// draft", and a boot that lands on another character (or on nothing) is no
// evidence against that. Its lifetime is bounded without any wall-clock
// constant: sessionStorage already scopes it to this tab, and
// `armPendingCharacterChatDraftQuarantine()` below stamps the one boot that
// owns it, so an intent that page never resolved is dropped by the next boot
// rather than dangling.
// ---------------------------------------------------------------------------

const PENDING_DRAFT_QUARANTINE_KEY = 'chatui:pendingDraftQuarantine';

export type PendingCharacterChatDraftQuarantine = Readonly<{ avatar: string; fileName: string }>;

/**
 * The outcome of one look at the live chat, from `resolvePendingCharacterChatDraftQuarantine()`.
 *
 * - `quarantine`: the fallback file is live now; `pointer` is the confirmed
 *   target and the tombstone has been consumed.
 * - `waiting`: a tombstone is queued but something else holds the live chat;
 *   it stays queued for the next signal.
 * - `settled`: nothing is queued (never was, or already consumed) — the
 *   caller can stop listening.
 */
export type CharacterChatDraftQuarantineMatch =
    | Readonly<{ status: 'quarantine'; pointer: PendingCharacterChatDraftQuarantine }>
    | Readonly<{ status: 'waiting' }>
    | Readonly<{ status: 'settled' }>;

const DRAFT_QUARANTINE_WAITING = Object.freeze({ status: 'waiting' as const });
const DRAFT_QUARANTINE_SETTLED = Object.freeze({ status: 'settled' as const });

type StoredCharacterChatDraftQuarantine = Readonly<{
    avatar: string;
    fileName: string;
    /** Set by the one boot that has taken ownership of this intent. */
    armed: boolean;
}>;

function readPendingCharacterChatDraftQuarantine(): StoredCharacterChatDraftQuarantine | null {
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
    return avatar && fileName ? { avatar, fileName, armed: record.armed === true } : null;
}

function writePendingCharacterChatDraftQuarantine(pending: StoredCharacterChatDraftQuarantine): void {
    try {
        sessionStorage.setItem(PENDING_DRAFT_QUARANTINE_KEY, JSON.stringify(pending));
    } catch (error) {
        console.error('[ChatUI] failed to persist draft-quarantine tombstone', error);
    }
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
    // Unarmed: the boot this reload is about to start is the one that owns it.
    writePendingCharacterChatDraftQuarantine({ avatar, fileName: bareName, armed: false });
}

/**
 * Claim the pending draft-quarantine intent for this page load, and expire one
 * a previous page load already claimed.
 *
 * Call exactly once per boot, before watching for the fallback file to go
 * live. The returned pointer is only "there is work to do this session" — the
 * authority on whether that work fires is
 * `resolvePendingCharacterChatDraftQuarantine()` below, which re-reads storage
 * every time.
 *
 * The arm stamp is the whole expiry policy, and it is deliberately counted in
 * page loads rather than milliseconds: the intent belongs to the reload that
 * `deleteChatuiChat` forced, so the honest bound is "the page it was queued
 * for, and no later". A page that ends without resolving it (the reader
 * reloaded again, closed the character, never came back) leaves a file that
 * has by then already been shown as ordinary history — folding it into the
 * quarantine set retroactively on some much later boot would be a surprise,
 * not a repair.
 */
export function armPendingCharacterChatDraftQuarantine(): PendingCharacterChatDraftQuarantine | null {
    const pending = readPendingCharacterChatDraftQuarantine();
    if (!pending) return null;
    if (pending.armed) {
        clearPendingCharacterChatDraftQuarantine();
        return null;
    }
    writePendingCharacterChatDraftQuarantine({ ...pending, armed: true });
    return { avatar: pending.avatar, fileName: pending.fileName };
}

/**
 * Read the queued intent without arming, consuming or otherwise touching it.
 *
 * Exists for readers that need to know *who* a delete transaction is still
 * mid-flight for while it is still waiting — the spine's membership rule
 * (ui/spine-cast.ts), whose whole problem is that this character's disk
 * snapshot says it has nothing. Deliberately not gated on the arm stamp: an
 * intent queued but not yet armed (between `queueCharacterChatDraftQuarantine`
 * and the reload it precedes) names the same character, and a caller asking
 * "who is this about" is entitled to the answer in both states.
 */
export function peekPendingCharacterChatDraftQuarantine(): PendingCharacterChatDraftQuarantine | null {
    const pending = readPendingCharacterChatDraftQuarantine();
    return pending ? { avatar: pending.avatar, fileName: pending.fileName } : null;
}

/**
 * Check the pending draft-quarantine tombstone against the live chat, and
 * consume it if this is the moment it names.
 *
 * The single condition is identity: this character's current chat is exactly
 * the fabricated fallback name. Nothing here asks the server anything — see
 * the section comment above for why the old directory check could only ever
 * look too early, and for exactly how much the remaining check proves (on a
 * CHAT_CHANGED, that the file is saved; called immediately at boot, only that
 * the pointer names it, plus the ~142ms window and the two consequences that
 * come with that distinction).
 *
 * A mismatch reports `waiting` and leaves the tombstone alone. Dropping it
 * there was the second half of the original bug: "some other chat is current
 * right now" is not evidence that the fallback file will never be, and with
 * the intent gone the file it eventually materializes silently becomes
 * permanent history.
 *
 * Read-only over adapter state on purpose: the temp-chat quarantine set
 * itself is store-layer state (temp-chat-store.ts), which the adapter must
 * not reach into (ARCHITECTURE.md's layering). The caller — sidebar-actions.ts,
 * the one place allowed to touch that store — commits the confirmed pointer.
 */
export function resolvePendingCharacterChatDraftQuarantine(): CharacterChatDraftQuarantineMatch {
    const pending = readPendingCharacterChatDraftQuarantine();
    if (!pending) return DRAFT_QUARANTINE_SETTLED;

    const current = getCurrentChatIdentity();
    if (current?.avatar !== pending.avatar || current.fileName !== pending.fileName) {
        return DRAFT_QUARANTINE_WAITING;
    }

    clearPendingCharacterChatDraftQuarantine();
    return { status: 'quarantine', pointer: { avatar: pending.avatar, fileName: pending.fileName } };
}
