import { expect, test } from '@playwright/test';

const EXPECTED_MESSAGES = [
    { id: '0', role: 'user', text: '第一条测试消息。' },
    { id: '1', role: 'character', text: '第一条测试回复。' },
    { id: '2', role: 'user', text: '第二条测试消息。' },
    { id: '3', role: 'character', text: '第二条测试回复。' },
];

test('real SillyTavern projects the smoke conversation into SillyLounge', async ({ page }, testInfo) => {
    const pageErrors = [];
    const chatuiConsoleErrors = [];
    page.on('pageerror', error => pageErrors.push(error.stack ?? error.message));
    page.on('console', message => {
        if (message.type() === 'error' && message.text().includes('[ChatUI]')) {
            chatuiConsoleErrors.push(message.text());
        }
    });

    const url = process.env.SILLYLOUNGE_E2E_URL;
    expect(url, 'global setup must expose the disposable ST URL').toBeTruthy();
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => {
        const context = globalThis.SillyTavern?.getContext?.();
        return context
            && Number(context.characterId) >= 0
            && context.chatId === 'smoke'
            && context.chat?.length === 4
            && context.powerUserSettings?.chat_truncation === 1
            && context.extensionSettings?.chatui_composer?.nativeTruncationBackup === 100
            && document.querySelectorAll('#chat > .mes').length === 1;
    });

    const hostState = await page.evaluate(async () => {
        const context = globalThis.SillyTavern.getContext();
        const character = context.characters[Number(context.characterId)];
        const discoveredExtensions = await fetch('/api/extensions/discover').then(response => response.json());
        return {
            characterId: Number(context.characterId),
            characterName: character?.name,
            characterAvatar: character?.avatar,
            chatId: context.chatId,
            messages: context.chat.map(message => ({
                isUser: message.is_user,
                text: message.mes,
            })),
            enabled: context.extensionSettings.chatui_composer?.enabled,
            nativeTruncationOverrideEnabled:
                context.extensionSettings.chatui_composer?.config?.nativeTruncationOverrideEnabled,
            liveChatTruncation: context.powerUserSettings?.chat_truncation,
            nativeTruncationBackup: context.extensionSettings.chatui_composer?.nativeTruncationBackup,
            nativeMessageCount: document.querySelectorAll('#chat > .mes').length,
            disabledExtensions: context.extensionSettings.disabledExtensions,
            globalExtensions: discoveredExtensions
                .filter(extension => extension.type === 'global')
                .map(extension => extension.name),
            // Keyed by the *install directory*. The fixture's is deliberately
            // not the name a real install uses — see EXTENSION_FOLDER in
            // scripts/e2e/generate-data-root.mjs for why sharing it made the
            // whole suite test the maintainer's installed build instead of this
            // one. Not a cosmetic string either way: this lookup returns null
            // the moment the two disagree, and it is the only thing that
            // notices.
            manifest: context.getExtensionManifest('SillyLounge-e2e'),
        };
    });
    await testInfo.attach('sillytavern-host-state', {
        body: Buffer.from(`${JSON.stringify(hostState, null, 4)}\n`),
        contentType: 'application/json',
    });

    // Before any of the rest means anything: the extension the browser loaded
    // has to be the one this run built. It was not, on the maintainer's own
    // machine, for as long as a same-named folder sat in the checkout's
    // `public/` — SillyTavern's static mount answers before its per-user
    // extension route, so the entire suite went green against an installed
    // build while the tree under test was never read
    // (scripts/e2e/generate-data-root.mjs's assertExtensionIsNotShadowed).
    // That guard rules out the one mechanism; this rules out the outcome, and
    // it reads the stamp back through `getExtensionManifest` — the same fetch
    // SillyTavern itself makes, down the same shadowed route.
    expect(
        hostState.manifest?.sillylounge_e2e_stamp,
        'the loaded extension is this run\'s copy, not one that shadowed it',
    ).toBe(process.env.SILLYLOUNGE_E2E_STAMP);

    expect(hostState).toMatchObject({
        characterName: 'Lounge Test Character',
        characterAvatar: 'Lounge Test Character.png',
        chatId: 'smoke',
        enabled: true,
        nativeTruncationOverrideEnabled: true,
        liveChatTruncation: 1,
        nativeTruncationBackup: 100,
        nativeMessageCount: 1,
        messages: [
            { isUser: true, text: '第一条测试消息。' },
            { isUser: false, text: '第一条测试回复。' },
            { isUser: true, text: '第二条测试消息。' },
            { isUser: false, text: '第二条测试回复。' },
        ],
        manifest: { display_name: 'SillyLounge 🍸' },
    });
    expect(hostState.disabledExtensions).not.toContain('third-party/SillyLounge-e2e');
    expect(hostState.disabledExtensions).not.toContain('SillyLounge');
    for (const extensionName of hostState.globalExtensions) {
        expect(hostState.disabledExtensions).toContain(extensionName);
    }

    // Before anything else: the files the browser is being served have to be
    // the ones this run put on disk. They were not, on the maintainer's own
    // machine, for as long as a same-named extension sat in the checkout's
    // `public/` — SillyTavern's static mount answers before its per-user
    // extension route, so the whole suite went green against an installed
    // build while the tree under test was never read
    // (scripts/e2e/generate-data-root.mjs's assertExtensionIsNotShadowed).
    // That guard rules out the mechanism; this rules out the outcome.
    const root = page.locator('#chatui-root[data-cui-root-mounted="1"]');
    await expect(root).toBeVisible();
    await expect(page.locator('body')).toHaveClass(/\bchatui-active\b/);
    await expect(page.locator('body')).toHaveClass(/\bchatui-root-visible\b/);
    await expect(page.locator('body')).toHaveClass(/\bchatui-chat-surface-shielded\b/);
    await expect(page.locator('body')).toHaveClass(/\bchatui-composer-surface-shielded\b/);
    await expect(page.locator('#chat')).toHaveCSS('display', 'none');
    await expect(page.locator('#send_form')).toHaveCSS('display', 'none');

    await expect(root.locator('.cui-root-topbar-eyebrow')).toHaveText('Lounge Test Character');
    await expect(root.locator('.cui-root-topbar-title')).toHaveText('smoke');
    await expect(root.getByRole('form', { name: 'ChatUI 输入区' })).toBeVisible();

    const messages = root.locator('.cui-root-message-list article.cui-root-message');
    await expect(messages).toHaveCount(EXPECTED_MESSAGES.length);
    for (const [index, expected] of EXPECTED_MESSAGES.entries()) {
        const message = messages.nth(index);
        await expect(message).toHaveAttribute('data-cui-message-id', expected.id);
        await expect(message).toHaveAttribute('data-cui-message-role', expected.role);
        const body = message.locator('.cui-root-message-body');
        await expect(body).toHaveClass(/\bmes_text\b/);
        await expect(body).toHaveText(expected.text);
    }

    const rail = root.getByRole('slider', { name: '快速跳转用户回合' });
    await expect(rail).toBeVisible();
    await expect(rail).toHaveAttribute('aria-valuemax', '2');
    await expect(rail).toHaveAttribute('data-cui-hidden-above', '0');
    await expect(rail).toHaveAttribute('data-cui-hidden-below', '0');
    const ticks = rail.locator('.cui-root-floor-tick');
    await expect(ticks).toHaveCount(2);
    const tickTops = await ticks.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().top));
    expect(Math.round(tickTops[1] - tickTops[0])).toBe(10);

    const railBox = await rail.boundingBox();
    expect(railBox).not.toBeNull();
    await page.mouse.move(railBox.x + 4, railBox.y + 1);
    await expect(rail.locator('.cui-root-floor-popover-title')).toHaveText('第一条测试消息。');
    await expect(rail.locator('.cui-root-floor-popover-preview')).toHaveText('第一条测试回复。');
    await expect(rail.locator('.cui-root-floor-popover-number')).toHaveText('第 1 楼');
    await page.mouse.move(railBox.x + railBox.width + 80, railBox.y + railBox.height + 80);
    await expect(rail.locator('.cui-root-floor-popover')).toHaveCount(0);

    // The edit round-trip, and then the same round-trip in reverse.
    //
    // This spec asserts a pristine fixture up at the hostState check, and it
    // writes to the shared disposable host that playwright-global-setup.mjs
    // boots once for the whole run. Those two facts only coexisted while the
    // suite ran in exactly one browser: adding the Gecko project made the
    // second engine open a chat the first engine had already rewritten, and
    // the pristine-fixture assertion failed on text this very spec had
    // persisted. Restoring the original text is what makes the spec
    // idempotent, and idempotent is the house rule for anything touching the
    // shared host (see confirm-dialog-keyboard.spec.mjs, which answers its
    // dialog with cancel for the same reason).
    const originalText = '第二条测试消息。';
    const editedText = '第二条测试消息（已编辑）。';
    const editableMessage = root.locator('[data-cui-message-id="2"]');

    /** One full edit: open, retype, 落笔, and read the result back off the host. */
    async function rewriteSecondMessage(from, to) {
        await editableMessage.hover();
        await editableMessage.getByRole('button', { name: '编辑' }).click();
        const editor = editableMessage.locator('.cui-root-edit-textarea');
        await expect(editor).toHaveValue(from);
        await editor.fill(to);
        await editableMessage.getByRole('button', { name: '落笔' }).click();
        await expect(editableMessage.locator('.cui-root-edit-textarea')).toHaveCount(0);
        await expect(editableMessage.locator('.cui-root-message-body')).toHaveText(to);
        await expect.poll(() => page.evaluate(() => (
            globalThis.SillyTavern?.getContext?.().chat?.[2]?.mes
        ))).toBe(to);
    }

    await rewriteSecondMessage(originalText, editedText);
    // Back to the fixture. Not a teardown afterthought: the second pass
    // re-exercises the same path from the edited state, so a save that only
    // works on a virgin message would still fail here.
    await rewriteSecondMessage(editedText, originalText);

    const screenshot = await page.screenshot({ fullPage: true });
    await testInfo.attach('sillylounge-smoke', { body: screenshot, contentType: 'image/png' });
    expect(pageErrors, `page errors:\n${pageErrors.join('\n')}`).toEqual([]);
    expect(chatuiConsoleErrors, `ChatUI console errors:\n${chatuiConsoleErrors.join('\n')}`).toEqual([]);
});
