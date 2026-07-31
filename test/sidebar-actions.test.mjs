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

/**
 * ST's boot landing (or not) on a chat, as getCurrentChatIdentity() reads it.
 * `null` is the honest state at APP_READY: ST's autoload chain has not
 * finished, so no character chat is live yet.
 */
function liveChat(host, pointer) {
    host.context.characterId = pointer ? 0 : undefined;
    host.registry.getCurrentChatDetails = () => ({ sessionName: pointer ? `${pointer}.jsonl` : '' });
}

test(
    "deleting a character's only chat queues the draft-quarantine tombstone before reload, and finalizeChatuiDraftQuarantine folds the fallback file into the same temp-chat quarantine ＋新对话 uses once ST's boot finally makes it live",
    async () => {
        const host = await createFakeStHost();
        try {
            configureHost(host, { avatar: 'bob.png', cardChatName: 'chat-a' });

            const router = createRouter(host);
            // Two /api/characters/chats reads, both inside the delete itself:
            // the pre-delete existence check (chat-a is the character's only
            // chat) and the post-delete existence poll (chat-a is gone). The
            // boot half of this handoff deliberately reads nothing at all any
            // more — see deletion-finalization.ts's section comment.
            router.queue(
                '/api/characters/chats',
                rawListing('chat-a'),
                rawListing(),
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
                'replay one it always writes on a successful delete, and the draft-quarantine one',
            );

            // ---- the reload ----
            // ChatUI's APP_READY handler runs while ST's fire-and-forget
            // autoload is still in flight: nothing is live yet, and the
            // fallback file has not been written. This is the exact instant
            // the previous implementation checked the chat directory at, found
            // nothing, and destroyed the intent.
            liveChat(host, null);
            const fetchesBeforeBoot = host.fetch.calls.length;
            const listenersBeforeBoot = host.eventSource.listenerCount('CHAT_CHANGED');

            sidebarActions.finalizeChatuiDraftQuarantine();

            const tempChatStore = await host.importModule('store/temp-chat-store.js');
            assert.deepEqual(tempChatStore.getTempChats(), [],
                'nothing may be quarantined before the fallback file is actually live');
            assert.equal(host.sessionStorage.length, 2, 'the intent must survive a boot that is not there yet');
            assert.equal(
                host.eventSource.listenerCount('CHAT_CHANGED') - listenersBeforeBoot,
                1,
                'an unresolved intent must be waiting on the signal ST emits after it saves the file',
            );

            // ST's autoload finishes: getChatResult() ran its unconditional
            // saveChatConditional() and only then emitted CHAT_CHANGED.
            liveChat(host, 'Bob - 2026-01-01 @00h00');
            await host.eventSource.emit('CHAT_CHANGED', 'Bob - 2026-01-01 @00h00');

            assert.deepEqual(
                tempChatStore.getTempChat(),
                { avatar: 'bob.png', fileName: 'Bob - 2026-01-01 @00h00' },
                'the fallback file must land in the quarantine set, active, exactly like any other new chat',
            );
            assert.ok(tempChatStore.isTempChat('bob.png', 'Bob - 2026-01-01 @00h00'));
            assert.equal(
                host.sessionStorage.length,
                1,
                'the draft-quarantine tombstone must clear once consumed, leaving only the untouched ' +
                'CHAT_DELETED replay tombstone (a separate boot step this test does not exercise)',
            );
            assert.equal(
                host.eventSource.listenerCount('CHAT_CHANGED'),
                listenersBeforeBoot,
                'a consumed intent must stop listening rather than re-check on every later chat change',
            );
            assert.equal(host.fetch.calls.length, fetchesBeforeBoot,
                'the boot half of the handoff must issue no request at all');
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

test('a pending draft quarantine ignores chat changes that are not its fallback file, and keeps waiting for the one that is', async () => {
    const host = await createFakeStHost();
    try {
        configureHost(host, { avatar: 'bob.png', cardChatName: 'chat-a' });
        host.fetch.setHandler(() => {
            throw new Error('the boot half of the draft-quarantine handoff must issue no request');
        });

        const adapter = await host.importModule('adapter/chats/deletion-finalization.js');
        const sidebarActions = await host.importModule('store/sidebar-actions.js');
        const tempChatStore = await host.importModule('store/temp-chat-store.js');

        adapter.queueCharacterChatDraftQuarantine('bob.png', 'Bob - 2026-01-01 @00h00');
        liveChat(host, null);
        sidebarActions.finalizeChatuiDraftQuarantine();

        // The reader went somewhere else first — an ordinary chat switch, not
        // the boot landing this intent is about.
        liveChat(host, 'chat-elsewhere');
        await host.eventSource.emit('CHAT_CHANGED', 'chat-elsewhere');
        assert.deepEqual(tempChatStore.getTempChats(), [],
            'an unrelated chat must never be adopted as the deleted character\'s draft');
        assert.equal(host.sessionStorage.length, 1, 'and the intent must not be thrown away over it either');

        // …and then came back to the character the delete emptied.
        liveChat(host, 'Bob - 2026-01-01 @00h00');
        await host.eventSource.emit('CHAT_CHANGED', 'Bob - 2026-01-01 @00h00');
        assert.deepEqual(tempChatStore.getTempChat(), { avatar: 'bob.png', fileName: 'Bob - 2026-01-01 @00h00' });
        assert.equal(host.sessionStorage.length, 0);
    } finally {
        await host.dispose();
    }
});

test('finalizeChatuiDraftQuarantine is a no-op when no draft-quarantine tombstone is pending', async () => {
    const host = await createFakeStHost();
    try {
        configureHost(host, { avatar: 'bob.png', cardChatName: 'chat-a' });
        const sidebarActions = await host.importModule('store/sidebar-actions.js');
        const listenersBefore = host.eventSource.listenerCount('CHAT_CHANGED');

        sidebarActions.finalizeChatuiDraftQuarantine();

        assert.equal(host.fetch.calls.length, 0);
        assert.equal(
            host.eventSource.listenerCount('CHAT_CHANGED'),
            listenersBefore,
            'with nothing queued there is nothing to wait for: no listener may be left behind',
        );
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
