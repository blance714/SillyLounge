import fs from 'node:fs';
import { buildAll } from './build.mjs';
import { DEFAULT_RUNTIME_DIR, isRuntimeSourcePath, syncRuntime } from './runtime.mjs';

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
        console.log(`[ChatUI] rebuilt + runtime synced (${reason}) -> ${DEFAULT_RUNTIME_DIR}`);
    } catch (error) {
        console.error('[ChatUI] rebuild failed', error);
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

await rebuildAndSync('initial');

fs.watch('.', { recursive: true }, (_eventType, filename) => {
    if (!filename) return;
    const normalized = filename.toString();
    if (!isRuntimeSourcePath(normalized)) return;
    schedule(normalized);
});

console.log(`[ChatUI] dev mode running. ST should load ${DEFAULT_RUNTIME_DIR}`);
console.log('[ChatUI] watching src/, manifest.json, style.css, package.json, and tsconfig.json...');

await new Promise(() => {});
