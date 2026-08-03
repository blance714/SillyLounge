import { expect, test } from '@playwright/test';

/**
 * ＋新对话 makes an ordinary conversation — nothing more (DESIGN §4.2,
 * 2026-08-02).
 *
 * Three behaviours retired together, and this spec is the gate on all three
 * because they were one mechanism wearing three faces: the new chat was
 * quarantined and therefore *withheld* from the card column, so the ＋新对话
 * button had to light up as its stand-in row, and a second press had nowhere
 * to be drawn and was refused. Take the quarantine's reader-facing layer away
 * and each of the three simply has no reason to exist.
 *
 * One thing survived the demolition, as presentation rather than as a tier: a
 * conversation nobody has written in yet is drawn with a dashed border
 * (ui/blank-conversation.ts decides which those are). It is still an ordinary
 * card in every other respect, which is why this spec reads the computed
 * border style off both a fresh chat and the written-in fixture — a rule that
 * dashed everything, or nothing, would pass a class-name assertion.
 *
 * The unit gates prove the pieces: sidebar-actions.test.mjs that the second
 * press reaches the host, blank-conversation.test.mjs that the predicate is
 * right. Only a real host can answer the question that actually changed for
 * the reader: does the chat show up in the playbill like everything else.
 *
 * Idempotent, as anything touching the shared disposable host must be
 * (playwright-global-setup.mjs boots one for the whole run — see
 * smoke.spec.mjs's edit round-trip for what a mutating spec cost the day a
 * second engine joined the matrix). The two chats created here are deleted
 * again at the end, and the fixture chat is re-opened first so that neither
 * deletion is a delete-the-current-chat — that path forces a page reload,
 * which is a different scenario and not this one's business.
 */

const FIXTURE_CHAT = 'smoke';

/** The ordinary conversation cards, by the name each one prints. */
function cardNames(root) {
    return root.locator('.cui-root-playbill-cards .cui-root-nested-chat-row-name');
}

/** Nothing about a new chat may be special-cased anywhere on screen. */
async function expectNoDraftVocabulary(page, root, label) {
    await expect(root.locator('.cui-root-draft-card'), `${label}: no draft card`).toHaveCount(0);
    await expect(page.locator('.cui-picker'), `${label}: no new-chat character picker`).toHaveCount(0);
    await expect(root.locator('.cui-root-newchat.is-active'), `${label}: the button does not light up`)
        .toHaveCount(0);
}

/**
 * The one thing a blank conversation *does* get: a dashed border, and only
 * that (DESIGN §4.2). Read off the computed style rather than the class, so a
 * rule that stops applying — or one an engine draws differently — fails here.
 */
function readCardBorder(root, name) {
    return root.locator('.cui-root-nested-chat-row', { hasText: name }).evaluate((card) => {
        const style = getComputedStyle(card);
        return { style: style.borderTopStyle, width: style.borderTopWidth };
    });
}

test('＋新对话 lands an ordinary card in the playbill, dashed while empty, and can be pressed again', async ({ page }, testInfo) => {
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.stack ?? error.message));

    const url = process.env.SILLYLOUNGE_E2E_URL;
    expect(url, 'global setup must expose the disposable ST URL').toBeTruthy();
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const root = page.locator('#chatui-root[data-cui-root-mounted="1"]');
    await expect(root).toBeVisible();
    await root.locator('.cui-root-message-list article.cui-root-message').first().waitFor();

    const names = cardNames(root);
    await expect(names).toHaveText([FIXTURE_CHAT]);
    await expectNoDraftVocabulary(page, root, 'before any new chat');

    // The fixture conversation has four messages in it, so it is the control:
    // whatever the dashed rule does below, it must not be doing it here.
    expect(await readCardBorder(root, FIXTURE_CHAT), 'a written-in conversation is solid')
        .toMatchObject({ style: 'solid' });

    const newChat = root.locator('.cui-root-newchat');
    await expect(newChat).toBeEnabled();

    // ── One press ────────────────────────────────────────────────────────────
    await newChat.click();
    await expect(names, 'the new chat is listed, not withheld').toHaveCount(2);
    await expect(
        root.locator('.cui-root-nested-chat-row.is-current .cui-root-nested-chat-row-name'),
        'and it is marked current the same way any opened conversation is',
    ).not.toHaveText(FIXTURE_CHAT);
    await expectNoDraftVocabulary(page, root, 'after one new chat');

    // ── And again, from the chat the first press produced ─────────────────────
    // This is what the retired 「只有一个新对话」 rule refused.
    await newChat.click();
    await expect(names, 'a second press makes a second conversation').toHaveCount(3);
    await expectNoDraftVocabulary(page, root, 'after two new chats');

    const created = (await names.allTextContents()).filter(name => name !== FIXTURE_CHAT);
    expect(created, 'the two new chats are distinct files').toHaveLength(2);
    expect(new Set(created).size).toBe(2);

    // ── Blank conversations are drawn dashed, and only that ──────────────────
    // The fixture character has a first_mes, so each of these holds exactly one
    // message — the greeting — which is what ui/blank-conversation.ts reads as
    // 「nobody has written here yet」.
    for (const name of created) {
        expect(await readCardBorder(root, name), `${name} is dashed while it is empty`)
            .toMatchObject({ style: 'dashed', width: '1px' });
    }
    expect(await readCardBorder(root, FIXTURE_CHAT), 'and the written-in one still is not')
        .toMatchObject({ style: 'solid' });

    // ── The two states must differ in *kind*, not in loudness ────────────────
    // The dashed card and the solid one are the same colour, so the only thing
    // separating them is the break in the line. That only holds while the
    // resting edge is actually visible: at the fainter --cui-color-border it
    // once used, the solid card's edge sank into the surface and the dashes
    // read as the louder state for a reason unrelated to what either means
    // (owner call, 2026-08-02). Pinned as a *token identity* rather than a
    // literal, and alongside a live resolve of the hover step, because this
    // palette has twice shipped a colour declaration that referenced an
    // undefined variable and was silently dropped at computed-value time —
    // which fails exactly like a design regression and is invisible in review.
    const palette = await page.evaluate(() => {
        const probe = document.createElement('div');
        document.body.appendChild(probe);
        const resolve = (value) => {
            probe.style.borderColor = '';
            probe.style.borderColor = value;
            return getComputedStyle(probe).borderTopColor;
        };
        const out = {
            faint: resolve('var(--cui-color-border)'),
            strong: resolve('var(--cui-color-border-strong)'),
            hover: resolve('var(--cui-color-border-hover)'),
            resting: getComputedStyle(
                document.querySelector('.cui-root-nested-chat-row:not(.is-current)'),
            ).borderTopColor,
        };
        probe.remove();
        return out;
    });
    expect(palette.resting, 'a resting card edge is border-strong, not the faint hairline')
        .toBe(palette.strong);
    expect(palette.hover, 'and hover keeps a step of its own above it')
        .not.toBe(palette.strong);
    expect(palette.hover, 'which has to be a real colour, not a dropped declaration')
        .not.toBe(palette.faint);

    // Evidence, the same way smoke.spec.mjs keeps one: the assertions above say
    // 'dashed', and this is what 'dashed' looked like on the run that passed.
    await testInfo.attach('playbill-blank-and-written', {
        body: await root.locator('.cui-root-sidebar').screenshot(),
        contentType: 'image/png',
    });

    // ── Leave the host as it was found ───────────────────────────────────────
    // The fixture chat first, so neither delete below is the current chat.
    await root.locator('.cui-root-nested-chat-row', { hasText: FIXTURE_CHAT }).click();
    await expect(
        root.locator('.cui-root-nested-chat-row.is-current .cui-root-nested-chat-row-name'),
    ).toHaveText(FIXTURE_CHAT);

    for (const name of created) {
        const card = root.locator('.cui-root-nested-chat-row', { hasText: name });
        await card.hover();
        await card.getByRole('button', { name: '删除' }).click();
        const dialog = page.locator('.cui-root-dialog');
        await expect(dialog).toBeVisible();
        await dialog.locator('.cui-root-dialog-confirm').click();
        await expect(card, `discarded ${name}`).toHaveCount(0);
    }

    await expect(names, 'the playbill is back to the fixture').toHaveText([FIXTURE_CHAT]);
    expect(pageErrors, `page errors:\n${pageErrors.join('\n')}`).toEqual([]);
});
