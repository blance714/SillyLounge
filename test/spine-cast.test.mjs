// test/spine-cast.test.mjs
//
// dist/runtime/ui/spine-cast.js — pure membership + ordering, no host/DOM
// needed. Source: src/ui/spine-cast.ts.
//
// The rule this pins is the one that decides whether a character is reachable
// at all: the spine is ChatUI's only way to change character, so a character
// missing from it cannot be walked to from inside ChatUI (ST's own list is
// under the shield). The original rule was 「chat_size > 0」 alone, and
// `chat_size` is a per-boot disk snapshot (src/endpoints/characters.js's
// calculateChatSize) that is never refreshed inside the page — so deleting a
// character's last conversation made the character you were standing on
// vanish from the rail on the very next paint, with no way back.
//
// Every case below is written against the three enrolment sources by name
// (disk snapshot / on stage / session ledger) and against literal expected
// orders, not against a re-derivation of the sort comparator.
//
// The ledger replaced a pair of quarantine-shaped sources on 2026-08-02: a
// lease set and a sessionStorage credential, both of which happened to name
// the right characters while tracking something else entirely.

import assert from 'node:assert/strict';
import test from 'node:test';

import { orderSpineCast } from '../dist/runtime/ui/spine-cast.js';

/** A cast entry as adapter/chats/queries.js's listCharacters projects one. */
function character(avatar, { chatSize = 0, dateLastChatTs = 0, name = avatar.replace('.png', '') } = {}) {
    return { avatar, name, chatSize, dateLastChatTs };
}

const names = cast => cast.map(entry => entry.avatar);

test('the spine enrols the union of the three sources and seats a character named by several of them exactly once', () => {
    const cast = [
        // 1. the disk snapshot: has conversations, like any ordinary entry.
        character('ann.png', { chatSize: 4096, dateLastChatTs: 300 }),
        // 2. on stage right now, but its chats directory reads empty — the
        //    state a current-chat delete leaves behind until the next boot.
        character('bob.png'),
        // 3. in the session ledger: ChatUI gave it a conversation after the
        //    snapshot was taken (＋新对话, or a post-delete landing).
        character('cat.png'),
        // …and never used at all: the case the original filter exists for.
        character('eve.png'),
    ];

    const enrolled = orderSpineCast(cast, {
        onStageAvatar: 'bob.png',
        sessionAvatars: ['cat.png'],
    });

    assert.deepEqual(
        new Set(names(enrolled)),
        new Set(['ann.png', 'bob.png', 'cat.png']),
        'each source enrols its character; a character no source names stays off the rail',
    );
    assert.equal(enrolled.length, 3, 'and nobody is enrolled twice');

    // The same character named by every source at once is still one seat: the
    // rule filters the cast list, it does not concatenate source lists.
    const allAtOnce = orderSpineCast(
        [character('bob.png', { chatSize: 4096, dateLastChatTs: 300 })],
        { onStageAvatar: 'bob.png', sessionAvatars: ['bob.png', 'bob.png'] },
    );
    assert.deepEqual(names(allAtOnce), ['bob.png']);
});

test('with no session sources at all the spine is exactly the characters that have conversations on disk', () => {
    const cast = [
        character('ann.png', { chatSize: 4096, dateLastChatTs: 300 }),
        character('bob.png'),
        character('cat.png', { chatSize: 1, dateLastChatTs: 100 }),
    ];

    assert.deepEqual(
        names(orderSpineCast(cast)),
        ['ann.png', 'cat.png'],
        'the filter the union relaxes is still the filter: an unused character is not on the bill',
    );
    assert.deepEqual(
        names(orderSpineCast(cast, { onStageAvatar: null, sessionAvatars: [] })),
        ['ann.png', 'cat.png'],
        'empty/null sources must behave exactly like passing nothing',
    );
});

test('entries with no usable identity are refused no matter which source names them', () => {
    const cast = [
        { avatar: '', name: 'Nameless file', chatSize: 4096, dateLastChatTs: 300 },
        { avatar: 'blank.png', name: '', chatSize: 4096, dateLastChatTs: 200 },
        character('ann.png', { chatSize: 4096, dateLastChatTs: 100 }),
    ];

    assert.deepEqual(
        names(orderSpineCast(cast, {
            onStageAvatar: 'blank.png',
            sessionAvatars: ['', 'blank.png'],
        })),
        ['ann.png'],
        'a seat needs an avatar to key it and a name to label it; enrolment cannot conjure either',
    );
});

test('a character ChatUI knows is live leads the rail, because its recency key is absent rather than old', () => {
    // The same directory scan that reports chat_size: 0 reports
    // date_last_chat: 0, so ordering these by recency alone would bury exactly
    // the entries the union was added to rescue at the bottom of a rail that
    // scrolls.
    const cast = [
        character('ann.png', { chatSize: 4096, dateLastChatTs: 300 }),
        character('bob.png', { chatSize: 4096, dateLastChatTs: 200 }),
        character('cat.png'),
    ];

    assert.deepEqual(
        names(orderSpineCast(cast, { onStageAvatar: 'cat.png' })),
        ['cat.png', 'ann.png', 'bob.png'],
    );
});

test('a character the disk snapshot already accounts for keeps its recency seat, on stage or not', () => {
    const cast = [
        character('ann.png', { chatSize: 4096, dateLastChatTs: 300 }),
        character('bob.png', { chatSize: 4096, dateLastChatTs: 200 }),
        character('cat.png', { chatSize: 4096, dateLastChatTs: 100 }),
    ];

    // Holding the stage *and* sitting in the session ledger still does not move
    // a character the ordinary rule already seats: the union changes who is on
    // the rail, not how the rail is ordered.
    assert.deepEqual(
        names(orderSpineCast(cast, {
            onStageAvatar: 'cat.png',
            sessionAvatars: ['cat.png'],
        })),
        ['ann.png', 'bob.png', 'cat.png'],
    );
});

test('ties fall back to the incoming cast order, so two session-known characters keep ST\'s own sequence', () => {
    // Both carry the same (missing) timestamp, which is the ordinary case for
    // this band — Array.prototype.sort has been stable by specification since
    // ES2019, so this is a guarantee, not an engine detail.
    const cast = [
        character('ann.png'),
        character('bob.png', { chatSize: 4096, dateLastChatTs: 300 }),
        character('cat.png'),
    ];

    assert.deepEqual(
        names(orderSpineCast(cast, { sessionAvatars: ['ann.png', 'cat.png'] })),
        ['ann.png', 'cat.png', 'bob.png'],
    );
    // Reversing the input reverses only the tied pair, proving the fallback is
    // the input order rather than something derived from the avatars.
    assert.deepEqual(
        names(orderSpineCast([cast[2], cast[1], cast[0]], {
            sessionAvatars: ['ann.png', 'cat.png'],
        })),
        ['cat.png', 'ann.png', 'bob.png'],
    );
});

test('malformed recency and size values are read as zero instead of poisoning the order', () => {
    const cast = [
        { avatar: 'ann.png', name: 'Ann', chatSize: Number.NaN, dateLastChatTs: Number.NaN },
        { avatar: 'bob.png', name: 'Bob', chatSize: '4096', dateLastChatTs: '999' },
        character('cat.png', { chatSize: 4096, dateLastChatTs: 100 }),
    ];

    assert.deepEqual(
        names(orderSpineCast(cast, { onStageAvatar: 'ann.png', sessionAvatars: ['bob.png'] })),
        // ann and bob both read as size 0 (NaN and a string are not finite
        // numbers), so they lead in input order; cat is the only entry the
        // snapshot can speak for.
        ['ann.png', 'bob.png', 'cat.png'],
    );
});

test('the source list is never mutated', () => {
    const cast = [
        character('ann.png', { chatSize: 1, dateLastChatTs: 100 }),
        character('bob.png', { chatSize: 1, dateLastChatTs: 300 }),
    ];
    const before = names(cast);

    orderSpineCast(cast, { onStageAvatar: 'ann.png' });

    assert.deepEqual(names(cast), before,
        'the cast array belongs to the query cache; sorting it in place would reorder it for every reader');
});
