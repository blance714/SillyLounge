import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateRuntimeTree } from './check-runtime.mjs';

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
    'scripts/vendor/',
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

function uniqueSiblingPath(targetDir, label) {
    const parentDir = path.dirname(targetDir);
    const name = path.basename(targetDir);
    return path.join(parentDir, `.${name}.${label}-${process.pid}-${randomUUID()}`);
}

async function lstatOrNull(filePath) {
    try {
        return await fs.lstat(filePath);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

async function managedReleaseTarget(targetDir) {
    const stat = await lstatOrNull(targetDir);
    if (!stat?.isSymbolicLink()) return null;

    const parentDir = path.dirname(targetDir);
    const prefix = `.${path.basename(targetDir)}.release-`;
    const linkTarget = await fs.readlink(targetDir);
    const resolved = path.resolve(parentDir, linkTarget);
    if (path.dirname(resolved) !== parentDir || !path.basename(resolved).startsWith(prefix)) {
        return null;
    }
    return resolved;
}

/**
 * Assemble the complete extension tree beside its eventual live path. Keeping
 * the candidate on the same filesystem makes the final rename atomic.
 *
 * @param {string} targetDir
 * @returns {Promise<string>}
 */
export async function assembleRuntimeCandidate(targetDir = DEFAULT_RUNTIME_DIR) {
    const candidateDir = uniqueSiblingPath(path.resolve(targetDir), 'stage');
    await fs.mkdir(candidateDir, { recursive: true });

    try {
        for (const entry of RUNTIME_PATHS) {
            const source = path.join(PROJECT_ROOT, entry.source);
            const target = path.join(candidateDir, entry.target);
            await fs.mkdir(path.dirname(target), { recursive: true });
            if (entry.target === '.') {
                await fs.cp(source, candidateDir, { recursive: true });
            } else {
                await fs.cp(source, target, { recursive: true });
            }
        }
        return candidateDir;
    } catch (error) {
        await fs.rm(candidateDir, { recursive: true, force: true });
        throw error;
    }
}

/**
 * Publish a validated candidate through an atomically-replaced symlink. The
 * first run migrates a legacy real directory with a rollback-safe rename; every
 * subsequent release is a single atomic symlink rename, so readers see either
 * the complete old tree or the complete new tree.
 *
 * @param {string} candidateDir
 * @param {string} targetDir
 * @returns {Promise<void>}
 */
export async function publishRuntimeCandidate(candidateDir, targetDir = DEFAULT_RUNTIME_DIR) {
    const resolvedTarget = path.resolve(targetDir);
    const parentDir = path.dirname(resolvedTarget);
    const currentStat = await lstatOrNull(resolvedTarget);
    if (currentStat && !currentStat.isDirectory() && !currentStat.isSymbolicLink()) {
        throw new Error(`Runtime target must be a directory or symlink: ${resolvedTarget}`);
    }

    const previousManagedRelease = await managedReleaseTarget(resolvedTarget);
    const releaseDir = uniqueSiblingPath(resolvedTarget, 'release');
    const linkPath = uniqueSiblingPath(resolvedTarget, 'link');
    let legacyBackup = null;
    let published = false;

    await fs.mkdir(parentDir, { recursive: true });
    await fs.rename(candidateDir, releaseDir);

    try {
        await fs.symlink(path.basename(releaseDir), linkPath, 'dir');

        if (currentStat?.isDirectory() && !currentStat.isSymbolicLink()) {
            legacyBackup = uniqueSiblingPath(resolvedTarget, 'backup');
            await fs.rename(resolvedTarget, legacyBackup);
            try {
                await fs.rename(linkPath, resolvedTarget);
            } catch (error) {
                await fs.rename(legacyBackup, resolvedTarget);
                legacyBackup = null;
                throw error;
            }
        } else {
            // rename(2) atomically creates the live pointer or replaces the old
            // symlink. The previous release remains available until this call.
            await fs.rename(linkPath, resolvedTarget);
        }
        published = true;
    } finally {
        await fs.rm(linkPath, { recursive: true, force: true });
        if (!published) {
            await fs.rm(releaseDir, { recursive: true, force: true });
        }
    }

    // Cleanup happens only after the new pointer is live. A cleanup failure must
    // not roll back or misreport an otherwise successful publication.
    const obsoletePaths = [legacyBackup, previousManagedRelease]
        .filter(Boolean)
        .filter(obsolete => obsolete !== releaseDir);
    for (const obsolete of obsoletePaths) {
        try {
            await fs.rm(obsolete, { recursive: true, force: true });
        } catch (error) {
            console.warn(`[ChatUI] runtime published, but obsolete release cleanup failed: ${obsolete}`, error);
        }
    }
}

/**
 * Assemble and validate the exact tree that would be published, without
 * changing the live runtime target.
 *
 * @param {string} targetDir
 */
export async function checkRuntimeBuild(targetDir = process.env.CHATUI_RUNTIME_DIR || DEFAULT_RUNTIME_DIR) {
    const candidateDir = await assembleRuntimeCandidate(targetDir);
    try {
        return await validateRuntimeTree(candidateDir);
    } finally {
        await fs.rm(candidateDir, { recursive: true, force: true });
    }
}

/**
 * @param {string} targetDir
 * @returns {Promise<void>}
 */
export async function syncRuntime(targetDir = process.env.CHATUI_RUNTIME_DIR || DEFAULT_RUNTIME_DIR) {
    const resolvedTarget = path.resolve(targetDir);
    const candidateDir = await assembleRuntimeCandidate(resolvedTarget);
    let candidateExists = true;

    try {
        await validateRuntimeTree(candidateDir);
        await publishRuntimeCandidate(candidateDir, resolvedTarget);
        candidateExists = false;
    } finally {
        if (candidateExists) {
            await fs.rm(candidateDir, { recursive: true, force: true });
        }
    }
}

function parseCliArgs(argv) {
    let targetDir;
    let checkOnly = false;

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--check-only') {
            checkOnly = true;
        } else if (arg === '--target') {
            targetDir = argv[index + 1];
            if (!targetDir) throw new Error('--target requires a directory');
            index += 1;
        } else {
            throw new Error(`Unknown runtime option: ${arg}`);
        }
    }

    return { targetDir: targetDir || process.env.CHATUI_RUNTIME_DIR || DEFAULT_RUNTIME_DIR, checkOnly };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const { targetDir, checkOnly } = parseCliArgs(process.argv.slice(2));
    if (checkOnly) {
        const result = await checkRuntimeBuild(targetDir);
        console.log(
            `[ChatUI] build contract passed (${result.fileCount} files, ${result.moduleCount} modules); live runtime unchanged`,
        );
    } else {
        await syncRuntime(targetDir);
        console.log(`[ChatUI] validated runtime published atomically to ${path.resolve(targetDir)}`);
    }
}
