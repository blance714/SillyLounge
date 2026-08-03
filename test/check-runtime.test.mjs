import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    RuntimeValidationError,
    validateRuntimeTree,
} from '../scripts/check-runtime.mjs';
import {
    isRuntimeSourcePath,
    publishRuntimeCandidate,
} from '../scripts/runtime.mjs';
import { z as runtimeZod } from '../scripts/vendor/zod-mini.mjs';

async function writeFiles(rootDir, files) {
    for (const [relativePath, content] of Object.entries(files)) {
        const filePath = path.join(rootDir, relativePath);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content);
    }
}

async function makeRuntime(t, overrides = {}) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatui-runtime-test-'));
    // Match SillyTavern's real extension nesting. A shallow /tmp/runtime fixture
    // lets sufficiently deep ../ imports clamp at the filesystem root, making
    // allowlist behavior depend on whether the OS temp path is /tmp or /private/tmp.
    const rootDir = path.join(
        tempDir,
        'public',
        'scripts',
        'extensions',
        'third-party',
        'SillyLounge-dist',
    );
    t.after(() => fs.rm(tempDir, { recursive: true, force: true }));

    await writeFiles(rootDir, {
        'manifest.json': JSON.stringify({ js: 'index.js', css: 'style.css' }),
        'style.css': '.chatui { display: block; }',
        'index.js': [
            'import "./chunks/vendor/zod.js";',
            'import "./adapter/chats.js";',
            'import "../../../extensions.js";',
        ].join('\n'),
        'adapter/chats.js': [
            'import "../../../../../script.js";',
            'import "../../../../slash-commands.js";',
            'export const ready = true;',
        ].join('\n'),
        'chunks/vendor/zod.js': 'export const z = {};\n',
        ...overrides,
    });
    return { tempDir, rootDir };
}

async function expectFinding(action, id) {
    await assert.rejects(action, error => {
        assert.ok(error instanceof RuntimeValidationError);
        assert.ok(
            error.findings.some(finding => finding.id === id),
            `expected ${id}; got ${error.findings.map(finding => finding.id).join(', ')}`,
        );
        return true;
    });
}

test('accepts a complete runtime tree and the explicit SillyTavern import allowlist', async t => {
    const { rootDir } = await makeRuntime(t);
    const result = await validateRuntimeTree(rootDir);
    assert.equal(result.moduleCount, 3);
    assert.ok(result.fileCount >= 5);
});

test('rejects a missing manifest entry', async t => {
    const { rootDir } = await makeRuntime(t, {
        'manifest.json': JSON.stringify({ js: 'missing.js', css: 'style.css' }),
    });
    await expectFinding(() => validateRuntimeTree(rootDir), 'missing-manifest-entry');
});

test('rejects a missing in-tree relative import', async t => {
    const { rootDir } = await makeRuntime(t, {
        'index.js': 'import "./missing.js";\n',
    });
    await expectFinding(() => validateRuntimeTree(rootDir), 'missing-relative-import');
});

test('checks re-export and dynamic-import edges in the generated module graph', async t => {
    const { rootDir } = await makeRuntime(t, {
        'index.js': [
            'export{missing}from"./missing-export.js";',
            'void import("./missing-dynamic.js");',
        ].join('\n'),
    });
    await assert.rejects(() => validateRuntimeTree(rootDir), error => {
        assert.ok(error instanceof RuntimeValidationError);
        assert.equal(
            error.findings.filter(finding => finding.id === 'missing-relative-import').length,
            2,
        );
        return true;
    });
});

test('rejects unexpected traversal outside the runtime tree', async t => {
    const { rootDir } = await makeRuntime(t, {
        'index.js': 'import "../../../untrusted.js";\n',
    });
    await expectFinding(() => validateRuntimeTree(rootDir), 'unexpected-runtime-escape');
});

test('rejects unresolved bare imports', async t => {
    const { rootDir } = await makeRuntime(t, {
        'index.js': 'import "zod/mini";\n',
    });
    await expectFinding(() => validateRuntimeTree(rootDir), 'bare-import-specifier');
});

test('rejects package-manager paths in names and source maps', async t => {
    const { rootDir } = await makeRuntime(t, {
        'node_modules/leak.js': 'export {};\n',
        'index.js.map': JSON.stringify({ sources: ['../node_modules/.pnpm/pkg/index.js'] }),
    });
    await expectFinding(() => validateRuntimeTree(rootDir), 'dependency-manager-artifact');
    await expectFinding(() => validateRuntimeTree(rootDir), 'dependency-manager-path');
});

test('rejects absolute machine-local paths in generated metadata', async t => {
    const { rootDir } = await makeRuntime(t, {
        'index.js.map': JSON.stringify({ sources: ['/Users/example/project/src/index.ts'] }),
    });
    await expectFinding(() => validateRuntimeTree(rootDir), 'posix-local-path');
});

test('publishes complete generations behind an atomically replaceable live pointer', async t => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatui-publish-test-'));
    t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
    const targetDir = path.join(tempDir, 'SillyTavern-ChatUI');
    const firstCandidate = path.join(tempDir, 'candidate-one');
    const secondCandidate = path.join(tempDir, 'candidate-two');

    await writeFiles(targetDir, { 'old.txt': 'legacy' });
    await writeFiles(firstCandidate, { 'release.txt': 'one' });
    await publishRuntimeCandidate(firstCandidate, targetDir);
    assert.equal((await fs.lstat(targetDir)).isSymbolicLink(), true);
    assert.equal(await fs.readFile(path.join(targetDir, 'release.txt'), 'utf8'), 'one');
    const firstRelease = path.resolve(tempDir, await fs.readlink(targetDir));

    await writeFiles(secondCandidate, { 'release.txt': 'two' });
    await publishRuntimeCandidate(secondCandidate, targetDir);
    assert.equal(await fs.readFile(path.join(targetDir, 'release.txt'), 'utf8'), 'two');
    await assert.rejects(fs.access(firstRelease), error => error?.code === 'ENOENT');
});

test('dev watcher ignores generated trees and observes runtime inputs', () => {
    assert.equal(isRuntimeSourcePath('src/adapter/chats.ts'), true);
    assert.equal(isRuntimeSourcePath('scripts/vendor/zod-mini.mjs'), true);
    assert.equal(isRuntimeSourcePath('manifest.json'), true);
    assert.equal(isRuntimeSourcePath('dist/runtime/index.js'), false);
    assert.equal(isRuntimeSourcePath('.runtime/SillyTavern-ChatUI/index.js'), false);
    assert.equal(isRuntimeSourcePath('node_modules/zod/index.js'), false);
});

test('runtime Zod facade covers every value-level z member used by adapter schema', async () => {
    const schemaPath = new URL('../src/adapter/schema.ts', import.meta.url);
    const source = await fs.readFile(schemaPath, 'utf8');
    const usedMembers = new Set(
        [...source.matchAll(/\bz\.([A-Za-z_$][\w$]*)/g)]
            .map(match => match[1])
            .filter(member => member !== 'infer'),
    );
    assert.deepEqual([...usedMembers].sort(), Object.keys(runtimeZod).sort());
});
