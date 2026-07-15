import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { validateRuntimeTree } from '../check-runtime.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '../..');
const DEFAULT_ST_PIN_PATH = path.join(PROJECT_ROOT, 'test', 'e2e', 'st-version.json');
const DEFAULT_FIXTURE_PATH = path.join(PROJECT_ROOT, 'test', 'e2e', 'fixtures', 'smoke', 'fixture.json');
const DEFAULT_RUNTIME_ROOT = path.join(PROJECT_ROOT, '.runtime', 'SillyTavern-ChatUI');
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const USER_HANDLE = 'default-user';
const EXTENSION_FOLDER = 'SillyLounge';
const FIXTURE_MANIFEST_FILE = '_sillylounge-fixture.json';
const EXTENSION_MODES = new Set(['disabled', 'bootstrap', 'active']);

function isPathInside(rootPath, candidatePath) {
    const relative = path.relative(rootPath, candidatePath);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function safeLeafName(value, label) {
    if (
        typeof value !== 'string'
        || value.length === 0
        || value === '.'
        || value === '..'
        || value.includes('/')
        || value.includes('\\')
        || value.includes('\0')
        || path.basename(value) !== value
    ) {
        throw new Error(`${label} must be one safe path segment`);
    }
    return value;
}

function fixturePath(rootPath, ...segments) {
    const targetPath = path.resolve(rootPath, ...segments);
    if (!isPathInside(rootPath, targetPath)) {
        throw new Error(`fixture path leaves target data root: ${segments.join('/')}`);
    }
    return targetPath;
}

async function readJson(filePath) {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(value, null, 4)}\n`, 'utf8');
}

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
    const typeBuffer = Buffer.from(type, 'ascii');
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    typeBuffer.copy(chunk, 4);
    data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
    return chunk;
}

function createSolidPng(width, height, rgba) {
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
        throw new Error('PNG dimensions must be positive integers');
    }
    if (!Array.isArray(rgba) || rgba.length !== 4 || rgba.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
        throw new Error('PNG color must contain four bytes');
    }

    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 6;
    header[10] = 0;
    header[11] = 0;
    header[12] = 0;

    const row = Buffer.alloc(1 + width * 4);
    row[0] = 0;
    for (let offset = 1; offset < row.length; offset += 4) {
        row.set(rgba, offset);
    }
    const pixels = Buffer.concat(Array.from({ length: height }, () => row));
    return Buffer.concat([
        PNG_SIGNATURE,
        pngChunk('IHDR', header),
        pngChunk('IDAT', zlib.deflateSync(pixels, { level: 9 })),
        pngChunk('IEND'),
    ]);
}

function characterCardSource(fixture, card) {
    const data = card.data;
    return {
        name: data.name,
        description: data.description,
        personality: data.personality,
        scenario: data.scenario,
        first_mes: data.first_mes,
        mes_example: data.mes_example,
        creatorcomment: data.creator_notes,
        avatar: 'none',
        chat: fixture.conversation.fileName,
        talkativeness: data.extensions?.talkativeness ?? 0.5,
        fav: data.extensions?.fav ?? false,
        tags: data.tags,
        create_date: fixture.createdAt,
        spec: card.spec,
        spec_version: card.spec_version,
        data: structuredClone(data),
    };
}

function textChunk(keyword, text) {
    return pngChunk('tEXt', Buffer.concat([
        Buffer.from(keyword, 'latin1'),
        Buffer.from([0]),
        Buffer.from(text, 'latin1'),
    ]));
}

function createCharacterPng(fixture, card) {
    const v2 = characterCardSource(fixture, card);
    const v3 = { ...structuredClone(v2), spec: 'chara_card_v3', spec_version: '3.0' };
    const basePng = createSolidPng(128, 192, fixture.character.avatarColor);
    return Buffer.concat([
        basePng.subarray(0, basePng.length - 12),
        textChunk('chara', Buffer.from(JSON.stringify(v2), 'utf8').toString('base64')),
        textChunk('ccv3', Buffer.from(JSON.stringify(v3), 'utf8').toString('base64')),
        basePng.subarray(basePng.length - 12),
    ]);
}

function conversationRows(fixture, characterName, messages) {
    const rows = [{
        user_name: fixture.user.name,
        character_name: characterName,
        create_date: fixture.createdAt,
        chat_metadata: {},
    }];
    const epoch = Date.parse(fixture.createdAt);
    messages.forEach((message, index) => {
        const isUser = message.role === 'user';
        rows.push({
            name: isUser ? fixture.user.name : characterName,
            is_user: isUser,
            is_name: true,
            send_date: new Date(epoch + (index + 1) * 1000).toISOString(),
            mes: message.text,
            extra: {},
        });
    });
    return rows;
}

async function discoverGlobalExtensionNames(stRoot) {
    const extensionRoot = path.join(stRoot, 'public', 'scripts', 'extensions', 'third-party');
    let entries;
    try {
        entries = await fs.readdir(extensionRoot, { withFileTypes: true });
    } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
    }
    const discovered = [];
    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const entryPath = path.join(extensionRoot, entry.name);
        if ((await fs.stat(entryPath)).isDirectory()) discovered.push(`third-party/${entry.name}`);
    }
    return discovered.sort((left, right) => left.localeCompare(right));
}

function patchSettings(baseSettings, fixture, stVersion, globalExtensions, extensionMode) {
    const settings = structuredClone(baseSettings);
    settings.firstRun = false;
    settings.currentVersion = stVersion;
    settings.username = fixture.user.name;
    settings.active_character = fixture.character.fileName;
    settings.active_group = null;
    settings.user_avatar = fixture.user.avatar;
    settings.selected_button = 'characters';
    settings.power_user = settings.power_user && typeof settings.power_user === 'object'
        ? settings.power_user
        : {};
    settings.power_user.default_persona = fixture.user.avatar;
    settings.power_user.auto_load_chat = true;
    settings.power_user.chat_truncation = 100;
    settings.power_user.personas = settings.power_user.personas && typeof settings.power_user.personas === 'object'
        ? settings.power_user.personas
        : {};
    settings.power_user.personas[fixture.user.avatar] = fixture.user.name;
    settings.power_user.persona_descriptions = settings.power_user.persona_descriptions
        && typeof settings.power_user.persona_descriptions === 'object'
        ? settings.power_user.persona_descriptions
        : {};
    settings.power_user.persona_descriptions[fixture.user.avatar] = {
        description: '',
        position: 0,
    };

    settings.extension_settings = settings.extension_settings && typeof settings.extension_settings === 'object'
        ? settings.extension_settings
        : {};
    const disabled = Array.isArray(settings.extension_settings.disabledExtensions)
        ? settings.extension_settings.disabledExtensions
        : [];
    const disabledExtensions = Array.from(new Set([
        ...disabled.filter(value => (
            typeof value !== 'string' || !value.toLowerCase().includes('sillylounge')
        )),
        ...globalExtensions.filter(value => value.toLowerCase() !== 'third-party/sillylounge'),
    ]));
    if (extensionMode === 'disabled') disabledExtensions.push(`third-party/${EXTENSION_FOLDER}`);
    settings.extension_settings.disabledExtensions = disabledExtensions;
    const existing = settings.extension_settings.chatui_composer;
    settings.extension_settings.chatui_composer = {
        ...(existing && typeof existing === 'object' ? existing : {}),
        enabled: extensionMode === 'active',
    };
    return settings;
}

function materializeConversationMessages(fixture) {
    const source = fixture.conversation?.messages;
    if (Array.isArray(source)) return structuredClone(source);
    if (source?.kind !== 'alternating') {
        throw new Error('fixture conversation must contain messages or an alternating message generator');
    }
    if (!Number.isInteger(source.userTurns) || source.userTurns <= 0 || source.userTurns > 10_000) {
        throw new Error('alternating fixture userTurns must be an integer between 1 and 10000');
    }
    if (typeof source.userTemplate !== 'string' || typeof source.assistantTemplate !== 'string') {
        throw new Error('alternating fixture templates must be strings');
    }
    const messages = [];
    for (let floor = 1; floor <= source.userTurns; floor += 1) {
        messages.push(
            { role: 'user', text: source.userTemplate.replaceAll('{floor}', String(floor)) },
            { role: 'assistant', text: source.assistantTemplate.replaceAll('{floor}', String(floor)) },
        );
    }
    return messages;
}

function validateFixture(fixture) {
    if (!fixture || typeof fixture !== 'object') throw new Error('fixture must be an object');
    safeLeafName(fixture.id, 'fixture id');
    safeLeafName(fixture.user?.avatar, 'user avatar');
    safeLeafName(fixture.character?.fileName, 'character filename');
    safeLeafName(fixture.character?.card, 'character card filename');
    safeLeafName(fixture.conversation?.fileName, 'conversation filename');
    if (!fixture.character.fileName.endsWith('.png')) throw new Error('character filename must end in .png');
    const messages = materializeConversationMessages(fixture);
    if (messages.length === 0) throw new Error('fixture conversation must contain messages');
    for (const [index, message] of messages.entries()) {
        if (!['user', 'assistant'].includes(message?.role) || typeof message?.text !== 'string') {
            throw new Error(`fixture message ${index} is invalid`);
        }
    }
    if (!Number.isFinite(Date.parse(fixture.createdAt))) throw new Error('fixture createdAt must be an ISO date');
    return messages;
}

function validateCharacterCard(card) {
    if (card?.spec !== 'chara_card_v2' || card?.spec_version !== '2.0' || !card?.data) {
        throw new Error('fixture character card must use the chara_card_v2 JSON format');
    }
    safeLeafName(card.data.name, 'character card name');
}

async function assertEmptyTarget(targetRoot) {
    await fs.mkdir(targetRoot, { recursive: true });
    const entries = await fs.readdir(targetRoot);
    if (entries.length > 0) {
        throw new Error('target data root must be empty');
    }
}

export function readCharacterMetadata(pngBuffer) {
    if (!pngBuffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        throw new Error('invalid PNG signature');
    }
    let offset = PNG_SIGNATURE.length;
    const chunks = new Map();
    while (offset < pngBuffer.length) {
        const length = pngBuffer.readUInt32BE(offset);
        const type = pngBuffer.toString('ascii', offset + 4, offset + 8);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd + 4 > pngBuffer.length) throw new Error('truncated PNG chunk');
        if (type === 'tEXt') {
            const separator = pngBuffer.indexOf(0, dataStart);
            if (separator >= dataStart && separator < dataEnd) {
                const keyword = pngBuffer.toString('latin1', dataStart, separator);
                const value = pngBuffer.toString('latin1', separator + 1, dataEnd);
                chunks.set(keyword, value);
            }
        }
        offset = dataEnd + 4;
        if (type === 'IEND') break;
    }
    const encoded = chunks.get('ccv3') ?? chunks.get('chara');
    if (!encoded) throw new Error('PNG has no character metadata');
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
}

export async function generateStDataRoot({
    targetRoot,
    stRoot,
    runtimeRoot = DEFAULT_RUNTIME_ROOT,
    fixturePath: sourceFixturePath = DEFAULT_FIXTURE_PATH,
    stPinPath = DEFAULT_ST_PIN_PATH,
    extensionMode = 'active',
}) {
    if (!targetRoot || !stRoot || !runtimeRoot) {
        throw new Error('targetRoot, stRoot, and runtimeRoot are required');
    }

    const resolvedTarget = path.resolve(targetRoot);
    const resolvedStRoot = path.resolve(stRoot);
    const resolvedRuntimeRoot = path.resolve(runtimeRoot);
    const [pin, fixture, stPackage, baseSettings, globalExtensions] = await Promise.all([
        readJson(stPinPath),
        readJson(sourceFixturePath),
        readJson(path.join(resolvedStRoot, 'package.json')),
        readJson(path.join(resolvedStRoot, 'default', 'content', 'settings.json')),
        discoverGlobalExtensionNames(resolvedStRoot),
    ]);
    if (stPackage.version !== pin.version) {
        throw new Error(`SillyTavern version mismatch: expected ${pin.version}, got ${stPackage.version}`);
    }
    if (!EXTENSION_MODES.has(extensionMode)) {
        throw new Error(`invalid extension mode: ${extensionMode}`);
    }
    const messages = validateFixture(fixture);
    const characterCardPath = path.join(path.dirname(sourceFixturePath), fixture.character.card);
    const characterCard = await readJson(characterCardPath);
    validateCharacterCard(characterCard);
    await validateRuntimeTree(resolvedRuntimeRoot);
    await assertEmptyTarget(resolvedTarget);

    const userRoot = fixturePath(resolvedTarget, USER_HANDLE);
    const characterDirName = fixture.character.fileName.slice(0, -'.png'.length);
    const settingsPath = fixturePath(userRoot, 'settings.json');
    const avatarPath = fixturePath(userRoot, 'User Avatars', fixture.user.avatar);
    const characterPath = fixturePath(userRoot, 'characters', fixture.character.fileName);
    const chatPath = fixturePath(
        userRoot,
        'chats',
        characterDirName,
        `${fixture.conversation.fileName}.jsonl`,
    );
    const extensionPath = fixturePath(userRoot, 'extensions', EXTENSION_FOLDER);

    await writeJson(
        settingsPath,
        patchSettings(baseSettings, fixture, pin.version, globalExtensions, extensionMode),
    );
    await fs.mkdir(path.dirname(avatarPath), { recursive: true });
    await fs.writeFile(avatarPath, createSolidPng(128, 128, fixture.user.avatarColor));
    await fs.mkdir(path.dirname(characterPath), { recursive: true });
    await fs.writeFile(characterPath, createCharacterPng(fixture, characterCard));
    await fs.mkdir(path.dirname(chatPath), { recursive: true });
    await fs.writeFile(
        chatPath,
        `${conversationRows(fixture, characterCard.data.name, messages).map(row => JSON.stringify(row)).join('\n')}\n`,
        'utf8',
    );
    await fs.cp(resolvedRuntimeRoot, extensionPath, {
        recursive: true,
        dereference: true,
        errorOnExist: true,
    });

    const messageCount = messages.length;
    const userTurns = messages.filter(message => message.role === 'user').length;
    const manifest = {
        schemaVersion: pin.fixtureSchema,
        fixture: fixture.id,
        st: {
            repository: pin.repository,
            version: pin.version,
            commit: pin.commit,
        },
        user: {
            handle: USER_HANDLE,
            name: fixture.user.name,
            avatar: fixture.user.avatar,
        },
        character: {
            name: characterCard.data.name,
            fileName: fixture.character.fileName,
            source: fixture.character.card,
        },
        conversation: {
            fileName: fixture.conversation.fileName,
            messageCount,
            userTurns,
        },
        extension: EXTENSION_FOLDER,
        extensionMode,
    };
    const manifestPath = fixturePath(resolvedTarget, FIXTURE_MANIFEST_FILE);
    await writeJson(manifestPath, manifest);

    return Object.freeze({
        targetRoot: resolvedTarget,
        manifest,
        paths: Object.freeze({
            settings: settingsPath,
            avatar: avatarPath,
            character: characterPath,
            chat: chatPath,
            extension: extensionPath,
            manifest: manifestPath,
        }),
    });
}

async function main() {
    const args = process.argv.slice(2);
    const values = {};
    for (let index = 0; index < args.length; index += 2) {
        const option = args[index];
        const value = args[index + 1];
        if (!option?.startsWith('--') || !value) throw new Error(`invalid argument: ${option ?? ''}`);
        values[option.slice(2)] = value;
    }
    const result = await generateStDataRoot({
        targetRoot: values.target,
        stRoot: values.st,
        runtimeRoot: values.runtime,
        fixturePath: values.fixture,
        extensionMode: values.mode,
    });
    const digest = crypto.createHash('sha256')
        .update(JSON.stringify(result.manifest))
        .digest('hex')
        .slice(0, 12);
    console.log(`[SillyLounge test] generated ${result.manifest.fixture} dataRoot (${digest}) -> ${result.targetRoot}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
