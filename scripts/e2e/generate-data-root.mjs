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
// The directory a real install lands in, which SillyTavern names after the
// *repo* it cloned from (`sanitize(path.basename(parsedUrl.pathname, '.git'))`,
// its endpoints/extensions.js) — so this tracks the installable repo,
// blance714/SillyLounge-dist, not the source repo this file lives in. A fixture
// that used the source repo's name would be simulating a directory no real
// install has.
const EXTENSION_FOLDER = 'SillyLounge-dist';
const FIXTURE_MANIFEST_FILE = '_sillylounge-fixture.json';
/**
 * Added to the copied extension's `manifest.json`, and read back through
 * SillyTavern's own `getExtensionManifest()` by e2e/smoke.spec.mjs. Its whole
 * job is to make 「the browser is being served the build we just made」 an
 * assertion rather than an assumption — see `assertExtensionIsNotShadowed` for
 * the failure that made it necessary. SillyTavern ignores keys it does not
 * know, so the copy stays a working extension.
 *
 * The value is a digest of the copied tree rather than a per-run id, for two
 * reasons. Identical inputs must still generate byte-identical data roots (the
 * determinism this file is tested for), and 「the served extension is *this
 * build*」 is a more useful claim than 「is this object」: a shadow that happens
 * to be byte-equal is harmless, and one that is not says so.
 */
const EXTENSION_STAMP_KEY = 'sillylounge_e2e_stamp';
const EXTENSION_MODES = new Set(['disabled', 'bootstrap', 'active']);
const REGEX_MODES = new Set(['active', 'disabled']);
/**
 * The fixture's real `power_user.chat_truncation` in every generated data
 * root, absent a truncation-guard pollution request (see
 * `truncationGuard.pollution` below). Recorded in the manifest so consumers
 * (e.g. scripts/e2e/verify-truncation-guard.mjs) never have to hardcode it.
 */
const CHAT_TRUNCATION_DEFAULT = 100;
/**
 * Mirrors `NATIVE_TRUNCATION_OVERRIDE` in src/adapter/native-window-guard.ts
 * (ST reads `chat_truncation || MAX_SAFE_INTEGER`, so 0 means "unlimited" —
 * the override sentinel is the smallest non-zero floor).
 */
const NATIVE_TRUNCATION_OVERRIDE_SENTINEL = 1;

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
        const row = {
            name: isUser ? fixture.user.name : characterName,
            is_user: isUser,
            is_name: true,
            send_date: new Date(epoch + (index + 1) * 1000).toISOString(),
            mes: message.text,
            extra: structuredClone(message.extra ?? {}),
        };
        if (Array.isArray(message.swipes)) {
            row.swipes = structuredClone(message.swipes);
            row.swipe_id = Number.isInteger(message.swipeId) ? message.swipeId : 0;
            row.swipe_info = structuredClone(message.swipeInfo ?? []);
        }
        rows.push(row);
    });
    return rows;
}

/** A content digest of a directory tree: sorted relative paths plus bytes. */
async function hashDirectory(root) {
    const digest = crypto.createHash('sha256');
    const walk = async (dir) => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            const entryPath = path.join(dir, entry.name);
            digest.update(path.relative(root, entryPath).split(path.sep).join('/'));
            if (entry.isDirectory()) await walk(entryPath);
            else digest.update(await fs.readFile(entryPath));
        }
    };
    await walk(root);
    return digest.digest('hex');
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

/**
 * Refuse to run against a checkout that already has *this* extension installed
 * globally.
 *
 * SillyTavern serves `public/` through `express.static` (src/server-main.js)
 * **before** it mounts the per-user extensions route (src/users.js's
 * `/scripts/extensions/third-party/*`). So when a folder of the same name
 * exists in the checkout's own `public/scripts/extensions/third-party/`, every
 * file request the browser makes is answered from *there* — the fixture's copy
 * is on disk, is what `/api/extensions/discover` reports, and is never read.
 *
 * The failure is silent and total: the gate boots, mounts, and asserts happily
 * against whatever build the maintainer happens to have installed. It was found
 * on 2026-08-05 by a card assertion that could not be made to pass — the DOM
 * kept showing a build from the previous day, while the tree under test on disk
 * was correct. Every DOM-level assertion in the suite had been running against
 * the installed copy on this machine for as long as that install existed.
 *
 * CI never sees it (a fresh checkout has nothing but `.gitkeep` there), which is
 * exactly what makes it worth failing loudly here: the local run is the fast
 * feedback loop, and a fast loop that answers about the wrong artifact is worse
 * than no loop at all.
 */
async function assertExtensionIsNotShadowed(stRoot) {
    const shadowPath = path.join(
        stRoot, 'public', 'scripts', 'extensions', 'third-party', EXTENSION_FOLDER,
    );
    try {
        await fs.stat(shadowPath);
    } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
    }
    throw new Error(
        `${EXTENSION_FOLDER} is installed globally in the SillyTavern checkout, at\n`
        + `  ${shadowPath}\n`
        + 'SillyTavern serves public/ before its per-user extension route, so that copy would be\n'
        + 'served to the browser instead of the runtime under test, and every assertion would\n'
        + 'silently describe it. Move it aside for the run:\n'
        + `  mv "${shadowPath}" "${shadowPath}.off"\n`
        + `  mv "${shadowPath}.off" "${shadowPath}"   # afterwards`,
    );
}

function patchSettings(baseSettings, fixture, stVersion, globalExtensions, extensionMode, regexMode, truncationGuard = {}) {
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
    // `pollution` simulates the exact bootstrap self-heal crash signature
    // (INVARIANTS.md §16 gap 2): a previous session's crash left
    // chat_truncation pinned at the override sentinel in the user's own
    // persisted settings, with the pre-override real value still sitting in
    // SillyLounge's own backup below.
    settings.power_user.chat_truncation = truncationGuard.pollution
        ? NATIVE_TRUNCATION_OVERRIDE_SENTINEL
        : CHAT_TRUNCATION_DEFAULT;
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
        ...globalExtensions.filter(value => value.toLowerCase() !== 'third-party/sillylounge-dist'),
    ]));
    if (extensionMode === 'disabled') disabledExtensions.push(`third-party/${EXTENSION_FOLDER}`);
    settings.extension_settings.disabledExtensions = disabledExtensions;
    const existing = settings.extension_settings.chatui_composer;
    settings.extension_settings.chatui_composer = {
        ...(existing && typeof existing === 'object' ? existing : {}),
        enabled: extensionMode === 'active',
    };
    // Always persist the requested boolean. Omitting `false` is not equivalent
    // to flag-off now that the product default is true: initConfigStore() would
    // fill the missing key from DEFAULT_CONFIG and silently exercise flag-on.
    // Keeping both values explicit makes fixture manifests and runtime behavior
    // describe the same test mode.
    const existingConfig = settings.extension_settings.chatui_composer.config;
    settings.extension_settings.chatui_composer.config = {
        ...(existingConfig && typeof existingConfig === 'object' ? existingConfig : {}),
        nativeTruncationOverrideEnabled: truncationGuard.overrideEnabled,
    };
    if (truncationGuard.pollution) {
        // src/adapter/native-window-guard.ts reads/writes this at
        // `chatui_composer.nativeTruncationBackup` directly (sibling of
        // `.config`, see getGuardNamespace()).
        settings.extension_settings.chatui_composer.nativeTruncationBackup = CHAT_TRUNCATION_DEFAULT;
    }
    settings.extension_settings.character_allowed_regex = fixture.scopedRegexProfile && regexMode === 'active'
        ? [fixture.character.fileName]
        : [];
    settings.accountStorage = settings.accountStorage && typeof settings.accountStorage === 'object'
        ? settings.accountStorage
        : {};
    const scopedRegexAlertKey = `AlertRegex_${fixture.character.fileName}`;
    if (fixture.scopedRegexProfile && regexMode === 'disabled') {
        // Match a user who deliberately declined the embedded scripts: keep
        // them disallowed without ST's one-time consent dialog covering the
        // page and contaminating the performance baseline.
        settings.accountStorage[scopedRegexAlertKey] = 'true';
    } else {
        delete settings.accountStorage[scopedRegexAlertKey];
    }
    return settings;
}

const SYNTHETIC_USER_FILLER = '补充场景、动作与预期。';
const SYNTHETIC_ASSISTANT_FILLER = '叙事继续沿着环境、人物动作、感官细节与前后因果展开；这段文字完全由测试生成器合成，只用于稳定模拟较长回复的排版、格式化与滚动成本。';
const SYNTHETIC_REASONING_FILLER = '检查上下文约束，比较可选路径，记录人物状态、空间关系、时间连续性与下一步响应计划；这里只保留合成的推理结构，不包含任何真实对话。';

function profileLength(profile, floor, total) {
    if (floor === total) return profile.max;
    const percentile = ((floor * 137) % total) / total;
    if (percentile >= 0.99 && Number.isInteger(profile.p99)) return profile.p99;
    if (percentile >= 0.95) return profile.p95;
    if (percentile >= 0.90) return profile.p90;
    return profile.p50;
}

function paddedSyntheticText(prefix, filler, suffix, targetLength) {
    if (!Number.isInteger(targetLength) || targetLength < prefix.length + suffix.length) {
        throw new Error('synthetic target length is too short for its required structure');
    }
    const remaining = targetLength - prefix.length - suffix.length;
    const repeated = `${filler}\n\n`.repeat(Math.ceil(remaining / (filler.length + 2)) + 1);
    return `${prefix}${repeated.slice(0, remaining)}${suffix}`;
}

function makeCodeBlock(floor) {
    const rows = Array.from({ length: 12 }, (_, index) => (
        `  { floor: ${floor}, step: ${index + 1}, state: "synthetic-${(floor + index) % 9}" },`
    )).join('\n');
    return `\n\n\`\`\`json\n[\n${rows}\n]\n\`\`\``;
}

function makeChoiceBlock(floor) {
    const choices = Array.from({ length: 6 }, (_, index) => (
        `${String.fromCharCode(65 + index)}. 第 ${floor} 楼的合成路径 ${index + 1}：继续验证状态、动作与上下文连续性。`
    )).join('\n');
    return `\n\n<branches>\n<details>\n<summary>synthetic paths</summary>\n${choices}\n</details>\n</branches>`;
}

function swipeCountForFloor(floor, total) {
    if (floor === total) return 53;
    const percentile = ((floor * 137) % total) / total;
    if (percentile >= 0.95) return 6;
    if (percentile >= 0.45) return 2;
    return 1;
}

function materializeProfiledRichMessages(source) {
    const { profile, userTurns } = source;
    if (!profile || typeof profile !== 'object') {
        throw new Error('profiled-rich fixture must declare a profile');
    }
    const messages = [];
    for (let floor = 1; floor <= userTurns; floor += 1) {
        const userLength = profileLength(profile.userChars, floor, userTurns);
        const userPrefix = `第${floor}楼：`;
        const userText = paddedSyntheticText(userPrefix, SYNTHETIC_USER_FILLER, '。', userLength);
        messages.push({ role: 'user', text: userText });

        const assistantLength = profileLength(profile.assistantChars, floor, userTurns);
        const noThinking = floor % 41 === 0;
        const bothThinkingForms = floor % 100 === 0;
        const extraReasoning = !noThinking && floor % 5 === 0;
        const embeddedThinking = !noThinking && (!extraReasoning || bothThinkingForms);
        const embeddedReasoningLength = profileLength(profile.thinkingChars, floor, userTurns);
        const separateReasoningLength = profileLength(profile.extraReasoningChars, floor, userTurns);
        const embeddedReasoning = embeddedThinking
            ? paddedSyntheticText('', SYNTHETIC_REASONING_FILLER, '', embeddedReasoningLength)
            : '';
        const separateReasoning = extraReasoning
            ? paddedSyntheticText('', SYNTHETIC_REASONING_FILLER, '', separateReasoningLength)
            : '';
        const thinkingPrefix = embeddedReasoning
            ? `<thinking>\n${embeddedReasoning}\n</thinking>\n\n`
            : '';
        const hasCodeBlock = ((floor * 37) % 1000) < Math.round(profile.codeBlockRate * 1000);
        const codeBlock = hasCodeBlock ? makeCodeBlock(floor) : '';
        const bodyPrefix = `## 合成长回复 · 第 ${floor} 楼\n\n`;
        const bodySuffix = `${codeBlock}${makeChoiceBlock(floor)}`;
        const bodyLength = assistantLength - thinkingPrefix.length;
        const body = paddedSyntheticText(
            bodyPrefix,
            SYNTHETIC_ASSISTANT_FILLER,
            bodySuffix,
            bodyLength,
        );
        const text = `${thinkingPrefix}${body}`;
        const extra = {
            reasoning_duration: Number((4 + (floor % 37) * 0.7).toFixed(1)),
            token_count: Math.ceil((text.length + separateReasoning.length) / 3),
        };
        if (separateReasoning) extra.reasoning = separateReasoning;

        const swipeCount = swipeCountForFloor(floor, userTurns);
        const swipes = Array.from({ length: swipeCount }, (_, index) => (
            index === 0 ? text : `${text}\n\n<!-- synthetic swipe ${index + 1} -->`
        ));
        const swipeInfo = swipes.map((_, index) => ({
            send_date: new Date(Date.parse('2026-01-03T00:00:00.000Z') + (floor * 100 + index) * 1000).toISOString(),
            extra: index > 0 && index % 4 === 0
                ? { reasoning: separateReasoning || embeddedReasoning }
                : {},
        }));
        messages.push({
            role: 'assistant',
            text,
            extra,
            swipes,
            swipeId: 0,
            swipeInfo,
        });
    }
    return messages;
}

function materializeConversationMessages(conversation) {
    const source = conversation?.messages;
    if (Array.isArray(source)) return structuredClone(source);
    if (source?.kind === 'profiled-rich') {
        if (!Number.isInteger(source.userTurns) || source.userTurns <= 0 || source.userTurns > 10_000) {
            throw new Error('profiled-rich fixture userTurns must be an integer between 1 and 10000');
        }
        return materializeProfiledRichMessages(source);
    }
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

function materializeConversationCopies(conversation) {
    const configured = conversation?.copies;
    if (configured === undefined) {
        return [{ fileName: conversation?.fileName, marker: null }];
    }
    if (!Array.isArray(configured) || configured.length === 0) {
        throw new Error('conversation copies must be a non-empty array');
    }
    const copies = configured.map((copy, index) => {
        safeLeafName(copy?.fileName, `conversation copy ${index} filename`);
        if (typeof copy?.marker !== 'string' || copy.marker.length === 0 || copy.marker.length > 128) {
            throw new Error(`conversation copy ${index} marker must be a non-empty string up to 128 characters`);
        }
        return { fileName: copy.fileName, marker: copy.marker };
    });
    if (copies[0].fileName !== conversation.fileName) {
        throw new Error('first conversation copy must match the primary conversation filename');
    }
    if (new Set(copies.map(copy => copy.fileName)).size !== copies.length) {
        throw new Error('conversation copy filenames must be unique');
    }
    if (new Set(copies.map(copy => copy.marker)).size !== copies.length) {
        throw new Error('conversation copy markers must be unique');
    }
    return copies;
}

function applyConversationMarker(sourceMessages, marker) {
    if (!marker) return sourceMessages;
    const messages = structuredClone(sourceMessages);
    const label = `会话标记：${marker}`;
    messages[0].text = `${label}\n\n${messages[0].text}`;
    const last = messages.at(-1);
    last.text = `${last.text}\n\n${label}`;
    if (Array.isArray(last.swipes)) {
        last.swipes = last.swipes.map(swipe => `${swipe}\n\n${label}`);
    }
    return messages;
}

function syntheticChoiceReplacement(targetLength) {
    const open = `\`\`\`html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Synthetic paths</title>
  <style>
    :root{color-scheme:dark;font-family:ui-serif,Georgia,serif;background:#17201f;color:#edf3ea}
    *{box-sizing:border-box}body{margin:0;padding:18px;background:radial-gradient(circle at top right,#36534c 0,transparent 48%),#17201f}
    .card{overflow:hidden;border:1px solid #78978c;border-radius:16px;background:rgba(20,31,30,.94);box-shadow:0 16px 45px rgba(0,0,0,.35)}
    header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:20px 22px;border-bottom:1px solid rgba(237,243,234,.16)}
    h1{margin:0;font-size:21px;letter-spacing:.08em}header p{margin:.35rem 0 0;color:#b9cbc4}.seal{width:36px;height:36px;border:1px solid #b76f61;border-radius:50%;display:grid;place-items:center;color:#e7a492}
    .grid{display:grid;gap:8px;padding:16px}.metric{display:grid;grid-template-columns:34px minmax(0,1fr) auto;gap:12px;align-items:center;padding:12px;border:1px solid rgba(237,243,234,.1);border-radius:10px;background:rgba(255,255,255,.035)}
    .metric small{display:block;margin-top:3px;color:#9eb3ab}.metric output{font-family:ui-monospace,monospace;color:#c6e0d6}.index{color:#d59684;font-variant-numeric:tabular-nums}
    details{margin:0 16px 16px;padding:12px 14px;border:1px solid rgba(237,243,234,.12);border-radius:10px}summary{cursor:pointer}button{padding:9px 14px;border:1px solid #78978c;border-radius:999px;background:#29433e;color:#edf3ea;cursor:pointer}.metric.is-selected{border-color:#d59684;transform:translateX(6px)}
  </style>
</head>
<body>
  <main class="card" data-synthetic-regex="choice">
    <header><div><h1>Synthetic paths</h1><p>Full-document regex replacement</p></div><button class="theme" type="button">D/N</button></header>
    <details open><summary>Choose a deterministic continuation</summary><section class="grid"></section></details>
    <div class="raw-options" hidden>$1$2</div>
  </main>
  <script>
    (function () {
      const root = document.querySelector('.grid');
      const raw = document.querySelector('.raw-options');
      const theme = document.querySelector('.theme');
      const themeKey = 'sl_fixture_choice_theme';
      const applyTheme = function () { document.body.dataset.theme = localStorage.getItem(themeKey) || 'day'; };
      applyTheme();
      window.addEventListener('sl-fixture-theme-sync', applyTheme);
      window.addEventListener('storage', function (event) { if (event.key === themeKey) applyTheme(); });
      theme.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        localStorage.setItem(themeKey, localStorage.getItem(themeKey) === 'night' ? 'day' : 'night');
        window.dispatchEvent(new Event('sl-fixture-theme-sync'));
      });
      raw.textContent.trim().split(/\\r?\\n/).filter(function (line) { return line.trim(); }).forEach(function (line, index) {
        const text = line.trim().replace(/^[A-Z]\\.\\s*/i, '');
        if (!text) return;
        const item = document.createElement('article');
        item.className = 'metric';
        item.dataset.action = text;
        item.innerHTML = '<span class="index">' + String(index + 1).padStart(2, '0') + '</span><div><strong>synthetic path</strong><small>' + text + '</small></div>';
        item.addEventListener('click', function () {
          root.querySelectorAll('.metric').forEach(function (candidate) { candidate.classList.remove('is-selected'); });
          item.classList.add('is-selected');
          document.body.dataset.selectedPath = item.dataset.action;
        });
        root.appendChild(item);
      });
    })();
  </script>
`;
    const close = '\n</body>\n</html>\n```';
    const commentShellLength = '<!---->'.length;
    const paddingLength = targetLength - open.length - close.length - commentShellLength;
    if (paddingLength < 0) throw new Error('synthetic choice replacement exceeds target length');
    const paddingSeed = 'synthetic-choice-document-padding ';
    const padding = paddingSeed.repeat(Math.ceil(paddingLength / paddingSeed.length) + 1).slice(0, paddingLength);
    return `${open}<!--${padding}-->${close}`;
}

function syntheticThinkingReplacement(targetLength) {
    const open = `<style>
.sl-thought-wrapper{--accent:#b87361;--muted:#9e9387;--rule:rgba(184,115,97,.28);margin:15px 0;position:relative;white-space:normal}
.sl-thought-theme{display:none}.sl-thought-wrapper:has(.sl-thought-theme:checked){--accent:#82a99c;--muted:#a8bbb4;--rule:rgba(130,169,156,.3)}
.sl-thought-toggle{position:absolute;top:0;right:10px;color:var(--muted);font-family:ui-serif,Georgia,serif;font-size:11px;cursor:pointer;letter-spacing:1px;opacity:.3;transition:opacity .3s,color .3s;user-select:none;z-index:10}.sl-thought-wrapper:hover .sl-thought-toggle{opacity:1}
.sl-thought-wrapper details{border-left:2px solid var(--accent);padding-left:15px;transition:border-color .3s}.sl-thought-wrapper summary{list-style:none;cursor:pointer;font-family:ui-serif,Georgia,serif;font-size:.8rem;color:var(--muted);letter-spacing:2px;opacity:.6;transition:opacity .2s,color .3s;user-select:none}.sl-thought-wrapper summary::-webkit-details-marker{display:none}.sl-thought-wrapper summary:hover{opacity:1}
.sl-thought-content{margin-top:10px;font-family:ui-serif,Georgia,serif;font-size:.7rem;color:var(--muted);line-height:1.8;opacity:.85;max-height:50vh;overflow-y:auto;padding-right:10px;white-space:pre-wrap;transition:color .3s}.sl-thought-content::-webkit-scrollbar{width:4px}.sl-thought-content::-webkit-scrollbar-track{background:transparent}.sl-thought-content::-webkit-scrollbar-thumb{background:var(--rule);border-radius:4px}
</style><div class="sl-thought-wrapper" data-synthetic-regex="thought"><label class="sl-thought-toggle" title="Toggle theme"><input type="checkbox" class="sl-thought-theme">D/N</label><details><summary>SYNTHETIC NOTES...</summary><div class="sl-thought-content">$1</div></details>`;
    const close = '</div>';
    const commentShellLength = '<!---->'.length;
    const paddingLength = targetLength - open.length - close.length - commentShellLength;
    if (paddingLength < 0) throw new Error('synthetic thinking replacement exceeds target length');
    return `${open}<!--${'reasoning-padding '.repeat(Math.ceil(paddingLength / 18) + 1).slice(0, paddingLength)}-->${close}`;
}

function syntheticRegexScript(id, scriptName, findRegex, replaceString, overrides = {}) {
    return {
        id,
        scriptName,
        findRegex,
        replaceString,
        trimStrings: overrides.trimStrings ?? [],
        placement: [2],
        disabled: false,
        markdownOnly: true,
        promptOnly: false,
        runOnEdit: true,
        substituteRegex: 0,
        minDepth: null,
        maxDepth: overrides.maxDepth ?? null,
    };
}

function createSyntheticRegexScripts(profile) {
    const targets = profile.replacementChars;
    return [
        syntheticRegexScript(
            '00000000-0000-4000-8000-000000000001',
            'Synthetic path document',
            '/(?:<branches>\\s+(?:<details>[\\s\\S]*?<summary>[\\s\\S]*?<\\/summary>\\s*)?([\\s\\S]+?)(?:<\\/details>\\s*)?<\\/branches>)|(?:\\[paths\\]\\n((?:[A-Z]\\..+$\\n?)+))/gm',
            syntheticChoiceReplacement(targets.choice),
            { maxDepth: 2 },
        ),
        syntheticRegexScript(
            '00000000-0000-4000-8000-000000000002',
            'Synthetic thought disclosure',
            '/<thinking>\\s*(.*)\\s*<\\/thinking>/si',
            syntheticThinkingReplacement(targets.thinking),
            {
                maxDepth: 5,
                trimStrings: ['</', '<', '>', '[', ']', '{', '}', '~'],
            },
        ),
    ];
}

function materializeCharacterCard(fixture, sourceCard) {
    const card = structuredClone(sourceCard);
    if (!fixture.scopedRegexProfile) return card;
    card.data.extensions = card.data.extensions && typeof card.data.extensions === 'object'
        ? card.data.extensions
        : {};
    card.data.extensions.regex_scripts = createSyntheticRegexScripts(fixture.scopedRegexProfile);
    return card;
}

function validateFixture(fixture) {
    if (!fixture || typeof fixture !== 'object') throw new Error('fixture must be an object');
    safeLeafName(fixture.id, 'fixture id');
    safeLeafName(fixture.user?.avatar, 'user avatar');
    safeLeafName(fixture.character?.fileName, 'character filename');
    safeLeafName(fixture.character?.card, 'character card filename');
    safeLeafName(fixture.conversation?.fileName, 'conversation filename');
    if (!fixture.character.fileName.endsWith('.png')) throw new Error('character filename must end in .png');
    const copies = materializeConversationCopies(fixture.conversation);
    const messages = materializeConversationMessages(fixture.conversation);
    if (messages.length === 0) throw new Error('fixture conversation must contain messages');
    for (const [index, message] of messages.entries()) {
        if (!['user', 'assistant'].includes(message?.role) || typeof message?.text !== 'string') {
            throw new Error(`fixture message ${index} is invalid`);
        }
    }
    if (!Number.isFinite(Date.parse(fixture.createdAt))) throw new Error('fixture createdAt must be an ISO date');
    return { copies, messages };
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
    regexMode = 'active',
    // Orthogonal to extensionMode/regexMode so any combination is reachable
    // (e.g. active + overrideEnabled for a real activation round trip, or
    // bootstrap + pollution for the self-heal crash signature) without a
    // combinatorial explosion of named modes — see
    // scripts/e2e/verify-truncation-guard.mjs and INVARIANTS.md §16.
    // Main fixtures follow the product default. Callers that need a control
    // baseline must opt out explicitly with `false`.
    nativeTruncationOverrideEnabled = true,
    nativeTruncationPollution = false,
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
    if (!REGEX_MODES.has(regexMode)) {
        throw new Error(`invalid regex mode: ${regexMode}`);
    }
    if (typeof nativeTruncationOverrideEnabled !== 'boolean' || typeof nativeTruncationPollution !== 'boolean') {
        throw new Error('nativeTruncationOverrideEnabled and nativeTruncationPollution must be booleans');
    }
    const validatedFixture = validateFixture(fixture);
    const characterCardPath = path.join(path.dirname(sourceFixturePath), fixture.character.card);
    const characterCard = materializeCharacterCard(fixture, await readJson(characterCardPath));
    validateCharacterCard(characterCard);
    await validateRuntimeTree(resolvedRuntimeRoot);
    await assertExtensionIsNotShadowed(resolvedStRoot);
    await assertEmptyTarget(resolvedTarget);

    const userRoot = fixturePath(resolvedTarget, USER_HANDLE);
    const characterDirName = fixture.character.fileName.slice(0, -'.png'.length);
    const settingsPath = fixturePath(userRoot, 'settings.json');
    const avatarPath = fixturePath(userRoot, 'User Avatars', fixture.user.avatar);
    const characterPath = fixturePath(userRoot, 'characters', fixture.character.fileName);
    const chatRoot = fixturePath(userRoot, 'chats', characterDirName);
    const extensionPath = fixturePath(userRoot, 'extensions', EXTENSION_FOLDER);

    await writeJson(
        settingsPath,
        patchSettings(baseSettings, fixture, pin.version, globalExtensions, extensionMode, regexMode, {
            overrideEnabled: nativeTruncationOverrideEnabled,
            pollution: nativeTruncationPollution,
        }),
    );
    await fs.mkdir(path.dirname(avatarPath), { recursive: true });
    await fs.writeFile(avatarPath, createSolidPng(128, 128, fixture.user.avatarColor));
    await fs.mkdir(path.dirname(characterPath), { recursive: true });
    await fs.writeFile(characterPath, createCharacterPng(fixture, characterCard));
    await fs.mkdir(chatRoot, { recursive: true });
    const generatedConversations = [];
    for (const copy of validatedFixture.copies) {
        const messages = applyConversationMarker(validatedFixture.messages, copy.marker);
        const chatPath = fixturePath(chatRoot, `${copy.fileName}.jsonl`);
        await fs.writeFile(
            chatPath,
            `${conversationRows(fixture, characterCard.data.name, messages).map(row => JSON.stringify(row)).join('\n')}\n`,
            'utf8',
        );
        generatedConversations.push({
            fileName: copy.fileName,
            marker: copy.marker,
            messageCount: messages.length,
            userTurns: messages.filter(message => message.role === 'user').length,
            kind: fixture.conversation.messages?.kind ?? 'literal',
            path: chatPath,
        });
    }
    await fs.cp(resolvedRuntimeRoot, extensionPath, {
        recursive: true,
        dereference: true,
        errorOnExist: true,
    });
    // A per-run marker *inside* the copied extension, so a spec can prove from
    // the browser that the files it is being served are the ones this run put
    // on disk. `assertExtensionIsNotShadowed` above rules out the one shadow
    // mechanism we know about; this rules out the rest, by asking the question
    // the gate actually cares about — is the tree under test the tree being
    // served — instead of enumerating ways it might not be.
    // Into `manifest.json` specifically, and not a file of its own: the point is
    // to detect a *shadow*, and `express.static` only shadows paths that exist
    // in it. A marker file unique to the fixture is never shadowed — it falls
    // through to the per-user route and answers correctly while every real file
    // still comes from the installed copy. The manifest is the one file both
    // copies always have, and it is the file SillyTavern itself fetches through
    // the same route before loading anything.
    const stamp = await hashDirectory(extensionPath);
    const stampedManifestPath = fixturePath(extensionPath, 'manifest.json');
    await writeJson(stampedManifestPath, {
        ...await readJson(stampedManifestPath),
        [EXTENSION_STAMP_KEY]: stamp,
    });

    const primaryConversation = generatedConversations[0];
    const manifest = {
        schemaVersion: pin.fixtureSchema,
        fixture: fixture.id,
        /** Identifies this run's copy of the extension; see EXTENSION_STAMP_FILE. */
        stamp,
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
            fileName: primaryConversation.fileName,
            messageCount: primaryConversation.messageCount,
            userTurns: primaryConversation.userTurns,
            kind: primaryConversation.kind,
        },
        conversations: generatedConversations.map(({ path: _path, ...conversation }) => conversation),
        extension: EXTENSION_FOLDER,
        extensionMode,
        regexMode,
        nativeTruncation: {
            overrideEnabled: nativeTruncationOverrideEnabled,
            pollution: nativeTruncationPollution,
            originalChatTruncation: CHAT_TRUNCATION_DEFAULT,
            overrideSentinel: NATIVE_TRUNCATION_OVERRIDE_SENTINEL,
        },
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
            chat: primaryConversation.path,
            chats: Object.freeze(generatedConversations.map(conversation => Object.freeze({
                fileName: conversation.fileName,
                path: conversation.path,
            }))),
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
        regexMode: values.regex,
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
