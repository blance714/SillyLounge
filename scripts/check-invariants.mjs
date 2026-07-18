import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');

const INVARIANTS_DOC = path.join(PROJECT_ROOT, 'INVARIANTS.md');
const TEST_DIR = path.join(PROJECT_ROOT, 'test');

// Only the Node unit suites participate in the reverse (completeness) check.
// test/e2e/*.test.mjs exercises the measurement harness, not product
// invariants, so its tests may be registered but are not required to be.
const REVERSE_CHECK_EXEMPT_DIRS = new Set(['e2e', 'helpers']);

// A reference cell looks like `test/foo.test.mjs :: exact test title`.
const REFERENCE_PATTERN = /`([^`]+?\.test\.mjs)\s*::\s*([^`]+?)`/g;

// Forward references may point at any registration, including t.test()
// subtests; the reverse (completeness) check only demands top-level test()
// calls so suites remain free to structure their internals with subtests.
const TEST_TITLE_PATTERN = /(?:^|[\s(.])(?:test|it)\(\s*(['"`])((?:\\.|(?!\1).)+)\1/gm;
const TOP_LEVEL_TEST_PATTERN = /^test\(\s*(['"`])((?:\\.|(?!\1).)+)\1/gm;

function extractTestTitles(source, pattern = TEST_TITLE_PATTERN) {
    const titles = [];
    for (const match of source.matchAll(pattern)) {
        titles.push(match[2].replace(/\\(['"`])/g, '$1'));
    }
    return titles;
}

async function listUnitTestFiles() {
    const files = [];
    const entries = await fs.readdir(TEST_DIR, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.test.mjs')) continue;
        const parentDir = path.relative(TEST_DIR, entry.parentPath || entry.path);
        const topLevelDir = parentDir === '' ? null : parentDir.split(path.sep)[0];
        if (topLevelDir !== null && REVERSE_CHECK_EXEMPT_DIRS.has(topLevelDir)) continue;
        files.push(path.join(entry.parentPath || entry.path, entry.name));
    }
    return files.sort();
}

async function main() {
    let doc;
    try {
        doc = await fs.readFile(INVARIANTS_DOC, 'utf8');
    } catch {
        console.error('[check-invariants] INVARIANTS.md is missing.');
        process.exitCode = 1;
        return;
    }

    const problems = [];

    // Forward check: every referenced test must exist verbatim in its file.
    const references = [...doc.matchAll(REFERENCE_PATTERN)];
    const sourceCache = new Map();
    for (const [, refFile, refTitleRaw] of references) {
        const refTitle = refTitleRaw.trim();
        const absolute = path.join(PROJECT_ROOT, refFile);
        if (!sourceCache.has(absolute)) {
            try {
                sourceCache.set(absolute, await fs.readFile(absolute, 'utf8'));
            } catch {
                sourceCache.set(absolute, null);
            }
        }
        const source = sourceCache.get(absolute);
        if (source === null) {
            problems.push(`引用的测试文件不存在：${refFile}`);
            continue;
        }
        if (!extractTestTitles(source).includes(refTitle)) {
            problems.push(`清单引用的测试在 ${refFile} 中不存在：“${refTitle}”`);
        }
    }

    // Reverse check: every unit test must be registered in the doc, so the
    // doc cannot silently fall behind the suite it claims to describe.
    let unitTestCount = 0;
    for (const file of await listUnitTestFiles()) {
        const relFile = path.relative(PROJECT_ROOT, file).split(path.sep).join('/');
        const source = await fs.readFile(file, 'utf8');
        for (const title of extractTestTitles(source, TOP_LEVEL_TEST_PATTERN)) {
            unitTestCount += 1;
            if (!doc.includes(`\`${relFile} :: ${title}\``)) {
                problems.push(`未登记的测试：\`${relFile} :: ${title}\``);
            }
        }
    }

    if (problems.length > 0) {
        console.error(`[check-invariants] 校验失败（${problems.length} 个问题）：`);
        for (const problem of problems) console.error(`  - ${problem}`);
        process.exitCode = 1;
        return;
    }

    console.log(
        `[check-invariants] OK：${references.length} 条清单引用与 ${unitTestCount} 个单元测试双向一致。`,
    );
}

await main();
