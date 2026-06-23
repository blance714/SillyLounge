import fs from 'node:fs';
import path from 'node:path';
import esbuild from 'esbuild';
import { buildOptions } from './build-config.mjs';
import { DEFAULT_RUNTIME_DIR, isRuntimeSourcePath, syncRuntime } from './runtime.mjs';

let syncTimer = null;

/**
 * @param {string} reason
 * @returns {void}
 */
function scheduleRuntimeSync(reason) {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(async () => {
        try {
            await syncRuntime();
            console.log(`[ChatUI] runtime synced (${reason}) -> ${DEFAULT_RUNTIME_DIR}`);
        } catch (error) {
            console.error('[ChatUI] runtime sync failed', error);
        }
    }, 80);
}

const context = await esbuild.context({
    ...buildOptions,
    plugins: [
        {
            name: 'chatui-runtime-sync',
            setup(build) {
                build.onEnd((result) => {
                    if (result.errors.length > 0) return;
                    scheduleRuntimeSync('build');
                });
            },
        },
    ],
});

await context.watch();

fs.watch('.', { recursive: true }, (_eventType, filename) => {
    if (!filename) return;
    if (!isRuntimeSourcePath(filename.toString())) return;
    scheduleRuntimeSync(filename.toString());
});

console.log(`[ChatUI] dev mode running. ST should load ${DEFAULT_RUNTIME_DIR}`);
console.log('[ChatUI] watching TSX build and runtime files...');

await new Promise(() => {});
