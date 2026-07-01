import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');

const DEFAULT_SCAN_ROOTS = [
    path.join(PROJECT_ROOT, 'dist'),
    path.join(PROJECT_ROOT, '.runtime', 'SillyTavern-ChatUI'),
];

const SCANNED_EXTENSIONS = new Set(['.js', '.mjs']);
const MAX_SNIPPET_LENGTH = 180;

const TEXT_CHECKS = [
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

const IMPORT_SPECIFIER_PATTERN = /\bfrom\s*(['"])([^'"]+)\1|\bimport\s*(?:\(\s*)?(['"])([^'"]+)\3/g;

function posixPath(value) {
    return value.split(path.sep).join('/');
}

function displayPath(filePath) {
    return posixPath(path.relative(PROJECT_ROOT, filePath));
}

function snippet(line) {
    const trimmed = line.trim();
    return trimmed.length > MAX_SNIPPET_LENGTH
        ? `${trimmed.slice(0, MAX_SNIPPET_LENGTH)}...`
        : trimmed;
}

function shouldScanFile(filePath) {
    return SCANNED_EXTENSIONS.has(path.extname(filePath));
}

async function pathExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function collectFiles(rootDir) {
    const files = [];

    async function walk(currentDir) {
        for (const entry of await fs.readdir(currentDir, { withFileTypes: true })) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                await walk(fullPath);
            } else if (entry.isFile() && shouldScanFile(fullPath)) {
                files.push(fullPath);
            }
        }
    }

    await walk(rootDir);
    return files.sort((a, b) => displayPath(a).localeCompare(displayPath(b)));
}

function isBadImportSpecifier(specifier) {
    return specifier.startsWith('/')
        || specifier.startsWith('file:')
        || specifier.startsWith('node:')
        || /^[A-Za-z]:[\\/]/.test(specifier);
}

function checkImportSpecifiers(line, lineNumber, filePath, findings) {
    IMPORT_SPECIFIER_PATTERN.lastIndex = 0;

    for (let match = IMPORT_SPECIFIER_PATTERN.exec(line); match; match = IMPORT_SPECIFIER_PATTERN.exec(line)) {
        const specifier = match[2] || match[4];
        if (!specifier || !isBadImportSpecifier(specifier)) continue;

        findings.push({
            id: 'absolute-import-specifier',
            filePath,
            lineNumber,
            columnNumber: match.index + 1,
            message: `Generated browser files must not import absolute or Node-only specifiers: ${specifier}`,
            snippet: snippet(line),
        });
    }
}

function checkTextPatterns(line, lineNumber, filePath, findings) {
    for (const check of TEXT_CHECKS) {
        check.pattern.lastIndex = 0;

        for (let match = check.pattern.exec(line); match; match = check.pattern.exec(line)) {
            findings.push({
                id: check.id,
                filePath,
                lineNumber,
                columnNumber: match.index + 1,
                message: check.message,
                snippet: snippet(line),
            });
        }
    }
}

async function checkFile(filePath) {
    const findings = [];
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split(/\r?\n/);

    lines.forEach((line, index) => {
        const lineNumber = index + 1;
        checkImportSpecifiers(line, lineNumber, filePath, findings);
        checkTextPatterns(line, lineNumber, filePath, findings);
    });

    return findings;
}

function parseScanRoots(argv) {
    const roots = argv.length > 0
        ? argv
        : DEFAULT_SCAN_ROOTS;

    return roots.map(root => path.resolve(PROJECT_ROOT, root));
}

async function main() {
    const scanRoots = parseScanRoots(process.argv.slice(2));
    const missingRoots = [];
    const files = [];

    for (const root of scanRoots) {
        if (!(await pathExists(root))) {
            missingRoots.push(root);
            continue;
        }
        files.push(...await collectFiles(root));
    }

    if (missingRoots.length > 0) {
        console.error('[ChatUI] runtime artifact check failed: missing scan roots');
        for (const root of missingRoots) {
            console.error(`- ${displayPath(root)}`);
        }
        process.exitCode = 1;
        return;
    }

    if (files.length === 0) {
        console.error('[ChatUI] runtime artifact check failed: no generated JS/MJS files found');
        process.exitCode = 1;
        return;
    }

    const findings = [];
    for (const file of files) {
        findings.push(...await checkFile(file));
    }

    if (findings.length > 0) {
        console.error(`[ChatUI] runtime artifact check failed with ${findings.length} finding(s):`);
        for (const finding of findings) {
            console.error(`- ${displayPath(finding.filePath)}:${finding.lineNumber}:${finding.columnNumber} [${finding.id}] ${finding.message}`);
            console.error(`  ${finding.snippet}`);
        }
        process.exitCode = 1;
        return;
    }

    const scannedRoots = scanRoots.map(displayPath).join(', ');
    console.log(`[ChatUI] runtime artifact check passed (${files.length} files across ${scannedRoots})`);
}

await main();
