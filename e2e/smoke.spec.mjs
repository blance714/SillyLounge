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
            && context.chat?.length === 4;
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
            disabledExtensions: context.extensionSettings.disabledExtensions,
            globalExtensions: discoveredExtensions
                .filter(extension => extension.type === 'global')
                .map(extension => extension.name),
            manifest: context.getExtensionManifest('SillyLounge'),
        };
    });
    await testInfo.attach('sillytavern-host-state', {
        body: Buffer.from(`${JSON.stringify(hostState, null, 4)}\n`),
        contentType: 'application/json',
    });

    expect(hostState).toMatchObject({
        characterName: 'Lounge Test Character',
        characterAvatar: 'Lounge Test Character.png',
        chatId: 'smoke',
        enabled: true,
        messages: [
            { isUser: true, text: '第一条测试消息。' },
            { isUser: false, text: '第一条测试回复。' },
            { isUser: true, text: '第二条测试消息。' },
            { isUser: false, text: '第二条测试回复。' },
        ],
        manifest: { display_name: 'SillyLounge 🍸' },
    });
    expect(hostState.disabledExtensions).not.toContain('third-party/SillyLounge');
    expect(hostState.disabledExtensions).not.toContain('SillyLounge');
    for (const extensionName of hostState.globalExtensions) {
        expect(hostState.disabledExtensions).toContain(extensionName);
    }

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
    await expect(root.getByRole('form', { name: 'ChatUI composer' })).toBeVisible();

    const messages = root.locator('.cui-root-message-list > article.cui-root-message');
    await expect(messages).toHaveCount(EXPECTED_MESSAGES.length);
    for (const [index, expected] of EXPECTED_MESSAGES.entries()) {
        const message = messages.nth(index);
        await expect(message).toHaveAttribute('data-cui-message-id', expected.id);
        await expect(message).toHaveAttribute('data-cui-message-role', expected.role);
        await expect(message.locator('.cui-root-message-body')).toHaveText(expected.text);
    }

    const rail = root.getByRole('slider', { name: '快速跳转用户回合' });
    await expect(rail).toBeVisible();
    await expect(rail).toHaveAttribute('aria-valuemax', '2');
    const ticks = rail.locator('.cui-root-floor-tick');
    await expect(ticks).toHaveCount(2);
    const tickTops = await ticks.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().top));
    expect(Math.round(tickTops[1] - tickTops[0])).toBe(8);

    const railBox = await rail.boundingBox();
    expect(railBox).not.toBeNull();
    await page.mouse.move(railBox.x + 4, railBox.y + 1);
    await expect(rail.locator('.cui-root-floor-popover-title')).toHaveText('第一条测试消息。');
    await expect(rail.locator('.cui-root-floor-popover-preview')).toHaveText('第一条测试回复。');
    await page.mouse.move(railBox.x + railBox.width + 80, railBox.y + railBox.height + 80);
    await expect(rail.locator('.cui-root-floor-popover')).toHaveCount(0);

    const screenshot = await page.screenshot({ fullPage: true });
    await testInfo.attach('sillylounge-smoke', { body: screenshot, contentType: 'image/png' });
    expect(pageErrors, `page errors:\n${pageErrors.join('\n')}`).toEqual([]);
    expect(chatuiConsoleErrors, `ChatUI console errors:\n${chatuiConsoleErrors.join('\n')}`).toEqual([]);
});
