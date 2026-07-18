import assert from 'node:assert/strict';
import test from 'node:test';

import { measureChatSwitch } from '../../scripts/e2e/measure-chat-switch.mjs';

test('chat-switch harness requires the pinned SillyTavern checkout', async () => {
    await assert.rejects(measureChatSwitch({}), /stRoot is required/);
});

test('chat-switch harness rejects fixture path traversal before browser launch', async () => {
    await assert.rejects(
        measureChatSwitch({ stRoot: '/unused', fixture: '../private-data' }),
        /fixture must be one safe directory name/,
    );
});

test('chat-switch harness rejects an unsafe native truncation before browser launch', async () => {
    await assert.rejects(
        measureChatSwitch({ stRoot: '/unused', nativeTruncation: -1 }),
        /nativeTruncation must be an integer between 0 and 1000/,
    );
});
