// test/sidebar-actions.test.mjs
//
// Covers dist/runtime/store/sidebar-actions.js's own orchestration on top of
// the chat adapter — specifically the draft-quarantine handoff added for
// DESIGN §3 / evaluation §5 3.6 ("delete a character's only chat -> land on
// a recoverable draft, never on a bare 'character selected, no conversation'
// state"). adapter-chats.test.mjs already covers the adapter-layer pieces
// (delete-transaction.js's fallbackChatFileName, deletion-finalization.js's
// queue/take pair) in isolation; this file drives the store-layer glue that
// connects them to the temp-chat quarantine store, end to end through the
// fake ST host.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createFakeStHost } from './helpers/fake-st-host.mjs';

// ---------------------------------------------------------------------
// Fetch routing helpers (same shape as adapter-chats.test.mjs's; kept local
// per this repo's convention of not sharing test-only fetch routers across
// files — see that file's own copy of this comment).
// ---------------------------------------------------------------------
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
    };
}

function okJson(body) {
    return { ok: true, status: 200, json: async () => body };
}

/** /api/characters/chats raw listing rows: [{ file_id: '<name>.jsonl' }, ...]. */
function rawListing(...bareNames) {
    return okJson(bareNames.map(name => ({ file_id: `${name}.jsonl` })));
}

/** /api/characters/get response: the durable character-card chat pointer. */
function pointerResponse(bareChatName) {
    return okJson({ chat: `${bareChatName}.jsonl` });
}

function configureHost(host, { avatar, cardChatName, characterName = 'Bob' }) {
    host.registry.getRequestHeaders = () => ({});
    host.registry.isGenerating = () => false;
    host.registry.cancelDebouncedChatSave = () => {};
    host.registry.cancelDebouncedMetadataSave = () => {};
    host.registry.saveChatConditional = async () => {};
    host.registry.humanizedDateTime = () => '2026-01-01 @00h00';
    // Every reloadRequired path now flushes ST's debounced settings write
    // before tearing the page down (sidebar-actions.ts's
    // _reloadForChatTransaction); unstubbed, that call would throw.
    host.registry.saveSettings = async () => {};
    host.registry.getCurrentChatDetails = () => ({ sessionName: `${cardChatName}.jsonl` });
    host.context.characterId = 0;
    host.context.characters = [{
        avatar,
        name: characterName,
        chat: `${cardChatName}.jsonl`,
        chat_size: 1,
        date_last_chat: 0,
        fav: false,
    }];
}

test(
    "deleting a character's only chat queues the draft-quarantine tombstone before reload, and finalizeChatuiDraftQuarantine folds the fallback file ST's next boot materializes into the same temp-chat quarantine ＋新对话 uses",
    async () => {
        const host = await createFakeStHost();
        try {
            configureHost(host, { avatar: 'bob.png', cardChatName: 'chat-a' });

            const router = createRouter(host);
            // Three /api/characters/chats reads in sequence: the pre-delete
            // existence check (chat-a is the character's only chat), the
            // post-delete existence poll (chat-a is gone), and — simulating
            // the reload — the post-"reboot" confirm read that finds ST's own
            // boot materialized the fallback file. Queued together up front,
            // not split across a later router.queue() call on the same URL:
            // this router's "once a queue is down to one entry, that entry
            // keeps answering" semantics (see createRouter's doc comment
            // above) mean a later queue() call on the same URL appends
            // *after* the still-unconsumed sticky entry, so the next real
            // call would drain the stale one first instead of the new one.
            router.queue(
                '/api/characters/chats',
                rawListing('chat-a'),
                rawListing(),
                rawListing('Bob - 2026-01-01 @00h00'),
            );
            router.queue('/api/chats/search', okJson([]));
            router.queue('/api/characters/merge-attributes', okJson({}));
            router.queue('/api/characters/get', pointerResponse('Bob - 2026-01-01 @00h00'));
            router.queue('/api/chats/delete', { ok: true });

            const sidebarActions = await host.importModule('store/sidebar-actions.js');

            await sidebarActions.deleteChatuiChat('bob.png', 'chat-a');

            assert.equal(
                host.sessionStorage.length,
                2,
                'deleteChatuiChat must queue both tombstones before the mandatory reload: the CHAT_DELETED ' +
                'replay one it always writes on a successful delete, and the new draft-quarantine one',
            );

            // Simulate the reload: ST's own boot materialized the fallback file
            // and loaded it as bob's current chat (the third queued
            // /api/characters/chats response above answers the read this
            // triggers).
            host.registry.getCurrentChatDetails = () => ({ sessionName: 'Bob - 2026-01-01 @00h00.jsonl' });

            await sidebarActions.finalizeChatuiDraftQuarantine();

            assert.equal(
                host.sessionStorage.length,
                1,
                'the draft-quarantine tombstone must clear once resolved, leaving only the untouched ' +
                'CHAT_DELETED replay tombstone (a separate boot step this test does not exercise)',
            );

            const tempChatStore = await host.importModule('store/temp-chat-store.js');
            assert.deepEqual(
                tempChatStore.getTempChat(),
                { avatar: 'bob.png', fileName: 'Bob - 2026-01-01 @00h00' },
                'the fallback file must land in the quarantine set, active, exactly like any other new chat',
            );
            assert.ok(tempChatStore.isTempChat('bob.png', 'Bob - 2026-01-01 @00h00'));
        } finally {
            await host.dispose();
        }
    },
);

test('deleting a chat that leaves a real remaining conversation never queues a draft-quarantine tombstone', async () => {
    const host = await createFakeStHost();
    try {
        configureHost(host, { avatar: 'bob.png', cardChatName: 'chat-a' });

        const router = createRouter(host);
        router.queue('/api/characters/chats', rawListing('chat-a', 'chat-b'));
        router.queue('/api/chats/search', okJson([]));
        router.queue('/api/characters/merge-attributes', okJson({}));
        router.queue('/api/characters/get', pointerResponse('chat-b'));
        router.queue('/api/chats/delete', { ok: true });
        router.queue('/api/characters/chats', rawListing('chat-b'));

        const sidebarActions = await host.importModule('store/sidebar-actions.js');

        await sidebarActions.deleteChatuiChat('bob.png', 'chat-a');

        assert.equal(
            host.sessionStorage.length,
            1,
            'only the CHAT_DELETED replay tombstone — a real replacement chat needs no draft quarantine',
        );

        const tempChatStore = await host.importModule('store/temp-chat-store.js');
        assert.equal(tempChatStore.getTempChat(), null);
        assert.deepEqual(tempChatStore.getTempChats(), []);
    } finally {
        await host.dispose();
    }
});

test('finalizeChatuiDraftQuarantine is a no-op when no draft-quarantine tombstone is pending', async () => {
    const host = await createFakeStHost();
    try {
        configureHost(host, { avatar: 'bob.png', cardChatName: 'chat-a' });
        const sidebarActions = await host.importModule('store/sidebar-actions.js');

        await sidebarActions.finalizeChatuiDraftQuarantine();

        assert.equal(host.fetch.calls.length, 0);
        const tempChatStore = await host.importModule('store/temp-chat-store.js');
        assert.deepEqual(tempChatStore.getTempChats(), []);
    } finally {
        await host.dispose();
    }
});

test("a chat transaction's mandatory reload lands ST's pending settings write first, so the character ChatUI selected survives it", async () => {
    const host = await createFakeStHost();
    try {
        configureHost(host, { avatar: 'bob.png', cardChatName: 'chat-a' });

        const order = [];
        host.registry.saveSettings = async () => {
            order.push('saveSettings');
        };
        host.window.location.reload = () => {
            order.push('reload');
        };

        const router = createRouter(host);
        router.queue('/api/characters/chats', rawListing('chat-a', 'chat-b'), rawListing('chat-b'));
        router.queue('/api/chats/search', okJson([]));
        router.queue('/api/characters/merge-attributes', okJson({}));
        router.queue('/api/characters/get', pointerResponse('chat-b'));
        router.queue('/api/chats/delete', { ok: true });

        const sidebarActions = await host.importModule('store/sidebar-actions.js');
        await sidebarActions.deleteChatuiChat('bob.png', 'chat-a');

        assert.deepEqual(
            order,
            ['saveSettings', 'reload'],
            'saveSettingsDebounced is one shared cancel-and-re-arm timer: a reload inside its window drops '
            + "the persisted active_character the character switch wrote, and the page comes back on someone else",
        );
    } finally {
        await host.dispose();
    }
});
