import assert from 'node:assert/strict';
import test from 'node:test';

import { measureLongChat } from '../../scripts/e2e/measure-long-chat.mjs';

test('performance harness rejects fixture path traversal before launching a browser', async () => {
    await assert.rejects(
        measureLongChat({ stRoot: '/unused', fixture: '../private-data' }),
        /fixture must be one safe directory name/,
    );
});

test('performance harness rejects unknown regex modes before launching a browser', async () => {
    await assert.rejects(
        measureLongChat({ stRoot: '/unused', regexMode: 'maybe' }),
        /regexMode must be active or disabled/,
    );
});
