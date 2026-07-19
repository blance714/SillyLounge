import assert from 'node:assert/strict';
import test from 'node:test';

import { createFakeStHost } from './helpers/fake-st-host.mjs';

// adapter/native-window-guard.ts owns the power_user.chat_truncation
// override behind DOM-DECOUPLING.md's 停用恢复 row (2026-07-19 拍板). These
// tests exercise the compiled module directly through the fake host — no
// index.ts / DOM wiring involved — mirroring the module's own doc comment:
// ST reads `power_user.chat_truncation || Number.MAX_SAFE_INTEGER`, so 0
// means UNLIMITED and the override is 1, never 0; every assertion below that
// touches a "real value" therefore includes a literal 0 case to prove the
// backup/restore path is value-faithful rather than treating 0 as falsy.

function countSaves(host) {
    const calls = { count: 0 };
    host.registry.saveSettingsDebounced = () => { calls.count += 1; };
    return calls;
}

test('backupOnce takes a value-faithful backup of a real chat_truncation of 0 (unlimited), and applyOverride then flips the live value to the sentinel', async () => {
    const host = await createFakeStHost();
    try {
        const guard = await host.importModule('adapter/native-window-guard.js');
        host.context.powerUserSettings = { chat_truncation: 0 };
        const saves = countSaves(host);

        assert.equal(guard.backupOnce(), 'established');
        assert.equal(host.context.extensionSettings.chatui_composer.nativeTruncationBackup, 0);
        assert.equal(saves.count, 1);

        guard.applyOverride();
        assert.equal(host.context.powerUserSettings.chat_truncation, guard.NATIVE_TRUNCATION_OVERRIDE);
        assert.equal(guard.NATIVE_TRUNCATION_OVERRIDE, 1);
    } finally {
        await host.dispose();
    }
});

test('backupOnce is write-once: a second activation cannot clobber an existing backup with the override value', async () => {
    const host = await createFakeStHost();
    try {
        const guard = await host.importModule('adapter/native-window-guard.js');
        host.context.powerUserSettings = { chat_truncation: 42 };
        countSaves(host);

        assert.equal(guard.backupOnce(), 'established');
        guard.applyOverride();
        assert.equal(host.context.powerUserSettings.chat_truncation, 1);

        // Simulate a second activation (or a crashed-session leftover) racing
        // in while the backup from the first activation is still present.
        assert.equal(guard.backupOnce(), 'already-present', 'a second backupOnce() must report the existing backup, not overwrite it');
        assert.equal(
            host.context.extensionSettings.chatui_composer.nativeTruncationBackup,
            42,
            'the original real value must survive, not be clobbered by the live override (1)',
        );
    } finally {
        await host.dispose();
    }
});

test('backupOnce refuses to fabricate a backup when the live chat_truncation cannot be read as a finite number', async () => {
    const host = await createFakeStHost();
    try {
        const guard = await host.importModule('adapter/native-window-guard.js');
        host.context.powerUserSettings = { chat_truncation: 'not-a-number' };
        const saves = countSaves(host);

        assert.equal(guard.backupOnce(), 'unreadable');

        assert.equal(guard.hasNativeTruncationBackup(), false);
        assert.equal(saves.count, 0);
    } finally {
        await host.dispose();
    }
});

test('activateNativeTruncationGuard(false) never touches power_user or persists anything', async () => {
    const host = await createFakeStHost();
    try {
        const guard = await host.importModule('adapter/native-window-guard.js');
        host.context.powerUserSettings = { chat_truncation: 77 };
        const saves = countSaves(host);

        assert.equal(guard.activateNativeTruncationGuard(false), false);

        assert.equal(host.context.powerUserSettings.chat_truncation, 77, 'live chat_truncation must be untouched');
        assert.deepEqual(host.context.extensionSettings, {}, 'no backup namespace may be created while the flag is off');
        assert.equal(saves.count, 0, 'saveSettingsDebounced must never fire while the flag is off');
        assert.equal(guard.isNativeTruncationGuardLive(), false);
    } finally {
        await host.dispose();
    }
});

test('activateNativeTruncationGuard fails closed when the live chat_truncation is unreadable: no override applied, no backup fabricated, return value reflects the refusal', async () => {
    const host = await createFakeStHost();
    try {
        const guard = await host.importModule('adapter/native-window-guard.js');
        host.context.powerUserSettings = { chat_truncation: 'not-a-number' };
        const saves = countSaves(host);

        assert.equal(guard.activateNativeTruncationGuard(true), false, 'a session without the perf win must be preferred over one that strands the sentinel with no restore path');

        assert.equal(host.context.powerUserSettings.chat_truncation, 'not-a-number', 'the unreadable live value must be left exactly as-is, never coerced to the override sentinel');
        assert.equal(guard.hasNativeTruncationBackup(), false, 'no backup may be fabricated for a value that was never actually observed');
        assert.equal(saves.count, 0);
        assert.equal(guard.isNativeTruncationGuardLive(), false, 'a refused activation must never report itself as live');
    } finally {
        await host.dispose();
    }
});

test('activateNativeTruncationGuard applies the override when a valid restore point already exists (already-present outcome)', async () => {
    const host = await createFakeStHost();
    try {
        const guard = await host.importModule('adapter/native-window-guard.js');
        // A backup already on file (e.g. left over from an earlier activation
        // this session) is itself a valid restore point — activation must
        // still proceed rather than treating "already-present" as a failure.
        host.context.extensionSettings = { chatui_composer: { nativeTruncationBackup: 250 } };
        host.context.powerUserSettings = { chat_truncation: guard.NATIVE_TRUNCATION_OVERRIDE };
        countSaves(host);

        assert.equal(guard.activateNativeTruncationGuard(true), true);

        assert.equal(host.context.powerUserSettings.chat_truncation, guard.NATIVE_TRUNCATION_OVERRIDE);
        assert.equal(host.context.extensionSettings.chatui_composer.nativeTruncationBackup, 250, 'the pre-existing backup must be left untouched, not overwritten');
        assert.equal(guard.isNativeTruncationGuardLive(), true);
    } finally {
        await host.dispose();
    }
});

test('selfHealNativeTruncation restores a backed-up real chat_truncation of 0 (unlimited) after a crash left the override persisted, and clears the backup', async () => {
    const host = await createFakeStHost();
    try {
        const guard = await host.importModule('adapter/native-window-guard.js');
        // Crash signature: a backup exists and the live value is still the
        // override sentinel (as if a prior activation's saveSettingsDebounced
        // flushed the override before restoreForDisable() could run).
        host.context.extensionSettings = { chatui_composer: { nativeTruncationBackup: 0 } };
        host.context.powerUserSettings = { chat_truncation: guard.NATIVE_TRUNCATION_OVERRIDE };
        const saves = countSaves(host);

        assert.equal(guard.selfHealNativeTruncation(), true);

        assert.equal(host.context.powerUserSettings.chat_truncation, 0, 'the real value (0 = unlimited) must be restored exactly');
        assert.equal(
            'nativeTruncationBackup' in host.context.extensionSettings.chatui_composer,
            false,
            'the backup record must be cleared once healed',
        );
        assert.equal(saves.count, 1, 'the restore must be persisted');
    } finally {
        await host.dispose();
    }
});

test('selfHealNativeTruncation no-ops without a backup', async () => {
    const host = await createFakeStHost();
    try {
        const guard = await host.importModule('adapter/native-window-guard.js');
        host.context.powerUserSettings = { chat_truncation: guard.NATIVE_TRUNCATION_OVERRIDE };
        const saves = countSaves(host);

        assert.equal(guard.selfHealNativeTruncation(), false);

        assert.equal(host.context.powerUserSettings.chat_truncation, guard.NATIVE_TRUNCATION_OVERRIDE, 'no backup means nothing to heal from, so the live value is left exactly as read');
        assert.equal(saves.count, 0);
    } finally {
        await host.dispose();
    }
});

test('selfHealNativeTruncation keeps a manually-changed live value authoritative and discards the stale backup', async () => {
    const host = await createFakeStHost();
    try {
        const guard = await host.importModule('adapter/native-window-guard.js');
        // A backup exists, but the live value is not the override sentinel —
        // e.g. the user changed chat_truncation through ST's own native
        // settings after a crash. The live value is authoritative; the backup
        // is stale and must be discarded so a later reactivation captures a
        // fresh backup of the authoritative value instead of resurrecting
        // this one on the eventual disable.
        host.context.extensionSettings = { chatui_composer: { nativeTruncationBackup: 100 } };
        host.context.powerUserSettings = { chat_truncation: 50 };
        const saves = countSaves(host);

        assert.equal(guard.selfHealNativeTruncation(), false);

        assert.equal(host.context.powerUserSettings.chat_truncation, 50, 'a live value that is not the override sentinel must never be overwritten by self-heal');
        assert.equal(host.context.extensionSettings.chatui_composer.nativeTruncationBackup, undefined, 'the stale backup is discarded, not kept for a later reactivation to resurrect');
        assert.ok(saves.count >= 1, 'discarding the stale backup must be persisted, not left as an in-memory-only removal');
    } finally {
        await host.dispose();
    }
});

test('a stale backup surviving a crash-after-manual-change is never resurrected across reactivation and disable', async () => {
    const host = await createFakeStHost();
    try {
        const guard = await host.importModule('adapter/native-window-guard.js');
        // Full scenario from the adversarial re-review: (1) a crashed session
        // left backup=X while (2) the user has since manually set the live
        // value to Y. Boot self-heal must discard X; the next activation must
        // back up Y; the eventual disable must restore Y, not X.
        host.context.extensionSettings = { chatui_composer: { nativeTruncationBackup: 100 } };
        host.context.powerUserSettings = { chat_truncation: 40 };
        countSaves(host);

        guard.selfHealNativeTruncation();
        assert.equal(guard.activateNativeTruncationGuard(true), true);
        assert.equal(host.context.extensionSettings.chatui_composer.nativeTruncationBackup, 40, 'reactivation backs up the authoritative manual value, not the stale crash-era backup');
        assert.equal(host.context.powerUserSettings.chat_truncation, guard.NATIVE_TRUNCATION_OVERRIDE);

        assert.equal(guard.restoreForDisable(), true);
        assert.equal(host.context.powerUserSettings.chat_truncation, 40, 'disable restores the value the user actually chose, never the crash-era backup');
    } finally {
        await host.dispose();
    }
});

test('restoreForDisable restores the backup, persists it, and clears the backup record', async () => {
    const host = await createFakeStHost();
    try {
        const guard = await host.importModule('adapter/native-window-guard.js');
        host.context.extensionSettings = { chatui_composer: { nativeTruncationBackup: 250 } };
        host.context.powerUserSettings = { chat_truncation: guard.NATIVE_TRUNCATION_OVERRIDE };
        const saves = countSaves(host);

        assert.equal(guard.restoreForDisable(), true);

        assert.equal(host.context.powerUserSettings.chat_truncation, 250);
        assert.equal('nativeTruncationBackup' in host.context.extensionSettings.chatui_composer, false);
        assert.equal(saves.count, 1);
    } finally {
        await host.dispose();
    }
});

test('restoreForDisable is a no-op when the guard was never activated this session', async () => {
    const host = await createFakeStHost();
    try {
        const guard = await host.importModule('adapter/native-window-guard.js');
        host.context.powerUserSettings = { chat_truncation: 100 };
        const saves = countSaves(host);

        assert.equal(guard.restoreForDisable(), false);

        assert.equal(host.context.powerUserSettings.chat_truncation, 100);
        assert.equal(saves.count, 0);
    } finally {
        await host.dispose();
    }
});

test('restoreForDisable leaves a manually-changed live value alone (the user\'s own setting is authoritative) and clears the now-stale backup instead of stomping it', async () => {
    const host = await createFakeStHost();
    try {
        const guard = await host.importModule('adapter/native-window-guard.js');
        // Mirrors selfHealNativeTruncation's guard: a backup exists (from
        // activation), but the live value no longer carries the override
        // sentinel — the user opened ST's own #AdvancedFormatting drawer and
        // dragged chat_truncation to a new value Y while the guard was live,
        // and ST's own change handler already persisted Y itself. The stale
        // pre-activation backup (X = 999) must not be forced back over it.
        host.context.extensionSettings = { chatui_composer: { nativeTruncationBackup: 999 } };
        host.context.powerUserSettings = { chat_truncation: 300 };
        const saves = countSaves(host);

        assert.equal(guard.restoreForDisable(), false, 'no restore happened — the live value already carries the user\'s manual, authoritative choice');

        assert.equal(host.context.powerUserSettings.chat_truncation, 300, 'the user\'s manually-set value must survive disable, not be silently discarded');
        assert.equal(
            'nativeTruncationBackup' in host.context.extensionSettings.chatui_composer,
            false,
            'the now-stale backup must still be cleared so a future activation captures a fresh one instead of skipping it',
        );
        assert.equal(saves.count, 1, 'clearing the stale backup persists once');
    } finally {
        await host.dispose();
    }
});

test('isNativeTruncationGuardLive reflects whether the override actually applied this session, independent of the enabled flag on later calls', async () => {
    const host = await createFakeStHost();
    try {
        const guard = await host.importModule('adapter/native-window-guard.js');
        host.context.powerUserSettings = { chat_truncation: 100 };
        countSaves(host);

        assert.equal(guard.isNativeTruncationGuardLive(), false, 'not live before any activation');

        assert.equal(guard.activateNativeTruncationGuard(true), true);
        assert.equal(guard.isNativeTruncationGuardLive(), true, 'live once the override has actually been applied');

        // A later call with enabled=false (e.g. a config flag flipped off
        // mid-session by a future UI toggle) must NOT retroactively mark a
        // still-applied override as no-longer-live — teardown must still
        // find and restore it. activateNativeTruncationGuard(false) is a
        // pure early-return and touches nothing.
        assert.equal(guard.activateNativeTruncationGuard(false), false);
        assert.equal(guard.isNativeTruncationGuardLive(), true, 'a disabled flag on a later call must not divert session-live state away from a still-applied override');

        assert.equal(guard.restoreForDisable(), true);
        assert.equal(guard.isNativeTruncationGuardLive(), false, 'no longer live once disable has restored the real value');
    } finally {
        await host.dispose();
    }
});
