import { defineConfig, devices } from '@playwright/test';

import { DESKTOP_VIEWPORT, REDUCED_MOTION } from './scripts/e2e/browser-baseline.mjs';

export default defineConfig({
    testDir: './e2e',
    outputDir: './test-results/playwright',
    globalSetup: './scripts/e2e/playwright-global-setup.mjs',
    fullyParallel: false,
    workers: 1,
    retries: process.env.CI ? 1 : 0,
    timeout: 60_000,
    expect: {
        timeout: 10_000,
    },
    reporter: [
        ['list'],
        ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ],
    use: {
        viewport: DESKTOP_VIEWPORT,
        reducedMotion: REDUCED_MOTION,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'off',
    },
    projects: [{
        name: 'chromium',
        use: {
            ...devices['Desktop Chrome'],
            browserName: 'chromium',
            viewport: DESKTOP_VIEWPORT,
        },
    }, {
        /* Gecko, because Blink alone does not answer layout questions.
           .cui-root-rails shipped three QA waves green while it was visibly
           broken in the owner's Firefox: a flex item sized only by flex-basis
           contributes its flex base size to an ancestor's intrinsic sizing in
           Blink and its content size in Gecko, and nothing in a Chromium-only
           matrix can see the difference (fixed in 55af8f1).

           This project runs on CI, not on the maintainer's Mac: Playwright's
           Firefox build cannot launch there at all (RenderCompositorSWGL fails
           to map a framebuffer, headless and headed alike), which is exactly
           why `pnpm run test:e2e` pins itself to --project=chromium and CI
           runs the matrix unpinned. */
        name: 'firefox',
        use: {
            ...devices['Desktop Firefox'],
            browserName: 'firefox',
            viewport: DESKTOP_VIEWPORT,
        },
    }],
});
