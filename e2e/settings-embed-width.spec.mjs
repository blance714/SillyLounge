import { expect, test } from '@playwright/test';

/**
 * Regression gate for the 769–1000px window-width corridor that no other
 * viewport in this suite visits (smoke runs at 1280, the drawer specs at
 * 390). Below 1000px SillyTavern's mobile-styles.css re-targets the very
 * drawer panels settings mode embeds — BY ID, with !important
 * (`#left-nav-panel { min-width: 100dvw !important; left: 0 !important }`) —
 * so unless the .cui-settings-host flatten outranks id specificity, the
 * embedded panel snaps to viewport width inside a 618px column and the
 * settings layout shears apart exactly where laptop users half-tile their
 * windows (owner report, 2026-08-02, ~950px window).
 *
 * Non-mutating: settings mode, the AI 配置 panel mount, and the viewport size
 * are all client-side state on this test's own page; the shared disposable
 * host is left untouched.
 */

const MID_VIEWPORT = { width: 976, height: 800 };

test.use({ viewport: MID_VIEWPORT });

test('an embedded ST drawer fills the settings column, not the viewport, below ST\'s 1000px breakpoint', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.stack ?? error.message));

    const url = process.env.SILLYLOUNGE_E2E_URL;
    expect(url, 'global setup must expose the disposable ST URL').toBeTruthy();
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const root = page.locator('#chatui-root[data-cui-root-mounted="1"]');
    await expect(root).toBeVisible();

    await root.locator('.cui-root-settings-entry').click();
    await root.locator('.cui-settings-nav').waitFor();
    await root.locator('.cui-settings-nav-item', { hasText: 'AI 配置' }).click();
    const panel = page.locator('.cui-settings-host #left-nav-panel');
    await panel.waitFor();

    const geometry = await page.evaluate(() => {
        const box = (el) => {
            const r = el.getBoundingClientRect();
            return { left: r.left, right: r.right, width: r.width };
        };
        const panelEl = document.getElementById('left-nav-panel');
        const cs = getComputedStyle(panelEl);
        return {
            nav: box(document.querySelector('.cui-settings-nav')),
            content: box(document.querySelector('.cui-settings-content')),
            panel: box(panelEl),
            panelPosition: cs.position,
            panelRadius: cs.borderRadius,
            viewportWidth: window.innerWidth,
        };
    });

    // The nav keeps its owner-called 300px and the panel starts where the nav
    // ends — nothing overlaps the nav column.
    expect(geometry.nav.width).toBe(300);
    expect(geometry.panel.left).toBeGreaterThanOrEqual(geometry.nav.right);

    // The panel fills its column, and only its column. Before the specificity
    // fix this width was the full 976 (ST's 100dvw), overflowing a 618px host.
    expect(geometry.panel.width).toBe(geometry.content.width);
    expect(geometry.panel.width).toBeLessThan(geometry.viewportWidth);

    // Still flattened into flow (not ST's fixed overlay), and wearing ST's
    // desktop skin rather than the mobile drawer's 0 0 20px 20px radius.
    expect(geometry.panelPosition).toBe('static');
    expect(geometry.panelRadius).toBe('10px');

    expect(pageErrors).toEqual([]);
});
