import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');

export const DEFAULT_RUNTIME_DIR = path.join(PROJECT_ROOT, '.runtime', 'SillyTavern-ChatUI');

const RUNTIME_PATHS = [
    { source: 'manifest.json', target: 'manifest.json' },
    { source: 'style.css', target: 'style.css' },
    { source: 'dist/runtime', target: '.' },
    { source: 'dist/root-app.mjs', target: 'dist/root-app.mjs' },
    { source: 'dist/root-app.mjs.map', target: 'dist/root-app.mjs.map' },
];

export const WATCHED_RUNTIME_PREFIXES = [
    'src/',
];

export const WATCHED_RUNTIME_FILES = new Set([
    'manifest.json',
    'style.css',
    'package.json',
    'tsconfig.json',
]);

/**
 * @param {string} relativePath
 * @returns {boolean}
 */
export function isRuntimeSourcePath(relativePath) {
    const normalized = relativePath.split(path.sep).join('/');
    if (
        normalized.startsWith('.runtime/')
        || normalized.startsWith('dist/')
        || normalized.startsWith('node_modules/')
        || normalized.startsWith('.git/')
    ) {
        return false;
    }

    if (WATCHED_RUNTIME_FILES.has(normalized)) return true;
    return WATCHED_RUNTIME_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

/**
 * @param {string} targetDir
 * @returns {Promise<void>}
 */
export async function syncRuntime(targetDir = process.env.CHATUI_RUNTIME_DIR || DEFAULT_RUNTIME_DIR) {
    const tmpDir = `${targetDir}.tmp`;
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.mkdir(tmpDir, { recursive: true });

    for (const entry of RUNTIME_PATHS) {
        const source = path.join(PROJECT_ROOT, entry.source);
        const target = path.join(tmpDir, entry.target);
        await fs.mkdir(path.dirname(target), { recursive: true });
        if (entry.target === '.') {
            await fs.cp(source, tmpDir, { recursive: true });
        } else {
            await fs.cp(source, target, { recursive: true });
        }
    }

    await fs.rm(targetDir, { recursive: true, force: true });
    await fs.rename(tmpDir, targetDir);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const targetArgIndex = process.argv.indexOf('--target');
    const targetDir = targetArgIndex >= 0 ? process.argv[targetArgIndex + 1] : undefined;
    await syncRuntime(targetDir);
    console.log(`[ChatUI] runtime synced to ${targetDir || DEFAULT_RUNTIME_DIR}`);
}
