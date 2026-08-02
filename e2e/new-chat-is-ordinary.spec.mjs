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
 * The unit gate (sidebar-actions.test.mjs) proves the second press reaches the
 * host. Only a real host can answer the question that actually changed for the
 * reader: does the chat show up in the playbill like everything else.
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

test('＋新对话 lands an ordinary card in the playbill, and can be pressed again', async ({ page }) => {
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
