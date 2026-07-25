/**
 * SillyLounge · verify-truncation-guard
 *
 * Browser-level acceptance for the native truncation guard (DOM-DECOUPLING.md
 * 停用恢复 row; adapter/native-window-guard.ts; store/config-store.ts's
 * default-ON nativeTruncationOverrideEnabled flag). Closes INVARIANTS.md §16's
 * two "need src-level injection or only verifiable in a browser" gaps:
 *
 *   Scenario A — flag-on activate + the real disable-reload round trip
 *     (gap 1: index.ts's two wiring paths had zero browser drive).
 *   Scenario B — bootstrap self-heal on a pre-polluted data root
 *     (gap 2: selfHealNativeTruncation() at the top of init() had zero
 *     browser drive).
 *
 * Mirrors scripts/e2e/measure-chat-switch.mjs's structure (fresh disposable
 * data root via generate-data-root.mjs, disposable ST via st-process.mjs,
 * structural assertions over wall-clock thresholds) and scripts/e2e/smoke-st.mjs's
 * disposable-run bookkeeping. This is an acceptance script, not a performance
 * measurement. Its evidence supported the explicit 2026-07-19 decision to
 * enable the product flag by default, and it now runs in the CI publish gate
 * alongside the default-ON smoke and chat-switch fixtures.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

import { DESKTOP_VIEWPORT, REDUCED_MOTION } from './browser-baseline.mjs';
import { generateStDataRoot } from './generate-data-root.mjs';
import { inspectStCheckout, startStServer } from './st-process.mjs';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const RUNTIME_ROOT = path.join(PROJECT_ROOT, '.runtime', 'SillyTavern-ChatUI');
const FIXTURE_ROOT = path.join(PROJECT_ROOT, 'test', 'e2e', 'fixtures');
// A long-but-cheap-to-generate single conversation (400 floors / 800
// messages, plain alternating text — no rich-profile generation cost) so the
// override's truncation is actually observable (native #chat mounting 1 of
// 800 is a meaningfully different shape than 1 of 4) without paying the
// long-rich fixture's ~20MB / slow-generation cost this script does not need.
const DEFAULT_FIXTURE = 'long-plain';
// SillyTavern's own saveSettingsDebounced() uses debounce_timeout.relaxed
// (1000ms, SillyTavern/public/scripts/constants.js) with no leading-edge or
// forced flush. Every disk-persistence assertion below polls the real
// settings.json on disk (not just in-memory state) for up to this long past
// that debounce window, so "persisted" in this script's assertions always
// means "durable on disk", never "written to a JS object ST intends to save
// eventually".
const SETTINGS_FLUSH_TIMEOUT_MS = 8_000;
const SETTINGS_POLL_INTERVAL_MS = 100;

function defaultEvidenceRoot() {
    return path.join(PROJECT_ROOT, 'test-results', 'truncation-guard');
}

function parseArgs(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--') continue;
        if (!['--fixture', '--evidence-root'].includes(argument)) {
            throw new Error(`unknown argument: ${argument}`);
        }
        const value = argv[index + 1];
        if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
        if (argument === '--fixture') options.fixture = value;
        if (argument === '--evidence-root') options.evidenceRoot = value;
        index += 1;
    }
    return options;
}

async function readJson(filePath) {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function copyIfPresent(source, destination) {
    try {
        await fs.copyFile(source, destination);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
}

/**
 * Polls the real settings.json on disk (never just an in-memory read) until
 * `predicate` is satisfied or `timeoutMs` elapses — the only honest way to
 * assert something SillyTavern's debounced settings save actually persisted,
 * given that save has no forced-flush path (see module doc).
 */
async function waitForSettingsOnDisk(settingsPath, predicate, description, timeoutMs = SETTINGS_FLUSH_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    let lastSeen;
    for (;;) {
        try {
            lastSeen = await readJson(settingsPath);
            if (predicate(lastSeen)) return lastSeen;
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
        if (Date.now() >= deadline) {
            throw new Error(
                `${description}: settings.json at ${settingsPath} never satisfied this within ${timeoutMs}ms `
                + `(last read: ${JSON.stringify(lastSeen?.power_user?.chat_truncation)} / `
                + `${JSON.stringify(lastSeen?.extension_settings?.chatui_composer)})`,
            );
        }
        await new Promise(resolve => setTimeout(resolve, SETTINGS_POLL_INTERVAL_MS));
    }
}

async function launchGuardBrowser() {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: DESKTOP_VIEWPORT, reducedMotion: REDUCED_MOTION });
    const page = await context.newPage();
    const pageErrors = [];
    const chatuiErrors = [];
    page.on('pageerror', error => pageErrors.push(error.stack ?? error.message));
    page.on('console', message => {
        if (message.type() === 'error' && message.text().includes('[ChatUI]')) {
            chatuiErrors.push(message.text());
        }
    });
    return { browser, context, page, pageErrors, chatuiErrors };
}

/** Waits for ChatUI to be fully live for the fixture's single conversation. */
async function waitForChatuiActive(page, expected) {
    await page.waitForFunction(expected => {
        const context = globalThis.SillyTavern?.getContext?.();
        const root = document.querySelector('#chatui-root[data-cui-root-mounted="1"]');
        const list = root?.querySelector('.cui-root-message-list');
        const lastMessage = root?.querySelector(`[data-cui-message-id="${expected.messageCount - 1}"]`);
        return Boolean(
            context?.chatId === expected.fileName
            && context.chat?.length === expected.messageCount
            && list?.getAttribute('data-cui-virtual-count') === String(expected.messageCount)
            && lastMessage
            && root?.querySelector('[aria-label="快速跳转用户回合"]')?.getAttribute('aria-valuemax') === String(expected.userTurns)
            && !document.querySelector('dialog[open]'),
        );
    }, expected, { timeout: 120_000 });
}

/** Reads guard-relevant live state straight from the same objects the guard itself reads/writes. */
async function readGuardState(page) {
    return page.evaluate(() => {
        const context = globalThis.SillyTavern?.getContext?.();
        const composerSettings = context?.extensionSettings?.chatui_composer;
        return {
            liveChatTruncation: context?.powerUserSettings?.chat_truncation ?? null,
            backup: typeof composerSettings?.nativeTruncationBackup === 'number'
                ? composerSettings.nativeTruncationBackup
                : null,
            enabled: composerSettings?.enabled ?? null,
            nativeMessageCount: document.querySelectorAll('#chat > .mes').length,
            chatuiRootMounted: document.querySelector('#chatui-root[data-cui-root-mounted="1"]') !== null,
        };
    });
}

/**
 * Proves ChatUI's own message list still spans the *full* conversation (not
 * the native-truncated window) by driving the real floor rail to both edges
 * and reading back the boundary message text — the same edge-navigation
 * technique measure-chat-switch.mjs uses, simplified to one conversation.
 */
async function assertChatuiShowsFullConversation(page, target) {
    const rail = page.locator('[aria-label="快速跳转用户回合"]');
    await rail.press('Home');
    await page.waitForFunction(target => {
        const railEl = document.querySelector('[aria-label="快速跳转用户回合"]');
        const first = document.querySelector('[data-cui-message-id="0"]');
        return railEl?.getAttribute('aria-valuenow') === '1' && Boolean(first?.textContent?.includes(target.firstFloorText));
    }, target, { timeout: 30_000 });
    await rail.press('End');
    await page.waitForFunction(target => {
        const railEl = document.querySelector('[aria-label="快速跳转用户回合"]');
        const last = document.querySelector(`[data-cui-message-id="${target.messageCount - 1}"]`);
        return railEl?.getAttribute('aria-valuenow') === String(target.userTurns)
            && Boolean(last?.textContent?.includes(target.lastFloorText));
    }, target, { timeout: 30_000 });
}

/**
 * Drives the exact real UI a user clicks to disable ChatUI: sidebar "设置"
 * entry -> Settings nav's "关闭 ChatUI" footer button -> the confirm
 * dialog's "关闭" button (src/ui/components/settings/SettingsNav.tsx). This
 * dispatches CHATUI_DISABLE_EVENT, which index.ts's disableFromUi() handles
 * identically to the native #chatui_enabled checkbox's own change handler.
 * Races a `page.waitForEvent('load')` against the click so the returned
 * promise only resolves once a *real navigation* actually occurs — asserting
 * the sealed-queue reload path fired rather than an in-place teardown (which
 * would leave this promise hanging until the timeout).
 */
async function disableChatuiViaRealUi(page) {
    await page.locator('.cui-root-settings-entry').click();
    const disableButton = page.locator('.cui-settings-nav-disable');
    await disableButton.waitFor({ state: 'visible', timeout: 30_000 });
    await disableButton.click();
    const confirmButton = page.locator('.cui-root-dialog-confirm');
    await confirmButton.waitFor({ state: 'visible', timeout: 30_000 });
    const navigated = page.waitForEvent('load', { timeout: 60_000 });
    await confirmButton.click();
    await navigated;
}

/**
 * Waits for native `#chat`'s rendered row count to reach an exact expected
 * value — a structural assertion, not a wall-clock settle window (see
 * PERFORMANCE.md's methodology convention). This matters specifically
 * because ST's own boot sequence prints the native chat via a *fire-and-
 * forget* async chain (RA_autoloadchat() in RossAscends-mods.js is invoked
 * without `await`, racing the rest of firstLoadInit() including the
 * APP_INITIALIZED/APP_READY emits our extension's init() — and therefore
 * activateNativeTruncationGuard()/selfHealNativeTruncation() — hang off of).
 * ChatUI's own store hydration is on a separate, often-faster path, so
 * `waitForChatuiActive` resolving is not proof the native print has
 * happened yet; every native-count assertion in this script waits for the
 * exact count directly instead of inferring it from ChatUI's readiness.
 */
async function waitForNativeMessageCount(page, expectedCount, timeoutMs = 120_000) {
    await page.waitForFunction(expectedCount => (
        document.querySelectorAll('#chat > .mes').length === expectedCount
    ), expectedCount, { timeout: timeoutMs });
}

// ── Scenario A ───────────────────────────────────────────────────────────────

async function runScenarioA({ stRoot, fixture, evidenceRoot }) {
    const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sillylounge-guard-a-'));
    const dataRoot = path.join(runRoot, 'data');
    const scenarioEvidenceRoot = path.join(evidenceRoot, 'scenario-a');
    await fs.mkdir(scenarioEvidenceRoot, { recursive: true });

    let server = null;
    let browser = null;
    let context = null;
    let page = null;
    const assertions = [];
    const record = (name, fn) => { fn(); assertions.push(name); };

    try {
        const generated = await generateStDataRoot({
            targetRoot: dataRoot,
            stRoot,
            runtimeRoot: RUNTIME_ROOT,
            fixturePath: path.join(FIXTURE_ROOT, fixture, 'fixture.json'),
            extensionMode: 'active',
            regexMode: 'active',
            nativeTruncationOverrideEnabled: true,
        });
        const conversation = generated.manifest.conversation;
        const { originalChatTruncation, overrideSentinel } = generated.manifest.nativeTruncation;
        assert.equal(generated.manifest.nativeTruncation.overrideEnabled, true);
        const expected = {
            fileName: conversation.fileName,
            messageCount: conversation.messageCount,
            userTurns: conversation.userTurns,
            firstFloorText: '第 1 楼用户消息',
            lastFloorText: `第 ${conversation.userTurns} 楼助手回复`,
        };

        server = await startStServer({ stRoot, runRoot, dataRoot, readyTimeoutMs: 120_000 });
        ({ browser, context, page } = await launchGuardBrowser());
        const pageErrors = [];
        const chatuiErrors = [];
        page.on('pageerror', error => pageErrors.push(error.stack ?? error.message));
        page.on('console', message => {
            if (message.type() === 'error' && message.text().includes('[ChatUI]')) chatuiErrors.push(message.text());
        });
        await page.goto(server.url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
        await waitForChatuiActive(page, expected);
        await waitForNativeMessageCount(page, overrideSentinel);

        // ── Step 1: flag-on activation ──────────────────────────────────────
        const activated = await readGuardState(page);
        record('live chat_truncation is the override sentinel while active', () => {
            assert.equal(activated.liveChatTruncation, overrideSentinel);
        });
        record('native #chat mounts only the truncated window', () => {
            assert.equal(activated.nativeMessageCount, overrideSentinel);
        });
        const persistedBackup = await waitForSettingsOnDisk(
            generated.paths.settings,
            settings => settings.extension_settings?.chatui_composer?.nativeTruncationBackup === originalChatTruncation,
            'backupOnce() must persist the fixture\'s original chat_truncation to disk',
        );
        record('persisted SillyLounge backup holds the fixture\'s original value', () => {
            assert.equal(persistedBackup.extension_settings.chatui_composer.nativeTruncationBackup, originalChatTruncation);
            // The live override must not have been flushed over power_user's
            // *own* on-disk value in a way that would make the backup and the
            // live setting indistinguishable — the module doc's whole point
            // is that these two facts (live=sentinel, backup=original) must
            // coexist durably.
            assert.notEqual(persistedBackup.power_user.chat_truncation, persistedBackup.extension_settings.chatui_composer.nativeTruncationBackup);
        });
        await assertChatuiShowsFullConversation(page, expected);
        record('ChatUI itself still shows/navigates the full conversation', () => {});
        record('no console errors after activation', () => {
            assert.deepEqual(pageErrors, []);
            assert.deepEqual(chatuiErrors, []);
        });
        await page.screenshot({ path: path.join(scenarioEvidenceRoot, '1-activated.png') });

        // ── "already-present" fold-in: a second full boot with the flag still
        // on and a backup already on file must still activate (not skip the
        // override), and must not clobber the existing backup with the
        // override value (backupOnce()'s write-once guarantee, driven through
        // a real page boot rather than only the unit-level fake host). ──
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 });
        await waitForChatuiActive(page, expected);
        await waitForNativeMessageCount(page, overrideSentinel);
        const reactivated = await readGuardState(page);
        record('a flag-on boot with an existing backup ("already-present") still activates the override', () => {
            assert.equal(reactivated.liveChatTruncation, overrideSentinel);
            assert.equal(reactivated.nativeMessageCount, overrideSentinel);
        });
        const persistedAfterReactivate = await readJson(generated.paths.settings);
        record('"already-present" reactivation never clobbers the existing backup with the override value', () => {
            assert.equal(
                persistedAfterReactivate.extension_settings.chatui_composer.nativeTruncationBackup,
                originalChatTruncation,
            );
        });
        record('no console errors after the already-present reactivation', () => {
            assert.deepEqual(pageErrors, []);
            assert.deepEqual(chatuiErrors, []);
        });

        // ── Step 2: drive the real disable control, assert an actual reload ──
        await disableChatuiViaRealUi(page);
        record('disabling via the real UI control triggers an actual page reload (sealed-queue path), not an in-place teardown', () => {});

        // ── Step 3: post-reload restoration ──────────────────────────────────
        await waitForNativeMessageCount(page, Math.min(conversation.messageCount, originalChatTruncation));
        const restoredNativeCount = await page.evaluate(() => document.querySelectorAll('#chat > .mes').length);
        const restoredLive = await page.evaluate(() => (
            globalThis.SillyTavern?.getContext?.()?.powerUserSettings?.chat_truncation ?? null
        ));
        const chatuiRootMountedAfterReload = await page.evaluate(() => (
            document.querySelector('#chatui-root[data-cui-root-mounted="1"]') !== null
        ));
        record('live chat_truncation is restored to the original fixture value after reload', () => {
            assert.equal(restoredLive, originalChatTruncation);
        });
        record('ChatUI does not reactivate after a real disable-reload (settings.enabled persisted before reload)', () => {
            assert.equal(chatuiRootMountedAfterReload, false);
        });
        record('native #chat renders the full (non-truncated per the user\'s real setting) native message set after reload', () => {
            assert.equal(restoredNativeCount, Math.min(conversation.messageCount, originalChatTruncation));
        });
        const persistedAfterDisable = await waitForSettingsOnDisk(
            generated.paths.settings,
            settings => (
                settings.power_user?.chat_truncation === originalChatTruncation
                && settings.extension_settings?.chatui_composer?.nativeTruncationBackup === undefined
            ),
            'restoreForDisable()/selfHealNativeTruncation() must persist the restored value and clear the backup to disk',
        );
        record('persisted chat_truncation equals the original fixture value after reload', () => {
            assert.equal(persistedAfterDisable.power_user.chat_truncation, originalChatTruncation);
        });
        record('the persisted SillyLounge backup field is cleared after reload', () => {
            assert.equal(persistedAfterDisable.extension_settings.chatui_composer.nativeTruncationBackup, undefined);
        });
        record('no console errors after the disable-reload round trip', () => {
            assert.deepEqual(pageErrors, []);
            assert.deepEqual(chatuiErrors, []);
        });
        await page.screenshot({ path: path.join(scenarioEvidenceRoot, '2-after-disable-reload.png') });

        return { name: 'scenario-a', assertions, pageErrors, chatuiErrors };
    } catch (error) {
        if (page) {
            try {
                await page.screenshot({ path: path.join(scenarioEvidenceRoot, 'failure.png') });
            } catch {
                // Preserve the original failure when the page is already gone.
            }
        }
        throw error;
    } finally {
        if (context) await context.close();
        if (browser) await browser.close();
        if (server) {
            await server.stop();
            await Promise.all([
                copyIfPresent(server.paths.stdout, path.join(scenarioEvidenceRoot, 'sillytavern.stdout.log')),
                copyIfPresent(server.paths.stderr, path.join(scenarioEvidenceRoot, 'sillytavern.stderr.log')),
            ]);
        }
        await inspectStCheckout({ stRoot });
        await fs.rm(runRoot, { recursive: true, force: true });
    }
}

// ── Scenario B ───────────────────────────────────────────────────────────────

async function runScenarioB({ stRoot, fixture, evidenceRoot }) {
    const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sillylounge-guard-b-'));
    const dataRoot = path.join(runRoot, 'data');
    const scenarioEvidenceRoot = path.join(evidenceRoot, 'scenario-b');
    await fs.mkdir(scenarioEvidenceRoot, { recursive: true });

    let server = null;
    let browser = null;
    let context = null;
    let page = null;
    const assertions = [];
    const record = (name, fn) => { fn(); assertions.push(name); };
    const pageErrors = [];
    const chatuiErrors = [];

    try {
        const generated = await generateStDataRoot({
            targetRoot: dataRoot,
            stRoot,
            runtimeRoot: RUNTIME_ROOT,
            fixturePath: path.join(FIXTURE_ROOT, fixture, 'fixture.json'),
            // Bootstrap: SillyLounge is installed (not in disabledExtensions,
            // so index.ts's init() runs and registers on APP_READY) but the
            // replacement UI is off (chatui_composer.enabled === false) —
            // exactly the "extension installed, replacement UI disabled"
            // half of the crash signature the task calls for.
            extensionMode: 'bootstrap',
            regexMode: 'active',
            // The other half: persisted chat_truncation already sitting at
            // the override sentinel, with a backup already on file — the
            // exact signature a crashed/force-closed *previous* session
            // (that had the flag on) would leave behind.
            nativeTruncationPollution: true,
        });
        const conversation = generated.manifest.conversation;
        const { originalChatTruncation, overrideSentinel } = generated.manifest.nativeTruncation;
        assert.equal(generated.manifest.nativeTruncation.pollution, true);

        const prePolluted = await readJson(generated.paths.settings);
        record('fixture is generated pre-polluted with the crash signature', () => {
            assert.equal(prePolluted.power_user.chat_truncation, overrideSentinel);
            assert.equal(prePolluted.extension_settings.chatui_composer.nativeTruncationBackup, originalChatTruncation);
            assert.equal(prePolluted.extension_settings.chatui_composer.enabled, false);
        });

        server = await startStServer({ stRoot, runRoot, dataRoot, readyTimeoutMs: 120_000 });
        ({ browser, context, page } = await launchGuardBrowser());
        page.on('pageerror', error => pageErrors.push(error.stack ?? error.message));
        page.on('console', message => {
            if (message.type() === 'error' && message.text().includes('[ChatUI]')) chatuiErrors.push(message.text());
        });
        await page.goto(server.url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
        await waitForNativeMessageCount(page, Math.min(conversation.messageCount, originalChatTruncation));
        await page.screenshot({ path: path.join(scenarioEvidenceRoot, '1-after-boot.png') });

        const booted = await page.evaluate(() => {
            const context = globalThis.SillyTavern?.getContext?.();
            const composerSettings = context?.extensionSettings?.chatui_composer;
            return {
                liveChatTruncation: context?.powerUserSettings?.chat_truncation ?? null,
                backup: typeof composerSettings?.nativeTruncationBackup === 'number' ? composerSettings.nativeTruncationBackup : null,
                nativeMessageCount: document.querySelectorAll('#chat > .mes').length,
                chatuiRootMounted: document.querySelector('#chatui-root[data-cui-root-mounted="1"]') !== null,
            };
        });
        record('bootstrap mode never mounts the replacement UI (this session never activated ChatUI)', () => {
            assert.equal(booted.chatuiRootMounted, false);
        });
        record('self-heal restores the live chat_truncation to the original fixture value', () => {
            assert.equal(booted.liveChatTruncation, originalChatTruncation);
        });
        record('self-heal clears the in-memory backup', () => {
            assert.equal(booted.backup, null);
        });
        record('native chat renders per the restored (non-sentinel) value', () => {
            assert.equal(booted.nativeMessageCount, Math.min(conversation.messageCount, originalChatTruncation));
        });

        const persisted = await waitForSettingsOnDisk(
            generated.paths.settings,
            settings => (
                settings.power_user?.chat_truncation === originalChatTruncation
                && settings.extension_settings?.chatui_composer?.nativeTruncationBackup === undefined
            ),
            'selfHealNativeTruncation() must persist the restored value and clear the backup to disk',
        );
        record('the restored chat_truncation and cleared backup are durably persisted to disk', () => {
            assert.equal(persisted.power_user.chat_truncation, originalChatTruncation);
            assert.equal(persisted.extension_settings.chatui_composer.nativeTruncationBackup, undefined);
        });
        record('no console errors across the self-heal boot', () => {
            assert.deepEqual(pageErrors, []);
            assert.deepEqual(chatuiErrors, []);
        });

        return { name: 'scenario-b', assertions, pageErrors, chatuiErrors };
    } catch (error) {
        if (page) {
            try {
                await page.screenshot({ path: path.join(scenarioEvidenceRoot, 'failure.png') });
            } catch {
                // Preserve the original failure when the page is already gone.
            }
        }
        throw error;
    } finally {
        if (context) await context.close();
        if (browser) await browser.close();
        if (server) {
            await server.stop();
            await Promise.all([
                copyIfPresent(server.paths.stdout, path.join(scenarioEvidenceRoot, 'sillytavern.stdout.log')),
                copyIfPresent(server.paths.stderr, path.join(scenarioEvidenceRoot, 'sillytavern.stderr.log')),
            ]);
        }
        await inspectStCheckout({ stRoot });
        await fs.rm(runRoot, { recursive: true, force: true });
    }
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function verifyTruncationGuard({
    stRoot,
    fixture = DEFAULT_FIXTURE,
    evidenceRoot,
}) {
    if (!stRoot) throw new Error('stRoot is required (set SILLYTAVERN_TEST_ROOT)');
    if (!/^[a-z0-9-]+$/i.test(fixture)) throw new Error('fixture must be one safe directory name');

    const resolvedEvidenceRoot = path.resolve(evidenceRoot ?? defaultEvidenceRoot());
    await fs.rm(resolvedEvidenceRoot, { recursive: true, force: true });
    await fs.mkdir(resolvedEvidenceRoot, { recursive: true });

    const scenarioA = await runScenarioA({ stRoot, fixture, evidenceRoot: resolvedEvidenceRoot });
    const scenarioB = await runScenarioB({ stRoot, fixture, evidenceRoot: resolvedEvidenceRoot });

    const report = {
        schemaVersion: 1,
        recordedAt: new Date().toISOString(),
        fixture,
        scenarios: [scenarioA, scenarioB],
    };
    const reportPath = path.join(resolvedEvidenceRoot, 'report.json');
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 4)}\n`, 'utf8');
    return { evidenceRoot: resolvedEvidenceRoot, reportPath, report };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const result = await verifyTruncationGuard({
        stRoot: process.env.SILLYTAVERN_TEST_ROOT,
        ...options,
    });
    for (const scenario of result.report.scenarios) {
        console.log(`[SillyLounge guard] ${scenario.name}: ${scenario.assertions.length} assertions passed`);
        for (const assertion of scenario.assertions) console.log(`  - ${assertion}`);
    }
    console.log(`[SillyLounge guard] evidence: ${result.evidenceRoot}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
