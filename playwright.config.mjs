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
    }],
});
