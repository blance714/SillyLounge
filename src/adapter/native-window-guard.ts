/**
 * SillyTavern-ChatUI · native-window-guard
 *
 * Boundary submodule owning the `power_user.chat_truncation` override that
 * lets ChatUI keep SillyTavern's own `#chat` render window tiny (see
 * DOM-DECOUPLING.md's 停用恢复 row, 2026-07-19 拍板) instead of building a full
 * native-message host of its own. Only this module touches
 * `chat_truncation`.
 *
 * Two invariants everything below exists to protect:
 *
 *   1. ST reads `power_user.chat_truncation || Number.MAX_SAFE_INTEGER`
 *      (SillyTavern/public/script.js:1434/1477) — `0` means UNLIMITED, not
 *      zero. The override value is therefore never 0; it is
 *      NATIVE_TRUNCATION_OVERRIDE (1), which keeps exactly the last message
 *      natively rendered. A user's *real* setting may legitimately BE 0
 *      (unlimited) — every read/write path here is value-faithful to that,
 *      including 0, by testing `typeof x === 'number' && Number.isFinite(x)`
 *      rather than truthiness anywhere a stored value is inspected.
 *   2. The override must never permanently pollute the user's real setting.
 *      SillyTavern's own `saveSettingsDebounced()` fires on many unrelated
 *      paths and serializes whatever currently sits in
 *      `power_user.chat_truncation` — including the override — the instant
 *      it flushes. Defense in depth:
 *        (a) the real value is backed up into SillyLounge's own persisted
 *            settings BEFORE the override is ever applied (backupOnce);
 *        (b) that backup is WRITE-ONCE while it exists (backupOnce refuses
 *            to overwrite one) so a second activation, or a crashed-session
 *            leftover, can never clobber the true original value with the
 *            override;
 *        (c) selfHealNativeTruncation() runs at boot in EVERY mode
 *            (including bootstrap, i.e. even when the feature flag is off
 *            or ChatUI itself never activates this session) and repairs the
 *            exact crash signature: a backup exists AND the live value is
 *            still the override sentinel.
 *
 * `activateNativeTruncationGuard(enabled)` is the single gated entry point
 * index.ts calls during setup(): passing `enabled = false` is guaranteed to
 * never touch `power_user` at all (see test/native-window-guard.test.mjs).
 *
 * Two more invariants added on top of the above:
 *
 *   3. Activation fails closed. `backupOnce()` reports a three-way outcome
 *      (established / already-present / unreadable) and
 *      activateNativeTruncationGuard() only calls applyOverride() when a
 *      valid restore point is on file (established this call, or already
 *      present from an earlier one) — never on `unreadable`. A session
 *      without the perf win is strictly better than a session that strands
 *      the sentinel with no restore path.
 *   4. Whether the override is actually live *this session* is tracked
 *      independently of the `nativeTruncationOverrideEnabled` config flag
 *      (see `isNativeTruncationGuardLive()`). index.ts's teardown path must
 *      branch on session state, not on the flag's current value, so a
 *      flag flip mid-session can never divert disable away from a live
 *      override.
 */

import { saveSettingsDebounced } from '@st/script';
import { getContext } from './internals.js';

/** Settings namespace key — must match index.js MODULE constant. */
const MODULE = 'chatui_composer';

/**
 * ST treats 0 as "unlimited" (see module doc). 1 is the smallest floor that
 * still keeps the natively-rendered `#chat` non-empty — DOM-gated paths
 * (edit-save, full-message delete; DOM-DECOUPLING.md Tier 2/3) still need
 * the last message to exist as a real `.mes` node until those tiers land.
 */
export const NATIVE_TRUNCATION_OVERRIDE = 1;

type PowerUserTruncationContext = {
    powerUserSettings?: {
        chat_truncation?: unknown;
    };
};

type GuardExtensionSettings = {
    [MODULE]?: {
        nativeTruncationBackup?: unknown;
        [key: string]: unknown;
    };
    [key: string]: unknown;
};

function getPowerUserSettings(): { chat_truncation?: unknown } | null {
    const settings = (getContext() as PowerUserTruncationContext).powerUserSettings;
    return settings && typeof settings === 'object' ? settings : null;
}

/** Ensures `extensionSettings[MODULE]` exists; returns the live nested object. */
function getGuardNamespace(): { nativeTruncationBackup?: unknown } {
    const ctx = getContext();
    if (!ctx.extensionSettings) ctx.extensionSettings = {};
    const settings = ctx.extensionSettings as GuardExtensionSettings;
    if (!settings[MODULE]) settings[MODULE] = {};
    return settings[MODULE] as { nativeTruncationBackup?: unknown };
}

/**
 * Value-faithful live read. Returns `null` (never a fabricated number) when
 * `power_user.chat_truncation` cannot be read as a finite number — callers
 * must not treat an unreadable value as if it were a real setting.
 */
export function getLiveChatTruncation(): number | null {
    const raw = getPowerUserSettings()?.chat_truncation;
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function setLiveChatTruncation(value: number): void {
    const settings = getPowerUserSettings();
    if (!settings) {
        console.error('[ChatUI] native-window-guard: powerUserSettings unavailable; cannot write chat_truncation');
        return;
    }
    // Mutates the exact object SillyTavern's own module-level `power_user`
    // singleton is (st-context.js re-exports it as `powerUserSettings:
    // power_user`, not a clone) — this is what script.js reads at print
    // time and what saveSettings() serializes.
    settings.chat_truncation = value;
}

function readBackup(): { present: boolean; value: number } {
    const raw = getGuardNamespace().nativeTruncationBackup;
    return typeof raw === 'number' && Number.isFinite(raw)
        ? { present: true, value: raw }
        : { present: false, value: 0 };
}

function persistBackup(value: number): void {
    getGuardNamespace().nativeTruncationBackup = value;
    saveSettingsDebounced();
}

/** Absence (not a sentinel number) means "no backup" — distinguishes a real backed-up 0 from "none". */
function clearBackup(): void {
    delete getGuardNamespace().nativeTruncationBackup;
    saveSettingsDebounced();
}

/** @returns {boolean} Whether a real-value backup currently exists. */
export function hasNativeTruncationBackup(): boolean {
    return readBackup().present;
}

/**
 * Three-way outcome of {@link backupOnce}:
 *   - `'established'`: no backup existed; the live value was readable and
 *     has now been written as a fresh backup. A valid restore point exists.
 *   - `'already-present'`: a backup already existed (earlier activation this
 *     session, or a crashed/force-closed previous one) and was left
 *     untouched. A valid restore point exists (from before this call).
 *   - `'unreadable'`: no backup existed, and the live value could not be
 *     read as a finite number, so none was fabricated. No restore point
 *     exists.
 */
export type BackupOutcome = 'established' | 'already-present' | 'unreadable';

/**
 * Write-once backup of the user's real `chat_truncation` into SillyLounge's
 * own persisted settings, before any override is applied. A no-op
 * (`'already-present'`) if a backup already exists — from an earlier
 * activation this session, or left over from a crashed/force-closed
 * previous one — since writing again could capture the override value
 * itself as if it were the real setting, permanently losing the user's true
 * preference (including a legitimate 0). Also a no-op (`'unreadable'`) if
 * the live value cannot be read as a finite number: never fabricate a
 * backup for a value we did not actually observe.
 *
 * @returns {BackupOutcome} See {@link BackupOutcome}.
 */
export function backupOnce(): BackupOutcome {
    if (readBackup().present) return 'already-present';
    const live = getLiveChatTruncation();
    if (live === null) {
        console.error('[ChatUI] native-window-guard: chat_truncation is not a finite number; refusing to back it up');
        return 'unreadable';
    }
    persistBackup(live);
    return 'established';
}

/**
 * Apply the in-memory override. Never persists by itself — callers must
 * back up the real value first (backupOnce) so a later unrelated
 * `saveSettingsDebounced()` flush can be healed from that backup instead of
 * silently adopting the override as the user's permanent setting.
 */
export function applyOverride(): void {
    setLiveChatTruncation(NATIVE_TRUNCATION_OVERRIDE);
}

/**
 * Whether the truncation override is actually live *this session* — i.e.
 * {@link activateNativeTruncationGuard} applied it and
 * {@link restoreForDisable} has not since run. Tracked independently of the
 * `nativeTruncationOverrideEnabled` config flag: if a future round adds a
 * live UI toggle for that flag, flipping it mid-session must not affect
 * this value, so index.ts's teardown branch (which reads this, not the
 * flag) always finds and restores a live override. Resets to `false` on
 * every fresh page load (this is plain module state, not persisted).
 */
let guardLiveThisSession = false;

/**
 * @returns {boolean} Whether the override is live this session — see
 *   {@link guardLiveThisSession}.
 */
export function isNativeTruncationGuardLive(): boolean {
    return guardLiveThisSession;
}

/**
 * Gated activation entry point — the only one index.ts's setup() calls.
 * `enabled = false` is guaranteed to never read or write `power_user` (the
 * truncation override cannot default on yet: edit-save and full-message
 * delete are still DOM-gated until DOM-DECOUPLING.md Tier 2/3 land).
 *
 * Fails closed: the override is applied only when a valid restore point
 * exists on file (backupOnce() reporting `'established'` or
 * `'already-present'`). If the live value is unreadable, backupOnce()
 * cannot record what to restore later, so applying the override would
 * permanently strand `chat_truncation` at the sentinel with no way back —
 * refuse instead and warn. A session without the perf win is strictly
 * better than one that can never recover the user's real setting.
 *
 * @returns {boolean} Whether the override was actually applied.
 */
export function activateNativeTruncationGuard(enabled: boolean): boolean {
    if (!enabled) return false;
    const outcome = backupOnce();
    if (outcome === 'unreadable') {
        console.warn(
            '[ChatUI] native-window-guard: chat_truncation is unreadable and no backup is on file; ' +
            'refusing to activate the truncation override this session (no restore point available)',
        );
        return false;
    }
    applyOverride();
    guardLiveThisSession = true;
    return true;
}

/**
 * Boot-time self-heal. Must run in EVERY mode (including bootstrap, i.e.
 * even when the feature flag is off or ChatUI never activates this
 * session) and as early as safe, because the polluting write can happen in
 * a *previous* session regardless of this session's flag state.
 *
 * Crash signature: a backup exists AND the live (just-loaded)
 * `chat_truncation` still equals the override sentinel. That combination
 * can only arise from a previous activation that applied the override,
 * took its backup, and then had its tab crash/force-close before
 * restoreForDisable() could run — while some unrelated
 * `saveSettingsDebounced()` flush persisted the override into the user's
 * real settings in the meantime.
 *
 * When that signature is detected: restore the backed-up value, persist it,
 * and clear the backup — exactly the effect a clean disable would have
 * had. The backup is cleared because its job (undoing this exact
 * pollution) is complete; keeping it would make the next legitimate
 * activation's backupOnce() wrongly skip capturing a fresh backup of the
 * value just restored here.
 *
 * If a backup exists but the live value does NOT equal the override, the
 * live value does not carry the pollution signature (e.g. the user changed
 * `chat_truncation` through ST's own native settings after the crash) —
 * the live value is authoritative and stays untouched, and the backup is
 * cleared as stale. Keeping it would let a later reactivation's
 * backupOnce() treat it as `already-present` and eventually "restore" a
 * value the user had since replaced on purpose; clearing it makes that
 * reactivation capture a fresh backup of the authoritative value instead.
 *
 * @returns {boolean} Whether a restore actually happened.
 */
export function selfHealNativeTruncation(): boolean {
    const backup = readBackup();
    if (!backup.present) return false;
    if (getLiveChatTruncation() !== NATIVE_TRUNCATION_OVERRIDE) {
        clearBackup();
        return false;
    }
    setLiveChatTruncation(backup.value);
    clearBackup();
    return true;
}

/**
 * Clean disable path: restore the real value, persist it, and clear the
 * backup. Idempotent — a missing backup (the guard was never activated
 * this session) is a no-op. Always clears `guardLiveThisSession` (the
 * guard's session involvement is over either way — see below).
 *
 * Mirrors selfHealNativeTruncation()'s guarded philosophy (asymmetry
 * removed): a backup existing is not by itself proof the live value still
 * needs restoring. ST's native `#AdvancedFormatting` chat_truncation
 * slider is never shielded by st-dom-shield.ts, so the user can freely
 * change `chat_truncation` through ST's own settings UI while the guard is
 * active — and ST's own change handler persists that value itself via its
 * own `saveSettingsDebounced()`. If that happened, the live value no
 * longer equals NATIVE_TRUNCATION_OVERRIDE, and the user's manual value is
 * authoritative: restoring the stale backup over it would silently
 * discard a setting the user just chose on purpose. In that case, leave
 * the live value untouched and just clear the now-stale backup (its
 * original job — undoing this activation's override — no longer applies
 * to the current live value, and keeping it around would make the next
 * activation's backupOnce() wrongly skip capturing a fresh one).
 *
 * If the reload that normally follows a real restore (see index.ts) races
 * the debounced settings save and wins, the write here never reaches the
 * server — but selfHealNativeTruncation() detects and repairs exactly that
 * on the very next boot, so this path does not need to force-flush the
 * save itself.
 *
 * @returns {boolean} Whether the backup value was actually restored onto
 *   the live setting (false both when there was no backup, and when a
 *   backup existed but was discarded because the live value had already
 *   been manually changed).
 */
export function restoreForDisable(): boolean {
    guardLiveThisSession = false;
    const backup = readBackup();
    if (!backup.present) return false;
    if (getLiveChatTruncation() !== NATIVE_TRUNCATION_OVERRIDE) {
        // The live value no longer carries the override sentinel — the user
        // changed it through ST's own UI, and that change is already live
        // and already persisted by ST's own settings flow. Don't stomp it;
        // just drop the now-stale backup.
        clearBackup();
        return false;
    }
    setLiveChatTruncation(backup.value);
    clearBackup();
    return true;
}
