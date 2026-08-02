// test/blank-conversation.test.mjs
//
// dist/runtime/ui/blank-conversation.js — pure predicate, no host/DOM needed.
// Source: src/ui/blank-conversation.ts.
//
// The rule decides which playbill cards are drawn dashed: conversations nobody
// has written in yet. It exists in this shape because ST's chat listing does
// not report *who* wrote a message — only how many there are — so 「the only
// message is the character's」 has to be derived from what the page already
// knows rather than read off the wire. The derivation is only sound because ST
// seeds a new chat from exactly one place (script.js's getChatResult): a
// character with a greeting always starts at one character message, so a
// one-message chat of theirs is that greeting; a character without one starts
// at zero, so a one-message chat of theirs is the reader's own line.
//
// The cases below are written against that argument, not against a
// re-derivation of the boolean expression.

import assert from 'node:assert/strict';
import test from 'node:test';

import { isBlankConversation } from '../dist/runtime/ui/blank-conversation.js';

test('an empty conversation is blank whether or not the character has a greeting', () => {
    assert.equal(isBlankConversation({ messageCount: 0, hasGreeting: true }), true);
    assert.equal(isBlankConversation({ messageCount: 0, hasGreeting: false }), true);
});

test('one message means the greeting alone for a character who has one, and the reader\'s own line for one who does not', () => {
    // ST pushed first_mes (or the first non-empty alternate) into a fresh chat.
    // Nothing the reader wrote can be message one — theirs would be message two.
    assert.equal(isBlankConversation({ messageCount: 1, hasGreeting: true }), true);

    // No greeting to push, so ST left the chat empty and the single message is
    // necessarily the reader's. Drawing this dashed would call a conversation
    // that has been written in unwritten.
    assert.equal(isBlankConversation({ messageCount: 1, hasGreeting: false }), false);
});

test('a conversation with a reply in it is never blank', () => {
    for (const hasGreeting of [true, false]) {
        assert.equal(isBlankConversation({ messageCount: 2, hasGreeting }), false);
        assert.equal(isBlankConversation({ messageCount: 400, hasGreeting }), false);
    }
});

test('a count the listing could not supply is read as "not blank" rather than guessed', () => {
    // The dashed border is a claim about the file. Absent evidence, the honest
    // answer is the one that claims nothing — and it is also the safe one,
    // since the alternative marks real history as unwritten.
    for (const messageCount of [undefined, null, NaN, Infinity, -1, '1']) {
        assert.equal(
            isBlankConversation({ messageCount, hasGreeting: true }),
            false,
            `messageCount=${String(messageCount)}`,
        );
    }
});
