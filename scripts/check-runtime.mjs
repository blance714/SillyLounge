import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { posixPath } from './lib.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');

export const DEFAULT_RUNTIME_ROOT = path.join(PROJECT_ROOT, '.runtime', 'SillyTavern-ChatUI');

const MODULE_EXTENSIONS = new Set(['.js', '.mjs']);
const TEXT_EXTENSIONS = new Set(['.css', '.js', '.json', '.map', '.mjs']);
const MAX_SNIPPET_LENGTH = 180;

// These are the only imports that may intentionally leave the extension tree.
// They resolve to SillyTavern's own browser modules from the third-party
// extension directory. Compare resolved targets instead of raw ../ depth so the
// same allowlist works for modules nested anywhere inside the runtime tree.
const ALLOWED_ST_EXTERNAL_TARGETS = new Set([
    '../../../extensions.js',
    '../../../../script.js',
    '../../../st-context.js',
    '../../../utils.js',
    '../../../bookmarks.js',
    '../../../chats.js',
    '../../../personas.js',
    '../../../slash-commands.js',
    '../../../../scripts/RossAscends-mods.js',
]);

const JS_TEXT_CHECKS = [
    {
        id: 'st-external-alias',
        pattern: /@st\//g,
        message: 'Generated browser files must not contain unresolved @st/* imports.',
    },
    {
        id: 'process-env',
        pattern: /\bprocess\s*\.\s*env\b/g,
        message: 'Generated browser files must not reference process.env.',
    },
    {
        id: 'process-global',
        pattern: /\bprocess\b(?!\s*\.\s*env\b)/g,
        message: 'Generated browser files must not reference the Node process global.',
    },
    {
        id: 'buffer-global',
        pattern: /\bBuffer\b/g,
        message: 'Generated browser files must not reference the Node Buffer global.',
    },
    {
        id: 'dirname-global',
        pattern: /\b__dirname\b/g,
        message: 'Generated browser files must not reference __dirname.',
    },
    {
        id: 'filename-global',
        pattern: /\b__filename\b/g,
        message: 'Generated browser files must not reference __filename.',
    },
    {
        id: 'commonjs-require',
        pattern: /\brequire\s*\(/g,
        message: 'Generated browser files must not contain CommonJS require() calls.',
    },
    {
        id: 'commonjs-module-exports',
        pattern: /\bmodule\s*\.\s*exports\b/g,
        message: 'Generated browser files must not contain module.exports.',
    },
];

const ARTIFACT_PATH_CHECKS = [
    {
        id: 'dependency-manager-path',
        pattern: /(?:^|[\\/])(?:node_modules|\.pnpm)(?:[\\/]|$)/m,
        message: 'Runtime artifacts must not expose node_modules or .pnpm paths.',
    },
    {
        id: 'posix-local-path',
        pattern: /(?:file:\/\/)?\/(?:Users|home)\/[^\s"']+/m,
        message: 'Runtime artifacts must not contain absolute user-machine paths.',
    },
    {
        id: 'macos-private-path',
        pattern: /(?:file:\/\/)?\/private\/(?:tmp|var|Users)\/[^\s"']+/m,
        message: 'Runtime artifacts must not contain absolute machine-local paths.',
    },
    {
        id: 'windows-local-path',
        pattern: /\b[A-Za-z]:[\\/][^\s"']+/m,
        message: 'Runtime artifacts must not contain absolute Windows paths.',
    },
];

const IMPORT_SPECIFIER_PATTERN = /\b(?:import|export)\s*(?:(?:[\w$*,\s{}]+?)\s*from\s*)?(['"])([^'"]+)\1|\bimport\s*\(\s*(['"])([^'"]+)\3\s*\)/g;

export class RuntimeValidationError extends Error {
    constructor(rootDir, findings) {
        super(`Runtime validation failed with ${findings.length} finding(s): ${rootDir}`);
        this.name = 'RuntimeValidationError';
        this.rootDir = rootDir;
        this.findings = findings;
    }
}

function displayPath(filePath) {
    const relative = path.relative(PROJECT_ROOT, filePath);
    return posixPath(relative || '.');
}

function snippet(value) {
    const trimmed = value.trim();
    return trimmed.length > MAX_SNIPPET_LENGTH
        ? `${trimmed.slice(0, MAX_SNIPPET_LENGTH)}...`
        : trimmed;
}

function locationAt(content, index) {
    const before = content.slice(0, index);
    const lines = before.split(/\r?\n/);
    return {
        lineNumber: lines.length,
        columnNumber: lines.at(-1).length + 1,
    };
}

function isPathInside(rootDir, targetPath) {
    const relative = path.relative(rootDir, targetPath);
    return relative === ''
        || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function pathExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function isRegularFile(filePath) {
    try {
        return (await fs.stat(filePath)).isFile();
    } catch {
        return false;
    }
}

function addFinding(findings, {
    id,
    filePath,
    message,
    lineNumber = null,
    columnNumber = null,
    source = '',
}) {
    findings.push({
        id,
        filePath,
        lineNumber,
        columnNumber,
        message,
        snippet: source ? snippet(source) : '',
    });
}

async function collectRuntimeFiles(rootDir, findings) {
    const files = [];

    async function visit(directory) {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const fullPath = path.join(directory, entry.name);
            const relative = posixPath(path.relative(rootDir, fullPath));
            const pathSegments = relative.split('/');

            if (pathSegments.includes('node_modules') || pathSegments.includes('.pnpm')) {
                addFinding(findings, {
                    id: 'dependency-manager-artifact',
                    filePath: fullPath,
                    message: 'Runtime tree must not contain node_modules or .pnpm paths.',
                    source: relative,
                });
            }

            if (entry.isSymbolicLink()) {
                addFinding(findings, {
                    id: 'runtime-symlink',
                    filePath: fullPath,
                    message: 'Runtime tree must not contain symlinks that can escape validation.',
                    source: relative,
                });
                continue;
            }

            if (entry.isDirectory()) {
                await visit(fullPath);
            } else if (entry.isFile()) {
                files.push(fullPath);
            }
        }
    }

    await visit(rootDir);
    return files.sort((a, b) => displayPath(a).localeCompare(displayPath(b)));
}

function isUnsafeManifestPath(value) {
    if (typeof value !== 'string' || !value.trim()) return true;
    if (value.includes('\\') || value.includes('?') || value.includes('#')) return true;
    if (path.posix.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return true;
    return value.split('/').includes('..');
}

async function checkManifestEntry(rootDir, manifestPath, manifest, key, extension, findings) {
    const value = manifest[key];
    if (isUnsafeManifestPath(value) || path.extname(value) !== extension) {
        addFinding(findings, {
            id: 'invalid-manifest-entry',
            filePath: manifestPath,
            message: `manifest.json must declare a safe relative ${key} entry ending in ${extension}.`,
            source: `${key}: ${String(value)}`,
        });
        return;
    }

    const target = path.resolve(rootDir, value);
    if (!isPathInside(rootDir, target) || !(await isRegularFile(target))) {
        addFinding(findings, {
            id: 'missing-manifest-entry',
            filePath: manifestPath,
            message: `manifest.json ${key} entry does not resolve to a runtime file: ${value}`,
            source: value,
        });
    }
}

async function checkManifest(rootDir, findings) {
    const manifestPath = path.join(rootDir, 'manifest.json');
    let manifest;
    try {
        manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    } catch (error) {
        addFinding(findings, {
            id: 'invalid-manifest',
            filePath: manifestPath,
            message: `Runtime manifest is missing or invalid JSON: ${error.message}`,
        });
        return;
    }

    await checkManifestEntry(rootDir, manifestPath, manifest, 'js', '.js', findings);
    await checkManifestEntry(rootDir, manifestPath, manifest, 'css', '.css', findings);
}

function checkArtifactPaths(content, filePath, findings) {
    for (const check of ARTIFACT_PATH_CHECKS) {
        const match = check.pattern.exec(content);
        check.pattern.lastIndex = 0;
        if (!match) continue;
        const location = locationAt(content, match.index);
        addFinding(findings, {
            id: check.id,
            filePath,
            ...location,
            message: check.message,
            source: match[0],
        });
    }
}

function checkJsText(content, filePath, findings) {
    for (const check of JS_TEXT_CHECKS) {
        check.pattern.lastIndex = 0;
        for (let match = check.pattern.exec(content); match; match = check.pattern.exec(content)) {
            const location = locationAt(content, match.index);
            addFinding(findings, {
                id: check.id,
                filePath,
                ...location,
                message: check.message,
                source: match[0],
            });
        }
    }
}

function isAbsoluteOrProtocolSpecifier(specifier) {
    return specifier.startsWith('/')
        || specifier.startsWith('\\')
        || /^[A-Za-z]:[\\/]/.test(specifier)
        || /^[A-Za-z][A-Za-z\d+.-]*:/.test(specifier);
}

async function checkImportSpecifier(specifier, content, matchIndex, filePath, rootDir, findings) {
    const sourceIndex = matchIndex + content.slice(matchIndex).indexOf(specifier);
    const location = locationAt(content, sourceIndex);

    if (isAbsoluteOrProtocolSpecifier(specifier)) {
        addFinding(findings, {
            id: 'absolute-import-specifier',
            filePath,
            ...location,
            message: `Generated browser modules must not import absolute or protocol specifiers: ${specifier}`,
            source: specifier,
        });
        return;
    }

    if (!specifier.startsWith('.')) {
        addFinding(findings, {
            id: 'bare-import-specifier',
            filePath,
            ...location,
            message: `Generated browser modules must not contain unresolved bare imports: ${specifier}`,
            source: specifier,
        });
        return;
    }

    if (specifier.includes('?') || specifier.includes('#')) {
        addFinding(findings, {
            id: 'qualified-relative-import',
            filePath,
            ...location,
            message: `Generated relative imports must resolve to an exact runtime file: ${specifier}`,
            source: specifier,
        });
        return;
    }

    const target = path.resolve(path.dirname(filePath), specifier);
    if (isPathInside(rootDir, target)) {
        if (!(await isRegularFile(target))) {
            addFinding(findings, {
                id: 'missing-relative-import',
                filePath,
                ...location,
                message: `Generated relative import does not exist in the runtime tree: ${specifier}`,
                source: specifier,
            });
        }
        return;
    }

    const externalTarget = posixPath(path.relative(rootDir, target));
    if (!ALLOWED_ST_EXTERNAL_TARGETS.has(externalTarget)) {
        addFinding(findings, {
            id: 'unexpected-runtime-escape',
            filePath,
            ...location,
            message: `Relative import leaves the runtime tree but is not an allowed SillyTavern module: ${specifier}`,
            source: specifier,
        });
    }
}

async function checkModuleImports(content, filePath, rootDir, findings) {
    IMPORT_SPECIFIER_PATTERN.lastIndex = 0;
    for (
        let match = IMPORT_SPECIFIER_PATTERN.exec(content);
        match;
        match = IMPORT_SPECIFIER_PATTERN.exec(content)
    ) {
        const specifier = match[2] || match[4];
        if (!specifier) continue;
        await checkImportSpecifier(specifier, content, match.index, filePath, rootDir, findings);
    }
}

export async function validateRuntimeTree(inputRoot) {
    const rootDir = path.resolve(inputRoot);
    const findings = [];

    if (!(await pathExists(rootDir))) {
        addFinding(findings, {
            id: 'missing-runtime-root',
            filePath: rootDir,
            message: 'Runtime validation root does not exist.',
        });
        throw new RuntimeValidationError(rootDir, findings);
    }

    const rootStat = await fs.stat(rootDir);
    if (!rootStat.isDirectory()) {
        addFinding(findings, {
            id: 'invalid-runtime-root',
            filePath: rootDir,
            message: 'Runtime validation root must be a directory.',
        });
        throw new RuntimeValidationError(rootDir, findings);
    }

    const files = await collectRuntimeFiles(rootDir, findings);
    await checkManifest(rootDir, findings);

    const moduleFiles = files.filter(filePath => MODULE_EXTENSIONS.has(path.extname(filePath)));
    if (moduleFiles.length === 0) {
        addFinding(findings, {
            id: 'missing-runtime-modules',
            filePath: rootDir,
            message: 'Runtime tree contains no generated JS/MJS modules.',
        });
    }

    for (const filePath of files) {
        const extension = path.extname(filePath);
        if (!TEXT_EXTENSIONS.has(extension)) continue;
        const content = await fs.readFile(filePath, 'utf8');
        checkArtifactPaths(content, filePath, findings);
        if (!MODULE_EXTENSIONS.has(extension)) continue;
        checkJsText(content, filePath, findings);
        await checkModuleImports(content, filePath, rootDir, findings);
    }

    if (findings.length > 0) {
        throw new RuntimeValidationError(rootDir, findings);
    }

    return { rootDir, fileCount: files.length, moduleCount: moduleFiles.length };
}

function printValidationError(error) {
    if (!(error instanceof RuntimeValidationError)) {
        console.error(error);
        return;
    }

    console.error(`[ChatUI] runtime validation failed with ${error.findings.length} finding(s):`);
    for (const finding of error.findings) {
        const line = finding.lineNumber === null ? '' : `:${finding.lineNumber}:${finding.columnNumber}`;
        console.error(`- ${displayPath(finding.filePath)}${line} [${finding.id}] ${finding.message}`);
        if (finding.snippet) console.error(`  ${finding.snippet}`);
    }
}

async function main(argv) {
    const roots = argv.length > 0 ? argv : [DEFAULT_RUNTIME_ROOT];
    try {
        for (const root of roots) {
            const result = await validateRuntimeTree(root);
            console.log(
                `[ChatUI] runtime validation passed (${result.fileCount} files, ${result.moduleCount} modules): ${displayPath(result.rootDir)}`,
            );
        }
    } catch (error) {
        printValidationError(error);
        process.exitCode = 1;
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await main(process.argv.slice(2));
}
