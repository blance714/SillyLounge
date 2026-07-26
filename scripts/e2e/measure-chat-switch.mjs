import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance as nodePerformance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

import { DESKTOP_VIEWPORT, REDUCED_MOTION } from './browser-baseline.mjs';
import { generateStDataRoot } from './generate-data-root.mjs';
import { inspectStCheckout, startStServer } from './st-process.mjs';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const RUNTIME_ROOT = path.join(PROJECT_ROOT, '.runtime', 'SillyTavern-ChatUI');
const FIXTURE_ROOT = path.join(PROJECT_ROOT, 'test', 'e2e', 'fixtures');
const DEFAULT_FIXTURE = 'long-rich-switch';
const CHAT_STORE_BROWSER_MODULE = '/scripts/extensions/third-party/SillyLounge/store/chat-store.js';
const MESSAGE_EDIT_DRAFT_BROWSER_MODULE = '/scripts/extensions/third-party/SillyLounge/store/message-edit-draft-store.js';

function defaultOutput(fixture, suffix = '') {
    return path.join(PROJECT_ROOT, 'test-results', 'performance', `${fixture}${suffix}.json`);
}

function defaultEvidenceRoot(fixture) {
    return path.join(PROJECT_ROOT, 'test-results', 'performance', `${fixture}-evidence`);
}

function parseArgs(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--') continue;
        if (!['--fixture', '--output', '--evidence-root', '--native-truncation', '--truncation-guard'].includes(argument)) {
            throw new Error(`unknown argument: ${argument}`);
        }
        const value = argv[index + 1];
        if (!value || value.startsWith('--')) {
            throw new Error(`${argument} requires a value`);
        }
        if (argument === '--fixture') options.fixture = value;
        if (argument === '--output') options.output = value;
        if (argument === '--evidence-root') options.evidenceRoot = value;
        if (argument === '--native-truncation') options.nativeTruncation = Number(value);
        // Selects the real product flag path (settings.nativeTruncationOverrideEnabled,
        // read by src/index.ts's setup() -> activateNativeTruncationGuard()) rather
        // than the tool-level `--native-truncation` poke below, which writes
        // power_user.chat_truncation directly and never runs that production code.
        if (argument === '--truncation-guard') {
            if (!['on', 'off'].includes(value)) throw new Error('--truncation-guard must be on or off');
            options.truncationGuardFlag = value === 'on';
        }
        index += 1;
    }
    return options;
}

function normalizeNativeTruncation(value) {
    const count = value ?? 100;
    if (!Number.isInteger(count) || count < 0 || count > 1000) {
        throw new Error('nativeTruncation must be an integer between 0 and 1000');
    }
    return count;
}

function toStNativeTruncation(count) {
    // ST treats 0 as "unlimited" via `chat_truncation || MAX_SAFE_INTEGER`.
    // A negative in-memory sentinel makes its start index exceed chat.length,
    // producing an empty native message slice without persisting a setting.
    return count === 0 ? -1 : count;
}

function summarizeDurations(entries) {
    const durations = entries.map(entry => entry.duration);
    return {
        count: durations.length,
        totalMs: durations.reduce((sum, duration) => sum + duration, 0),
        maxMs: durations.length > 0 ? Math.max(...durations) : 0,
    };
}

function metricMap(response) {
    return Object.fromEntries(response.metrics.map(metric => [metric.name, metric.value]));
}

async function copyIfPresent(source, destination) {
    try {
        await fs.copyFile(source, destination);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
}

async function waitForConversation(page, expected, allFileNames) {
    await page.waitForFunction(({ expected, allFileNames }) => {
        const context = globalThis.SillyTavern?.getContext?.();
        const root = document.querySelector('#chatui-root[data-cui-root-mounted="1"]');
        const list = root?.querySelector('.cui-root-message-list');
        const articles = list?.querySelectorAll('article.cui-root-message') ?? [];
        const lastMessage = root?.querySelector(`[data-cui-message-id="${expected.messageCount - 1}"]`);
        const currentRow = root?.querySelector('.cui-root-nested-chat-row.is-current .cui-root-nested-chat-row-name');
        const topbarTitle = root?.querySelector('.cui-root-topbar-title');
        const listedChats = Array.from(root?.querySelectorAll('.cui-root-nested-chat-row-name') ?? [])
            .map(element => element.textContent?.trim());
        return Boolean(
            context?.chatId === expected.fileName
            && context.chat?.length === expected.messageCount
            && list?.getAttribute('data-cui-virtual-count') === String(expected.messageCount)
            && articles.length > 0
            && articles.length < expected.messageCount
            && lastMessage?.textContent?.includes(expected.marker)
            && !lastMessage?.textContent?.includes(expected.otherMarker)
            && currentRow?.textContent?.trim() === expected.fileName
            && topbarTitle?.textContent?.trim() === expected.fileName
            && allFileNames.every(fileName => listedChats.includes(fileName))
            && root?.querySelector('[aria-label="快速跳转用户回合"]')?.getAttribute('aria-valuemax') === String(expected.userTurns)
            && !document.querySelector('dialog[open]')
        );
    }, { expected, allFileNames }, { timeout: 120_000 });
    const contentReadyAt = nodePerformance.now();
    await page.waitForFunction(() => (
        performance.now() - (globalThis.__sillyLoungeSwitchPerf?.lastMutation ?? 0) >= 200
    ), null, { timeout: 30_000 });
    await page.evaluate(() => new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
    return contentReadyAt;
}

async function assertConversationEdges(page, expected) {
    const rail = page.locator('[aria-label="快速跳转用户回合"]');
    await rail.press('Home');
    await page.waitForFunction(expected => {
        const railElement = document.querySelector('[aria-label="快速跳转用户回合"]');
        const firstMessage = document.querySelector('[data-cui-message-id="0"]');
        return railElement?.getAttribute('aria-valuenow') === '1'
            && firstMessage?.textContent?.includes(expected.marker)
            && !firstMessage?.textContent?.includes(expected.otherMarker);
    }, expected, { timeout: 30_000 });
    await rail.press('End');
    await page.waitForFunction(expected => {
        const railElement = document.querySelector('[aria-label="快速跳转用户回合"]');
        const lastMessage = document.querySelector(`[data-cui-message-id="${expected.messageCount - 1}"]`);
        return railElement?.getAttribute('aria-valuenow') === String(expected.userTurns)
            && lastMessage?.textContent?.includes(expected.marker)
            && !lastMessage?.textContent?.includes(expected.otherMarker);
    }, expected, { timeout: 30_000 });
    await page.waitForFunction(() => (
        performance.now() - (globalThis.__sillyLoungeSwitchPerf?.lastMutation ?? 0) >= 200
    ), null, { timeout: 30_000 });
    await page.evaluate(() => new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
    await page.waitForFunction(() => {
        const rows = Array.from(document.querySelectorAll('.cui-root-virtual-message-row'))
            .sort((left, right) => Number(left.getAttribute('data-index')) - Number(right.getAttribute('data-index')));
        return rows.every((row, index) => {
            const next = rows[index + 1];
            if (!next) return true;
            return row.getBoundingClientRect().bottom <= next.getBoundingClientRect().top + 1;
        });
    }, null, { timeout: 30_000 });
}

async function assertSmoothConversationEdges(page, expected) {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    try {
        await assertConversationEdges(page, expected);
    } finally {
        await page.emulateMedia({ reducedMotion: REDUCED_MOTION });
    }
}

/**
 * The editing-row pin may add the one offscreen editor to the virtualizer's
 * ordinary top window, but it must not widen that ordinary window. Comparing
 * against a real unedited baseline is valid for both long chats and short
 * controls: a fixed "50 messages away" threshold incorrectly rejects the
 * 10-floor fixture even when its top window is perfectly bounded.
 */
export function assertPinnedWindowMatchesBaseline(baselineRowIndexes, pinnedRowIndexes, editMessageId) {
    assert.equal(
        pinnedRowIndexes.includes(editMessageId),
        true,
        'editing row must stay mounted while scrolled far away (rangeExtractor pin)',
    );
    assert.deepEqual(
        pinnedRowIndexes.filter(index => index !== editMessageId),
        baselineRowIndexes.filter(index => index !== editMessageId),
        'editing-row pin must not widen the ordinary virtual window',
    );
}

async function waitForTopEdge(page, target) {
    await page.waitForFunction(target => {
        const railElement = document.querySelector('[aria-label="快速跳转用户回合"]');
        const firstMessage = document.querySelector('[data-cui-message-id="0"]');
        return railElement?.getAttribute('aria-valuenow') === '1'
            && firstMessage?.textContent?.includes(target.marker)
            && !firstMessage?.textContent?.includes(target.otherMarker);
    }, target, { timeout: 30_000 });
    await page.waitForFunction(() => (
        performance.now() - (globalThis.__sillyLoungeSwitchPerf?.lastMutation ?? 0) >= 200
    ), null, { timeout: 30_000 });
}

async function waitForBottomEdge(page, target) {
    await page.waitForFunction(target => {
        const railElement = document.querySelector('[aria-label="快速跳转用户回合"]');
        const lastMessage = document.querySelector(`[data-cui-message-id="${target.messageCount - 1}"]`);
        return railElement?.getAttribute('aria-valuenow') === String(target.userTurns)
            && lastMessage?.textContent?.includes(target.marker)
            && !lastMessage?.textContent?.includes(target.otherMarker);
    }, target, { timeout: 30_000 });
    await page.waitForFunction(() => (
        performance.now() - (globalThis.__sillyLoungeSwitchPerf?.lastMutation ?? 0) >= 200
    ), null, { timeout: 30_000 });
}

async function mountedVirtualRowIndexes(page) {
    return page.locator('.cui-root-virtual-message-row').evaluateAll(rows => (
        rows
            .map(row => Number(row.getAttribute('data-index')))
            .sort((left, right) => left - right)
    ));
}

async function waitForSettledEditorFocus(page, editMessageId) {
    // MessageEditor's mount effect focuses the textarea and collapses the
    // cursor to the end asynchronously. Wait for that real user-visible state
    // before Locator.fill() performs its focus + select-all replacement.
    await page.waitForFunction(editMessageId => {
        const textarea = document.querySelector(
            `[data-cui-message-id="${editMessageId}"] .cui-root-edit-textarea`,
        );
        return textarea instanceof HTMLTextAreaElement
            && document.activeElement === textarea
            && textarea.selectionStart === textarea.value.length
            && textarea.selectionEnd === textarea.value.length;
    }, editMessageId, { timeout: 5_000 });
}

async function readEditDraftState(page, messageId) {
    return page.evaluate(async ({ modulePath, messageId }) => {
        const context = globalThis.SillyTavern?.getContext?.();
        const drafts = await import(modulePath);
        return {
            mes: context?.chat?.[messageId]?.mes,
            remainingDrafts: Object.keys(drafts.getMessageEditDraftStoreSnapshot().drafts),
        };
    }, { modulePath: MESSAGE_EDIT_DRAFT_BROWSER_MODULE, messageId });
}

/**
 * Drives the full historical-user-message path in a real browser: establish
 * the ordinary top virtual window, open an editor near the bottom, carry its
 * draft through a far-away scroll using the rangeExtractor pin, save, prove
 * the external draft was cleared, then unmount/remount the saved row and read
 * the committed text back from both ST state and rendered DOM.
 */
async function assertHistoricalUserEditPersists(page, target) {
    // An interior *user* turn a few floors before the last one: user messages
    // tile the Edit action inline (no overflow menu to open first -- see
    // MessageActions.tsx's canShowUserMenu branch), the text is short (fast
    // to diff), and it stays clear of the marker text baked into message 0
    // and message (messageCount - 1) by applyConversationMarker.
    const editMessageId = target.messageCount - 4;
    const rail = page.locator('[aria-label="快速跳转用户回合"]');
    const article = page.locator(`[data-cui-message-id="${editMessageId}"]`);

    await rail.press('Home');
    await waitForTopEdge(page, target);
    const baselineRowIndexes = await mountedVirtualRowIndexes(page);
    assert.equal(baselineRowIndexes.length > 0, true);
    await rail.press('End');
    await waitForBottomEdge(page, target);

    await article.waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(
        await article.getAttribute('data-cui-message-role'),
        'user',
        'scroll-during-edit target must be a user turn (fixture role layout drifted)',
    );
    const originalMes = await page.evaluate(editMessageId => (
        globalThis.SillyTavern?.getContext?.()?.chat?.[editMessageId]?.mes
    ), editMessageId);
    assert.equal(typeof originalMes, 'string');

    await article.hover();
    await article.getByRole('button', { name: 'Edit' }).click();
    const editor = article.locator('.cui-root-edit-textarea');
    await editor.waitFor({ state: 'visible', timeout: 30_000 });
    await waitForSettledEditorFocus(page, editMessageId);
    const marker = `SAVED-HISTORICAL-USER-EDIT::${target.fileName}::${editMessageId}`;
    await editor.fill(marker);
    assert.equal(await editor.inputValue(), marker);

    await rail.press('Home');
    await waitForTopEdge(page, target);

    // The editor remains mounted with its draft, while every other row exactly
    // matches the ordinary top window captured before editing.
    const farState = await page.evaluate(editMessageId => {
        const rowIndexes = Array.from(document.querySelectorAll('.cui-root-virtual-message-row'))
            .map(row => Number(row.getAttribute('data-index')))
            .sort((left, right) => left - right);
        const editorTextarea = document.querySelector(
            `[data-cui-message-id="${editMessageId}"] .cui-root-edit-textarea`,
        );
        return {
            rowIndexes,
            editorPresent: editorTextarea !== null,
            editorValue: editorTextarea instanceof HTMLTextAreaElement ? editorTextarea.value : null,
        };
    }, editMessageId);
    assert.equal(farState.editorPresent, true);
    assert.equal(farState.editorValue, marker, 'pinned editor must retain the typed draft while far away');
    assertPinnedWindowMatchesBaseline(baselineRowIndexes, farState.rowIndexes, editMessageId);

    await rail.press('End');
    await waitForBottomEdge(page, target);

    const editorAfterReturn = article.locator('.cui-root-edit-textarea');
    await editorAfterReturn.waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(
        await editorAfterReturn.inputValue(),
        marker,
        'draft must survive the round trip back to the message unchanged',
    );

    await article.getByRole('button', { name: 'Save edit' }).click();
    await page.waitForFunction(({ editMessageId, marker }) => {
        const context = globalThis.SillyTavern?.getContext?.();
        const editedArticle = document.querySelector(`[data-cui-message-id="${editMessageId}"]`);
        return context?.chat?.[editMessageId]?.mes === marker
            && editedArticle?.querySelector('.cui-root-edit-textarea') === null
            && editedArticle?.querySelector('.cui-root-message-body')?.textContent?.includes(marker);
    }, { editMessageId, marker }, { timeout: 30_000 });
    const savedState = await readEditDraftState(page, editMessageId);
    assert.equal(savedState.mes, marker, 'save must commit the historical edit to SillyTavern state');
    assert.deepEqual(savedState.remainingDrafts, [], 'save must clear the external message-edit draft');

    // Once save closes the editor, the special pin is gone. Scroll away and
    // back once more so the final DOM assertion reads from a normal remount.
    await rail.press('Home');
    await waitForTopEdge(page, target);
    if (!baselineRowIndexes.includes(editMessageId)) {
        assert.equal(
            await page.locator(`[data-cui-message-id="${editMessageId}"]`).count(),
            0,
            'saved historical row should unmount normally after its editing pin is released',
        );
    }
    await rail.press('End');
    await waitForBottomEdge(page, target);
    await article.waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(
        (await article.locator('.cui-root-message-body').textContent())?.includes(marker),
        true,
        'saved historical edit must survive a normal virtual-row unmount/remount',
    );

    return {
        messageId: editMessageId,
        baselineMountedRows: baselineRowIndexes.length,
        pinnedMountedRows: farState.rowIndexes.length,
        draftCleared: savedState.remainingDrafts.length === 0,
        remountVerified: true,
    };
}

/**
 * Character messages expose Edit only through their portaled overflow menu.
 * Drive that presentation rather than invoking local component state or the
 * adapter directly, then prove the same save contract reaches ST and the DOM.
 */
async function assertCharacterOverflowEditPersists(page, target) {
    const editMessageId = target.messageCount - 3;
    const article = page.locator(`[data-cui-message-id="${editMessageId}"]`);
    await article.waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(
        await article.getAttribute('data-cui-message-role'),
        'character',
        'overflow-edit target must be a character turn (fixture role layout drifted)',
    );

    await article.hover();
    await article.getByRole('button', { name: 'More actions' }).click();
    const overflowMenu = page.locator('body > .cui-root-menu');
    await overflowMenu.waitFor({ state: 'visible', timeout: 5_000 });
    await overflowMenu.locator('.cui-root-menu-item').filter({ hasText: /^Edit$/ }).click();

    const editor = article.locator('.cui-root-edit-textarea');
    await editor.waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(await overflowMenu.count(), 0, 'choosing Edit must close the portaled overflow menu');
    await waitForSettledEditorFocus(page, editMessageId);
    const marker = `SAVED-CHARACTER-OVERFLOW-EDIT::${target.fileName}::${editMessageId}`;
    await editor.fill(marker);
    await article.getByRole('button', { name: 'Save edit' }).click();
    await page.waitForFunction(({ editMessageId, marker }) => {
        const context = globalThis.SillyTavern?.getContext?.();
        const editedArticle = document.querySelector(`[data-cui-message-id="${editMessageId}"]`);
        return context?.chat?.[editMessageId]?.mes === marker
            && editedArticle?.querySelector('.cui-root-edit-textarea') === null
            && editedArticle?.querySelector('.cui-root-message-body')?.textContent?.includes(marker);
    }, { editMessageId, marker }, { timeout: 30_000 });
    const savedState = await readEditDraftState(page, editMessageId);
    assert.equal(savedState.mes, marker, 'overflow-menu edit must commit the character message to SillyTavern state');
    assert.deepEqual(savedState.remainingDrafts, [], 'character edit save must clear the external draft');

    return {
        messageId: editMessageId,
        enteredThroughOverflowMenu: true,
        draftCleared: savedState.remainingDrafts.length === 0,
    };
}

async function captureBrowserState(page, cdp) {
    const metrics = metricMap(await cdp.send('Performance.getMetrics'));
    const dom = await page.evaluate(async chatStoreModule => {
        const store = await import(chatStoreModule);
        return {
            totalElements: document.querySelectorAll('*').length,
            nativeMessages: document.querySelectorAll('#chat > .mes').length,
            rootArticles: document.querySelectorAll('.cui-root-message-list article.cui-root-message').length,
            rootButtons: document.querySelectorAll('#chatui-root button').length,
            rootFrames: document.querySelectorAll('#chatui-root iframe.cui-embed-frame').length,
            rootThoughts: document.querySelectorAll('#chatui-root [data-synthetic-regex="thought"]').length,
            openDialogs: document.querySelectorAll('dialog[open]').length,
            messageCache: store.getChatuiMessageCacheStats(),
        };
    }, CHAT_STORE_BROWSER_MODULE);
    return {
        ...dom,
        heapBytes: metrics.JSHeapUsedSize ?? null,
        nodes: metrics.Nodes ?? null,
    };
}

async function captureCollectedBrowserState(page, cdp) {
    const beforeGc = await captureBrowserState(page, cdp);
    await cdp.send('HeapProfiler.collectGarbage');
    const afterGc = await captureBrowserState(page, cdp);
    return { beforeGc, afterGc };
}

async function switchConversation({ page, cdp, target, allFileNames, screenshotPath }) {
    const row = page.locator('.cui-root-nested-chat-row').filter({ hasText: target.fileName });
    await row.waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(await row.count(), 1, `expected one sidebar row for ${target.fileName}`);
    const browserStarted = await page.evaluate(() => performance.now());
    const wallStarted = nodePerformance.now();
    await row.click();
    const contentReadyAt = await waitForConversation(page, target, allFileNames);
    const settledMs = nodePerformance.now() - wallStarted;
    const ready = await captureBrowserState(page, cdp);
    const longTasks = await page.evaluate(started => (
        globalThis.__sillyLoungeSwitchPerf.longTasks.filter(entry => entry.startTime >= started)
    ), browserStarted);
    await assertConversationEdges(page, target);
    await page.screenshot({ path: screenshotPath });
    const states = await captureCollectedBrowserState(page, cdp);
    return {
        from: target.otherFileName,
        to: target.fileName,
        contentReadyMs: contentReadyAt - wallStarted,
        settledMs,
        longTasks: summarizeDurations(longTasks),
        ready,
        ...states,
    };
}

export async function measureChatSwitch({
    stRoot,
    fixture = DEFAULT_FIXTURE,
    output,
    evidenceRoot,
    nativeTruncation,
    truncationGuardFlag = true,
}) {
    if (!stRoot) throw new Error('stRoot is required (set SILLYTAVERN_TEST_ROOT)');
    if (!/^[a-z0-9-]+$/i.test(fixture)) throw new Error('fixture must be one safe directory name');
    // Tool-level `--native-truncation` still validates eagerly even in flag
    // mode so a bad combination fails before a browser launches; the value
    // itself is unused once the real flag is live (see below).
    const resolvedNativeTruncation = normalizeNativeTruncation(nativeTruncation);
    if (truncationGuardFlag && nativeTruncation !== undefined) {
        throw new Error('nativeTruncation and truncationGuardFlag are mutually exclusive');
    }

    const resolvedOutput = path.resolve(output ?? defaultOutput(fixture, truncationGuardFlag ? '' : '-truncation-guard-off'));
    const resolvedEvidenceRoot = path.resolve(
        evidenceRoot ?? defaultEvidenceRoot(truncationGuardFlag ? fixture : `${fixture}-truncation-guard-off`),
    );
    const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sillylounge-switch-'));
    const dataRoot = path.join(runRoot, 'data');
    let browser = null;
    let context = null;
    let page = null;
    let server = null;
    const pageErrors = [];
    const chatuiErrors = [];

    await fs.mkdir(path.dirname(resolvedOutput), { recursive: true });
    await fs.rm(resolvedOutput, { force: true });
    await fs.rm(resolvedEvidenceRoot, { recursive: true, force: true });
    await fs.mkdir(resolvedEvidenceRoot, { recursive: true });

    try {
        const generated = await generateStDataRoot({
            targetRoot: dataRoot,
            stRoot,
            runtimeRoot: RUNTIME_ROOT,
            fixturePath: path.join(FIXTURE_ROOT, fixture, 'fixture.json'),
            extensionMode: 'active',
            regexMode: 'active',
            // Real product flag path: src/index.ts's setup() reads this at
            // APP_READY and calls activateNativeTruncationGuard(), which backs
            // up and overrides power_user.chat_truncation itself. Distinct from
            // the tool-level `page.evaluate` poke below, which never exercises
            // that code.
            nativeTruncationOverrideEnabled: truncationGuardFlag,
        });
        const conversations = generated.manifest.conversations;
        assert.equal(conversations.length, 2, 'switch fixture must contain exactly two conversations');
        const [primaryConversation] = conversations;
        assert.equal(primaryConversation.userTurns > 0, true);
        assert.equal(primaryConversation.messageCount, primaryConversation.userTurns * 2);
        assert.equal(
            conversations.every(conversation => (
                conversation.userTurns === primaryConversation.userTurns
                && conversation.messageCount === primaryConversation.messageCount
            )),
            true,
            'switch fixture conversations must have identical floor and message counts',
        );
        assert.equal(conversations.every(conversation => conversation.marker), true);

        server = await startStServer({ stRoot, runRoot, dataRoot, readyTimeoutMs: 120_000 });
        browser = await chromium.launch({ headless: true });
        context = await browser.newContext({
            viewport: DESKTOP_VIEWPORT,
            reducedMotion: REDUCED_MOTION,
        });
        page = await context.newPage();
        page.on('pageerror', error => pageErrors.push(error.stack ?? error.message));
        page.on('console', message => {
            if (message.type() === 'error' && message.text().includes('[ChatUI]')) {
                chatuiErrors.push(message.text());
            }
        });
        await page.addInitScript(() => {
            const state = { longTasks: [], lastMutation: 0 };
            globalThis.__sillyLoungeSwitchPerf = state;
            try {
                new PerformanceObserver(list => {
                    for (const entry of list.getEntries()) {
                        state.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
                    }
                }).observe({ type: 'longtask', buffered: true });
            } catch {
                // Unsupported long-task observation stays empty in the report.
            }
            const observe = () => {
                state.lastMutation = performance.now();
                new MutationObserver(() => {
                    state.lastMutation = performance.now();
                }).observe(document.documentElement, {
                    subtree: true,
                    childList: true,
                    attributes: true,
                    characterData: true,
                });
            };
            if (document.documentElement) observe();
            else document.addEventListener('DOMContentLoaded', observe, { once: true });
        });
        const cdp = await context.newCDPSession(page);
        await cdp.send('Performance.enable');
        await page.goto(server.url, { waitUntil: 'domcontentloaded', timeout: 120_000 });

        const [first, second] = conversations;
        const allFileNames = conversations.map(conversation => conversation.fileName);
        const expected = (current, other) => ({
            ...current,
            otherFileName: other.fileName,
            otherMarker: other.marker,
        });
        await waitForConversation(page, expected(first, second), allFileNames);
        await assertConversationEdges(page, expected(first, second));
        await assertSmoothConversationEdges(page, expected(first, second));
        // Product flag-on: activateNativeTruncationGuard() already applied at
        // boot. Product flag-off: prove the persisted false stayed authoritative
        // at runtime before any optional tool experiment can touch the value.
        // In particular, a mistakenly-live guard would leave both sentinel=1
        // and a backup; checking this first prevents the tool poke from washing
        // that product regression green.
        if (!truncationGuardFlag) {
            const flagOffState = await page.evaluate(() => {
                const context = globalThis.SillyTavern?.getContext?.();
                const composerSettings = context?.extensionSettings?.chatui_composer;
                return {
                    configured: composerSettings?.config?.nativeTruncationOverrideEnabled,
                    liveChatTruncation: context?.powerUserSettings?.chat_truncation,
                    backupPresent: typeof composerSettings?.nativeTruncationBackup === 'number',
                };
            });
            assert.deepEqual(flagOffState, {
                configured: false,
                liveChatTruncation: generated.manifest.nativeTruncation.originalChatTruncation,
                backupPresent: false,
            });
        }
        // `--native-truncation` is a separate, explicitly requested experiment.
        // With no such argument, flag-off leaves the user's generated setting
        // untouched and the browser measures that real product-off path.
        if (!truncationGuardFlag && nativeTruncation !== undefined) {
            await page.evaluate(async count => {
                const { power_user: powerUser } = await import('/scripts/power-user.js');
                powerUser.chat_truncation = count;
            }, toStNativeTruncation(resolvedNativeTruncation));
        }
        const requestedNativeMessages = truncationGuardFlag
            ? generated.manifest.nativeTruncation.overrideSentinel
            : nativeTruncation !== undefined
                ? resolvedNativeTruncation
                : generated.manifest.nativeTruncation.originalChatTruncation;
        const expectedNativeMessages = Math.min(requestedNativeMessages, primaryConversation.messageCount);
        const initial = {
            chatId: first.fileName,
            ...await captureCollectedBrowserState(page, cdp),
        };
        await page.screenshot({ path: path.join(resolvedEvidenceRoot, 'initial-a.png') });
        const transitions = [
            await switchConversation({
                page,
                cdp,
                target: expected(second, first),
                allFileNames,
                screenshotPath: path.join(resolvedEvidenceRoot, 'after-a-to-b.png'),
            }),
            await switchConversation({
                page,
                cdp,
                target: expected(first, second),
                allFileNames,
                screenshotPath: path.join(resolvedEvidenceRoot, 'after-b-to-a.png'),
            }),
        ];
        // Keep mutation-heavy edit acceptance outside the timed transition
        // samples above. The disposable final A conversation can now be edited
        // without shrinking rich HTML or otherwise contaminating the switch
        // report's DOM/heap measurements.
        const editAcceptance = {
            historicalUser: await assertHistoricalUserEditPersists(page, expected(first, second)),
            characterOverflow: await assertCharacterOverflowEditPersists(page, expected(first, second)),
        };
        await page.screenshot({ path: path.join(resolvedEvidenceRoot, 'edit-acceptance.png') });

        assert.equal(transitions.every(transition => (
            transition.beforeGc.rootArticles > 0
            && transition.beforeGc.rootArticles < first.messageCount
        )), true);
        assert.equal(transitions.every(transition => (
            transition.afterGc.rootArticles > 0
            && transition.afterGc.rootArticles < first.messageCount
        )), true);
        assert.equal(transitions.every(transition => (
            transition.ready.messageCache.indexedMessages === first.messageCount
            && transition.ready.messageCache.materializedMessages < first.messageCount
            && transition.ready.messageCache.materializationsSinceRefresh < first.messageCount
        )), true);
        assert.equal(transitions.every(transition => (
            transition.ready.nativeMessages === expectedNativeMessages
        )), true);
        assert.equal(transitions.every(transition => transition.afterGc.openDialogs === 0), true);
        assert.deepEqual(pageErrors, []);
        assert.deepEqual(chatuiErrors, []);

        const report = {
            schemaVersion: 3,
            recordedAt: new Date().toISOString(),
            st: generated.manifest.st,
            browser: 'chromium',
            viewport: DESKTOP_VIEWPORT,
            nativeTruncation: expectedNativeMessages,
            nativeTruncationMode: truncationGuardFlag
                ? 'product-flag'
                : nativeTruncation !== undefined
                    ? 'tool-override'
                    : 'product-flag-off',
            truncationGuardFlag,
            fixture: {
                id: generated.manifest.fixture,
                conversations,
            },
            initial,
            transitions,
            editAcceptance,
            errors: { page: pageErrors, chatui: chatuiErrors },
        };
        await fs.writeFile(resolvedOutput, `${JSON.stringify(report, null, 4)}\n`, 'utf8');
        return { output: resolvedOutput, evidenceRoot: resolvedEvidenceRoot, report };
    } catch (error) {
        if (page) {
            try {
                await page.screenshot({ path: path.join(resolvedEvidenceRoot, 'failure.png') });
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
                copyIfPresent(server.paths.stdout, path.join(resolvedEvidenceRoot, 'sillytavern.stdout.log')),
                copyIfPresent(server.paths.stderr, path.join(resolvedEvidenceRoot, 'sillytavern.stderr.log')),
            ]);
        }
        await inspectStCheckout({ stRoot });
        await fs.rm(runRoot, { recursive: true, force: true });
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const result = await measureChatSwitch({
        stRoot: process.env.SILLYTAVERN_TEST_ROOT,
        ...options,
    });
    console.table(Object.fromEntries(result.report.transitions.map(transition => [
        `${transition.from} -> ${transition.to}`,
        {
            contentReadyMs: Math.round(transition.contentReadyMs),
            settledMs: Math.round(transition.settledMs),
            longTaskMs: Math.round(transition.longTasks.totalMs),
            elements: transition.afterGc.totalElements,
            nativeMessages: transition.afterGc.nativeMessages,
            articles: transition.afterGc.rootArticles,
            materialized: transition.ready.messageCache.materializedMessages,
            heapBeforeGcMiB: Math.round(transition.beforeGc.heapBytes / 1024 / 1024),
            heapAfterGcMiB: Math.round(transition.afterGc.heapBytes / 1024 / 1024),
        },
    ])));
    console.log(`[SillyLounge switch] report: ${result.output}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
