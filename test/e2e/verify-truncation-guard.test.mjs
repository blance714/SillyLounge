import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyTruncationGuard } from '../../scripts/e2e/verify-truncation-guard.mjs';

test('truncation-guard harness requires the pinned SillyTavern checkout', async () => {
    await assert.rejects(verifyTruncationGuard({}), /stRoot is required/);
});

test('truncation-guard harness rejects fixture path traversal before browser launch', async () => {
    await assert.rejects(
        verifyTruncationGuard({ stRoot: '/unused', fixture: '../private-data' }),
        /fixture must be one safe directory name/,
    );
});
