/**
 * SillyLounge · verify-last-chat-delete
 *
 * Browser-level acceptance for the one path that must survive the temp-chat
 * quarantine's removal: **deleting a character's only conversation**
 * (DESIGN §3, evaluation §5 3.6 — never strand the reader on "character
 * selected, no conversation", and never on something worse).
 *
 * What makes it worth its own script rather than a spec on the shared
 * disposable host: it is irreversibly destructive to its fixture. The
 * conversation it deletes is the fixture's only one, and what replaces it is a
 * fresh file ST writes during the reload. A spec doing that under
 * playwright-global-setup.mjs would hand every later spec a different host than
 * the one they were written against, so this follows verify-truncation-guard.mjs
 * instead: its own data root, its own disposable ST, thrown away at the end.
 *
 * The sequence being pinned, end to end through the real host:
 *
 *   1. the reader deletes their only conversation from the playbill;
 *   2. `delete-transaction.ts` moves the character's durable pointer to a
 *      fabricated name nothing has written yet, and reports it back;
 *   3. `sidebar-actions.ts` queues the landing credential and forces a reload;
 *   4. ST's boot materialises *something* at that name (greeting or empty);
 *   5. ChatUI comes back with the reader on that character, holding a usable
 *      conversation, and the character visible on the spine.
 *
 * Step 5 is the whole point, and every part of it has failed on a real machine
 * at some stage of this feature's life — the spine dropping the character
 * because ST's boot-time `chat_size` snapshot was taken before its own boot
 * wrote the file (which the session ledger now answers), and a lease left
 * pointing at a file that never appeared ("danglinglease", INVARIANTS §3).
 *
 * Note the one branch this cannot reach: the fixture forces
 * `power_user.auto_load_chat = true`, so ST's own autoload seats the character
 * and ChatUI's stock-host landing (`selectCharacterIfNobodyIsOnStage`) is not
 * what puts them there. That branch is unit-covered
 * (`sidebar-actions.test.mjs`); this script covers the one a browser can
 * actually reach, and says so rather than implying more.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

import { DESKTOP_VIEWPORT, REDUCED_MOTION } from './browser-baseline.mjs';
import { generateStDataRoot } from './generate-data-root.mjs';
import { inspectStCheckout, startStServer } from './st-process.mjs';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const RUNTIME_ROOT = path.join(PROJECT_ROOT, '.runtime', 'SillyTavern-ChatUI');
const FIXTURE_ROOT = path.join(PROJECT_ROOT, 'test', 'e2e', 'fixtures');
const DEFAULT_FIXTURE = 'smoke';
const BOOT_TIMEOUT_MS = 120_000;

function defaultEvidenceRoot() {
    return path.join(PROJECT_ROOT, 'test-results', 'last-chat-delete');
}

function parseArgs(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--') continue;
        if (!['--fixture', '--evidence-root'].includes(argument)) {
            throw new Error(`unknown argument: ${argument}`);
        }
        const value = argv[index + 1];
        if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
        if (argument === '--fixture') options.fixture = value;
        if (argument === '--evidence-root') options.evidenceRoot = value;
        index += 1;
    }
    return options;
}

/** ChatUI mounted, with a conversation actually open. */
async function waitForChatuiConversation(page) {
    await page.waitForFunction(() => {
        const context = globalThis.SillyTavern?.getContext?.();
        const root = document.querySelector('#chatui-root[data-cui-root-mounted="1"]');
        return Boolean(
            root
            && Number(context?.characterId) >= 0
            && typeof context?.chatId === 'string'
            && context.chatId !== ''
            && root.querySelector('.cui-root-playbill-cards .cui-root-nested-chat-row'),
        );
    }, undefined, { timeout: BOOT_TIMEOUT_MS });
}

/** Everything this script asserts about "where is the reader", in one read. */
async function readStanding(page) {
    return page.evaluate(() => {
        const context = globalThis.SillyTavern?.getContext?.();
        const root = document.querySelector('#chatui-root');
        const text = (selector) => root?.querySelector(selector)?.textContent?.trim() ?? null;
        return {
            characterId: Number(context?.characterId),
            characterName: context?.characters?.[Number(context?.characterId)]?.name ?? null,
            chatId: context?.chatId ?? null,
            messageCount: context?.chat?.length ?? null,
            // What the reader can actually see and act on. Both topbar slots,
            // because which one carries the character name depends on whether
            // the conversation has a reader-given name: an unnamed one (ST's
            // 「角色名 - 时间戳」, which is what the fallback file is called)
            // puts the character name in the title and yields the eyebrow to
            // 「对话手记」 — DESIGN §3's naming rule, and exactly the state a
            // just-created replacement is in.
            eyebrow: text('.cui-root-topbar-eyebrow'),
            title: text('.cui-root-topbar-title'),
            playbillName: text('.cui-root-playbill-name'),
            cards: Array.from(
                root?.querySelectorAll('.cui-root-playbill-cards .cui-root-nested-chat-row-name') ?? [],
            ).map(node => node.textContent.trim()),
            // The character seats specifically, by the name each one is
            // labelled with — *not* `.cui-root-spine-slot`, which the rail's
            // always-present 「角色管理」 ＋ button carries too (Spine.tsx). A
            // count over that class can never reach zero, so it cannot fail.
            spineCharacters: Array.from(
                root?.querySelectorAll('.cui-root-spine-char') ?? [],
            ).map(node => node.getAttribute('aria-label')),
            composer: Boolean(root?.querySelector('.cui-root-composer')),
        };
    });
}

async function runScenario({ stRoot, fixture, evidenceRoot }) {
    const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sillylounge-lastdelete-'));
    const dataRoot = path.join(runRoot, 'data');
    await fs.mkdir(evidenceRoot, { recursive: true });

    let server = null;
    let browser = null;
    const assertions = [];
    const record = (name, fn) => { fn(); assertions.push(name); };

    try {
        const generated = await generateStDataRoot({
            targetRoot: dataRoot,
            stRoot,
            runtimeRoot: RUNTIME_ROOT,
            fixturePath: path.join(FIXTURE_ROOT, fixture, 'fixture.json'),
            extensionMode: 'active',
            regexMode: 'active',
        });
        const conversation = generated.manifest.conversation;
        const characterName = generated.manifest.character?.name ?? null;

        server = await startStServer({ stRoot, runRoot, dataRoot, readyTimeoutMs: BOOT_TIMEOUT_MS });
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
            viewport: DESKTOP_VIEWPORT,
            reducedMotion: REDUCED_MOTION,
        });
        const page = await context.newPage();
        const pageErrors = [];
        page.on('pageerror', error => pageErrors.push(error.stack ?? error.message));

        await page.goto(server.url, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });
        await waitForChatuiConversation(page);

        const before = await readStanding(page);
        record('the fixture starts with exactly one conversation, and it is the one on stage', () => {
            assert.deepEqual(before.cards, [conversation.fileName]);
            assert.equal(before.chatId, conversation.fileName);
            assert.equal(before.messageCount, conversation.messageCount);
        });

        // ── The delete, driven the way a reader drives it ────────────────────
        const card = page.locator('.cui-root-nested-chat-row', { hasText: conversation.fileName });
        await card.hover();
        await card.getByRole('button', { name: '删除' }).click();
        const dialog = page.locator('.cui-root-dialog');
        await dialog.waitFor({ timeout: 10_000 });

        // The confirm forces a full page reload from inside ChatUI. Waiting on
        // the navigation itself rather than on a settle timeout: the reload is
        // the transaction's own step, not an incidental side effect.
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS }),
            dialog.locator('.cui-root-dialog-confirm').click(),
        ]);

        // ── Where the reader lands ──────────────────────────────────────────
        await waitForChatuiConversation(page);
        const after = await readStanding(page);

        record('the reader is back on the same character, not on nobody and not on somebody else', () => {
            assert.equal(after.characterId, before.characterId);
            assert.equal(after.characterName, characterName);
            // And can see it: the playbill masthead names whose programme this
            // is, and the topbar carries the name in one slot or the other.
            assert.equal(after.playbillName, characterName);
            assert.ok(
                [after.eyebrow, after.title].includes(characterName),
                `topbar must name the character somewhere: ${JSON.stringify([after.eyebrow, after.title])}`,
            );
        });
        record('holding a real, usable conversation rather than an empty stage', () => {
            assert.notEqual(after.chatId, null);
            assert.notEqual(after.chatId, '', 'a conversation with no name is not a conversation');
            assert.equal(after.composer, true, 'and one the reader can write in');
        });
        record('the deleted conversation is gone and exactly one replacement took its place', () => {
            assert.equal(after.cards.includes(conversation.fileName), false);
            assert.deepEqual(after.cards, [after.chatId]);
        });
        record('the character is still on the spine, whose chat_size snapshot predates its own boot', () => {
            // The failure this guards is not cosmetic: the spine is ChatUI's
            // only way to change character, so a character missing from it
            // cannot be walked back to at all. Assert *this* character's own
            // seat rather than a slot count, and note honestly what that does
            // and does not prove: this fixture forces `auto_load_chat: true`,
            // so the character is also on stage, and either source would seat
            // it. What is pinned here is the reader-facing outcome. Which
            // source answers when — and the stock-host case where only the
            // ledger can — is pinned by spine-cast.test.mjs and by
            // sidebar-actions.test.mjs's boot-that-lands-on-nobody test.
            assert.ok(
                after.spineCharacters.includes(characterName),
                `the spine must still seat ${characterName}: ${JSON.stringify(after.spineCharacters)}`,
            );
        });
        record('and ChatUI raised no page errors across the whole transaction', () => {
            assert.deepEqual(pageErrors, []);
        });

        await fs.writeFile(
            path.join(evidenceRoot, 'standing.json'),
            `${JSON.stringify({ before, after }, null, 4)}\n`,
            'utf8',
        );
        await fs.writeFile(
            path.join(evidenceRoot, 'after.png'),
            await page.screenshot({ fullPage: true }),
        );

        return { name: 'last-chat-delete', assertions, before, after };
    } finally {
        if (browser) await browser.close().catch(() => {});
        if (server) await server.stop().catch(() => {});
        await fs.rm(runRoot, { recursive: true, force: true });
    }
}

export async function verifyLastChatDelete({ stRoot, fixture = DEFAULT_FIXTURE, evidenceRoot }) {
    if (!stRoot) throw new Error('stRoot is required (set SILLYTAVERN_TEST_ROOT)');
    if (!/^[a-z0-9-]+$/i.test(fixture)) throw new Error('fixture must be one safe directory name');
    await inspectStCheckout({ stRoot });

    const resolvedEvidenceRoot = path.resolve(evidenceRoot ?? defaultEvidenceRoot());
    await fs.rm(resolvedEvidenceRoot, { recursive: true, force: true });
    await fs.mkdir(resolvedEvidenceRoot, { recursive: true });

    const scenario = await runScenario({ stRoot, fixture, evidenceRoot: resolvedEvidenceRoot });
    const report = {
        schemaVersion: 1,
        recordedAt: new Date().toISOString(),
        fixture,
        scenarios: [scenario],
    };
    const reportPath = path.join(resolvedEvidenceRoot, 'report.json');
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 4)}\n`, 'utf8');
    return { evidenceRoot: resolvedEvidenceRoot, reportPath, report };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const result = await verifyLastChatDelete({
        stRoot: process.env.SILLYTAVERN_TEST_ROOT,
        ...options,
    });
    for (const scenario of result.report.scenarios) {
        console.log(`[SillyLounge last-delete] ${scenario.name}: ${scenario.assertions.length} assertions passed`);
        for (const assertion of scenario.assertions) console.log(`  - ${assertion}`);
    }
    console.log(`[SillyLounge last-delete] evidence: ${result.evidenceRoot}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
