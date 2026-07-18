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

function defaultOutput(fixture) {
    return path.join(PROJECT_ROOT, 'test-results', 'performance', `${fixture}.json`);
}

function defaultEvidenceRoot(fixture) {
    return path.join(PROJECT_ROOT, 'test-results', 'performance', `${fixture}-evidence`);
}

function parseArgs(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--') continue;
        if (!['--fixture', '--output', '--evidence-root', '--native-truncation'].includes(argument)) {
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
}) {
    if (!stRoot) throw new Error('stRoot is required (set SILLYTAVERN_TEST_ROOT)');
    if (!/^[a-z0-9-]+$/i.test(fixture)) throw new Error('fixture must be one safe directory name');
    const resolvedNativeTruncation = normalizeNativeTruncation(nativeTruncation);

    const resolvedOutput = path.resolve(output ?? defaultOutput(fixture));
    const resolvedEvidenceRoot = path.resolve(evidenceRoot ?? defaultEvidenceRoot(fixture));
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
        await page.evaluate(async count => {
            const { power_user: powerUser } = await import('/scripts/power-user.js');
            powerUser.chat_truncation = count;
        }, toStNativeTruncation(resolvedNativeTruncation));
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
            transition.ready.nativeMessages === resolvedNativeTruncation
        )), true);
        assert.equal(transitions.every(transition => transition.afterGc.openDialogs === 0), true);
        assert.deepEqual(pageErrors, []);
        assert.deepEqual(chatuiErrors, []);

        const report = {
            schemaVersion: 2,
            recordedAt: new Date().toISOString(),
            st: generated.manifest.st,
            browser: 'chromium',
            viewport: DESKTOP_VIEWPORT,
            nativeTruncation: resolvedNativeTruncation,
            fixture: {
                id: generated.manifest.fixture,
                conversations,
            },
            initial,
            transitions,
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
