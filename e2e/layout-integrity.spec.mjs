import { expect, test } from '@playwright/test';

/**
 * A net for the whole class of defect the rails-width bug belonged to:
 * the same stylesheet laid out differently by two engines, in a window
 * nobody photographed.
 *
 * rails-geometry.spec.mjs pins the one relationship that actually broke.
 * This pins the properties that must hold *around* it — no horizontal
 * overflow anywhere in the app, and every region of the stage starting at
 * or after the chrome that precedes it — across the three widths that
 * matter: the design baseline, ST's own 1000px breakpoint corridor, and
 * the maintainer's real window.
 *
 * These are deliberately relationships and bounds, never pixel counts.
 * A pixel assertion would canonise whichever engine happened to author it,
 * which is exactly how a Blink-only suite stayed green while Gecko sheared.
 *
 * Non-mutating: viewport size and settings mode are this page's own state.
 */

const WIDTHS = [
    { width: 1280, why: 'design baseline' },
    { width: 976, why: "inside ST's 1000px mobile breakpoint" },
    { width: 889, why: "the maintainer's real window" },
];

/** Horizontal overflow, and the seam between the chrome and the stage. */
async function readLayout(page, stageSelector) {
    return page.evaluate((stageSel) => {
        const root = document.querySelector('#chatui-root');
        const rails = document.querySelector('.cui-root-rails');
        const stage = document.querySelector(stageSel);
        const list = document.querySelector('.cui-root-message-list');
        const box = (el) => (el ? (({ left, right, width }) => ({ left, right, width }))(
            el.getBoundingClientRect()) : null);
        return {
            viewportWidth: window.innerWidth,
            rootOverflow: root ? root.scrollWidth - root.clientWidth : null,
            // A reading column with a horizontal scrollbar is a layout failure,
            // not a feature: the fixture's messages are all short plain text.
            listOverflow: list ? list.scrollWidth - list.clientWidth : null,
            rails: box(rails),
            stage: box(stage),
        };
    }, stageSelector);
}

function assertNoShear(layout, label) {
    expect(layout.rails, `${label}: rails present`).not.toBeNull();
    expect(layout.stage, `${label}: stage present`).not.toBeNull();

    // Nothing may make the app scroll sideways.
    expect(layout.rootOverflow, `${label}: #chatui-root does not overflow horizontally`)
        .toBeLessThanOrEqual(1);
    if (layout.listOverflow !== null) {
        expect(layout.listOverflow, `${label}: the reading column does not scroll sideways`)
            .toBeLessThanOrEqual(1);
    }

    // The chrome starts at the left edge and the stage starts after it —
    // never underneath it, which is what a mis-sized rails produces.
    expect(layout.rails.left, `${label}: the rails is flush left`).toBeCloseTo(0, 0);
    expect(layout.stage.left, `${label}: the stage starts at or after the rails ends`)
        .toBeGreaterThanOrEqual(layout.rails.right - 0.5);

    // And together they account for the window, with nothing spilling past it.
    expect(layout.stage.right, `${label}: the stage ends within the window`)
        .toBeLessThanOrEqual(layout.viewportWidth + 1);
    expect(layout.rails.width + layout.stage.width,
        `${label}: chrome plus stage fills the window`)
        .toBeCloseTo(layout.viewportWidth, 0);
}

test('the app lays out without shear at every desktop width, in both modes', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.stack ?? error.message));

    const url = process.env.SILLYLOUNGE_E2E_URL;
    expect(url, 'global setup must expose the disposable ST URL').toBeTruthy();
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const root = page.locator('#chatui-root[data-cui-root-mounted="1"]');
    await expect(root).toBeVisible();
    await root.locator('.cui-root-message-list article.cui-root-message').first().waitFor();

    for (const { width, why } of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(400);
        assertNoShear(
            await readLayout(page, '.cui-root-app'),
            `chat @ ${width}px (${why})`,
        );
    }

    await root.locator('.cui-root-settings-entry').click();
    await root.locator('.cui-settings-nav').waitFor();

    for (const { width, why } of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(400);
        assertNoShear(
            await readLayout(page, '.cui-settings-content'),
            `settings @ ${width}px (${why})`,
        );
    }

    expect(pageErrors).toEqual([]);
});
