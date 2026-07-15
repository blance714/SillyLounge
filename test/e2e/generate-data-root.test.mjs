import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assembleRuntimeCandidate } from '../../scripts/runtime.mjs';
import {
    generateStDataRoot,
    readCharacterMetadata,
} from '../../scripts/e2e/generate-data-root.mjs';

const ST_VERSION = '1.18.0';

async function makeInputs(t) {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sillylounge-fixture-test-'));
    t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

    const stRoot = path.join(tempRoot, 'SillyTavern');
    await fs.mkdir(path.join(stRoot, 'default', 'content'), { recursive: true });
    await fs.writeFile(
        path.join(stRoot, 'package.json'),
        `${JSON.stringify({ name: 'sillytavern', version: ST_VERSION })}\n`,
        'utf8',
    );
    await fs.writeFile(
        path.join(stRoot, 'default', 'content', 'settings.json'),
        `${JSON.stringify({
            firstRun: true,
            username: 'User',
            active_character: '',
            active_group: '',
            user_avatar: 'user-default.png',
            power_user: {},
            extension_settings: {
                disabledExtensions: ['third-party/SillyLounge', 'other-extension'],
            },
        })}\n`,
        'utf8',
    );

    // validateRuntimeTree checks the assembled build tree before it is copied
    // into ST's dataRoot; generateStDataRoot separately verifies that copy.
    const runtimeTarget = path.join(tempRoot, '.runtime', 'SillyLounge');
    const runtimeRoot = await assembleRuntimeCandidate(runtimeTarget);
    return { tempRoot, stRoot, runtimeRoot };
}

async function walkFiles(rootDir) {
    const files = [];
    const visit = async directory => {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) await visit(absolute);
            else if (entry.isFile()) files.push(absolute);
        }
    };
    await visit(rootDir);
    return files;
}

async function treeDigest(rootDir) {
    const hash = crypto.createHash('sha256');
    for (const filePath of await walkFiles(rootDir)) {
        hash.update(path.relative(rootDir, filePath));
        hash.update(await fs.readFile(filePath));
    }
    return hash.digest('hex');
}

async function generate(t, suffix = 'one', overrides = {}) {
    const inputs = await makeInputs(t);
    const targetRoot = path.join(inputs.tempRoot, `data-${suffix}`);
    return generateStDataRoot({
        targetRoot,
        stRoot: inputs.stRoot,
        runtimeRoot: inputs.runtimeRoot,
        ...overrides,
    });
}

test('same fixture inputs generate byte-identical data roots', async t => {
    const inputs = await makeInputs(t);
    const firstRoot = path.join(inputs.tempRoot, 'data-one');
    const secondRoot = path.join(inputs.tempRoot, 'data-two');
    await generateStDataRoot({ targetRoot: firstRoot, stRoot: inputs.stRoot, runtimeRoot: inputs.runtimeRoot });
    await generateStDataRoot({ targetRoot: secondRoot, stRoot: inputs.stRoot, runtimeRoot: inputs.runtimeRoot });
    assert.equal(await treeDigest(firstRoot), await treeDigest(secondRoot));
});

test('generated single-user settings select the fixture and enable SillyLounge', async t => {
    const result = await generate(t);
    const settings = JSON.parse(await fs.readFile(result.paths.settings, 'utf8'));
    assert.equal(result.manifest.user.handle, 'default-user');
    assert.equal(settings.firstRun, false);
    assert.equal(settings.username, 'Test User');
    assert.equal(settings.active_character, 'Lounge Test Character.png');
    assert.equal(settings.active_group, null);
    assert.equal(settings.user_avatar, 'test-user.png');
    assert.equal(settings.power_user.default_persona, 'test-user.png');
    assert.equal(settings.power_user.personas['test-user.png'], 'Test User');
    assert.equal(settings.extension_settings.chatui_composer.enabled, true);
    assert.deepEqual(settings.extension_settings.disabledExtensions, ['other-extension']);
});

test('generated character card points at the existing smoke chat', async t => {
    const result = await generate(t);
    const metadata = readCharacterMetadata(await fs.readFile(result.paths.character));
    assert.equal(metadata.spec, 'chara_card_v3');
    assert.equal(metadata.name, 'Lounge Test Character');
    assert.equal(metadata.data.name, 'Lounge Test Character');
    assert.equal(metadata.chat, 'smoke');
    await fs.access(result.paths.chat);
});

test('generated JSONL has the declared user turns and alternating roles', async t => {
    const result = await generate(t);
    const rows = (await fs.readFile(result.paths.chat, 'utf8'))
        .trimEnd()
        .split('\n')
        .map(line => JSON.parse(line));
    const [header, ...messages] = rows;
    assert.deepEqual(header, {
        user_name: 'Test User',
        character_name: 'Lounge Test Character',
        create_date: '2026-01-01T00:00:00.000Z',
        chat_metadata: {},
    });
    assert.equal(messages.length, result.manifest.conversation.messageCount);
    assert.equal(messages.filter(message => message.is_user).length, result.manifest.conversation.userTurns);
    assert.deepEqual(messages.map(message => message.is_user), [true, false, true, false]);
    assert.deepEqual(messages.map(message => message.mes), [
        '第一条测试消息。',
        '第一条测试回复。',
        '第二条测试消息。',
        '第二条测试回复。',
    ]);
});

test('generated extension is a complete copy of the validated runtime', async t => {
    const result = await generate(t);
    const sourceManifest = await fs.readFile(path.join(result.paths.extension, 'manifest.json'), 'utf8');
    assert.equal(JSON.parse(sourceManifest).display_name, 'SillyLounge 🍸');
    assert.notEqual((await walkFiles(result.paths.extension)).length, 0);
    assert.equal((await fs.lstat(result.paths.extension)).isSymbolicLink(), false);
});

test('generated files contain no private paths, secrets, or real-user identifiers', async t => {
    const result = await generate(t);
    const forbidden = [
        '/Users/',
        '/home/',
        '\\Users\\',
        'blance_714@',
        'sk-',
    ];
    for (const filePath of await walkFiles(result.targetRoot)) {
        const content = (await fs.readFile(filePath)).toString('utf8');
        for (const marker of forbidden) {
            assert.equal(content.includes(marker), false, `${path.relative(result.targetRoot, filePath)} contains ${marker}`);
        }
    }
});

test('generator rejects a non-empty target instead of touching existing data', async t => {
    const inputs = await makeInputs(t);
    const targetRoot = path.join(inputs.tempRoot, 'existing-data');
    const sentinel = path.join(targetRoot, 'do-not-touch.txt');
    await fs.mkdir(targetRoot, { recursive: true });
    await fs.writeFile(sentinel, 'owned by somebody else', 'utf8');
    await assert.rejects(
        generateStDataRoot({ targetRoot, stRoot: inputs.stRoot, runtimeRoot: inputs.runtimeRoot }),
        /target data root must be empty/,
    );
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'owned by somebody else');
});

test('generator rejects fixture path traversal before writing output', async t => {
    const inputs = await makeInputs(t);
    const fixture = JSON.parse(await fs.readFile(
        path.join(import.meta.dirname, 'fixtures', 'smoke', 'fixture.json'),
        'utf8',
    ));
    fixture.user.avatar = '../outside.png';
    const maliciousFixture = path.join(inputs.tempRoot, 'malicious-fixture.json');
    await fs.writeFile(maliciousFixture, JSON.stringify(fixture), 'utf8');
    const targetRoot = path.join(inputs.tempRoot, 'data-malicious');
    await assert.rejects(
        generateStDataRoot({
            targetRoot,
            stRoot: inputs.stRoot,
            runtimeRoot: inputs.runtimeRoot,
            fixturePath: maliciousFixture,
        }),
        /user avatar must be one safe path segment/,
    );
    await assert.rejects(fs.access(targetRoot), error => error?.code === 'ENOENT');
});

test('generator rejects a SillyTavern checkout at the wrong version', async t => {
    const inputs = await makeInputs(t);
    await fs.writeFile(
        path.join(inputs.stRoot, 'package.json'),
        `${JSON.stringify({ name: 'sillytavern', version: '1.17.0' })}\n`,
        'utf8',
    );
    await assert.rejects(
        generateStDataRoot({
            targetRoot: path.join(inputs.tempRoot, 'data-wrong-version'),
            stRoot: inputs.stRoot,
            runtimeRoot: inputs.runtimeRoot,
        }),
        /SillyTavern version mismatch: expected 1\.18\.0, got 1\.17\.0/,
    );
});
