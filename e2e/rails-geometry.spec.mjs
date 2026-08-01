import { expect, test } from '@playwright/test';

/**
 * The left chrome must be exactly as wide as what it holds — in both modes,
 * in every engine.
 *
 * `.cui-root-rails` clips (`overflow: hidden`) and used to size itself with
 * `flex: 0 0 auto`, i.e. by asking its children. That question has two
 * answers: a child sized by flex-basis alone contributes its flex base size
 * in Blink and its content size in Gecko. On the owner's Firefox at 889px the
 * settings rails therefore came out 58 + 133 = 191px instead of 58 + 300, cut
 * its own nav in half, and let the stage column start underneath the
 * remainder — while every Chromium gate stayed green.
 *
 * So this asserts the relationship rather than the pixel counts: the rails is
 * the sum of its parts, the rail it holds is not clipped, and the stage
 * begins where the rails ends. Any engine that sizes a rail differently fails
 * here instead of in the owner's window.
 *
 * Non-mutating: entering settings mode and resizing are this page's own
 * client-side state.
 */

/** The owner's real window width, and narrow enough that a wrong sum shows. */
const OWNER_VIEWPORT = { width: 889, height: 906 };

test.use({ viewport: OWNER_VIEWPORT });

/** Rails, its two candidate rails, and the column that must start after it. */
async function readRails(page, railSelector, stageSelector) {
    return page.evaluate(([rail, stage]) => {
        const box = (selector) => {
            const el = document.querySelector(selector);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { left: r.left, right: r.right, width: r.width };
        };
        return {
            rails: box('.cui-root-rails'),
            spine: box('.cui-root-spine'),
            rail: box(rail),
            stage: box(stage),
        };
    }, [railSelector, stageSelector]);
}

function assertRailsAddUp({ rails, spine, rail, stage }, label) {
    expect(rails, `${label}: rails present`).not.toBeNull();
    expect(spine, `${label}: spine present`).not.toBeNull();
    expect(rail, `${label}: rail present`).not.toBeNull();
    expect(stage, `${label}: stage present`).not.toBeNull();

    // The sum, stated. This is the assertion Gecko failed at 191 vs 358.
    expect(rails.width, `${label}: rails width is spine + rail`)
        .toBeCloseTo(spine.width + rail.width, 1);

    // Nothing the rails holds may fall outside what it clips.
    expect(rail.right, `${label}: the rail is not clipped by its own wrapper`)
        .toBeLessThanOrEqual(rails.right + 0.5);

    // And the stage starts after the chrome, never beneath it.
    expect(stage.left, `${label}: the stage starts where the rails ends`)
        .toBeCloseTo(rails.right, 1);
}

test('the rails is exactly as wide as the spine plus the rail it holds, in both modes', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.stack ?? error.message));

    const url = process.env.SILLYLOUNGE_E2E_URL;
    expect(url, 'global setup must expose the disposable ST URL').toBeTruthy();
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const root = page.locator('#chatui-root[data-cui-root-mounted="1"]');
    await expect(root).toBeVisible();
    await root.locator('.cui-root-message-list article.cui-root-message').first().waitFor();

    // ── Chat mode: spine + playbill ─────────────────────────────────────────
    assertRailsAddUp(
        await readRails(page, '.cui-root-sidebar', '.cui-root-app'),
        'chat mode',
    );

    // ── Settings mode: spine + the wider nav ────────────────────────────────
    await root.locator('.cui-root-settings-entry').click();
    await root.locator('.cui-settings-nav').waitFor();
    assertRailsAddUp(
        await readRails(page, '.cui-settings-nav', '.cui-settings-content'),
        'settings mode',
    );

    expect(pageErrors).toEqual([]);
});
