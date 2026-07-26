import assert from 'node:assert/strict';
import test from 'node:test';

import {
    assertPinnedWindowMatchesBaseline,
    measureChatSwitch,
} from '../../scripts/e2e/measure-chat-switch.mjs';

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

test('editing-row pin accepts the short control window without a fixed floor-distance assumption', () => {
    assert.doesNotThrow(() => {
        assertPinnedWindowMatchesBaseline(
            [0, 1, 2, 3, 4, 5, 6, 7],
            [0, 1, 2, 3, 4, 5, 6, 7, 16],
            16,
        );
    });
});

test('editing-row pin rejects a virtual window widened through the offscreen editor', () => {
    assert.throws(
        () => assertPinnedWindowMatchesBaseline(
            [0, 1, 2, 3, 4, 5, 6, 7],
            Array.from({ length: 17 }, (_, index) => index),
            16,
        ),
        /must not widen the ordinary virtual window/,
    );
});
