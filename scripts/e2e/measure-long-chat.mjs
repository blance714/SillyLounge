import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance as nodePerformance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

import { generateStDataRoot } from './generate-data-root.mjs';
import { inspectStCheckout, startStServer } from './st-process.mjs';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const RUNTIME_ROOT = path.join(PROJECT_ROOT, '.runtime', 'SillyTavern-ChatUI');
const FIXTURE_PATH = path.join(PROJECT_ROOT, 'test', 'e2e', 'fixtures', 'long-plain', 'fixture.json');
const DEFAULT_OUTPUT = path.join(PROJECT_ROOT, 'test-results', 'performance', 'long-chat.json');
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
    const values = { repetitions: 1, warmups: 0 };
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
    return values;
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

async function waitForMeasuredPage(page, mode) {
    await page.waitForFunction(selectedMode => {
        const context = globalThis.SillyTavern?.getContext?.();
        if (!context || context.chatId !== 'long-plain' || context.chat?.length !== 800) return false;
        const nativeMessages = document.querySelectorAll('#chat .mes');
        const nativeLast = nativeMessages[nativeMessages.length - 1];
        if (nativeMessages.length !== 100 || nativeLast?.getAttribute('mesid') !== '799') return false;
        if (selectedMode !== 'active') {
            return !document.body.classList.contains('chatui-active');
        }
        const root = document.querySelector('#chatui-root[data-cui-root-mounted="1"]');
        const latest = root?.querySelector('[data-cui-message-id="799"]');
        const rail = root?.querySelector('[role="slider"][aria-label="快速跳转用户回合"]');
        return Boolean(
            root
            && latest
            && root.querySelectorAll('.cui-root-message-list > article').length === 800
            && root.querySelector('[aria-label="ChatUI composer"]')
            && rail?.getAttribute('aria-valuemax') === '400'
        );
    }, mode, { timeout: 120_000 });
    await page.waitForFunction(() => (
        performance.now() - (globalThis.__sillyLoungePerf?.lastMutation ?? 0) >= 120
    ), null, { timeout: 30_000 });
    await page.evaluate(() => new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
}

async function exerciseFloorRail(page) {
    const rail = page.locator('[role="slider"][aria-label="快速跳转用户回合"]');
    const list = page.locator('.cui-root-message-list');
    const rangeStart = rail.locator('.cui-root-floor-range-label.is-start');
    const scrollBeforeWheel = await list.evaluate(element => element.scrollTop);
    const rangeBeforeWheel = Number(await rangeStart.textContent());
    const box = await rail.boundingBox();
    if (!box) throw new Error('400-floor rail has no bounding box');

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
    await page.mouse.move(box.x + 4, box.y + box.height / 2);
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
    if (title !== '第 1 楼用户消息：用于测量长对话加载与跳转。') {
        throw new Error(`unexpected first-floor title: ${title}`);
    }
    if (preview !== '第 1 楼助手回复：固定、简短、无附件的 Markdown 文本。') {
        throw new Error(`unexpected first-floor preview: ${preview}`);
    }
    await rail.press('End');
    await page.waitForFunction(() => (
        document.querySelector('[aria-label="快速跳转用户回合"]')?.getAttribute('aria-valuenow') === '400'
    ));
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

async function runScenario({ browser, stRoot, mode, iteration, warmup, outputRoot }) {
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
            fixturePath: FIXTURE_PATH,
            extensionMode: mode,
        });
        server = await startStServer({ stRoot, runRoot, dataRoot, readyTimeoutMs: 120_000 });
        context = await browser.newContext({
            viewport: { width: 1440, height: 900 },
            reducedMotion: 'reduce',
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
        await waitForMeasuredPage(page, mode);
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
                    rootArticles: document.querySelectorAll('.cui-root-message-list > article').length,
                    rootButtons: document.querySelectorAll('#chatui-root button').length,
                    iframes: document.querySelectorAll('iframe').length,
                    floorMaximum: Number(document.querySelector('[aria-label="快速跳转用户回合"]')?.getAttribute('aria-valuemax')) || 0,
                },
            };
        });
        const rail = mode === 'active' ? await exerciseFloorRail(page) : null;
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

export async function measureLongChat({ stRoot, repetitions = 1, warmups = 0, output = DEFAULT_OUTPUT }) {
    if (!stRoot) throw new Error('stRoot is required (pass --st or SILLYTAVERN_TEST_ROOT)');
    const resolvedOutput = path.resolve(output);
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
                await runScenario({ browser, stRoot, mode, iteration: warmup, warmup: true, outputRoot: evidenceRoot });
            }
        }
        for (let iteration = 0; iteration < repetitions; iteration += 1) {
            for (const mode of modeOrder(iteration)) {
                console.log(`[SillyLounge perf] run ${iteration + 1}/${repetitions}: ${mode}`);
                results.push(await runScenario({
                    browser,
                    stRoot,
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
        viewport: { width: 1440, height: 900 },
        repetitions,
        warmups,
        fixture: { userTurns: 400, messages: 800, nativeTruncation: 100 },
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
    }])));
    console.log(`[SillyLounge perf] report: ${result.output}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
