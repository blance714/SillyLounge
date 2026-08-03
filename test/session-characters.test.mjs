// test/session-characters.test.mjs
//
// dist/runtime/store/session-characters.js — the ledger of characters ChatUI
// itself gave a conversation, which is the spine's answer to ST's `chat_size`
// being a boot-time disk snapshot. Source: src/store/session-characters.ts.
//
// What is being pinned is small but load-bearing: the spine is ChatUI's only
// way to change character (ST's own list is under the shield), so a character
// missing from it cannot be walked to at all. This ledger is what keeps the
// two cases where ChatUI knows better than the snapshot on the rail — ＋新对话
// for a character who had none, and the reload that follows deleting a
// character's last conversation.
//
// It replaced a persisted quarantine lease set that answered the same question
// as a side effect of tracking unadopted drafts. The tests below are therefore
// written against the *question* (who does ChatUI know has a conversation) and
// against the snapshot's stability contract, not against the old shape.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    getSessionCharacterConversations,
    rememberCharacterConversation,
    resetSessionCharacters,
    subscribeSessionCharacters,
} from '../dist/runtime/store/session-characters.js';

test('a remembered character is reported, and remembering is idempotent', () => {
    resetSessionCharacters();
    rememberCharacterConversation('ann.png');
    rememberCharacterConversation('bob.png');
    rememberCharacterConversation('ann.png');

    assert.deepEqual(getSessionCharacterConversations(), ['ann.png', 'bob.png']);
});

test('an unusable avatar is refused rather than recorded as a blank entry', () => {
    resetSessionCharacters();
    for (const value of ['', null, undefined, 0, {}, ['ann.png']]) {
        rememberCharacterConversation(value);
    }
    assert.deepEqual(getSessionCharacterConversations(), []);
});

test('the snapshot is stable across reads that changed nothing', () => {
    // useSyncExternalStore compares snapshots by identity and re-renders on any
    // change. A getter that rebuilt the array on every read would repaint the spine on
    // every unrelated store notification; a redundant remember that replaced it
    // would do the same.
    resetSessionCharacters();
    rememberCharacterConversation('ann.png');
    const first = getSessionCharacterConversations();
    assert.equal(getSessionCharacterConversations(), first, 'a plain re-read is the same object');
    rememberCharacterConversation('ann.png');
    assert.equal(getSessionCharacterConversations(), first, 'and so is a duplicate remember');
    rememberCharacterConversation('bob.png');
    assert.notEqual(getSessionCharacterConversations(), first, 'a real addition does replace it');
});

test('subscribers hear real additions and nothing else', () => {
    resetSessionCharacters();
    const seen = [];
    const unsubscribe = subscribeSessionCharacters(state => seen.push([...state.avatars]));

    rememberCharacterConversation('ann.png');
    rememberCharacterConversation('ann.png');
    rememberCharacterConversation('');
    rememberCharacterConversation('bob.png');
    unsubscribe();
    rememberCharacterConversation('cat.png');

    assert.deepEqual(seen, [['ann.png'], ['ann.png', 'bob.png']]);
});

test('resetting an already-empty ledger notifies nobody', () => {
    resetSessionCharacters();
    const seen = [];
    const unsubscribe = subscribeSessionCharacters(() => seen.push(1));
    resetSessionCharacters();
    unsubscribe();
    assert.deepEqual(seen, [], 'teardown must not repaint a rail that did not change');
});
