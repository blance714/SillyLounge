// test/escape-ladder.test.mjs
//
// dist/runtime/ui/escape-ladder.js — pure decision, no DOM.
// Source: src/ui/escape-ladder.ts.
//
// One Escape keystroke has four possible meanings in this app and they are
// resolved in two different places: the focused editor takes it first (by
// stopPropagation on its own element), then this function, which decides
// between the three that are global. The cases worth pinning are the overlaps,
// because those are the ones an implementation of "just add another window
// listener" gets wrong, and gets wrong destructively — it would abort the
// generation as a side effect of dismissing a menu or leaving settings.
//
// That is not hypothetical for the settings rung: it *was* a second window
// listener in SettingsContent.tsx until 2026-08-05, and with a reply streaming
// one Escape both left settings and killed the reply.

import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveEscapeIntent } from '../dist/runtime/ui/escape-ladder.js';

/** Every combination, so a case can be named by what is on screen. */
function intent({ menu = false, settings = false, generating = false } = {}) {
    return resolveEscapeIntent({
        hasOpenMenu: menu,
        isSettingsOpen: settings,
        isGenerating: generating,
    });
}

test('resolveEscapeIntent: an open menu answers the key before a running generation does, and answers it alone', () => {
    assert.equal(
        intent({ menu: true, generating: true }),
        'close-menu',
        'the overlap resolves to exactly one intent — closing a menu must never also stop the reply',
    );
    assert.equal(intent({ menu: true }), 'close-menu');
});

test('resolveEscapeIntent: a menu opened inside settings mode is still what the key answers', () => {
    // The menu is the most recent thing the reader put on screen, so it is the
    // thing they are dismissing — leaving settings underneath it would throw
    // away a surface they did not ask to leave.
    assert.equal(intent({ menu: true, settings: true }), 'close-menu');
    assert.equal(intent({ menu: true, settings: true, generating: true }), 'close-menu');
});

test('resolveEscapeIntent: settings mode answers the key before a running generation does', () => {
    // The rung that used to be a second window listener. Both of these ran on
    // one keystroke: the reader left settings *and* lost the reply, and the
    // reply is the half that cannot be got back by pressing Escape again.
    assert.equal(intent({ settings: true, generating: true }), 'close-settings');
    assert.equal(intent({ settings: true }), 'close-settings');
});

test('resolveEscapeIntent: with no menu and no settings on stage the key falls through to stopping the generation', () => {
    assert.equal(intent({ generating: true }), 'stop-generation');
});

test('resolveEscapeIntent: with nothing of ChatUI\'s on screen the keystroke is not ours to take', () => {
    assert.equal(
        intent(),
        'ignore',
        'an "ignore" the caller must honour by not calling preventDefault: Escape still belongs to the host and the browser',
    );
});
