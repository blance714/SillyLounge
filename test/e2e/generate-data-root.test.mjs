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
    await fs.mkdir(path.join(stRoot, 'public', 'scripts', 'extensions', 'third-party', 'ExistingGlobal'), {
        recursive: true,
    });

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
    assert.equal(settings.currentVersion, ST_VERSION);
    assert.equal(settings.username, 'Test User');
    assert.equal(settings.active_character, 'Lounge Test Character.png');
    assert.equal(settings.active_group, null);
    assert.equal(settings.user_avatar, 'test-user.png');
    assert.equal(settings.power_user.default_persona, 'test-user.png');
    assert.equal(settings.power_user.auto_load_chat, true);
    assert.equal(settings.power_user.chat_truncation, 100);
    assert.equal(settings.power_user.personas['test-user.png'], 'Test User');
    assert.equal(settings.extension_settings.chatui_composer.enabled, true);
    assert.deepEqual(settings.extension_settings.disabledExtensions, [
        'other-extension',
        'third-party/ExistingGlobal',
    ]);
});

test('extension modes isolate native, bootstrap, and active performance baselines', async t => {
    const disabled = await generate(t, 'disabled', { extensionMode: 'disabled' });
    const disabledSettings = JSON.parse(await fs.readFile(disabled.paths.settings, 'utf8'));
    assert.equal(disabled.manifest.extensionMode, 'disabled');
    assert.equal(disabledSettings.extension_settings.chatui_composer.enabled, false);
    assert.equal(
        disabledSettings.extension_settings.disabledExtensions.includes('third-party/SillyLounge'),
        true,
    );

    const bootstrap = await generate(t, 'bootstrap', { extensionMode: 'bootstrap' });
    const bootstrapSettings = JSON.parse(await fs.readFile(bootstrap.paths.settings, 'utf8'));
    assert.equal(bootstrap.manifest.extensionMode, 'bootstrap');
    assert.equal(bootstrapSettings.extension_settings.chatui_composer.enabled, false);
    assert.equal(
        bootstrapSettings.extension_settings.disabledExtensions.includes('third-party/SillyLounge'),
        false,
    );
});

test('native truncation guard flags are orthogonal to extension mode and land in the right settings slots', async t => {
    const plain = await generate(t, 'truncation-plain');
    const plainSettings = JSON.parse(await fs.readFile(plain.paths.settings, 'utf8'));
    assert.deepEqual(plain.manifest.nativeTruncation, {
        overrideEnabled: true,
        pollution: false,
        originalChatTruncation: 100,
        overrideSentinel: 1,
    });
    assert.equal(plainSettings.power_user.chat_truncation, 100);
    assert.equal(plainSettings.extension_settings.chatui_composer.config.nativeTruncationOverrideEnabled, true);
    assert.equal(plainSettings.extension_settings.chatui_composer.nativeTruncationBackup, undefined);

    const explicitFlagOff = await generate(t, 'truncation-explicit-flag-off', {
        extensionMode: 'active',
        nativeTruncationOverrideEnabled: false,
    });
    const explicitFlagOffSettings = JSON.parse(await fs.readFile(explicitFlagOff.paths.settings, 'utf8'));
    assert.equal(explicitFlagOff.manifest.nativeTruncation.overrideEnabled, false);
    assert.equal(explicitFlagOffSettings.extension_settings.chatui_composer.enabled, true);
    assert.equal(explicitFlagOffSettings.extension_settings.chatui_composer.config.nativeTruncationOverrideEnabled, false);
    assert.equal(explicitFlagOffSettings.power_user.chat_truncation, 100);

    const bootstrapPolluted = await generate(t, 'truncation-bootstrap-polluted', {
        extensionMode: 'bootstrap',
        nativeTruncationPollution: true,
    });
    const bootstrapPollutedSettings = JSON.parse(await fs.readFile(bootstrapPolluted.paths.settings, 'utf8'));
    assert.equal(bootstrapPolluted.manifest.nativeTruncation.pollution, true);
    assert.equal(bootstrapPollutedSettings.extension_settings.chatui_composer.enabled, false);
    assert.equal(bootstrapPollutedSettings.power_user.chat_truncation, 1);
    assert.equal(bootstrapPollutedSettings.extension_settings.chatui_composer.nativeTruncationBackup, 100);
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

test('long-plain generator materializes exactly 400 user floors and replies', async t => {
    const fixturePath = path.join(import.meta.dirname, 'fixtures', 'long-plain', 'fixture.json');
    const result = await generate(t, 'long-plain', { fixturePath });
    const rows = (await fs.readFile(result.paths.chat, 'utf8'))
        .trimEnd()
        .split('\n')
        .map(line => JSON.parse(line));
    const messages = rows.slice(1);
    assert.equal(result.manifest.fixture, 'long-plain');
    assert.equal(result.manifest.conversation.messageCount, 800);
    assert.equal(result.manifest.conversation.userTurns, 400);
    assert.equal(messages.length, 800);
    assert.deepEqual(messages.slice(0, 2).map(message => message.mes), [
        '第 1 楼用户消息：用于测量长对话加载与跳转。',
        '第 1 楼助手回复：固定、简短、无附件的 Markdown 文本。',
    ]);
    assert.deepEqual(messages.slice(-2).map(message => message.mes), [
        '第 400 楼用户消息：用于测量长对话加载与跳转。',
        '第 400 楼助手回复：固定、简短、无附件的 Markdown 文本。',
    ]);
});

test('long-rich generator reproduces the anonymized structural profile', async t => {
    const fixturePath = path.join(import.meta.dirname, 'fixtures', 'long-rich', 'fixture.json');
    const result = await generate(t, 'long-rich', { fixturePath });
    const chatSource = await fs.readFile(result.paths.chat, 'utf8');
    const rows = chatSource
        .trimEnd()
        .split('\n')
        .slice(1)
        .map(line => JSON.parse(line));
    const users = rows.filter(message => message.is_user);
    const assistants = rows.filter(message => !message.is_user);
    const quantile = (values, percentile) => {
        const sorted = values.toSorted((left, right) => left - right);
        return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentile))];
    };

    assert.equal(result.manifest.fixture, 'long-rich');
    assert.equal(result.manifest.conversation.kind, 'profiled-rich');
    assert.equal(rows.length, 800);
    assert.equal(users.length, 400);
    assert.equal(assistants.length, 400);
    assert.deepEqual(
        [0.5, 0.9, 0.95, 1].map(percentile => quantile(users.map(message => message.mes.length), percentile)),
        [24, 73, 87, 298],
    );
    assert.deepEqual(
        [0.5, 0.9, 0.95, 0.99, 1].map(percentile => quantile(assistants.map(message => message.mes.length), percentile)),
        [6147, 8706, 9273, 11122, 17761],
    );
    assert.equal(assistants.filter(message => message.mes.includes('<thinking>')).length, 316);
    assert.equal(assistants.filter(message => message.extra?.reasoning).length, 79);
    assert.equal(
        assistants.filter(message => message.mes.includes('<thinking>') || message.extra?.reasoning).length,
        391,
    );
    assert.equal(assistants.filter(message => message.mes.includes('```json')).length, 180);
    assert.equal(assistants.filter(message => message.mes.includes('<branches>')).length, 400);
    assert.ok(assistants.every(message => message.mes.indexOf('<branches>') > message.mes.indexOf('叙事继续沿着环境')));

    const swipeCounts = assistants.map(message => message.swipes.length);
    assert.equal(Number((swipeCounts.reduce((sum, value) => sum + value, 0) / swipeCounts.length).toFixed(2)), 1.88);
    assert.equal(quantile(swipeCounts, 0.95), 6);
    assert.equal(Math.max(...swipeCounts), 53);
    assert.ok(Buffer.byteLength(chatSource) > 20 * 1024 * 1024);

    const settings = JSON.parse(await fs.readFile(result.paths.settings, 'utf8'));
    assert.deepEqual(settings.extension_settings.character_allowed_regex, [
        'Lounge Rich Performance Character.png',
    ]);
    const metadata = readCharacterMetadata(await fs.readFile(result.paths.character));
    const scripts = metadata.data.extensions.regex_scripts;
    assert.equal(scripts.length, 2);
    assert.deepEqual(
        scripts.map(script => script.replaceString.length).toSorted((left, right) => left - right),
        [3244, 9054],
    );
    assert.equal(scripts.every(script => script.markdownOnly && script.placement.includes(2)), true);
    assert.deepEqual(scripts.map(script => script.maxDepth), [2, 5]);
    assert.equal(scripts.filter(script => script.replaceString.includes('```html')).length, 1);
    assert.equal(scripts.filter(script => script.replaceString.includes('data-synthetic-regex="thought"')).length, 1);
    assert.equal(scripts.filter(script => script.replaceString.includes('document.createElement')).length, 1);
});

test('long-rich generator can disable scoped regex without changing the fixture messages or card', async t => {
    const fixturePath = path.join(import.meta.dirname, 'fixtures', 'long-rich', 'fixture.json');
    const active = await generate(t, 'long-rich-regex-active', { fixturePath });
    const disabled = await generate(t, 'long-rich-regex-disabled', { fixturePath, regexMode: 'disabled' });
    const activeSettings = JSON.parse(await fs.readFile(active.paths.settings, 'utf8'));
    const disabledSettings = JSON.parse(await fs.readFile(disabled.paths.settings, 'utf8'));

    assert.equal(active.manifest.regexMode, 'active');
    assert.equal(disabled.manifest.regexMode, 'disabled');
    assert.deepEqual(activeSettings.extension_settings.character_allowed_regex, [
        'Lounge Rich Performance Character.png',
    ]);
    assert.deepEqual(disabledSettings.extension_settings.character_allowed_regex, []);
    assert.equal(
        activeSettings.accountStorage['AlertRegex_Lounge Rich Performance Character.png'],
        undefined,
    );
    assert.equal(
        disabledSettings.accountStorage['AlertRegex_Lounge Rich Performance Character.png'],
        'true',
    );
    assert.equal(await fs.readFile(active.paths.chat, 'utf8'), await fs.readFile(disabled.paths.chat, 'utf8'));
    assert.deepEqual(
        readCharacterMetadata(await fs.readFile(active.paths.character)),
        readCharacterMetadata(await fs.readFile(disabled.paths.character)),
    );
});

test('long-rich switch fixture generates two isolated 400-floor conversations', async t => {
    const fixturePath = path.join(import.meta.dirname, 'fixtures', 'long-rich-switch', 'fixture.json');
    const result = await generate(t, 'long-rich-switch', { fixturePath });

    assert.equal(result.manifest.conversation.fileName, 'long-rich-a');
    assert.deepEqual(result.manifest.conversations, [
        {
            fileName: 'long-rich-a',
            marker: 'LONG-RICH-A',
            messageCount: 800,
            userTurns: 400,
            kind: 'profiled-rich',
        },
        {
            fileName: 'long-rich-b',
            marker: 'LONG-RICH-B',
            messageCount: 800,
            userTurns: 400,
            kind: 'profiled-rich',
        },
    ]);
    assert.deepEqual(result.paths.chats.map(chat => chat.fileName), ['long-rich-a', 'long-rich-b']);
    const [firstSource, secondSource] = await Promise.all(
        result.paths.chats.map(chat => fs.readFile(chat.path, 'utf8')),
    );
    assert.equal(firstSource.split('\n').length - 1, 801);
    assert.equal(secondSource.split('\n').length - 1, 801);
    assert.equal(firstSource.includes('会话标记：LONG-RICH-A'), true);
    assert.equal(firstSource.includes('会话标记：LONG-RICH-B'), false);
    assert.equal(secondSource.includes('会话标记：LONG-RICH-B'), true);
    assert.equal(secondSource.includes('会话标记：LONG-RICH-A'), false);
    const metadata = readCharacterMetadata(await fs.readFile(result.paths.character));
    assert.equal(metadata.chat, 'long-rich-a');
});

test('long-rich 10-floor switch fixture preserves the rich profile for a small control pair', async t => {
    const fixturePath = path.join(import.meta.dirname, 'fixtures', 'long-rich-switch-10', 'fixture.json');
    const result = await generate(t, 'long-rich-switch-10', { fixturePath });

    assert.equal(result.manifest.conversation.fileName, 'long-rich-10-a');
    assert.deepEqual(result.manifest.conversations, [
        {
            fileName: 'long-rich-10-a',
            marker: 'LONG-RICH-10-A',
            messageCount: 20,
            userTurns: 10,
            kind: 'profiled-rich',
        },
        {
            fileName: 'long-rich-10-b',
            marker: 'LONG-RICH-10-B',
            messageCount: 20,
            userTurns: 10,
            kind: 'profiled-rich',
        },
    ]);
    const [firstSource, secondSource] = await Promise.all(
        result.paths.chats.map(chat => fs.readFile(chat.path, 'utf8')),
    );
    const firstMessages = firstSource
        .trimEnd()
        .split('\n')
        .slice(1)
        .map(line => JSON.parse(line));
    const firstAssistants = firstMessages.filter(message => !message.is_user);
    assert.equal(firstMessages.length, 20);
    assert.equal(firstAssistants.every(message => message.mes.includes('<branches>')), true);
    assert.equal(firstAssistants.filter(message => message.mes.includes('<thinking>')).length, 8);
    assert.equal(firstAssistants.filter(message => message.extra?.reasoning).length, 2);
    assert.equal(firstSource.includes('会话标记：LONG-RICH-10-A'), true);
    assert.equal(firstSource.includes('会话标记：LONG-RICH-10-B'), false);
    assert.equal(secondSource.includes('会话标记：LONG-RICH-10-B'), true);
    assert.equal(secondSource.includes('会话标记：LONG-RICH-10-A'), false);
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
