// test/adapter-chats.test.mjs
//
// Covers the chat rename/delete transaction subsystem:
//   dist/runtime/adapter/chats/{rename-transaction,delete-transaction,selection-protocol,deletion-finalization}.js
//
// These modules coordinate a stable-avatar file rename/delete against a
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

// -----------------------------------------------------------------------
// Gap 4: rename response is HTTP ok but its JSON body is unparseable
// (confirmedName stays ''). renameCharacterChatFile must fall back to
// inferring the outcome from the before/after raw-directory-listing diff
// (the `additions` set) instead of ever guessing from the request's own
// success/failure. Every test below is a non-current rename so the
// ambiguous-diff path resolves ('unknown' or otherwise) after exactly one
// readback, with no retry-budget plumbing involved.
// -----------------------------------------------------------------------

test('a rename response with an unparseable body infers a clean success from a single matching directory addition', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png', cardChatName: 'unrelated-chat' });

        const router = createRouter(host);
        router.queue('/api/characters/chats',
            rawListing('chat-a'),  // pre-rename existence check
            rawListing('chat-z'),  // forward-rename readback: chat-a gone, chat-z is the one addition
        );
        router.queue('/api/chats/rename', { ok: true, status: 200, json: async () => {
            throw new Error('malformed rename response body');
        } });

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

test('a rename response with an unparseable body infers a conflict when the old name and a single addition coexist', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png', cardChatName: 'unrelated-chat' });

        const router = createRouter(host);
        router.queue('/api/characters/chats',
            rawListing('chat-a'),               // pre-rename existence check
            rawListing('chat-a', 'chat-z'),      // forward-rename readback: chat-a still present too
        );
        router.queue('/api/chats/rename', { ok: true, status: 200, json: async () => {
            throw new Error('malformed rename response body');
        } });

        const rename = await host.importModule('adapter/chats/rename-transaction.js');
        let renamedEmitted = false;
        host.eventSource.on(host.event_types.CHAT_RENAMED, () => { renamedEmitted = true; });

        const result = await rename.renameCharacterChat('bob.png', 'chat-a', 'chat-z');

        assert.deepEqual(result, {
            renamed: true,
            reconciled: true,
            uncertain: true,
            reloadRequired: false,
            avatar: 'bob.png',
            oldFileName: 'chat-a',
            newFileName: 'chat-z',
            oldChatKey: chatKey('bob.png', 'chat-a'),
            newChatKey: chatKey('bob.png', 'chat-z'),
        });
        assert.equal(renamedEmitted, false,
            'the old name surviving alongside a new addition must never be reported a clean success');
    } finally {
        await host.dispose();
    }
});

test('a rename response with an unparseable body honestly reports unknown when the directory diff is ambiguous, without guessing a filename', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png', cardChatName: 'unrelated-chat' });

        const router = createRouter(host);
        router.queue('/api/characters/chats',
            rawListing('chat-a'),                  // pre-rename existence check
            rawListing('chat-x', 'chat-y'),         // forward-rename readback: two unrelated additions, chat-a gone
        );
        router.queue('/api/chats/rename', { ok: true, status: 200, json: async () => {
            throw new Error('malformed rename response body');
        } });

        const rename = await host.importModule('adapter/chats/rename-transaction.js');
        let renamedEmitted = false;
        host.eventSource.on(host.event_types.CHAT_RENAMED, () => { renamedEmitted = true; });

        const result = await rename.renameCharacterChat('bob.png', 'chat-a', 'chat-z');

        assert.deepEqual(result, {
            renamed: false,
            reconciled: false,
            uncertain: true,
            reloadRequired: false,
            avatar: 'bob.png',
            oldFileName: 'chat-a',
            newFileName: 'chat-z',
            oldChatKey: chatKey('bob.png', 'chat-a'),
            newChatKey: chatKey('bob.png', 'chat-z'),
        });
        assert.equal(router.callCount('/api/characters/chats'), 2,
            'a non-current rename must give up after its first ambiguous read, never retrying or guessing a winner');
        assert.equal(renamedEmitted, false);
    } finally {
        await host.dispose();
    }
});

// -----------------------------------------------------------------------
// Gap 3: persistCharacterChatSelection resolving 'different' (a concurrent
// writer won the character-card pointer before the rename could claim it).
// rename-transaction.ts documents two entirely different responses to this
// race depending on whether the chat being renamed is the live current chat:
// a non-current rename just follows the winner locally and still reports a
// clean success (the file move itself is not in question); a current-chat
// rename discards this branch's own verdict entirely and defers to
// reconcileCurrentRenameSafety, because only that function may safely touch
// the live message buffer's pointer.
// -----------------------------------------------------------------------

test('a non-current rename that loses the character-card pointer race still reports a clean success and follows the winner locally', async () => {
    const host = await createFakeStHost();
    try {
        // characterId is left unset: this rename never touches "the current chat".
        configureBaseHost(host, { avatar: 'bob.png', cardChatName: 'old-chat' });

        const router = createRouter(host);
        router.queue('/api/characters/chats',
            rawListing('old-chat'),  // pre-rename existence check
            rawListing('new-chat'),  // forward-rename readback: clean move
        );
        router.queue('/api/chats/rename', renameResponse('new-chat'));
        router.queue('/api/characters/merge-attributes', okJson({}));
        router.queue('/api/characters/get', pointerResponse('someone-elses-chat'));

        const rename = await host.importModule('adapter/chats/rename-transaction.js');
        let emittedPayload = null;
        host.eventSource.on(host.event_types.CHAT_RENAMED, payload => { emittedPayload = payload; });

        const result = await rename.renameCharacterChat('bob.png', 'old-chat', 'new-chat');

        assert.deepEqual(result, {
            renamed: true,
            reconciled: true,
            uncertain: false,
            reloadRequired: false,
            avatar: 'bob.png',
            oldFileName: 'old-chat',
            newFileName: 'new-chat',
            oldChatKey: chatKey('bob.png', 'old-chat'),
            newChatKey: chatKey('bob.png', 'new-chat'),
        });
        assert.deepEqual(emittedPayload, {
            avatarId: 'bob.png',
            groupId: null,
            oldFileName: 'old-chat.jsonl',
            newFileName: 'new-chat.jsonl',
        }, 'the file move itself is reported by its real names, independent of who won the pointer');
        assert.equal(host.context.characters[0].chat, 'someone-elses-chat',
            'the live card record must follow the winning pointer, not the renamed file');
    } finally {
        await host.dispose();
    }
});

test('a current-chat rename that loses the character-card pointer race defers entirely to reconcileCurrentRenameSafety, never acting on the race itself', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png', cardChatName: 'old-chat' });
        host.context.characterId = 0;
        host.registry.getCurrentChatDetails = () => ({ sessionName: 'old-chat.jsonl' });

        const router = createRouter(host);
        router.queue('/api/characters/chats',
            rawListing('old-chat'),  // pre-rename existence check
            rawListing('new-chat'),  // forward-rename readback: clean move
            rawListing('new-chat'),  // reconciliation: the live session file (old-chat) is gone
        );
        router.queue('/api/chats/rename', renameResponse('new-chat'));
        router.queue('/api/characters/merge-attributes', okJson({}));
        router.queue('/api/characters/get',
            pointerResponse('someone-elses-chat'), // initial pointer-persist readback: a winner already
            pointerResponse('new-chat'),            // reconciliation's own durable-pointer read: valid now
        );

        const rename = await host.importModule('adapter/chats/rename-transaction.js');
        let renamedEmitted = false;
        host.eventSource.on(host.event_types.CHAT_RENAMED, () => { renamedEmitted = true; });

        const result = await rename.renameCharacterChat('bob.png', 'old-chat', 'new-chat');

        assert.deepEqual(result, {
            renamed: true,
            reconciled: false,
            uncertain: true,
            reloadRequired: true,
            avatar: 'bob.png',
            oldFileName: 'old-chat',
            newFileName: 'new-chat',
            oldChatKey: chatKey('bob.png', 'old-chat'),
            newChatKey: chatKey('bob.png', 'new-chat'),
        });
        assert.equal(router.callCount('/api/characters/merge-attributes'), 1,
            'the current-chat branch must not itself attempt a second write once it lost the race; ' +
            'only reconcileCurrentRenameSafety may act further');
        assert.equal(host.context.characters[0].chat, 'old-chat.jsonl',
            'the live card record must stay untouched by this race; only a reload may safely apply a new pointer');
        assert.equal(renamedEmitted, false);
    } finally {
        await host.dispose();
    }
});

// -----------------------------------------------------------------------
// Gap 1: reconcileCurrentRenameSafety's convergence branches for when the
// live session file no longer appears in a *fresh* raw directory listing
// (a call this function always issues itself, never trusting what the
// forward rename already observed). It must fall back first to an
// already-valid durable pointer, then to locating identity by
// renamedFileName, then by oldFileName — and every one of those fallbacks
// must itself handle a concurrent pointer-alignment write losing honestly.
//
// Every test fixes cardChatName to a chat unrelated to the rename target so
// renameCharacterChat's own top-level pointer-persist block never fires,
// isolating coverage to reconcileCurrentRenameSafety's own retry loop.
// -----------------------------------------------------------------------

test('reconcileCurrentRenameSafety uses an already-valid durable pointer directly once the live session file is gone, without writing anything', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png', cardChatName: 'unrelated-chat' });
        host.context.characterId = 0;
        host.registry.getCurrentChatDetails = () => ({ sessionName: 'old-chat.jsonl' });

        const router = createRouter(host);
        router.queue('/api/characters/chats',
            rawListing('old-chat'), // pre-rename existence check
            rawListing('new-chat'), // forward-rename readback: clean move
            rawListing('new-chat'), // reconciliation's own fresh read: old-chat (live) is gone
        );
        router.queue('/api/chats/rename', renameResponse('new-chat'));
        router.queue('/api/characters/get', pointerResponse('new-chat')); // durable pointer already valid

        const rename = await host.importModule('adapter/chats/rename-transaction.js');
        let renamedEmitted = false;
        host.eventSource.on(host.event_types.CHAT_RENAMED, () => { renamedEmitted = true; });

        const result = await rename.renameCharacterChat('bob.png', 'old-chat', 'new-chat');

        assert.deepEqual(result, {
            renamed: true,
            reconciled: false,
            uncertain: true,
            reloadRequired: true,
            avatar: 'bob.png',
            oldFileName: 'old-chat',
            newFileName: 'new-chat',
            oldChatKey: chatKey('bob.png', 'old-chat'),
            newChatKey: chatKey('bob.png', 'new-chat'),
        });
        assert.equal(router.callCount('/api/characters/merge-attributes'), 0,
            'an already-valid durable pointer must be used as-is, never re-written');
        assert.equal(host.context.characters[0].chat, 'unrelated-chat.jsonl',
            'the live card record must be left untouched; only a reload may apply this pointer');
        assert.equal(renamedEmitted, false);
    } finally {
        await host.dispose();
    }
});

test('reconcileCurrentRenameSafety falls back to the renamed file when the live session file is gone and the durable pointer is stale, converging cleanly', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png', cardChatName: 'unrelated-chat' });
        host.context.characterId = 0;
        host.registry.getCurrentChatDetails = () => ({ sessionName: 'old-chat.jsonl' });

        const router = createRouter(host);
        router.queue('/api/characters/chats',
            rawListing('old-chat'), // pre-rename existence check
            rawListing('new-chat'), // forward-rename readback: clean move
            rawListing('new-chat'), // reconciliation's own fresh read: only the renamed file exists
        );
        router.queue('/api/chats/rename', renameResponse('new-chat'));
        router.queue('/api/characters/get',
            okJson({ chat: '' }),         // durable pointer read: empty/stale
            pointerResponse('new-chat'),  // alignment write readback: confirms the renamed file
        );
        router.queue('/api/characters/merge-attributes', okJson({}));

        const rename = await host.importModule('adapter/chats/rename-transaction.js');
        let emittedPayload = null;
        host.eventSource.on(host.event_types.CHAT_RENAMED, payload => { emittedPayload = payload; });

        const result = await rename.renameCharacterChat('bob.png', 'old-chat', 'new-chat');

        assert.deepEqual(result, {
            renamed: true,
            reconciled: true,
            uncertain: false,
            reloadRequired: false,
            avatar: 'bob.png',
            oldFileName: 'old-chat',
            newFileName: 'new-chat',
            oldChatKey: chatKey('bob.png', 'old-chat'),
            newChatKey: chatKey('bob.png', 'new-chat'),
        });
        assert.equal(router.callCount('/api/characters/merge-attributes'), 1,
            'the recovered identity must be persisted exactly once');
        assert.deepEqual(emittedPayload, {
            avatarId: 'bob.png',
            groupId: null,
            oldFileName: 'old-chat.jsonl',
            newFileName: 'new-chat.jsonl',
        });
    } finally {
        await host.dispose();
    }
});

test('reconcileCurrentRenameSafety falls back to the original file when neither the live session file nor the renamed file survives, and flags the mismatch as uncertain', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png', cardChatName: 'unrelated-chat' });
        host.context.characterId = 0;
        // The two pre-rename gating reads still see the chat being renamed;
        // reconciliation's own fresh read (3rd+ call) sees a live session
        // name that is neither oldFileName nor renamedFileName — the diff
        // recovery this branch exists for cares only about those two names,
        // never the live buffer's own (possibly stale) tracked name.
        let chatDetailsCalls = 0;
        host.registry.getCurrentChatDetails = () => {
            chatDetailsCalls += 1;
            return { sessionName: chatDetailsCalls <= 2 ? 'old-chat.jsonl' : 'ghost-session.jsonl' };
        };

        const router = createRouter(host);
        router.queue('/api/characters/chats',
            rawListing('old-chat'), // pre-rename existence check
            rawListing('new-chat'), // forward-rename readback: clean move
            rawListing('old-chat'), // reconciliation's own fresh read: the renamed file is gone too
        );
        router.queue('/api/chats/rename', renameResponse('new-chat'));
        router.queue('/api/characters/get',
            okJson({ chat: '' }),         // durable pointer read: empty/stale
            pointerResponse('old-chat'),  // alignment write readback: confirms the original file
        );
        router.queue('/api/characters/merge-attributes', okJson({}));

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
        assert.equal(router.callCount('/api/characters/merge-attributes'), 1,
            'the recovered identity must still be persisted even though it is not the rename target');
        assert.equal(renamedEmitted, false,
            'reconciling onto oldFileName instead of the rename target must never be reported a clean success');
    } finally {
        await host.dispose();
    }
});

test('reconcileCurrentRenameSafety reports uncertain and forces a reload when a concurrent write wins while recovering onto the renamed file', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png', cardChatName: 'unrelated-chat' });
        host.context.characterId = 0;
        host.registry.getCurrentChatDetails = () => ({ sessionName: 'old-chat.jsonl' });

        const router = createRouter(host);
        router.queue('/api/characters/chats',
            rawListing('old-chat'),                        // pre-rename existence check
            rawListing('new-chat'),                         // forward-rename readback: clean move
            rawListing('new-chat', 'someone-elses-chat'),    // reconciliation: a third file also exists
        );
        router.queue('/api/chats/rename', renameResponse('new-chat'));
        router.queue('/api/characters/get',
            okJson({ chat: '' }),                     // durable pointer read: empty/stale
            pointerResponse('someone-elses-chat'),     // alignment write readback: another writer won
        );
        router.queue('/api/characters/merge-attributes', okJson({}));

        const rename = await host.importModule('adapter/chats/rename-transaction.js');
        let renamedEmitted = false;
        host.eventSource.on(host.event_types.CHAT_RENAMED, () => { renamedEmitted = true; });

        const result = await rename.renameCharacterChat('bob.png', 'old-chat', 'new-chat');

        assert.deepEqual(result, {
            renamed: true,
            reconciled: false,
            uncertain: true,
            reloadRequired: true,
            avatar: 'bob.png',
            oldFileName: 'old-chat',
            newFileName: 'new-chat',
            oldChatKey: chatKey('bob.png', 'old-chat'),
            newChatKey: chatKey('bob.png', 'new-chat'),
        });
        assert.equal(router.callCount('/api/characters/merge-attributes'), 1,
            'a single alignment attempt must not be retried once a non-ambiguous concurrent winner is confirmed');
        assert.equal(renamedEmitted, false);
    } finally {
        await host.dispose();
    }
});

test('reconcileCurrentRenameSafety reports uncertain and forces a reload when a concurrent write wins while recovering onto the original file', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png', cardChatName: 'unrelated-chat' });
        host.context.characterId = 0;
        let chatDetailsCalls = 0;
        host.registry.getCurrentChatDetails = () => {
            chatDetailsCalls += 1;
            return { sessionName: chatDetailsCalls <= 2 ? 'old-chat.jsonl' : 'ghost-session.jsonl' };
        };

        const router = createRouter(host);
        router.queue('/api/characters/chats',
            rawListing('old-chat'),                        // pre-rename existence check
            rawListing('new-chat'),                         // forward-rename readback: clean move
            rawListing('old-chat', 'someone-elses-chat'),    // reconciliation: the renamed file is gone too
        );
        router.queue('/api/chats/rename', renameResponse('new-chat'));
        router.queue('/api/characters/get',
            okJson({ chat: '' }),                     // durable pointer read: empty/stale
            pointerResponse('someone-elses-chat'),     // alignment write readback: another writer won
        );
        router.queue('/api/characters/merge-attributes', okJson({}));

        const rename = await host.importModule('adapter/chats/rename-transaction.js');
        let renamedEmitted = false;
        host.eventSource.on(host.event_types.CHAT_RENAMED, () => { renamedEmitted = true; });

        const result = await rename.renameCharacterChat('bob.png', 'old-chat', 'new-chat');

        assert.deepEqual(result, {
            renamed: true,
            reconciled: false,
            uncertain: true,
            reloadRequired: true,
            avatar: 'bob.png',
            oldFileName: 'old-chat',
            newFileName: 'new-chat',
            oldChatKey: chatKey('bob.png', 'old-chat'),
            newChatKey: chatKey('bob.png', 'new-chat'),
        });
        assert.equal(router.callCount('/api/characters/merge-attributes'), 1);
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
        const unchanged = {
            deleted: false,
            reconciled: true,
            uncertain: false,
            reloadRequired: false,
            absent: false,
            fallbackChatFileName: null,
        };

        assert.deepEqual(await del.deleteCharacterChat('', 'chat-a'), unchanged);
        assert.deepEqual(await del.deleteCharacterChat('bob.png', ''), unchanged);
        assert.equal(host.fetch.calls.length, 0);
    } finally {
        await host.dispose();
    }
});

test('deleting a chat absent from the raw directory listing reports it as absent after one existence check, without issuing the destructive request', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png', cardChatName: 'other-chat' });
        const router = createRouter(host);
        router.queue('/api/characters/chats', rawListing('chat-a', 'chat-b'));

        const del = await host.importModule('adapter/chats/delete-transaction.js');
        const result = await del.deleteCharacterChat('bob.png', 'ghost-chat');

        assert.deepEqual(result, {
            deleted: false,
            reconciled: true,
            uncertain: false,
            reloadRequired: false,
            // Not just "nothing happened": the caller may still be holding a
            // quarantine lease for this file, and discarding a draft *is* this
            // call — reported as a plain failure, that lease could never be
            // dropped and its card stayed on the shelf forever.
            absent: true,
            fallbackChatFileName: null,
        });
        assert.equal(host.fetch.calls.length, 1, 'must not call /api/chats/delete for a file that was never listed');
    } finally {
        await host.dispose();
    }
});

// The other half of what `absent` means. A quarantined draft that ST has not
// written yet is a conversation with no file, and it is *live*: the next
// saveChatConditional() — a message, a swipe, walking away — puts the file
// back. Reported as absence, the caller settles it like a real deletion and
// drops the quarantine lease, so the file ST re-materializes a moment later is
// permanent history nobody is holding, which is exactly the outcome the draft
// quarantine exists to prevent.
test('a missing file that is still the live chat is not absence: the conversation is alive and unsaved, so the lease must survive', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png', cardChatName: 'ghost-chat' });
        host.context.characterId = 0;
        host.registry.getCurrentChatDetails = () => ({ sessionName: 'ghost-chat.jsonl' });
        const router = createRouter(host);
        router.queue('/api/characters/chats', rawListing('chat-a', 'chat-b'));

        const del = await host.importModule('adapter/chats/delete-transaction.js');
        const result = await del.deleteCharacterChat('bob.png', 'ghost-chat');

        assert.deepEqual(result, {
            deleted: false,
            reconciled: true,
            uncertain: false,
            reloadRequired: false,
            absent: false,
            fallbackChatFileName: null,
        });
        assert.equal(host.fetch.calls.length, 1, 'still no destructive request for a file that was never listed');
    } finally {
        await host.dispose();
    }
});

test('a directory listing that could not be read is never reported as absence', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png', cardChatName: 'other-chat' });
        host.fetch.setHandler(() => {
            throw new Error('network down');
        });

        const del = await host.importModule('adapter/chats/delete-transaction.js');
        const result = await del.deleteCharacterChat('bob.png', 'chat-a');

        assert.deepEqual(result, {
            deleted: false,
            reconciled: true,
            uncertain: false,
            reloadRequired: false,
            // An unreadable directory says nothing about what is in it. Calling
            // this absence would drop a quarantine lease that is still holding
            // a real file — the exact leak the quarantine exists to prevent.
            absent: false,
            fallbackChatFileName: null,
        });
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

        assert.deepEqual(result, { deleted: true, reconciled: true, uncertain: false, reloadRequired: false, absent: false, fallbackChatFileName: null });
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

        assert.deepEqual(result, { deleted: true, reconciled: true, uncertain: false, reloadRequired: false, absent: false, fallbackChatFileName: null });
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

        assert.deepEqual(result, { deleted: false, reconciled: true, uncertain: false, reloadRequired: false, absent: false, fallbackChatFileName: null });
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

        assert.deepEqual(result, { deleted: true, reconciled: true, uncertain: false, reloadRequired: true, absent: false, fallbackChatFileName: null });
        assert.equal(deletedEmitted, false,
            'a current-chat delete must never emit into the stale current-chat runtime; the caller reloads instead');
    } finally {
        await host.dispose();
    }
});

// DESIGN §3 / evaluation §5 3.6: deleting a character's *only* chat must
// never leave it selected with nothing to fall back to. There is no real
// file left to rank as a replacement, so the durable pointer is moved to the
// fabricated `fallbackName` (character name + humanizedDateTime()) instead —
// `fallbackChatFileName` on the result is how the caller (sidebar-actions.ts)
// finds out this happened, so it can quarantine whatever ST's reload boot
// materializes there as a draft instead of a permanent history entry.
test("deleting a character's only remaining chat persists a fabricated fallback pointer and reports it back for draft quarantine", async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png', cardChatName: 'chat-a', characterName: 'Bob' });
        host.context.characterId = 0;
        host.registry.getCurrentChatDetails = () => ({ sessionName: 'chat-a.jsonl' });

        const router = createRouter(host);
        router.queue('/api/characters/chats', rawListing('chat-a'), rawListing());
        router.queue('/api/chats/search', okJson([]));
        router.queue('/api/characters/merge-attributes', okJson({}));
        router.queue('/api/characters/get', pointerResponse('Bob - 2026-01-01 @00h00'));
        router.queue('/api/chats/delete', { ok: true });

        const del = await host.importModule('adapter/chats/delete-transaction.js');
        const result = await del.deleteCharacterChat('bob.png', 'chat-a');

        assert.deepEqual(result, {
            deleted: true,
            reconciled: true,
            uncertain: false,
            reloadRequired: true,
            absent: false,
            fallbackChatFileName: 'Bob - 2026-01-01 @00h00',
        });
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

        assert.deepEqual(result, { deleted: false, reconciled: false, uncertain: true, reloadRequired: true, absent: false, fallbackChatFileName: null });
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

// -----------------------------------------------------------------------
// Gap 3: persistCharacterChatSelection resolving 'different' (a concurrent
// writer won the character-card pointer before deleteCharacterChat could
// claim it). delete-transaction.ts documents two entirely different
// responses depending on whether the deleted chat is the live current chat:
// deleting the current chat abandons the whole operation immediately and
// requires a reload (the destructive DELETE must never fire once the
// pointer race is lost, per its own doc comment); deleting a non-current
// chat just follows the winner locally and safely proceeds with DELETE,
// because no live message buffer is at risk.
// -----------------------------------------------------------------------

test('deleting the current chat abandons the operation and requires a reload when a concurrent writer wins the pointer race, never issuing the destructive request', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png', cardChatName: 'chat-a' });
        host.context.characterId = 0;
        host.registry.getCurrentChatDetails = () => ({ sessionName: 'chat-a.jsonl' });

        const router = createRouter(host);
        router.queue('/api/characters/chats', rawListing('chat-a', 'chat-b'));
        router.queue('/api/chats/search', okJson([]));
        router.queue('/api/characters/merge-attributes', okJson({}));
        router.queue('/api/characters/get', pointerResponse('someone-elses-chat'));

        const del = await host.importModule('adapter/chats/delete-transaction.js');
        let deletedEmitted = false;
        host.eventSource.on(host.event_types.CHAT_DELETED, () => { deletedEmitted = true; });

        const result = await del.deleteCharacterChat('bob.png', 'chat-a');

        assert.deepEqual(result, { deleted: false, reconciled: false, uncertain: true, reloadRequired: true, absent: false, fallbackChatFileName: null });
        assert.equal(router.callCount('/api/chats/delete'), 0,
            'losing the pointer race must abandon the deletion before the destructive request is ever sent');
        assert.equal(host.context.characters[0].chat, 'chat-a.jsonl',
            'the live card record must be left untouched; only a reload may safely resolve the winning pointer');
        assert.equal(deletedEmitted, false);
    } finally {
        await host.dispose();
    }
});

test('deleting a non-current chat that loses the character-card pointer race still safely proceeds with the destructive request and follows the winner locally', async () => {
    const host = await createFakeStHost();
    try {
        // characterId is left unset: this delete never touches "the current chat".
        configureBaseHost(host, { avatar: 'bob.png', cardChatName: 'chat-a' });

        const router = createRouter(host);
        router.queue('/api/characters/chats',
            rawListing('chat-a', 'chat-b'), // pre-delete existence check
            rawListing('chat-b'),            // post-delete existence poll: chat-a confirmed gone
        );
        router.queue('/api/chats/search', okJson([]));
        router.queue('/api/characters/merge-attributes', okJson({}));
        router.queue('/api/characters/get', pointerResponse('someone-elses-chat'));
        router.queue('/api/chats/delete', { ok: true });

        const del = await host.importModule('adapter/chats/delete-transaction.js');
        let deletedPayload;
        host.eventSource.on(host.event_types.CHAT_DELETED, payload => { deletedPayload = payload; });

        const result = await del.deleteCharacterChat('bob.png', 'chat-a');

        assert.deepEqual(result, { deleted: true, reconciled: true, uncertain: false, reloadRequired: false, absent: false, fallbackChatFileName: null });
        assert.equal(deletedPayload, 'chat-a',
            'the file is still safely removed by its real name, independent of who won the pointer');
        assert.equal(host.context.characters[0].chat, 'someone-elses-chat',
            'the live card record must follow the winning pointer, not the replacement candidate');
    } finally {
        await host.dispose();
    }
});

// -----------------------------------------------------------------------
// Gap 2: deleting the current chat must never let the destructive DELETE
// cross the await gap between "the replacement pointer is durably
// persisted" and "the request is actually sent" while generation or chat
// saving starts in that window. deleteCharacterChat's own doc comment
// requires rolling the pointer back to the original file and abandoning
// the delete entirely — this is the one client-side path that cannot
// otherwise guard against writing the target's in-flight messages into the
// replacement chat after an await-time state change.
// -----------------------------------------------------------------------

test('deleting the current chat rolls the pointer back and abandons the delete when generation starts in the gap between persisting the replacement and issuing DELETE', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png', cardChatName: 'chat-a' });
        host.context.characterId = 0;
        host.registry.getCurrentChatDetails = () => ({ sessionName: 'chat-a.jsonl' });

        // false for the pre-persist gate, true from then on — isGenerating()
        // is called exactly twice on this path (the early gate, then the
        // post-persist re-check), so this deterministically simulates
        // generation starting in the await gap between them, without any
        // reliance on timing.
        let isGeneratingCalls = 0;
        host.registry.isGenerating = () => {
            isGeneratingCalls += 1;
            return isGeneratingCalls > 1;
        };

        const router = createRouter(host);
        router.queue('/api/characters/chats', rawListing('chat-a', 'chat-b'));
        router.queue('/api/chats/search', okJson([]));
        router.queue('/api/characters/merge-attributes', okJson({}), okJson({}));
        router.queue('/api/characters/get', pointerResponse('chat-b'), pointerResponse('chat-a'));

        const del = await host.importModule('adapter/chats/delete-transaction.js');
        let deletedEmitted = false;
        host.eventSource.on(host.event_types.CHAT_DELETED, () => { deletedEmitted = true; });

        const result = await del.deleteCharacterChat('bob.png', 'chat-a');

        assert.deepEqual(result, { deleted: false, reconciled: true, uncertain: false, reloadRequired: false, absent: false, fallbackChatFileName: null });
        assert.equal(router.callCount('/api/chats/delete'), 0,
            'generation starting in the await gap must abandon the delete before the destructive request is sent');
        assert.equal(router.callCount('/api/characters/merge-attributes'), 2,
            'the replacement pointer write must be followed by exactly one rollback write back to the original file');
        assert.equal(isGeneratingCalls, 2);
        assert.equal(deletedEmitted, false);
    } finally {
        await host.dispose();
    }
});

test('deleting the current chat rolls the pointer back and abandons the delete when chat saving begins in the gap between persisting the replacement and issuing DELETE', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png', cardChatName: 'chat-a' });
        host.context.characterId = 0;
        host.registry.getCurrentChatDetails = () => ({ sessionName: 'chat-a.jsonl' });
        host.registry.isGenerating = () => false;

        const router = createRouter(host);
        router.queue('/api/characters/chats', rawListing('chat-a', 'chat-b'));
        router.queue('/api/chats/search', okJson([]));
        // The initial replacement-pointer write's response is the trigger:
        // by the time it resolves, chat saving has begun — modeling a save
        // starting concurrently with (not caused by) the pointer write,
        // strictly inside the await gap the destructive DELETE must never
        // cross.
        router.queue('/api/characters/merge-attributes',
            () => { host.state.setChatSaving(true); return okJson({}); },
            okJson({}),
        );
        router.queue('/api/characters/get', pointerResponse('chat-b'), pointerResponse('chat-a'));

        const del = await host.importModule('adapter/chats/delete-transaction.js');
        let deletedEmitted = false;
        host.eventSource.on(host.event_types.CHAT_DELETED, () => { deletedEmitted = true; });

        const result = await del.deleteCharacterChat('bob.png', 'chat-a');

        assert.deepEqual(result, { deleted: false, reconciled: true, uncertain: false, reloadRequired: false, absent: false, fallbackChatFileName: null });
        assert.equal(router.callCount('/api/chats/delete'), 0,
            'chat saving beginning in the await gap must abandon the delete before the destructive request is sent');
        assert.equal(router.callCount('/api/characters/merge-attributes'), 2,
            'the replacement pointer write must be followed by exactly one rollback write back to the original file');
        assert.equal(deletedEmitted, false);
    } finally {
        await host.dispose();
        host.state.setChatSaving(false);
    }
});
// =======================================================================
// deletion-finalization.js — the draft-quarantine handoff
// (queueCharacterChatDraftQuarantine / armPendingCharacterChatDraftQuarantine
// / resolvePendingCharacterChatDraftQuarantine).
//
// sidebar-actions.ts queues this tombstone right before the mandatory reload
// that follows deleting a character's last chat (delete-transaction.js's
// `fallbackChatFileName`). Nothing in this trio touches the temp-chat
// quarantine store directly (that would violate the adapter/store layering
// boundary) — it arms the intent for one page load and then, whenever asked,
// reports whether the fabricated fallback name is the live current chat *now*,
// handing the bare pointer back for sidebar-actions.ts to commit.
//
// The timing these tests reproduce is the real one, and it is the reason this
// handoff was rewritten: ST materializes the fallback file on a chain APP_READY
// does not wait for, so at the moment ChatUI boots, that file is neither on
// disk nor the live chat yet. Every test below therefore starts from "the
// character's current chat is not ours" and only then lets ST's boot land —
// the shape the previous implementation could not survive, because it read the
// chat directory once at APP_READY and destroyed the tombstone when (always)
// the file was not there yet. `host.fetch.calls.length` is asserted throughout:
// this handoff must now make no request at all. Note what the remaining check
// does and does not prove — on a CHAT_CHANGED the file really is saved
// (getChatResult() awaits saveChatConditional() before emitting), but the
// immediate check reads the durable pointer ChatUI itself wrote, so it is an
// identity check and the file follows ~142ms later (deletion-finalization.ts's
// section comment records the window and why it is accepted). Each assertion
// also checks host.sessionStorage.length as a black-box proxy for "is the
// tombstone still queued" — this module owns exactly one sessionStorage key,
// so nothing else in these tests touches it.
// =======================================================================

/** ST's boot landing on a character's chat: what getCurrentChatIdentity() reads. */
function liveChat(host, { characterId = 0, sessionName }) {
    host.context.characterId = characterId;
    host.registry.getCurrentChatDetails = () => ({ sessionName });
}

test('armPendingCharacterChatDraftQuarantine resolves null and touches nothing when no tombstone was queued', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png' });
        const finalization = await host.importModule('adapter/chats/deletion-finalization.js');

        const result = finalization.armPendingCharacterChatDraftQuarantine();

        assert.equal(result, null);
        assert.equal(host.fetch.calls.length, 0);
        assert.equal(host.sessionStorage.length, 0);
    } finally {
        await host.dispose();
    }
});

test('queueCharacterChatDraftQuarantine with a missing avatar or filename is a no-op', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png' });
        const finalization = await host.importModule('adapter/chats/deletion-finalization.js');

        finalization.queueCharacterChatDraftQuarantine('', 'fallback-chat');
        finalization.queueCharacterChatDraftQuarantine('bob.png', '');

        assert.equal(host.sessionStorage.length, 0);
    } finally {
        await host.dispose();
    }
});

test('the draft-quarantine tombstone waits through the boot in which ST has not yet loaded the fallback file, then resolves the moment it becomes the live chat — without ever reading the chat directory', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png' });
        const finalization = await host.importModule('adapter/chats/deletion-finalization.js');

        finalization.queueCharacterChatDraftQuarantine('bob.png', 'Bob - 2026-01-01 @00h00');
        assert.equal(host.sessionStorage.length, 1, 'queueing must persist the tombstone immediately');

        // The real boot: ChatUI's APP_READY handler runs while ST's
        // fire-and-forget autoload chain is still in flight, so no character
        // chat is live yet and the fallback file is not on the server either.
        liveChat(host, { characterId: undefined, sessionName: '' });

        assert.deepEqual(
            finalization.armPendingCharacterChatDraftQuarantine(),
            { avatar: 'bob.png', fileName: 'Bob - 2026-01-01 @00h00' },
            'the first boot after the delete owns this intent',
        );
        assert.deepEqual(
            finalization.resolvePendingCharacterChatDraftQuarantine(),
            { status: 'waiting' },
            'the fallback file is not live yet — this is not the moment, and the intent must survive it',
        );
        assert.equal(host.sessionStorage.length, 1);

        // ST's autoload finishes: getChatResult() saved the file and only then
        // emitted CHAT_CHANGED, which is when this gets asked again.
        liveChat(host, { characterId: 0, sessionName: 'Bob - 2026-01-01 @00h00.jsonl' });

        assert.deepEqual(
            finalization.resolvePendingCharacterChatDraftQuarantine(),
            { status: 'quarantine', pointer: { avatar: 'bob.png', fileName: 'Bob - 2026-01-01 @00h00' } },
        );
        assert.equal(host.sessionStorage.length, 0,
            'a consumed tombstone must not linger for a later boot to misfire on');
        assert.deepEqual(
            finalization.resolvePendingCharacterChatDraftQuarantine(),
            { status: 'settled' },
            're-entry after the commit must report there is nothing left to watch for',
        );
        assert.equal(host.fetch.calls.length, 0,
            'the whole handoff must be request-free: the file being live already implies it is saved');
    } finally {
        await host.dispose();
    }
});

test('the draft-quarantine tombstone keeps waiting while an unrelated chat holds the live slot, and never quarantines it', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png' });
        const finalization = await host.importModule('adapter/chats/deletion-finalization.js');

        finalization.queueCharacterChatDraftQuarantine('bob.png', 'Bob - 2026-01-01 @00h00');
        finalization.armPendingCharacterChatDraftQuarantine();

        // Whoever ST's boot came back on this time, it is not our fallback
        // file: a different chat of the same character…
        liveChat(host, { characterId: 0, sessionName: 'chat-elsewhere.jsonl' });
        assert.deepEqual(finalization.resolvePendingCharacterChatDraftQuarantine(), { status: 'waiting' });
        assert.equal(host.sessionStorage.length, 1);

        // …and then another character entirely.
        host.context.characters = [
            { avatar: 'bob.png', name: 'Bob', chat: 'chat-elsewhere.jsonl' },
            { avatar: 'ann.png', name: 'Ann', chat: 'Bob - 2026-01-01 @00h00.jsonl' },
        ];
        liveChat(host, { characterId: 1, sessionName: 'Bob - 2026-01-01 @00h00.jsonl' });
        assert.deepEqual(
            finalization.resolvePendingCharacterChatDraftQuarantine(),
            { status: 'waiting' },
            'a same-named file under a different character is a different file and must never be adopted',
        );
        assert.equal(host.sessionStorage.length, 1,
            'the intent outlives a boot that landed elsewhere: the fallback file may still go live later');

        // The reader finally opens the character the delete emptied.
        liveChat(host, { characterId: 0, sessionName: 'Bob - 2026-01-01 @00h00.jsonl' });
        assert.deepEqual(
            finalization.resolvePendingCharacterChatDraftQuarantine(),
            { status: 'quarantine', pointer: { avatar: 'bob.png', fileName: 'Bob - 2026-01-01 @00h00' } },
        );
        assert.equal(host.fetch.calls.length, 0);
    } finally {
        await host.dispose();
    }
});

test('a draft-quarantine tombstone the previous page load already armed is expired by the next boot instead of dangling', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png' });
        const finalization = await host.importModule('adapter/chats/deletion-finalization.js');

        finalization.queueCharacterChatDraftQuarantine('bob.png', 'Bob - 2026-01-01 @00h00');
        assert.ok(finalization.armPendingCharacterChatDraftQuarantine(), 'boot 1 claims the intent');
        liveChat(host, { characterId: 0, sessionName: 'chat-elsewhere.jsonl' });
        assert.deepEqual(finalization.resolvePendingCharacterChatDraftQuarantine(), { status: 'waiting' });
        assert.equal(host.sessionStorage.length, 1, 'boot 1 ends with the intent still queued');

        // Boot 2 — the reader reloaded again without ever landing on the
        // fallback file. By now that file has been listed as ordinary history
        // for a whole page load; adopting it retroactively would be a surprise.
        assert.equal(finalization.armPendingCharacterChatDraftQuarantine(), null);
        assert.equal(host.sessionStorage.length, 0, 'the expired intent must not survive into a third boot');
        assert.deepEqual(finalization.resolvePendingCharacterChatDraftQuarantine(), { status: 'settled' });
        assert.equal(host.fetch.calls.length, 0);
    } finally {
        await host.dispose();
    }
});

test('resolvePendingCharacterChatDraftQuarantine reports settled without reading the live chat when no tombstone is queued', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png' });
        // Left unconfigured on purpose: a settled tombstone must short-circuit
        // before it can call this at all (the stub throws if it does).
        host.registry.getCurrentChatDetails = () => {
            throw new Error('getCurrentChatDetails must not be consulted with nothing queued');
        };
        const finalization = await host.importModule('adapter/chats/deletion-finalization.js');

        assert.deepEqual(finalization.resolvePendingCharacterChatDraftQuarantine(), { status: 'settled' });
        assert.equal(host.fetch.calls.length, 0);
        assert.equal(host.sessionStorage.length, 0);
    } finally {
        await host.dispose();
    }
});

// =======================================================================
// navigation.js — persisting ST's own "who is selected" state
//
// selectCharacterById() moves only the live selection; the `active_character`
// ST reads back on the next boot is written exclusively by its delegated
// .character_select click handler (RossAscends-mods.js:849-854), which no
// ChatUI path goes through. With the spine as the only way to change
// character, that left every reload — including the mandatory one a
// current-chat delete forces — coming back on whoever the reader last picked
// from ST's native list. See adapter/chats/navigation.ts's
// persistStActiveCharacter for why the live index (not the avatar) is what
// gets handed to setActiveCharacter.
// =======================================================================

/**
 * Record the exact setActiveCharacter/setActiveGroup/save call sequence.
 *
 * `setActiveCharacter` records what ST would actually *persist*, not what it
 * was handed: ST resolves the key behind a truthiness gate
 * (`active_character = entityOrKey ? getTagKeyForEntity(entityOrKey) : null`,
 * script.js:834-837), so a falsy key persists `null`. A stub that recorded the
 * raw argument would happily accept the number `0` — the first character in
 * the list — and report a persist that never happened.
 */
function recordActiveSelection(host) {
    const calls = [];
    host.registry.setActiveCharacter = (value) => calls.push([
        'setActiveCharacter',
        value ? String(value) : null,
    ]);
    host.registry.setActiveGroup = (value) => calls.push(['setActiveGroup', value]);
    host.registry.saveSettingsDebounced = () => calls.push(['saveSettingsDebounced']);
    return calls;
}

test('switchCharacter persists the character it just selected as ST\'s active character, mirroring the native list click', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png' });
        host.context.characters = [
            { avatar: 'ann.png', name: 'Ann', chat: 'ann-chat.jsonl' },
            { avatar: 'bob.png', name: 'Bob', chat: 'bob-chat.jsonl' },
        ];
        host.context.characterId = 0;
        const calls = recordActiveSelection(host);
        host.registry.selectCharacterById = (index) => {
            host.context.characterId = index;
        };

        const navigation = await host.importModule('adapter/chats/navigation.js');
        const result = await navigation.switchCharacter('bob.png');

        assert.equal(result, 'ok');
        assert.deepEqual(calls, [
            // The live index, never the avatar string: getTagKeyForEntity()
            // runs a string through parseInt() first, so an avatar like
            // "3.png" would resolve to a different card.
            ['setActiveCharacter', '1'],
            // A character selection must also retire any persisted group, or
            // ST's boot finds both set and drops the character.
            ['setActiveGroup', null],
            ['saveSettingsDebounced'],
        ]);
    } finally {
        await host.dispose();
    }
});

test('the first character in the list persists like any other, even though its index is the one value ST would treat as "no character"', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'ann.png' });
        // Ann is characters[0] — the position every list has and ST's own
        // handler only survives because a DOM attribute is always a string.
        host.context.characters = [
            { avatar: 'ann.png', name: 'Ann', chat: 'ann-chat.jsonl' },
            { avatar: 'bob.png', name: 'Bob', chat: 'bob-chat.jsonl' },
        ];
        host.context.characterId = 1;
        const calls = recordActiveSelection(host);
        host.registry.selectCharacterById = (index) => {
            host.context.characterId = index;
        };

        const navigation = await host.importModule('adapter/chats/navigation.js');

        assert.equal(await navigation.switchCharacter('ann.png'), 'ok');
        assert.deepEqual(calls, [
            // Not the number 0: setActiveCharacter resolves the key behind
            // `entityOrKey ? … : null`, so a falsy index would persist "no
            // character at all" and the next boot would skip RA_autoloadchat's
            // whole branch — landing the reader nowhere, which is worse than
            // the stale pointer this write exists to fix.
            ['setActiveCharacter', '0'],
            ['setActiveGroup', null],
            ['saveSettingsDebounced'],
        ]);
    } finally {
        await host.dispose();
    }
});

test('a character switch that does not land persists nothing, so a reload never comes back on a character ChatUI failed to select', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png' });
        host.context.characters = [
            { avatar: 'ann.png', name: 'Ann', chat: 'ann-chat.jsonl' },
            { avatar: 'bob.png', name: 'Bob', chat: 'bob-chat.jsonl' },
        ];
        host.context.characterId = 0;
        const calls = recordActiveSelection(host);
        // ST refused the switch (busy saving, a concurrent navigation won):
        // the live selection never moved.
        host.registry.selectCharacterById = () => {};

        const navigation = await host.importModule('adapter/chats/navigation.js');

        assert.equal(await navigation.switchCharacter('bob.png'), 'busy');
        assert.deepEqual(calls, []);
        assert.equal(await navigation.switchCharacter('nobody.png'), 'notfound');
        assert.deepEqual(calls, []);
    } finally {
        await host.dispose();
    }
});

test('opening another character\'s conversation persists that character too, and rolls back without persisting when the switch is refused', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png' });
        host.context.characters = [
            { avatar: 'ann.png', name: 'Ann', chat: 'ann-chat.jsonl' },
            { avatar: 'bob.png', name: 'Bob', chat: 'bob-chat.jsonl' },
        ];
        host.context.characterId = 0;
        const calls = recordActiveSelection(host);
        host.registry.createOrEditCharacter = async () => {};
        host.registry.getCurrentChatDetails = () => ({
            sessionName: host.context.characters[Number(host.context.characterId)]?.chat ?? '',
        });
        // First attempt: ST does not move the selection at all.
        host.registry.selectCharacterById = () => {};

        const navigation = await host.importModule('adapter/chats/navigation.js');

        assert.equal(await navigation.openChatForCharacter('bob.png', 'bob-night-two'), 'busy');
        assert.deepEqual(calls, [], 'a refused switch must leave the persisted character alone');

        host.registry.selectCharacterById = (index) => {
            host.context.characterId = index;
        };
        assert.equal(await navigation.openChatForCharacter('bob.png', 'bob-night-two'), 'ok');
        assert.deepEqual(calls, [
            ['setActiveCharacter', '1'],
            ['setActiveGroup', null],
            ['saveSettingsDebounced'],
        ]);
    } finally {
        await host.dispose();
    }
});

test('a failure to persist the active character never fails the switch the reader asked for', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png' });
        host.context.characters = [
            { avatar: 'ann.png', name: 'Ann', chat: 'ann-chat.jsonl' },
            { avatar: 'bob.png', name: 'Bob', chat: 'bob-chat.jsonl' },
        ];
        host.context.characterId = 0;
        host.registry.setActiveCharacter = () => {
            throw new Error('settings module exploded');
        };
        host.registry.selectCharacterById = (index) => {
            host.context.characterId = index;
        };

        const navigation = await host.importModule('adapter/chats/navigation.js');

        assert.equal(await navigation.switchCharacter('bob.png'), 'ok');
        assert.equal(String(host.context.characterId), '1', 'the switch itself still happened');
    } finally {
        await host.dispose();
    }
});

// =======================================================================
// navigation.js — finishing a delete transaction on a host that came back
// on nobody
//
// `power_user.auto_load_chat` is false by default (power-user.js:335) and this
// repo's e2e fixture forces it true (scripts/e2e/generate-data-root.mjs), so
// the reload a current-chat delete forces answers with an *empty stage* on a
// stock install: ST selects no character, never writes the fallback file, and
// the draft-quarantine credential waits for a signal that will never come.
// selectCharacterIfNobodyIsOnStage is the closing move of that transaction —
// and its refusal is the part that keeps it from being a preference override,
// so both halves are pinned here.
// =======================================================================

test('a pending chat transaction lands on its character when ST\'s boot chose nobody, persisting the selection like any other landing', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png' });
        host.context.characters = [
            { avatar: 'ann.png', name: 'Ann', chat: 'ann-chat.jsonl' },
            { avatar: 'bob.png', name: 'Bob', chat: 'bob-chat.jsonl' },
        ];
        // The stock no-autoload boot: nothing selected at all.
        host.context.characterId = undefined;
        host.context.groupId = undefined;
        const calls = recordActiveSelection(host);
        host.registry.selectCharacterById = (index) => {
            host.context.characterId = index;
        };

        const navigation = await host.importModule('adapter/chats/navigation.js');

        assert.equal(await navigation.selectCharacterIfNobodyIsOnStage('bob.png'), 'selected');
        assert.equal(String(host.context.characterId), '1');
        assert.deepEqual(calls, [
            ['setActiveCharacter', '1'],
            ['setActiveGroup', null],
            ['saveSettingsDebounced'],
        ], 'a landing that happened is persisted exactly like a reader-driven switch');
    } finally {
        await host.dispose();
    }
});

test('a pending chat transaction never steals a stage somebody already holds — not a character ST autoloaded, not a group', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png' });
        host.context.characters = [
            { avatar: 'ann.png', name: 'Ann', chat: 'ann-chat.jsonl' },
            { avatar: 'bob.png', name: 'Bob', chat: 'bob-chat.jsonl' },
        ];
        const calls = recordActiveSelection(host);
        host.registry.selectCharacterById = () => {
            throw new Error('a stage that is already held must never be taken');
        };

        const navigation = await host.importModule('adapter/chats/navigation.js');

        // The reader's own auto_load_chat setting brought a character back.
        host.context.characterId = 0;
        host.context.groupId = undefined;
        assert.equal(await navigation.selectCharacterIfNobodyIsOnStage('bob.png'), 'occupied');
        assert.equal(String(host.context.characterId), '0', 'the autoloaded character keeps the stage');

        // Even index 0's falsy-looking id counts as "somebody is here"; and a
        // group holds the stage just as much as a character does.
        host.context.characterId = undefined;
        host.context.groupId = 'group-1';
        assert.equal(await navigation.selectCharacterIfNobodyIsOnStage('bob.png'), 'occupied');

        assert.deepEqual(calls, [], 'and nothing was persisted on either refusal');
    } finally {
        await host.dispose();
    }
});

test('a pending chat transaction whose character is gone, or whose selection ST refuses, reports it and persists nothing', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png' });
        host.context.characters = [
            { avatar: 'ann.png', name: 'Ann', chat: 'ann-chat.jsonl' },
        ];
        host.context.characterId = undefined;
        host.context.groupId = undefined;
        const calls = recordActiveSelection(host);
        host.registry.selectCharacterById = () => {
            // ST returns silently while a chat is saving — the live selection
            // simply does not move.
        };

        const navigation = await host.importModule('adapter/chats/navigation.js');

        assert.equal(await navigation.selectCharacterIfNobodyIsOnStage('bob.png'), 'notfound',
            'the card was deleted between the two page loads: an honest absence, not a retryable failure');
        assert.equal(await navigation.selectCharacterIfNobodyIsOnStage(''), 'notfound');

        assert.equal(await navigation.selectCharacterIfNobodyIsOnStage('ann.png'), 'refused',
            'a selection that did not land must be reported as such, never assumed');
        assert.deepEqual(calls, [], 'never persist a character ChatUI failed to select');
    } finally {
        await host.dispose();
    }
});

test('peekPendingCharacterChatDraftQuarantine reports who a waiting credential is about without arming or consuming it', async () => {
    const host = await createFakeStHost();
    try {
        configureBaseHost(host, { avatar: 'bob.png' });
        const finalization = await host.importModule('adapter/chats/deletion-finalization.js');

        assert.equal(finalization.peekPendingCharacterChatDraftQuarantine(), null,
            'nothing queued, nothing to report');

        finalization.queueCharacterChatDraftQuarantine('bob.png', 'Bob - 2026-01-01 @00h00');
        const queued = { avatar: 'bob.png', fileName: 'Bob - 2026-01-01 @00h00' };

        // Before the reload the credential is not armed yet, and the answer to
        // "who is this about" is the same in both states.
        assert.deepEqual(finalization.peekPendingCharacterChatDraftQuarantine(), queued);
        assert.deepEqual(
            finalization.armPendingCharacterChatDraftQuarantine(),
            queued,
            'peeking must not have claimed the credential for a page load of its own',
        );
        assert.deepEqual(finalization.peekPendingCharacterChatDraftQuarantine(), queued);
        assert.deepEqual(
            finalization.resolvePendingCharacterChatDraftQuarantine(),
            { status: 'waiting' },
            'nor consumed it: the fallback file is still not the live chat',
        );

        liveChat(host, { characterId: 0, sessionName: 'Bob - 2026-01-01 @00h00.jsonl' });
        assert.deepEqual(
            finalization.resolvePendingCharacterChatDraftQuarantine(),
            { status: 'quarantine', pointer: queued },
        );
        assert.equal(finalization.peekPendingCharacterChatDraftQuarantine(), null,
            'once the credential is consumed there is nobody left to report');
        assert.equal(host.fetch.calls.length, 0);
    } finally {
        await host.dispose();
    }
});
