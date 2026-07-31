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

// ---------------------------------------------------------------------
// Finishing the transaction on a stock host (auto_load_chat: false)
//
// ST's default is *not* to reload onto the last character (power-user.js:335;
// this repo's e2e fixture forces it on, which is why every earlier real-machine
// run of this handoff ran under a non-default setting). On a stock install the
// mandatory reload therefore comes back with no character selected at all: ST
// never loads the deleted character, never writes the fallback file, and the
// credential below waits for a CHAT_CHANGED that will never be emitted. These
// two tests pin both halves of the completion — that ChatUI finishes the
// transaction when the stage is empty, and that it keeps its hands off when
// the reader's own setting already put somebody there.
// ---------------------------------------------------------------------

test("a boot that lands on nobody finishes the delete transaction itself: ChatUI selects the credential's character and the fallback file lands in quarantine", async () => {
    const host = await createFakeStHost();
    try {
        configureHost(host, { avatar: 'bob.png', cardChatName: 'chat-a' });
        host.context.characters = [
            { avatar: 'ann.png', name: 'Ann', chat: 'ann-chat.jsonl', chat_size: 1, date_last_chat: 0, fav: false },
            { avatar: 'bob.png', name: 'Bob', chat: 'Bob - 2026-01-01 @00h00.jsonl', chat_size: 0, date_last_chat: 0, fav: false },
        ];
        host.fetch.setHandler(() => {
            throw new Error('the boot half of the draft-quarantine handoff must issue no request');
        });

        const adapter = await host.importModule('adapter/chats/deletion-finalization.js');
        const sidebarActions = await host.importModule('store/sidebar-actions.js');
        const tempChatStore = await host.importModule('store/temp-chat-store.js');

        adapter.queueCharacterChatDraftQuarantine('bob.png', 'Bob - 2026-01-01 @00h00');

        // The stock boot: ST chose nobody, so nothing is live and the fallback
        // file has not been written.
        liveChat(host, null);
        host.context.groupId = undefined;
        const selections = [];
        host.registry.setActiveCharacter = () => {};
        host.registry.setActiveGroup = () => {};
        host.registry.saveSettingsDebounced = () => {};
        // ST's own selectCharacterById: it loads the character's durable chat
        // pointer — the fabricated fallback name — and getChatResult() emits
        // CHAT_CHANGED at the end of doing so.
        host.registry.selectCharacterById = async (index) => {
            selections.push(index);
            host.context.characterId = index;
            host.registry.getCurrentChatDetails = () => ({ sessionName: 'Bob - 2026-01-01 @00h00.jsonl' });
            await host.eventSource.emit('CHAT_CHANGED', 'Bob - 2026-01-01 @00h00');
        };

        sidebarActions.finalizeChatuiDraftQuarantine();
        await sidebarActions.waitForChatuiSidebarActionsIdle();
        // The landing runs outside the host queue (it is boot work, not a user
        // mutation), so drain the microtask chain it lives on.
        await new Promise(resolve => setImmediate(resolve));

        assert.deepEqual(selections, [1],
            'the credential names Bob, so Bob is who the transaction is finished on');
        assert.deepEqual(
            tempChatStore.getTempChat(),
            { avatar: 'bob.png', fileName: 'Bob - 2026-01-01 @00h00' },
            'and the fallback file ST wrote on the way in is quarantined exactly as an autoload boot would have it',
        );
        assert.equal(host.sessionStorage.length, 0, 'the credential is consumed, not left waiting');
        assert.equal(
            host.eventSource.listenerCount('CHAT_CHANGED'),
            0,
            'a consumed intent stops listening',
        );
    } finally {
        await host.dispose();
    }
});

test('a boot that landed on somebody else is never overridden: the credential simply keeps waiting', async () => {
    const host = await createFakeStHost();
    try {
        configureHost(host, { avatar: 'bob.png', cardChatName: 'chat-a' });
        host.context.characters = [
            { avatar: 'ann.png', name: 'Ann', chat: 'ann-chat.jsonl', chat_size: 1, date_last_chat: 0, fav: false },
            { avatar: 'bob.png', name: 'Bob', chat: 'Bob - 2026-01-01 @00h00.jsonl', chat_size: 0, date_last_chat: 0, fav: false },
        ];
        host.fetch.setHandler(() => {
            throw new Error('the boot half of the draft-quarantine handoff must issue no request');
        });
        host.registry.selectCharacterById = () => {
            throw new Error('ChatUI must not move a stage the reader\'s own autoload setting already filled');
        };

        const adapter = await host.importModule('adapter/chats/deletion-finalization.js');
        const sidebarActions = await host.importModule('store/sidebar-actions.js');
        const tempChatStore = await host.importModule('store/temp-chat-store.js');

        adapter.queueCharacterChatDraftQuarantine('bob.png', 'Bob - 2026-01-01 @00h00');

        // The reader has auto_load_chat on and ST came back on Ann.
        host.context.characterId = 0;
        host.context.groupId = undefined;
        host.registry.getCurrentChatDetails = () => ({ sessionName: 'ann-chat.jsonl' });

        sidebarActions.finalizeChatuiDraftQuarantine();
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(String(host.context.characterId), '0', 'Ann keeps the stage');
        assert.deepEqual(tempChatStore.getTempChats(), []);
        assert.equal(host.sessionStorage.length, 1,
            'the credential keeps its ordinary meaning: if that file goes live later, it is a draft');
        assert.equal(
            host.eventSource.listenerCount('CHAT_CHANGED'),
            1,
            'and it is still watching for the moment the reader walks over to Bob',
        );

        // …which the spine now makes reachable, so walking over resolves it.
        host.context.characterId = 1;
        host.registry.getCurrentChatDetails = () => ({ sessionName: 'Bob - 2026-01-01 @00h00.jsonl' });
        await host.eventSource.emit('CHAT_CHANGED', 'Bob - 2026-01-01 @00h00');
        assert.deepEqual(
            tempChatStore.getTempChat(),
            { avatar: 'bob.png', fileName: 'Bob - 2026-01-01 @00h00' },
        );
    } finally {
        await host.dispose();
    }
});

test('discarding a quarantined draft whose file has already vanished drops the lease instead of reporting a failure that can never be retried', async () => {
    const host = await createFakeStHost();
    try {
        configureHost(host, { avatar: 'bob.png', cardChatName: 'chat-a' });

        const router = createRouter(host);
        // The host's own listing: the draft file is not there. (The lease can
        // outlive its file whenever the save that was supposed to create it
        // failed — see deletion-finalization.ts's section comment — or when
        // anything outside ChatUI removed it.)
        router.queue('/api/characters/chats', rawListing('chat-a'));

        const tempChatStore = await host.importModule('store/temp-chat-store.js');
        const toastStore = await host.importModule('store/toast-store.js');
        const sidebarActions = await host.importModule('store/sidebar-actions.js');

        tempChatStore.setTempChat({ avatar: 'bob.png', fileName: 'ghost-draft' });
        assert.equal(tempChatStore.isTempChat('bob.png', 'ghost-draft'), true);

        await sidebarActions.deleteChatuiChat('bob.png', 'ghost-draft');

        assert.deepEqual(tempChatStore.getTempChats(), [],
            '丢弃 is the only path that can drop a lease; refusing here left the card on the shelf forever');
        assert.equal(tempChatStore.getTempChat(), null);
        assert.deepEqual(
            toastStore.getToasts().map(toast => [toast.kind, toast.text]),
            [['info', '该对话已不存在，已移出列表']],
            'and the reader is told what actually happened, not that their delete failed',
        );
        assert.equal(host.fetch.calls.length, 1, 'no destructive request for a file that is not there');
    } finally {
        await host.dispose();
    }
});
