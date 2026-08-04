// test/adapter-chat-listing.test.mjs
//
// dist/runtime/adapter/chats/queries.js — what the playbill's two inputs are
// projected from. Source: src/adapter/chats/queries.ts.
//
// ui/blank-conversation.ts decides whether a card is drawn dashed from exactly
// two facts: how many messages the listing counted, and whether ST would have
// seeded this character's fresh chat with a greeting. Both are produced here,
// and the rule is only as exact as they are — which is why this file exists
// separately from the predicate's own suite.
//
// The greeting half is a claim about what `getFirstMessage()`
// (public/script.js:7651) does.
//
// These cases are written against that function's *actual* branches rather than
// against a plain reading of 「has a greeting」, because the two disagree in both
// directions and each disagreement mislabels a real conversation:
//
//   - ST takes `alternate_greetings[0]` blindly once `first_mes` is falsy, so a
//     card whose first alternate is empty seeds nothing even though a later
//     alternate has text;
//   - ST tests plain truthiness, so a greeting of only spaces is still pushed
//     into the chat and still counted by the listing.
//
// Driven through the compiled module and the fake host, asserting on the public
// `listCharacters()` projection rather than the private predicate.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createFakeStHost } from './helpers/fake-st-host.mjs';

/** A raw ST character record, with only the fields this projection reads. */
function card({ first_mes = '', alternate_greetings = undefined, name = 'Bob' } = {}) {
    const entry = {
        avatar: 'bob.png',
        name,
        chat: '',
        chat_size: 1,
        date_last_chat: 0,
        fav: false,
        first_mes,
    };
    if (alternate_greetings !== undefined) entry.data = { alternate_greetings };
    return entry;
}

/** `listCharacters()[0].hasGreeting` for one character record. */
async function hasGreetingFor(entry) {
    const host = await createFakeStHost();
    try {
        host.registry.getThumbnailUrl = () => '';
        host.context.characters = [entry];
        host.context.characterId = undefined;
        const queries = await host.importModule('adapter/chats/queries.js');
        return queries.listCharacters()[0].hasGreeting;
    } finally {
        await host.dispose();
    }
}

test('a character with any first_mes greets, whatever its alternates say', async () => {
    assert.equal(await hasGreetingFor(card({ first_mes: '你好。' })), true);
    // ST never consults the alternates while first_mes is truthy: they become
    // swipes behind a greeting that is already there.
    assert.equal(
        await hasGreetingFor(card({ first_mes: '你好。', alternate_greetings: [''] })),
        true,
    );
});

test('a character with nothing to greet with does not greet', async () => {
    assert.equal(await hasGreetingFor(card()), false);
    assert.equal(await hasGreetingFor(card({ alternate_greetings: [] })), false);
    assert.equal(await hasGreetingFor(card({ alternate_greetings: [''] })), false);
});

test('an empty first alternate means ST seeds nothing, even with a later alternate full of text', async () => {
    // getFirstMessage builds [first_mes, ...alternates], shifts the empty
    // first_mes off, and takes swipes[0] without looking at it. A rule that
    // asked whether *some* alternate is non-empty would answer true here and
    // draw a conversation the reader wrote the only line of as unwritten.
    assert.equal(
        await hasGreetingFor(card({ alternate_greetings: ['', '要不要来一杯？'] })),
        false,
    );
    assert.equal(
        await hasGreetingFor(card({ alternate_greetings: ['要不要来一杯？', ''] })),
        true,
    );
});

test('a greeting of only spaces is still a greeting, because ST pushes it and the listing counts it', async () => {
    // `characters[i].first_mes || ''` is a truthiness test, not a blankness
    // test. Trimming here would call a fresh, unwritten conversation
    // written-in — the one direction the dashed border must never get wrong.
    assert.equal(await hasGreetingFor(card({ first_mes: '   ' })), true);
    assert.equal(await hasGreetingFor(card({ alternate_greetings: ['   '] })), true);
});

test('a card whose greeting fields are missing or malformed is read as not greeting', async () => {
    // The schema catches these before the predicate sees them, and the safe
    // answer is the one that claims nothing about the file.
    assert.equal(await hasGreetingFor({ ...card(), first_mes: undefined }), false);
    assert.equal(await hasGreetingFor({ ...card(), first_mes: 42 }), false);
    assert.equal(
        await hasGreetingFor(card({ alternate_greetings: [null, '你好。'] })),
        false,
    );
});

/** `listChatsForCharacterAvatar()`'s rows for one hand-written /api/chats/search body. */
async function listedRowsFor(rows) {
    const host = await createFakeStHost();
    try {
        host.registry.getRequestHeaders = () => ({});
        host.registry.getCurrentChatDetails = () => ({ sessionName: '' });
        host.registry.timestampToMoment = () => null;
        host.context.characters = [];
        host.context.characterId = undefined;
        host.fetch.setHandler(() => ({ ok: true, status: 200, json: async () => rows }));
        const queries = await host.importModule('adapter/chats/queries.js');
        return await queries.listChatsForCharacterAvatar('bob.png');
    } finally {
        await host.dispose();
    }
}

test('a listing row that names no message count reports null, not zero', async () => {
    // The two endpoints behind the playbill name the count differently, so the
    // projection reads both. A row carrying neither has said nothing about the
    // file — and `0` is not nothing, it is the strongest possible claim that
    // nobody has written in it, which is exactly the claim the dashed border
    // makes. Filling the gap in here would put that claim beyond the reach of
    // the predicate's own guard (ui/blank-conversation.ts).
    const { chats } = await listedRowsFor([
        { file_name: 'from-search.jsonl', message_count: 7 },
        { file_name: 'from-recent.jsonl', chat_items: 3 },
        { file_name: 'countless.jsonl' },
        { file_name: 'malformed.jsonl', message_count: 'lots', chat_items: null },
    ]);

    assert.deepEqual(
        chats.map(chat => [chat.fileName, chat.messageCount]),
        [
            ['from-search', 7],
            ['from-recent', 3],
            ['countless', null],
            ['malformed', null],
        ],
    );
});

test('a row that names one count field and blanks the other still uses the one it has', async () => {
    // The schema keeps `message_count` optional-and-strict rather than coercing
    // it, so a null in one field falls through to the other instead of
    // becoming a 0 that outranks it.
    const { chats } = await listedRowsFor([
        { file_name: 'mixed.jsonl', message_count: null, chat_items: 5 },
    ]);
    assert.deepEqual(chats.map(chat => chat.messageCount), [5]);
});
