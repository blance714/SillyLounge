// test/adapter-chats.test.mjs
//
// Covers the chat rename/delete transaction subsystem:
//   dist/runtime/adapter/chats/{rename-transaction,delete-transaction,selection-protocol}.js
//
// These three modules coordinate a stable-avatar file rename/delete against a
// server that can be slow, lie transiently, or race a concurrent host
// navigation — see the doc comments in src/adapter/chats/*.ts for the intent.
// Every test below drives the *compiled* modules through the fake ST host,
// asserting on the public DTO returned and/or the exact fetch calls/events
// produced, never on private state.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createFakeStHost } from './helpers/fake-st-host.mjs';

// ---------------------------------------------------------------------
// Fetch routing helpers
// ---------------------------------------------------------------------
//
// Each module under test drives a small fixed set of REST endpoints
// (/api/chats/rename, /api/characters/chats, /api/characters/merge-attributes,
// /api/characters/get, /api/chats/delete, /api/chats/search). A test queues
// one response per *expected* call to a given URL, in call order. Once a
// URL's queue is down to its last entry, further calls keep returning that
// same entry (useful when a URL is only ever hit once and re-queuing per
// call would be noise) — tests that care about the exact call count assert
// it explicitly via `router.callCount(url)`.
function createRouter(host) {
    const queues = new Map();
    host.fetch.setHandler((input) => {
        const url = typeof input === 'string' ? input : (input && input.url) || String(input);
        const queue = queues.get(url);
        if (!queue || queue.length === 0) {
            throw new Error(`fetch router: no response queued for ${url}`);
        }
        const next = queue.length > 1 ? queue.shift() : queue[0];
        return typeof next === 'function' ? next() : next;
    });
    return {
        queue(url, ...responses) {
            queues.set(url, (queues.get(url) ?? []).concat(responses));
        },
        callCount(url) {
            return host.fetch.calls.filter(call => call.input === url).length;
        },
    };
}

function okJson(body) {
    return { ok: true, status: 200, json: async () => body };
}

function notOk(status = 500) {
    return { ok: false, status };
}

/** A queue entry that makes fetch() itself reject, simulating a network throw. */
function networkThrow(message = 'network down') {
    return () => {
        throw new Error(message);
    };
}

/** /api/characters/chats raw listing rows: [{ file_id: '<name>.jsonl' }, ...]. */
function rawListing(...bareNames) {
    return okJson(bareNames.map(name => ({ file_id: `${name}.jsonl` })));
}

/** /api/characters/get response: the durable character-card chat pointer. */
function pointerResponse(bareChatName) {
    return okJson({ chat: `${bareChatName}.jsonl` });
}

/** /api/chats/rename response: the server-confirmed (possibly sanitized) name. */
function renameResponse(sanitizedBareName) {
    return okJson({ sanitizedFileName: `${sanitizedBareName}.jsonl` });
}

function chatKey(avatar, session) {
    return JSON.stringify(['character', avatar, `session:${session}`]);
}

/**
 * Shared host defaults every test needs regardless of which of the three
 * modules it exercises: request headers, the no-op debounced-save
 * cancellers, and a not-currently-generating/-saving state. `avatar` +
 * `cardChatName` (optional) seed a single character card whose durable
 * `chat` pointer is `cardChatName` — pass a value distinct from the file a
 * test operates on to keep that test's card-pointer race branch untouched;
 * pass the same value to opt into it. `characterId` defaults to unset (no
 * "current" chat at all); tests that need a live/current chat set
 * `host.context.characterId` themselves afterwards.
 */
function configureBaseHost(host, { avatar, cardChatName, characterName = 'Bob' } = {}) {
    host.registry.getRequestHeaders = () => ({});
    host.registry.isGenerating = () => false;
    host.registry.cancelDebouncedChatSave = () => {};
    host.registry.cancelDebouncedMetadataSave = () => {};
    host.registry.saveChatConditional = async () => {};
    host.registry.humanizedDateTime = () => '2026-01-01 @00h00';
    // deleteCharacterChat always ranks replacement candidates through
    // listChatsForCharacterAvatar(), which unconditionally reads
    // getCurrentChatDetails() to tag "is this row the current chat" — even
    // when there is no live/current chat at all. Tests that care about a
    // specific current-chat identity override this afterwards.
    host.registry.getCurrentChatDetails = () => ({ sessionName: '' });
    host.context.characterId = undefined;
    if (avatar) {
        host.context.characters = [{
            avatar,
            name: characterName,
            chat: cardChatName ? `${cardChatName}.jsonl` : '',
            chat_size: 1,
            date_last_chat: 0,
            fav: false,
        }];
    }
}

// =======================================================================
// selection-protocol.js — persistCharacterChatSelection outcome mapping
// (priority invariant 1) + the raw-listing/readback primitives it and the
// rename/delete transactions both depend on.
// =======================================================================

test('persistCharacterChatSelection resolves persisted when the write is accepted and readback confirms the target', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host);
        const router = createRouter(host);
        router.queue('/api/characters/merge-attributes', okJson({}));
        router.queue('/api/characters/get', pointerResponse('new-chat'));

        const selection = await host.importModule('adapter/chats/selection-protocol.js');
        const result = await selection.persistCharacterChatSelection('bob.png', 'new-chat', 'old-chat');

        assert.deepEqual(result, { status: 'persisted', fileName: 'new-chat' });
        assert.equal(router.callCount('/api/characters/merge-attributes'), 1);
        assert.equal(router.callCount('/api/characters/get'), 1);
    } finally {
        await host.dispose();
    }
});

test('persistCharacterChatSelection resolves different immediately when an accepted write is confirmed to have lost to another selection', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host);
        const router = createRouter(host);
        router.queue('/api/characters/merge-attributes', okJson({}));
        router.queue('/api/characters/get', pointerResponse('someone-elses-chat'));

        const selection = await host.importModule('adapter/chats/selection-protocol.js');
        const result = await selection.persistCharacterChatSelection('bob.png', 'new-chat', 'old-chat');

        assert.deepEqual(result, { status: 'different', fileName: 'someone-elses-chat' });
        assert.equal(router.callCount('/api/characters/get'), 1,
            'a definitive non-ambiguous readback must resolve without retrying');
    } finally {
        await host.dispose();
    }
});

test('persistCharacterChatSelection resolves rejected without retrying once an HTTP-rejected write is confirmed never to have landed', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host);
        const router = createRouter(host);
        router.queue('/api/characters/merge-attributes', notOk(500));
        router.queue('/api/characters/get', pointerResponse('old-chat'));

        const selection = await host.importModule('adapter/chats/selection-protocol.js');
        const result = await selection.persistCharacterChatSelection('bob.png', 'new-chat', 'old-chat');

        assert.deepEqual(result, { status: 'rejected' });
        assert.equal(router.callCount('/api/characters/merge-attributes'), 1);
        assert.equal(router.callCount('/api/characters/get'), 1);
    } finally {
        await host.dispose();
    }
});

test('a network-throwing write is treated as ambiguous and only resolves once a later write proves the outcome', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host);
        const router = createRouter(host);
        router.queue('/api/characters/merge-attributes', networkThrow('offline'), okJson({}));
        router.queue('/api/characters/get', pointerResponse('old-chat'), pointerResponse('new-chat'));

        const selection = await host.importModule('adapter/chats/selection-protocol.js');
        const result = await selection.persistCharacterChatSelection('bob.png', 'new-chat', 'old-chat');

        assert.deepEqual(result, { status: 'persisted', fileName: 'new-chat' });
        assert.equal(router.callCount('/api/characters/merge-attributes'), 2,
            'an ambiguous write must be retried, never assumed to have failed');
        assert.equal(router.callCount('/api/characters/get'), 2);
    } finally {
        await host.dispose();
    }
});

test('an accepted write survives transient HTTP failures on the readback and resolves once a read finally confirms the target', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host);
        const router = createRouter(host);
        router.queue('/api/characters/merge-attributes', okJson({}));
        router.queue('/api/characters/get', notOk(503), notOk(503), pointerResponse('new-chat'));

        const selection = await host.importModule('adapter/chats/selection-protocol.js');
        const result = await selection.persistCharacterChatSelection('bob.png', 'new-chat', 'old-chat');

        assert.deepEqual(result, { status: 'persisted', fileName: 'new-chat' });
        assert.equal(router.callCount('/api/characters/merge-attributes'), 1,
            'a definitively accepted write must never be repeated just because the readback is flaky');
        assert.equal(router.callCount('/api/characters/get'), 3);
    } finally {
        await host.dispose();
    }
});

// Bounded wall-clock budget: a sustained outage must eventually surrender the
// lane and report the honest 'unknown' outcome instead of retrying forever.
// The write starts ambiguous (a network throw) and every retry write stays
// ambiguous too, so the readback can never definitively resolve — the only
// way out is the shared RECONCILIATION_RETRY_BUDGET expiring.
test('persistCharacterChatSelection gives up and resolves unknown once the retry budget is exhausted by a sustained outage', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host);
        const router = createRouter(host);
        router.queue('/api/characters/merge-attributes', networkThrow('offline'));
        router.queue('/api/characters/get', networkThrow('offline'));

        const selection = await host.importModule('adapter/chats/selection-protocol.js');
        selection.RECONCILIATION_RETRY_BUDGET.maxAttempts = 3;

        const result = await selection.persistCharacterChatSelection('bob.png', 'new-chat', 'old-chat');

        assert.deepEqual(result, { status: 'unknown' });
        assert.equal(router.callCount('/api/characters/get'), 3,
            'the loop must stop reading back after exactly maxAttempts attempts');
        assert.equal(router.callCount('/api/characters/merge-attributes'), 3,
            'each failed readback (but the last) retries the write too, bounded by the same budget');
    } finally {
        await host.dispose();
    }
});

test('readCharacterChatSelection throws on a non-ok response instead of returning a stale value', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host);
        const router = createRouter(host);
        router.queue('/api/characters/get', notOk(500));

        const selection = await host.importModule('adapter/chats/selection-protocol.js');
        await assert.rejects(() => selection.readCharacterChatSelection('bob.png'));
    } finally {
        await host.dispose();
    }
});

test('listRawCharacterChatNames strips .jsonl and drops blank entries from the raw directory listing', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host);
        const router = createRouter(host);
        router.queue('/api/characters/chats', okJson([
            { file_id: 'chat-a.jsonl' },
            { file_id: 'chat-b' },
            { file_id: '' },
            {},
        ]));

        const selection = await host.importModule('adapter/chats/selection-protocol.js');
        const names = await selection.listRawCharacterChatNames('bob.png');

        assert.deepEqual(names, ['chat-a', 'chat-b']);
    } finally {
        await host.dispose();
    }
});

// =======================================================================
// rename-transaction.js
// =======================================================================

test('rename requests that fail basic input validation short-circuit before touching the host', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png', cardChatName: 'chat-a' });

        const rename = await host.importModule('adapter/chats/rename-transaction.js');
        const invalidCases = await Promise.all([
            rename.renameCharacterChat('', 'chat-a', 'chat-z'),
            rename.renameCharacterChat('bob.png', 'chat-a', 'chat-a'),
            rename.renameCharacterChat('bob.png', 'chat-a', '   '),
        ]);

        for (const result of invalidCases) {
            assert.equal(result.renamed, false);
            assert.equal(result.reconciled, true);
            assert.equal(result.uncertain, false);
            assert.equal(result.reloadRequired, false);
        }
        assert.equal(host.fetch.calls.length, 0, 'no host request should be issued for invalid input');
    } finally {
        await host.dispose();
    }
});

test('renaming a file absent from the raw directory listing returns invalid after one existence check, without issuing a rename request', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png', cardChatName: 'chat-a' });
        const router = createRouter(host);
        router.queue('/api/characters/chats', rawListing('chat-a', 'chat-b'));

        const rename = await host.importModule('adapter/chats/rename-transaction.js');
        const result = await rename.renameCharacterChat('bob.png', 'ghost-chat', 'chat-z');

        assert.equal(result.renamed, false);
        assert.equal(host.fetch.calls.length, 1, 'must not call /api/chats/rename for a file that was never listed');
    } finally {
        await host.dispose();
    }
});

test('a clean rename with no card-pointer race reports success and emits CHAT_RENAMED with the confirmed filenames', async () => {
    const host = await createFakeStHost();
    try {
        // The card points at an unrelated chat, so the rename never touches the
        // character-card pointer at all — the purest "nothing raced" case.
        configureBaseHost(host, { avatar: 'bob.png', cardChatName: 'unrelated-chat' });

        const router = createRouter(host);
        router.queue('/api/characters/chats', rawListing('chat-a'), rawListing('chat-z'));
        router.queue('/api/chats/rename', renameResponse('chat-z'));

        const rename = await host.importModule('adapter/chats/rename-transaction.js');
        let emittedPayload = null;
        host.eventSource.on(host.event_types.CHAT_RENAMED, payload => { emittedPayload = payload; });

        const result = await rename.renameCharacterChat('bob.png', 'chat-a', 'chat-z');

        assert.deepEqual(result, {
            renamed: true,
            reconciled: true,
            uncertain: false,
            reloadRequired: false,
            avatar: 'bob.png',
            oldFileName: 'chat-a',
            newFileName: 'chat-z',
            oldChatKey: chatKey('bob.png', 'chat-a'),
            newChatKey: chatKey('bob.png', 'chat-z'),
        });
        assert.deepEqual(emittedPayload, {
            avatarId: 'bob.png',
            groupId: null,
            oldFileName: 'chat-a.jsonl',
            newFileName: 'chat-z.jsonl',
        });
    } finally {
        await host.dispose();
    }
});

// Priority invariant 2: a current-chat rename is only ever finalized as a
// clean success when reconciliation both succeeds AND lands on the actual
// rename target — guards the `&& safety.fileName === actualName` conjunct
// at rename-transaction.ts:257.
test('a current-chat rename is uncertain, not clean, when reconciliation lands on a different durable file than the rename target', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png', cardChatName: 'old-chat' });
        host.context.characterId = 0;

        // Simulates a concurrent host navigation: the first two reads of
        // getCurrentChatDetails() (the pre-rename gating checks) still see the
        // chat being renamed; from the third read on (reconciliation) the live
        // session has moved to an entirely different, unrelated chat file that
        // also happens to be durably selected — a "reconciled-looking" state
        // whose fileName is simply not the rename target.
        let chatDetailsCalls = 0;
        host.registry.getCurrentChatDetails = () => {
            chatDetailsCalls += 1;
            return { sessionName: chatDetailsCalls <= 2 ? 'old-chat.jsonl' : 'race-chat.jsonl' };
        };

        const router = createRouter(host);
        router.queue('/api/characters/chats',
            rawListing('old-chat'),               // pre-rename existence check
            rawListing('new-chat'),                // forward-rename readback: clean move
            rawListing('new-chat', 'race-chat'),   // reconciliation readback
        );
        router.queue('/api/chats/rename', renameResponse('new-chat'));
        router.queue('/api/characters/merge-attributes', okJson({}));
        router.queue('/api/characters/get', pointerResponse('new-chat'), pointerResponse('race-chat'));

        const rename = await host.importModule('adapter/chats/rename-transaction.js');
        let renamedEmitted = false;
        host.eventSource.on(host.event_types.CHAT_RENAMED, () => { renamedEmitted = true; });

        const result = await rename.renameCharacterChat('bob.png', 'old-chat', 'new-chat');

        assert.deepEqual(result, {
            renamed: true,
            reconciled: false,
            uncertain: true,
            reloadRequired: false,
            avatar: 'bob.png',
            oldFileName: 'old-chat',
            newFileName: 'new-chat',
            oldChatKey: chatKey('bob.png', 'old-chat'),
            newChatKey: chatKey('bob.png', 'new-chat'),
        });
        assert.equal(renamedEmitted, false, 'CHAT_RENAMED must not fire on an uncertain result');
    } finally {
        await host.dispose();
    }
});

// Priority invariant 4: a rollback that itself lands in a file conflict must
// never be reported as a clean renamed+reconciled success.
test('a rename rollback that lands in a file conflict is reported uncertain, never a false clean success', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png', cardChatName: 'old-chat' });
        // characterId is left unset: getCurrentChatIdentity() is null, so this
        // is a non-current rename. The card-pointer race this test drives is
        // independent of "the live session", which is exactly what isolates it.

        const router = createRouter(host);
        router.queue('/api/characters/chats',
            rawListing('old-chat'),               // pre-rename existence check
            rawListing('new-chat'),                // forward-rename readback: clean move
            rawListing('new-chat'),                // rollback pre-listing
            rawListing('old-chat', 'new-chat'),    // rollback readback: BOTH names now exist
        );
        router.queue('/api/chats/rename', renameResponse('new-chat'), renameResponse('old-chat'));
        router.queue('/api/characters/merge-attributes', notOk(500));
        router.queue('/api/characters/get', pointerResponse('old-chat'));

        const rename = await host.importModule('adapter/chats/rename-transaction.js');
        let renamedEmitted = false;
        host.eventSource.on(host.event_types.CHAT_RENAMED, () => { renamedEmitted = true; });

        const result = await rename.renameCharacterChat('bob.png', 'old-chat', 'new-chat');

        assert.deepEqual(result, {
            renamed: true,
            reconciled: false,
            uncertain: true,
            reloadRequired: false,
            avatar: 'bob.png',
            oldFileName: 'old-chat',
            newFileName: 'new-chat',
            oldChatKey: chatKey('bob.png', 'old-chat'),
            newChatKey: chatKey('bob.png', 'new-chat'),
        });
        assert.equal(renamedEmitted, false);
    } finally {
        await host.dispose();
    }
});

// Bounded wall-clock budget: renameCharacterChatFile's resolveUnknown loop
// (only reachable for a current-chat rename) must eventually surrender the
// lane instead of polling forever through a sustained outage. The rename
// POST itself succeeds, but every readback of the raw directory listing
// after that fails, so the loop can never observe the real outcome.
test('a current-chat forward rename gives up and reports uncertain+reloadRequired once the retry budget is exhausted by a sustained readback outage', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png', cardChatName: 'other-chat' });
        host.context.characterId = 0;
        host.registry.getCurrentChatDetails = () => ({ sessionName: 'chat-a.jsonl' });

        const router = createRouter(host);
        router.queue('/api/characters/chats',
            rawListing('chat-a', 'chat-b'), // pre-rename existence check
            notOk(503),                      // forward-rename readback: never succeeds again
        );
        // An ok response whose body is unparseable: requestState is 'accepted'
        // (a real write happened) but confirmedName stays '' — the exact case
        // the retry loop's before/after-diff branch exists for. (A parseable
        // response would let a read failure short-circuit straight to
        // 'renamed' via the confirmedName check, never reaching this loop's
        // budget at all.)
        router.queue('/api/chats/rename', { ok: true, status: 200, json: async () => {
            throw new Error('malformed rename response body');
        } });

        const selection = await host.importModule('adapter/chats/selection-protocol.js');
        selection.RECONCILIATION_RETRY_BUDGET.maxAttempts = 3;

        const rename = await host.importModule('adapter/chats/rename-transaction.js');
        let renamedEmitted = false;
        host.eventSource.on(host.event_types.CHAT_RENAMED, () => { renamedEmitted = true; });

        const result = await rename.renameCharacterChat('bob.png', 'chat-a', 'chat-z');

        assert.deepEqual(result, {
            renamed: false,
            reconciled: false,
            uncertain: true,
            reloadRequired: true,
            avatar: 'bob.png',
            oldFileName: 'chat-a',
            newFileName: 'chat-z',
            oldChatKey: chatKey('bob.png', 'chat-a'),
            newChatKey: chatKey('bob.png', 'chat-z'),
        });
        assert.equal(router.callCount('/api/characters/chats'), 1 + 3,
            'the pre-rename check plus exactly maxAttempts readback attempts');
        assert.equal(renamedEmitted, false);
    } finally {
        await host.dispose();
    }
});

// Bounded wall-clock budget: reconcileCurrentRenameSafety must eventually
// surrender the lane instead of polling forever once both readbacks it needs
// (raw listing + durable pointer) start failing. The rename itself lands
// cleanly (forward move + pointer persist both succeed), isolating the
// budget expiry to this function's own retry loop.
test('reconcileCurrentRenameSafety gives up and reports uncertain+reloadRequired once the retry budget is exhausted by a sustained outage', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png', cardChatName: 'chat-a' });
        host.context.characterId = 0;
        host.registry.getCurrentChatDetails = () => ({ sessionName: 'chat-a.jsonl' });

        const router = createRouter(host);
        router.queue('/api/characters/chats',
            rawListing('chat-a', 'chat-b'),          // pre-rename existence check
            rawListing('chat-z', 'chat-b'),           // forward-rename readback: clean move
            networkThrow('offline'),                  // reconciliation: never succeeds again
        );
        router.queue('/api/chats/rename', renameResponse('chat-z'));
        router.queue('/api/characters/merge-attributes', okJson({}));
        router.queue('/api/characters/get',
            pointerResponse('chat-z'),                // pointer write readback: persisted
            networkThrow('offline'),                  // reconciliation: never succeeds again
        );

        const selection = await host.importModule('adapter/chats/selection-protocol.js');
        selection.RECONCILIATION_RETRY_BUDGET.maxAttempts = 3;

        const rename = await host.importModule('adapter/chats/rename-transaction.js');
        let renamedEmitted = false;
        host.eventSource.on(host.event_types.CHAT_RENAMED, () => { renamedEmitted = true; });

        const result = await rename.renameCharacterChat('bob.png', 'chat-a', 'chat-z');

        assert.deepEqual(result, {
            renamed: true,
            reconciled: false,
            uncertain: true,
            reloadRequired: true,
            avatar: 'bob.png',
            oldFileName: 'chat-a',
            newFileName: 'chat-z',
            oldChatKey: chatKey('bob.png', 'chat-a'),
            newChatKey: chatKey('bob.png', 'chat-z'),
        });
        assert.equal(router.callCount('/api/characters/chats'), 2 + 3,
            'the two clean reads plus exactly maxAttempts reconciliation attempts');
        assert.equal(router.callCount('/api/characters/get'), 1 + 3,
            'the one clean pointer readback plus exactly maxAttempts reconciliation attempts');
        assert.equal(renamedEmitted, false);
    } finally {
        await host.dispose();
    }
});

// =======================================================================
// delete-transaction.js
// =======================================================================

test('deleting with a missing avatar or filename resolves unchanged without contacting the host at all', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png', cardChatName: 'other-chat' });

        const del = await host.importModule('adapter/chats/delete-transaction.js');
        const unchanged = { deleted: false, reconciled: true, uncertain: false, reloadRequired: false };

        assert.deepEqual(await del.deleteCharacterChat('', 'chat-a'), unchanged);
        assert.deepEqual(await del.deleteCharacterChat('bob.png', ''), unchanged);
        assert.equal(host.fetch.calls.length, 0);
    } finally {
        await host.dispose();
    }
});

test('deleting a chat absent from the raw directory listing resolves unchanged after one existence check, without issuing the destructive request', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png', cardChatName: 'other-chat' });
        const router = createRouter(host);
        router.queue('/api/characters/chats', rawListing('chat-a', 'chat-b'));

        const del = await host.importModule('adapter/chats/delete-transaction.js');
        const result = await del.deleteCharacterChat('bob.png', 'ghost-chat');

        assert.deepEqual(result, { deleted: false, reconciled: true, uncertain: false, reloadRequired: false });
        assert.equal(host.fetch.calls.length, 1, 'must not call /api/chats/delete for a file that was never listed');
    } finally {
        await host.dispose();
    }
});

test('deleting a non-current chat that is not the character-card pointer resolves cleanly and emits CHAT_DELETED', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png', cardChatName: 'other-chat' });

        const router = createRouter(host);
        router.queue('/api/characters/chats', rawListing('chat-a', 'chat-b'), rawListing('chat-b'));
        router.queue('/api/chats/search', okJson([]));
        router.queue('/api/chats/delete', { ok: true });

        const del = await host.importModule('adapter/chats/delete-transaction.js');
        let deletedPayload;
        host.eventSource.on(host.event_types.CHAT_DELETED, payload => { deletedPayload = payload; });

        const result = await del.deleteCharacterChat('bob.png', 'chat-a');

        assert.deepEqual(result, { deleted: true, reconciled: true, uncertain: false, reloadRequired: false });
        assert.equal(deletedPayload, 'chat-a');
    } finally {
        await host.dispose();
    }
});

// Priority invariant 3 (core): the post-delete existence check retries
// through transient read failures — bounded by the fake timer guard — and
// only resolves 'deleted' once a read finally confirms the file is gone.
test('the post-delete existence check retries through transient read failures and resolves deleted once the listing confirms removal', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png', cardChatName: 'other-chat' });

        const router = createRouter(host);
        router.queue('/api/characters/chats',
            rawListing('chat-a', 'chat-b'),   // pre-delete existence check
            notOk(503),                        // existence poll: transient failure
            notOk(503),                        // existence poll: transient failure again
            rawListing('chat-b'),               // existence poll: finally confirms removal
        );
        router.queue('/api/chats/search', okJson([]));
        router.queue('/api/chats/delete', { ok: true });

        const del = await host.importModule('adapter/chats/delete-transaction.js');
        const result = await del.deleteCharacterChat('bob.png', 'chat-a');

        assert.deepEqual(result, { deleted: true, reconciled: true, uncertain: false, reloadRequired: false });
        assert.equal(router.callCount('/api/characters/chats'), 4,
            'the two transient failures should each have been retried before the third, successful read');
    } finally {
        await host.dispose();
    }
});

// Priority invariant 3 (complementary): the existence check is a single
// authoritative read, not a wait-until-gone poll — a listing that
// successfully reads back but still shows the file must resolve deleted:false
// immediately rather than being treated as ambiguous and retried forever.
test('a listing that successfully reads back but still shows the file resolves deleted:false immediately, without polling', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png', cardChatName: 'other-chat' });

        const router = createRouter(host);
        router.queue('/api/characters/chats',
            rawListing('chat-a', 'chat-b'),
            rawListing('chat-a', 'chat-b'), // still present after the delete request
        );
        router.queue('/api/chats/search', okJson([]));
        router.queue('/api/chats/delete', { ok: true });

        const del = await host.importModule('adapter/chats/delete-transaction.js');
        let deletedEmitted = false;
        host.eventSource.on(host.event_types.CHAT_DELETED, () => { deletedEmitted = true; });

        const result = await del.deleteCharacterChat('bob.png', 'chat-a');

        assert.deepEqual(result, { deleted: false, reconciled: true, uncertain: false, reloadRequired: false });
        assert.equal(router.callCount('/api/characters/chats'), 2,
            'a single successful read that still lists the file must not be retried as if it were ambiguous');
        assert.equal(deletedEmitted, false);
    } finally {
        await host.dispose();
    }
});

test('deleting the current chat persists the replacement pointer before deleting and always requires a reload, never emitting CHAT_DELETED', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png', cardChatName: 'chat-a' });
        host.context.characterId = 0;
        host.registry.getCurrentChatDetails = () => ({ sessionName: 'chat-a.jsonl' });

        const router = createRouter(host);
        router.queue('/api/characters/chats', rawListing('chat-a', 'chat-b'), rawListing('chat-b'));
        router.queue('/api/chats/search', okJson([]));
        router.queue('/api/characters/merge-attributes', okJson({}));
        router.queue('/api/characters/get', pointerResponse('chat-b'));
        router.queue('/api/chats/delete', { ok: true });

        const del = await host.importModule('adapter/chats/delete-transaction.js');
        let deletedEmitted = false;
        host.eventSource.on(host.event_types.CHAT_DELETED, () => { deletedEmitted = true; });

        const result = await del.deleteCharacterChat('bob.png', 'chat-a');

        assert.deepEqual(result, { deleted: true, reconciled: true, uncertain: false, reloadRequired: true });
        assert.equal(deletedEmitted, false,
            'a current-chat delete must never emit into the stale current-chat runtime; the caller reloads instead');
    } finally {
        await host.dispose();
    }
});

// Bounded wall-clock budget: the post-DELETE existence poll must eventually
// surrender the lane instead of polling forever through a sustained outage.
// Never attempt the usual pointer rollback here — the delete request may
// actually have committed, and rolling the pointer back to the deleted name
// would durably repoint the card at a file that no longer exists. Report the
// honest uncertain outcome instead, with reloadRequired mirroring the
// deletingCurrent case exactly like the confirmed-still-present branch does.
test('the post-delete existence poll gives up and reports uncertain, without rolling back the pointer, once the retry budget is exhausted', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png', cardChatName: 'chat-a' });
        host.context.characterId = 0;
        host.registry.getCurrentChatDetails = () => ({ sessionName: 'chat-a.jsonl' });

        const router = createRouter(host);
        router.queue('/api/characters/chats',
            rawListing('chat-a', 'chat-b'), // pre-delete existence check
            notOk(503),                      // existence poll: never succeeds again
        );
        router.queue('/api/chats/search', okJson([]));
        router.queue('/api/characters/merge-attributes', okJson({}));
        router.queue('/api/characters/get', pointerResponse('chat-b'));
        router.queue('/api/chats/delete', { ok: true });

        const selection = await host.importModule('adapter/chats/selection-protocol.js');
        selection.RECONCILIATION_RETRY_BUDGET.maxAttempts = 3;

        const del = await host.importModule('adapter/chats/delete-transaction.js');
        let deletedEmitted = false;
        host.eventSource.on(host.event_types.CHAT_DELETED, () => { deletedEmitted = true; });

        const result = await del.deleteCharacterChat('bob.png', 'chat-a');

        assert.deepEqual(result, { deleted: false, reconciled: false, uncertain: true, reloadRequired: true });
        assert.equal(router.callCount('/api/characters/chats'), 1 + 3,
            'the pre-delete check plus exactly maxAttempts existence-poll attempts');
        assert.equal(router.callCount('/api/characters/merge-attributes'), 1,
            'the pointer must already have been moved to the replacement before DELETE was even sent; ' +
            'an ambiguous DELETE outcome must never trigger a second (rollback) write');
        assert.equal(deletedEmitted, false);
    } finally {
        await host.dispose();
    }
});
