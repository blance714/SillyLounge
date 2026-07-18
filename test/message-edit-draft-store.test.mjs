import assert from 'node:assert/strict';
import test from 'node:test';

import {
    clearMessageEditDraft,
    getMessageEditDraft,
    getMessageEditDraftStoreSnapshot,
    resetMessageEditDraftStore,
    setMessageEditDraft,
    subscribeMessageEditDraftStore,
} from '../dist/runtime/store/message-edit-draft-store.js';

test.beforeEach(() => {
    resetMessageEditDraftStore();
});

test('a draft round-trips through set/get for its exact chatKey + messageId', () => {
    setMessageEditDraft('alice chat-a', 12, 'edited text');
    assert.equal(getMessageEditDraft('alice chat-a', 12), 'edited text');
});

test('no draft ever set reads as undefined, distinct from an explicit empty draft', () => {
    assert.equal(getMessageEditDraft('alice chat-a', 12), undefined);

    // The user selected-all-and-deleted: that IS a draft (an empty one), not
    // "no draft". Collapsing the two would resurrect the old message text on
    // a remount after the user deliberately cleared the textarea.
    setMessageEditDraft('alice chat-a', 12, '');
    assert.equal(getMessageEditDraft('alice chat-a', 12), '');
    assert.notEqual(getMessageEditDraft('alice chat-a', 12), undefined);
});

test('save clears exactly the drafted message and nothing else', () => {
    setMessageEditDraft('alice chat-a', 12, 'edited text');
    setMessageEditDraft('alice chat-a', 13, 'a different message');

    clearMessageEditDraft('alice chat-a', 12);

    assert.equal(getMessageEditDraft('alice chat-a', 12), undefined);
    assert.equal(getMessageEditDraft('alice chat-a', 13), 'a different message');
});

test('drafts for different messages in the same chat are independent', () => {
    setMessageEditDraft('alice chat-a', 1, 'first message edit');
    setMessageEditDraft('alice chat-a', 2, 'second message edit');

    assert.equal(getMessageEditDraft('alice chat-a', 1), 'first message edit');
    assert.equal(getMessageEditDraft('alice chat-a', 2), 'second message edit');

    clearMessageEditDraft('alice chat-a', 1);
    assert.equal(getMessageEditDraft('alice chat-a', 1), undefined);
    assert.equal(getMessageEditDraft('alice chat-a', 2), 'second message edit');
});

test('the same message id in two different chats keeps separate drafts', () => {
    setMessageEditDraft('alice chat-a', 5, 'draft in chat a');
    setMessageEditDraft('bob chat-b', 5, 'draft in chat b');

    assert.equal(getMessageEditDraft('alice chat-a', 5), 'draft in chat a');
    assert.equal(getMessageEditDraft('bob chat-b', 5), 'draft in chat b');

    clearMessageEditDraft('alice chat-a', 5);
    assert.equal(getMessageEditDraft('alice chat-a', 5), undefined);
    assert.equal(getMessageEditDraft('bob chat-b', 5), 'draft in chat b');
});

test('teardown reset clears every retained draft across all chats and messages', () => {
    setMessageEditDraft('alice chat-a', 1, 'one');
    setMessageEditDraft('bob chat-b', 2, 'two');

    resetMessageEditDraftStore();

    assert.equal(getMessageEditDraft('alice chat-a', 1), undefined);
    assert.equal(getMessageEditDraft('bob chat-b', 2), undefined);
    assert.deepEqual(getMessageEditDraftStoreSnapshot().drafts, {});
});

test('clearing an unset draft and re-setting the same text are both no-ops on subscribers', () => {
    let notifications = 0;
    const unsubscribe = subscribeMessageEditDraftStore(() => {
        notifications += 1;
    });

    // No draft exists yet for this key; clearing it must not touch the store.
    clearMessageEditDraft('alice chat-a', 9);
    assert.equal(notifications, 0);

    setMessageEditDraft('alice chat-a', 9, 'text');
    assert.equal(notifications, 1);

    // Re-setting the exact same text is a no-op: it must not re-notify or
    // otherwise perturb subscribers relying on change notifications.
    setMessageEditDraft('alice chat-a', 9, 'text');
    assert.equal(notifications, 1);

    setMessageEditDraft('alice chat-a', 9, 'changed');
    assert.equal(notifications, 2);

    clearMessageEditDraft('alice chat-a', 9);
    assert.equal(notifications, 3);

    unsubscribe();
    setMessageEditDraft('alice chat-a', 9, 'after unsubscribe');
    assert.equal(notifications, 3);
});

test('an unmount without save or cancel leaves the draft intact for the next mount to seed from', () => {
    // This mirrors MessageEditor's contract: on mount it seeds from
    // getMessageEditDraft(chatKey, id) falling back to message.text, and only
    // clears on save/cancel -- never on unmount alone.
    setMessageEditDraft('alice chat-a', 7, 'typed but not saved');

    // Simulate the row scrolling out of the virtualizer's window and back in:
    // no clear call happens in between.
    const seeded = getMessageEditDraft('alice chat-a', 7) ?? '<message.text fallback>';
    assert.equal(seeded, 'typed but not saved');
});
