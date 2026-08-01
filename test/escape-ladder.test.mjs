// test/escape-ladder.test.mjs
//
// dist/runtime/ui/escape-ladder.js — pure decision, no DOM.
// Source: src/ui/escape-ladder.ts.
//
// One Escape keystroke has three possible meanings in this app and they are
// resolved in three different places: the focused editor takes it first (by
// stopPropagation on its own element), then this function, which decides
// between the two that are global. The case worth pinning is the overlap —
// a menu open *while* a reply is being written — because that is the one an
// implementation of "just add another window listener" gets wrong, and gets
// wrong destructively: it would abort the generation as a side effect of
// dismissing a menu.

import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveEscapeIntent } from '../dist/runtime/ui/escape-ladder.js';

test('resolveEscapeIntent: an open menu answers the key before a running generation does, and answers it alone', () => {
    assert.equal(
        resolveEscapeIntent({ hasOpenMenu: true, isGenerating: true }),
        'close-menu',
        'the overlap resolves to exactly one intent — closing a menu must never also stop the reply',
    );
    assert.equal(resolveEscapeIntent({ hasOpenMenu: true, isGenerating: false }), 'close-menu');
});

test('resolveEscapeIntent: with no menu on stage the key falls through to stopping the generation', () => {
    assert.equal(resolveEscapeIntent({ hasOpenMenu: false, isGenerating: true }), 'stop-generation');
});

test('resolveEscapeIntent: with nothing of ChatUI\'s on screen the keystroke is not ours to take', () => {
    assert.equal(
        resolveEscapeIntent({ hasOpenMenu: false, isGenerating: false }),
        'ignore',
        'an "ignore" the caller must honour by not calling preventDefault: Escape still belongs to the host and the browser',
    );
});
