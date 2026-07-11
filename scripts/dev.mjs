import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAll } from './build.mjs';
import {
    DEFAULT_RUNTIME_DIR,
    WATCHED_RUNTIME_FILES,
    WATCHED_RUNTIME_PREFIXES,
    syncRuntime,
} from './runtime.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const WATCH_INTERVAL_MS = 300;

let timer = null;
let running = false;
let queuedReason = null;

async function rebuildAndSync(reason) {
    if (running) {
        queuedReason = reason;
        return;
    }

    running = true;
    try {
        await buildAll();
        await syncRuntime();
        console.log(`[ChatUI] rebuilt + validated runtime published (${reason}) -> ${DEFAULT_RUNTIME_DIR}`);
    } catch (error) {
        console.error('[ChatUI] rebuild failed; previous runtime remains live', error);
    } finally {
        running = false;
        if (queuedReason) {
            const next = queuedReason;
            queuedReason = null;
            schedule(next);
        }
    }
}

function schedule(reason) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
        timer = null;
        void rebuildAndSync(reason);
    }, 120);
}

async function addFileSnapshot(snapshot, relativePath) {
    const absolutePath = path.join(PROJECT_ROOT, relativePath);
    try {
        const stat = await fs.stat(absolutePath);
        if (stat.isFile()) snapshot.set(relativePath, `${stat.mtimeMs}:${stat.size}`);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
}

async function addDirectorySnapshot(snapshot, relativeDirectory) {
    const absoluteDirectory = path.join(PROJECT_ROOT, relativeDirectory);
    for (const entry of await fs.readdir(absoluteDirectory, { withFileTypes: true })) {
        const relativePath = path.posix.join(relativeDirectory, entry.name);
        if (entry.isDirectory()) {
            await addDirectorySnapshot(snapshot, relativePath);
        } else if (entry.isFile()) {
            await addFileSnapshot(snapshot, relativePath);
        }
    }
}

async function snapshotWatchInputs() {
    const snapshot = new Map();
    for (const file of WATCHED_RUNTIME_FILES) {
        await addFileSnapshot(snapshot, file);
    }
    for (const prefix of WATCHED_RUNTIME_PREFIXES) {
        await addDirectorySnapshot(snapshot, prefix.replace(/\/$/, ''));
    }
    return snapshot;
}

function changedPaths(previous, next) {
    const changed = [];
    for (const [filePath, signature] of next) {
        if (previous.get(filePath) !== signature) changed.push(filePath);
    }
    for (const filePath of previous.keys()) {
        if (!next.has(filePath)) changed.push(filePath);
    }
    return changed.sort();
}

const beforeInitialBuild = await snapshotWatchInputs();
await rebuildAndSync('initial');
let previousSnapshot = await snapshotWatchInputs();
const changedDuringInitialBuild = changedPaths(beforeInitialBuild, previousSnapshot);
if (changedDuringInitialBuild.length > 0) {
    schedule(`changed during initial build: ${changedDuringInitialBuild.join(', ')}`);
}

let polling = false;
const interval = setInterval(() => {
    if (polling) return;
    polling = true;
    void snapshotWatchInputs()
        .then(nextSnapshot => {
            const changed = changedPaths(previousSnapshot, nextSnapshot);
            previousSnapshot = nextSnapshot;
            if (changed.length > 0) schedule(changed.join(', '));
        })
        .catch(error => {
            console.error('[ChatUI] failed to scan dev inputs; will retry', error);
        })
        .finally(() => {
            polling = false;
        });
}, WATCH_INTERVAL_MS);

console.log(`[ChatUI] dev mode running. ST should load ${DEFAULT_RUNTIME_DIR}`);
console.log('[ChatUI] polling src/, scripts/vendor/, manifest.json, style.css, package.json, and tsconfig.json...');

await new Promise(resolve => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
});

clearInterval(interval);
if (timer) clearTimeout(timer);
