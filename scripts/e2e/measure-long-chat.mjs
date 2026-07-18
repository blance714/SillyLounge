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
const DEFAULT_FIXTURE = 'long-plain';
const MODES = Object.freeze(['disabled', 'bootstrap', 'active']);
const DURATION_METRICS = Object.freeze([
    'TaskDuration',
    'ScriptDuration',
    'LayoutDuration',
    'RecalcStyleDuration',
    'LayoutCount',
    'RecalcStyleCount',
]);

function parseArgs(argv) {
    const values = { repetitions: 1, warmups: 0, fixture: DEFAULT_FIXTURE, regex: 'active' };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--') continue;
        if (!argument.startsWith('--')) throw new Error(`invalid argument: ${argument}`);
        const value = argv[index + 1];
        if (!value) throw new Error(`${argument} requires a value`);
        values[argument.slice(2)] = value;
        index += 1;
    }
    for (const key of ['repetitions', 'warmups']) {
        const numeric = Number(values[key]);
        const minimum = key === 'warmups' ? 0 : 1;
        if (!Number.isInteger(numeric) || numeric < minimum || numeric > 20) {
            throw new Error(`${key} must be an integer between ${minimum} and 20`);
        }
        values[key] = numeric;
    }
    if (!/^[a-z0-9-]+$/i.test(values.fixture)) {
        throw new Error('fixture must be one safe directory name');
    }
    if (!['active', 'disabled'].includes(values.regex)) {
        throw new Error('regex must be active or disabled');
    }
    return values;
}

function fixturePath(fixture) {
    return path.join(FIXTURE_ROOT, fixture, 'fixture.json');
}

function defaultOutput(fixture, regexMode) {
    const suffix = regexMode === 'active' ? '' : '-regex-disabled';
    return path.join(PROJECT_ROOT, 'test-results', 'performance', `${fixture}${suffix}.json`);
}

function metricMap(response) {
    return Object.fromEntries(response.metrics.map(metric => [metric.name, metric.value]));
}

function metricReport(before, after) {
    const durations = Object.fromEntries(DURATION_METRICS.map(name => [
        name,
        (after[name] ?? 0) - (before[name] ?? 0),
    ]));
    return {
        ...durations,
        JSHeapUsedSize: after.JSHeapUsedSize ?? null,
        Nodes: after.Nodes ?? null,
    };
}

function percentile(values, ratio) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function summarizeDurations(values) {
    return {
        count: values.length,
        totalMs: values.reduce((sum, value) => sum + value, 0),
        maxMs: values.length === 0 ? 0 : Math.max(...values),
        p95Ms: percentile(values, 0.95),
    };
}

function median(values) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
}

function modeOrder(iteration) {
    const offset = iteration % MODES.length;
    return [...MODES.slice(offset), ...MODES.slice(0, offset)];
}

async function waitForMeasuredPage(page, mode, expected) {
    await page.waitForFunction(({ selectedMode, expected }) => {
        const context = globalThis.SillyTavern?.getContext?.();
        if (!context || context.chatId !== expected.chatId || context.chat?.length !== expected.messageCount) return false;
        const nativeMessages = document.querySelectorAll('#chat .mes');
        const nativeLast = nativeMessages[nativeMessages.length - 1];
        if (
            nativeMessages.length !== Math.min(100, expected.messageCount)
            || nativeLast?.getAttribute('mesid') !== String(expected.messageCount - 1)
        ) return false;
        if (selectedMode !== 'active') {
            return !document.body.classList.contains('chatui-active');
        }
        const root = document.querySelector('#chatui-root[data-cui-root-mounted="1"]');
        const list = root?.querySelector('.cui-root-message-list');
        const latest = root?.querySelector(`[data-cui-message-id="${expected.messageCount - 1}"]`);
        const rail = root?.querySelector('[role="slider"][aria-label="快速跳转用户回合"]');
        const mountedMessages = list?.querySelectorAll('article.cui-root-message').length ?? 0;
        return Boolean(
            root
            && latest
            && list?.getAttribute('data-cui-virtual-count') === String(expected.messageCount)
            && mountedMessages > 0
            && mountedMessages < expected.messageCount
            && root.querySelector('[aria-label="ChatUI composer"]')
            && rail?.getAttribute('aria-valuemax') === String(expected.userTurns)
        );
    }, { selectedMode: mode, expected }, { timeout: 120_000 });
    await page.waitForFunction(() => (
        performance.now() - (globalThis.__sillyLoungePerf?.lastMutation ?? 0) >= 120
    ), null, { timeout: 30_000 });
    await page.evaluate(() => new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
}

async function exerciseFloorRail(page, expected) {
    const rail = page.locator('[role="slider"][aria-label="快速跳转用户回合"]');
    const list = page.locator('.cui-root-message-list');
    const rangeStart = rail.locator('.cui-root-floor-range-label.is-start');
    // The initial scroll anchor depends on message height and late iframe
    // sizing. Establish the same bottom precondition for every fixture before
    // measuring the rail's independent wheel window.
    await rail.press('End');
    await page.waitForFunction(userTurns => {
        const activeTurn = document.querySelector('[aria-label="快速跳转用户回合"]')?.getAttribute('aria-valuenow');
        const firstVisibleTurn = Number(
            document.querySelector('.cui-root-floor-range-label.is-start')?.textContent,
        );
        return activeTurn === String(userTurns) && firstVisibleTurn > 1;
    }, expected.userTurns);
    await list.evaluate(element => new Promise(resolve => {
        let previous = element.scrollTop;
        let stableFrames = 0;
        const observe = () => {
            const current = element.scrollTop;
            stableFrames = Math.abs(current - previous) < 0.5 ? stableFrames + 1 : 0;
            previous = current;
            if (stableFrames >= 4) resolve(undefined);
            else requestAnimationFrame(observe);
        };
        requestAnimationFrame(observe);
    }));
    const scrollBeforeWheel = await list.evaluate(element => element.scrollTop);
    const rangeBeforeWheel = Number(await rangeStart.textContent());
    const box = await rail.boundingBox();
    if (!box) throw new Error(`${expected.userTurns}-floor rail has no bounding box`);

    await page.evaluate(() => {
        const sample = { active: true, gaps: [], previous: performance.now() };
        globalThis.__sillyLoungeRafSample = sample;
        const tick = now => {
            sample.gaps.push(now - sample.previous);
            sample.previous = now;
            if (sample.active) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    });
    await rail.hover({ position: { x: 4, y: box.height / 2 } });
    await page.mouse.wheel(0, -120);
    await page.waitForFunction(previous => (
        Number(document.querySelector('.cui-root-floor-range-label.is-start')?.textContent) < previous
    ), rangeBeforeWheel);
    const rangeAfterWheel = Number(await rangeStart.textContent());
    const scrollAfterWheel = await list.evaluate(element => element.scrollTop);
    if (Math.abs(scrollAfterWheel - scrollBeforeWheel) > 1) {
        throw new Error('floor-rail wheel unexpectedly scrolled the message list');
    }

    await page.mouse.move(box.x + box.width + 100, box.y + box.height + 100);
    await rail.press('Home');
    await page.waitForFunction(() => (
        document.querySelector('[aria-label="快速跳转用户回合"]')?.getAttribute('aria-valuenow') === '1'
    ));
    const title = (await rail.locator('.cui-root-floor-popover-title').textContent())?.trim();
    const preview = (await rail.locator('.cui-root-floor-popover-preview').textContent())?.trim();
    if (!title || !preview) {
        throw new Error(`empty first-floor preview: ${JSON.stringify({ title, preview })}`);
    }
    if (expected.firstFloor) {
        if (title !== expected.firstFloor.title) throw new Error(`unexpected first-floor title: ${title}`);
        if (preview !== expected.firstFloor.preview) throw new Error(`unexpected first-floor preview: ${preview}`);
    }
    await rail.press('End');
    await page.waitForFunction(userTurns => (
        document.querySelector('[aria-label="快速跳转用户回合"]')?.getAttribute('aria-valuenow') === String(userTurns)
    ), expected.userTurns);
    await page.waitForTimeout(150);
    const gaps = await page.evaluate(() => {
        globalThis.__sillyLoungeRafSample.active = false;
        return globalThis.__sillyLoungeRafSample.gaps;
    });
    return {
        wheelRangeStart: {
            before: rangeBeforeWheel,
            after: rangeAfterWheel,
        },
        wheelMessageScrollDelta: scrollAfterWheel - scrollBeforeWheel,
        firstFloorTitle: title,
        firstFloorPreview: preview,
        frameGaps: {
            ...summarizeDurations(gaps),
            over50ms: gaps.filter(gap => gap > 50).length,
        },
    };
}

async function copyIfPresent(source, destination) {
    try {
        await fs.copyFile(source, destination);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
}

async function runScenario({ browser, stRoot, fixture, regexMode, mode, iteration, warmup, outputRoot }) {
    const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), `sillylounge-perf-${mode}-`));
    const dataRoot = path.join(runRoot, 'data');
    const label = `${warmup ? 'warmup' : `run-${iteration + 1}`}-${mode}`;
    const evidenceRoot = path.join(outputRoot, label);
    let server = null;
    let context = null;
    const pageErrors = [];
    const chatuiErrors = [];
    const nativeRenderLogs = [];

    try {
        const generated = await generateStDataRoot({
            targetRoot: dataRoot,
            stRoot,
            runtimeRoot: RUNTIME_ROOT,
            fixturePath: fixturePath(fixture),
            extensionMode: mode,
            regexMode,
        });
        server = await startStServer({ stRoot, runRoot, dataRoot, readyTimeoutMs: 120_000 });
        context = await browser.newContext({
            viewport: DESKTOP_VIEWPORT,
            reducedMotion: REDUCED_MOTION,
        });
        const page = await context.newPage();
        page.on('pageerror', error => pageErrors.push(error.stack ?? error.message));
        page.on('console', message => {
            const text = message.text();
            if (message.type() === 'error' && text.includes('[ChatUI]')) chatuiErrors.push(text);
            if (/Rendered \d+ messages in/i.test(text)) nativeRenderLogs.push(text);
        });
        await page.addInitScript(() => {
            const state = { longTasks: [], paints: [], lcp: [], layoutShifts: [], lastMutation: 0 };
            globalThis.__sillyLoungePerf = state;
            for (const type of ['longtask', 'paint', 'largest-contentful-paint', 'layout-shift']) {
                try {
                    new PerformanceObserver(list => {
                        for (const entry of list.getEntries()) {
                            if (type === 'longtask') state.longTasks.push(entry.duration);
                            else if (type === 'paint') state.paints.push({ name: entry.name, startTime: entry.startTime });
                            else if (type === 'largest-contentful-paint') state.lcp.push(entry.startTime);
                            else if (!entry.hadRecentInput) state.layoutShifts.push(entry.value);
                        }
                    }).observe({ type, buffered: true });
                } catch {
                    // Unsupported observer entry types stay empty in the report.
                }
            }
            const observeMutations = () => {
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
            if (document.documentElement) observeMutations();
            else document.addEventListener('DOMContentLoaded', observeMutations, { once: true });
        });
        const cdp = await context.newCDPSession(page);
        await cdp.send('Performance.enable');
        const cdpBefore = metricMap(await cdp.send('Performance.getMetrics'));
        const navigationStarted = nodePerformance.now();
        await page.goto(server.url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
        const expected = {
            chatId: generated.manifest.conversation.fileName,
            messageCount: generated.manifest.conversation.messageCount,
            userTurns: generated.manifest.conversation.userTurns,
            firstFloor: generated.manifest.fixture === 'long-plain' ? {
                title: '第 1 楼用户消息：用于测量长对话加载与跳转。',
                preview: '第 1 楼助手回复：固定、简短、无附件的 Markdown 文本。',
            } : null,
        };
        await waitForMeasuredPage(page, mode, expected);
        const navigationToReadyMs = nodePerformance.now() - navigationStarted;
        const cdpAfter = metricMap(await cdp.send('Performance.getMetrics'));
        const browserState = await page.evaluate(() => {
            const state = globalThis.__sillyLoungePerf;
            const navigation = performance.getEntriesByType('navigation')[0];
            return {
                navigation: navigation ? {
                    domContentLoadedMs: navigation.domContentLoadedEventEnd,
                    loadEventMs: navigation.loadEventEnd,
                } : null,
                longTasks: state.longTasks,
                paints: state.paints,
                lcpMs: state.lcp.at(-1) ?? null,
                cls: state.layoutShifts.reduce((sum, value) => sum + value, 0),
                dom: {
                    totalElements: document.querySelectorAll('*').length,
                    nativeMessages: document.querySelectorAll('#chat .mes').length,
                    rootArticles: document.querySelectorAll('.cui-root-message-list article.cui-root-message').length,
                    rootButtons: document.querySelectorAll('#chatui-root button').length,
                    iframes: document.querySelectorAll('iframe').length,
                    rootThoughts: document.querySelectorAll('#chatui-root [data-synthetic-regex="thought"]').length,
                    rootCardFrames: document.querySelectorAll('#chatui-root iframe.cui-embed-frame').length,
                    rootStyleTags: document.querySelectorAll('#chatui-root style').length,
                    floorMaximum: Number(document.querySelector('[aria-label="快速跳转用户回合"]')?.getAttribute('aria-valuemax')) || 0,
                },
            };
        });
        const rail = mode === 'active' ? await exerciseFloorRail(page, expected) : null;
        await fs.mkdir(evidenceRoot, { recursive: true });
        if (mode === 'active' && !warmup) {
            await page.screenshot({ path: path.join(evidenceRoot, 'long-chat.png'), fullPage: true });
        }
        if (pageErrors.length > 0 || chatuiErrors.length > 0) {
            throw new Error(`browser errors: ${[...pageErrors, ...chatuiErrors].join('\n')}`);
        }
        return {
            mode,
            iteration,
            fixture: generated.manifest.conversation,
            navigationToReadyMs,
            cdp: metricReport(cdpBefore, cdpAfter),
            navigation: browserState.navigation,
            longTasks: summarizeDurations(browserState.longTasks),
            paints: browserState.paints,
            lcpMs: browserState.lcpMs,
            cls: browserState.cls,
            dom: browserState.dom,
            nativeRenderLogs,
            rail,
        };
    } finally {
        if (context) await context.close();
        if (server) {
            await server.stop();
            await fs.mkdir(evidenceRoot, { recursive: true });
            await Promise.all([
                copyIfPresent(server.paths.stdout, path.join(evidenceRoot, 'sillytavern.stdout.log')),
                copyIfPresent(server.paths.stderr, path.join(evidenceRoot, 'sillytavern.stderr.log')),
            ]);
        }
        await inspectStCheckout({ stRoot });
        await fs.rm(runRoot, { recursive: true, force: true });
    }
}

function aggregateResults(results) {
    return Object.fromEntries(MODES.map(mode => {
        const samples = results.filter(result => result.mode === mode);
        return [mode, {
            samples: samples.length,
            navigationToReadyMs: median(samples.map(sample => sample.navigationToReadyMs)),
            longTaskTotalMs: median(samples.map(sample => sample.longTasks.totalMs)),
            taskDurationSeconds: median(samples.map(sample => sample.cdp.TaskDuration)),
            scriptDurationSeconds: median(samples.map(sample => sample.cdp.ScriptDuration)),
            layoutDurationSeconds: median(samples.map(sample => sample.cdp.LayoutDuration)),
            heapBytes: median(samples.map(sample => sample.cdp.JSHeapUsedSize)),
            nodes: median(samples.map(sample => sample.cdp.Nodes)),
            totalElements: median(samples.map(sample => sample.dom.totalElements)),
            rootArticles: median(samples.map(sample => sample.dom.rootArticles)),
            rootButtons: median(samples.map(sample => sample.dom.rootButtons)),
            iframes: median(samples.map(sample => sample.dom.iframes)),
            rootThoughts: median(samples.map(sample => sample.dom.rootThoughts)),
            rootCardFrames: median(samples.map(sample => sample.dom.rootCardFrames)),
            rootStyleTags: median(samples.map(sample => sample.dom.rootStyleTags)),
        }];
    }));
}

function delta(left, right) {
    const result = {};
    for (const key of Object.keys(left)) {
        if (key === 'samples' || left[key] === null || right[key] === null) continue;
        result[key] = right[key] - left[key];
    }
    return result;
}

export async function measureLongChat({
    stRoot,
    fixture = DEFAULT_FIXTURE,
    regexMode = 'active',
    repetitions = 1,
    warmups = 0,
    output,
}) {
    if (!stRoot) throw new Error('stRoot is required (pass --st or SILLYTAVERN_TEST_ROOT)');
    if (!/^[a-z0-9-]+$/i.test(fixture)) throw new Error('fixture must be one safe directory name');
    if (!['active', 'disabled'].includes(regexMode)) throw new Error('regexMode must be active or disabled');
    const resolvedOutput = path.resolve(output ?? defaultOutput(fixture, regexMode));
    const outputRoot = path.dirname(resolvedOutput);
    const evidenceRoot = path.join(outputRoot, 'runs');
    await fs.mkdir(outputRoot, { recursive: true });
    await fs.rm(resolvedOutput, { force: true });
    await fs.rm(evidenceRoot, { recursive: true, force: true });
    await fs.mkdir(evidenceRoot, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    const results = [];
    try {
        for (let warmup = 0; warmup < warmups; warmup += 1) {
            for (const mode of modeOrder(warmup)) {
                console.log(`[SillyLounge perf] warmup ${warmup + 1}/${warmups}: ${mode}`);
                await runScenario({
                    browser,
                    stRoot,
                    fixture,
                    regexMode,
                    mode,
                    iteration: warmup,
                    warmup: true,
                    outputRoot: evidenceRoot,
                });
            }
        }
        for (let iteration = 0; iteration < repetitions; iteration += 1) {
            for (const mode of modeOrder(iteration)) {
                console.log(`[SillyLounge perf] run ${iteration + 1}/${repetitions}: ${mode}`);
                results.push(await runScenario({
                    browser,
                    stRoot,
                    fixture,
                    regexMode,
                    mode,
                    iteration,
                    warmup: false,
                    outputRoot: evidenceRoot,
                }));
            }
        }
    } finally {
        await browser.close();
    }
    const summary = aggregateResults(results);
    const report = {
        schemaVersion: 1,
        recordedAt: new Date().toISOString(),
        st: (await inspectStCheckout({ stRoot })).pin,
        browser: 'chromium',
        viewport: DESKTOP_VIEWPORT,
        repetitions,
        warmups,
        fixture: {
            id: fixture,
            regexMode,
            ...results[0]?.fixture,
            nativeTruncation: Math.min(100, results[0]?.fixture?.messageCount ?? 0),
        },
        summary,
        deltas: {
            bootstrapMinusNative: delta(summary.disabled, summary.bootstrap),
            activeMinusBootstrap: delta(summary.bootstrap, summary.active),
        },
        samples: results,
    };
    await fs.writeFile(resolvedOutput, `${JSON.stringify(report, null, 4)}\n`, 'utf8');
    return { output: resolvedOutput, report };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const result = await measureLongChat({
        stRoot: args.st ?? process.env.SILLYTAVERN_TEST_ROOT,
        fixture: args.fixture,
        regexMode: args.regex,
        repetitions: args.repetitions,
        warmups: args.warmups,
        output: args.output,
    });
    console.table(Object.fromEntries(Object.entries(result.report.summary).map(([mode, summary]) => [mode, {
        readyMs: Math.round(summary.navigationToReadyMs),
        longTaskMs: Math.round(summary.longTaskTotalMs),
        elements: Math.round(summary.totalElements),
        rootArticles: Math.round(summary.rootArticles),
        rootButtons: Math.round(summary.rootButtons),
        iframes: Math.round(summary.iframes),
    }])));
    console.log(`[SillyLounge perf] report: ${result.output}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
