// test/sidebar-actions.test.mjs
//
// Covers dist/runtime/store/sidebar-actions.js's own orchestration on top of
// the chat adapter — specifically the landing handoff DESIGN §3 / evaluation
// §5 3.6 requires ("delete a character's only chat -> come back on that
// character holding a usable conversation, never on a bare 'character
// selected, no conversation' state, and never on nobody at all").
// adapter-chats.test.mjs already covers the adapter-layer pieces
// (delete-transaction.js's fallbackChatFileName, deletion-finalization.js's
// queue/take pair) in isolation; this file drives the store-layer glue that
// spends the credential on the session ledger and, on a stock host, on the
// seating — end to end through the fake ST host.
//
// The quarantine this handoff used to feed (a persisted lease set that kept
// the fallback file out of ordinary history) was retired on 2026-08-02; what
// the tests below pin is what replaced it.

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
    "deleting a character's only chat queues the landing credential before the reload, and the next boot puts the reader back on that character",
    async () => {
        const host = await createFakeStHost();
        try {
            configureHost(host, { avatar: 'bob.png', cardChatName: 'chat-a' });

            const router = createRouter(host);
            // Two /api/characters/chats reads, both inside the delete itself:
            // the pre-delete existence check (chat-a is the character's only
            // chat) and the post-delete existence poll (chat-a is gone). The
            // boot half of this handoff reads nothing at all.
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
                'the CHAT_DELETED replay tombstone and the landing credential both survive the reload',
            );

            // ---- the reload ----
            liveChat(host, null);
            const fetchesBeforeBoot = host.fetch.calls.length;
            const sessionCharacters = await host.importModule('store/session-characters.js');
            sessionCharacters.resetSessionCharacters();

            sidebarActions.finalizeChatuiChatTransaction();

            assert.deepEqual(
                sessionCharacters.getSessionCharacterConversations(),
                ['bob.png'],
                'the spine must be able to show the character the reader is being returned to, '
                + "even though ST's boot-time chat_size snapshot was taken before its own boot wrote the file",
            );
            assert.equal(
                host.sessionStorage.length,
                1,
                'the landing credential is consumed, leaving only the untouched CHAT_DELETED replay tombstone',
            );
            assert.equal(host.fetch.calls.length, fetchesBeforeBoot,
                'the boot half of the handoff must issue no request at all');
        } finally {
            await host.dispose();
        }
    },
);

test('deleting a chat that leaves a real remaining conversation never queues a landing credential', async () => {
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
            'only the CHAT_DELETED replay tombstone — a real replacement chat needs no landing',
        );

        const sessionCharacters = await host.importModule('store/session-characters.js');
        sessionCharacters.resetSessionCharacters();
        sidebarActions.finalizeChatuiChatTransaction();
        assert.deepEqual(sessionCharacters.getSessionCharacterConversations(), [],
            'and the boot has nothing to land');
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
// never loads the deleted character, and the reader is left on an empty stage —
// worse than the "character selected, no conversation" state this transaction
// exists to prevent. These tests pin both halves of the completion: that ChatUI
// finishes the transaction when the stage is empty, and that it keeps its hands
// off when the reader's own setting already put somebody there.
// ---------------------------------------------------------------------

test("a boot that lands on nobody finishes the delete transaction itself: ChatUI selects the credential's character", async () => {
    const host = await createFakeStHost();
    try {
        configureHost(host, { avatar: 'bob.png', cardChatName: 'chat-a' });
        host.context.characters = [
            { avatar: 'ann.png', name: 'Ann', chat: 'ann-chat.jsonl', chat_size: 1, date_last_chat: 0, fav: false },
            { avatar: 'bob.png', name: 'Bob', chat: 'Bob - 2026-01-01 @00h00.jsonl', chat_size: 0, date_last_chat: 0, fav: false },
        ];
        host.fetch.setHandler(() => {
            throw new Error('the boot half of the landing handoff must issue no request');
        });

        const adapter = await host.importModule('adapter/chats/deletion-finalization.js');
        const sidebarActions = await host.importModule('store/sidebar-actions.js');
        const sessionCharacters = await host.importModule('store/session-characters.js');
        sessionCharacters.resetSessionCharacters();

        adapter.queueCharacterChatLanding('bob.png');

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

        sidebarActions.finalizeChatuiChatTransaction();
        // The landing is a host mutation on the shared serialized lane, so the
        // lane's own idle boundary is all this needs (see the lane test below).
        await sidebarActions.waitForChatuiSidebarActionsIdle();

        assert.deepEqual(selections, [1],
            'the credential names Bob, so Bob is who the transaction is finished on');
        assert.deepEqual(
            sessionCharacters.getSessionCharacterConversations(),
            ['bob.png'],
            'and Bob is on the spine, whose chat_size snapshot still reads zero',
        );
        assert.equal(host.sessionStorage.length, 0, 'the credential is consumed, not left waiting');
    } finally {
        await host.dispose();
    }
});

test('a boot that landed on somebody else keeps its stage, and the credential is spent on the ledger instead', async () => {
    const host = await createFakeStHost();
    try {
        configureHost(host, { avatar: 'bob.png', cardChatName: 'chat-a' });
        host.context.characters = [
            { avatar: 'ann.png', name: 'Ann', chat: 'ann-chat.jsonl', chat_size: 1, date_last_chat: 0, fav: false },
            { avatar: 'bob.png', name: 'Bob', chat: 'Bob - 2026-01-01 @00h00.jsonl', chat_size: 0, date_last_chat: 0, fav: false },
        ];
        host.fetch.setHandler(() => {
            throw new Error('the boot half of the landing handoff must issue no request');
        });
        host.registry.selectCharacterById = () => {
            throw new Error('ChatUI must not move a stage the reader\'s own autoload setting already filled');
        };

        const adapter = await host.importModule('adapter/chats/deletion-finalization.js');
        const sidebarActions = await host.importModule('store/sidebar-actions.js');
        const sessionCharacters = await host.importModule('store/session-characters.js');
        sessionCharacters.resetSessionCharacters();

        adapter.queueCharacterChatLanding('bob.png');

        // The reader has auto_load_chat on and ST came back on Ann.
        host.context.characterId = 0;
        host.context.groupId = undefined;
        host.registry.getCurrentChatDetails = () => ({ sessionName: 'ann-chat.jsonl' });

        sidebarActions.finalizeChatuiChatTransaction();
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(String(host.context.characterId), '0', 'Ann keeps the stage');
        assert.equal(host.sessionStorage.length, 0, 'the credential is spent either way');
        assert.deepEqual(
            sessionCharacters.getSessionCharacterConversations(),
            ['bob.png'],
            'and Bob is on the spine regardless, so the reader can walk over to the conversation the '
            + 'transaction left them: that is the half that does not depend on who ST seated',
        );
    } finally {
        await host.dispose();
    }
});

test('with ChatUI switched off the boot still spends the credential, but never selects a character inside ST\'s own interface', async () => {
    const host = await createFakeStHost();
    try {
        configureHost(host, { avatar: 'bob.png', cardChatName: 'chat-a' });
        host.context.characters = [
            { avatar: 'bob.png', name: 'Bob', chat: 'Bob - 2026-01-01 @00h00.jsonl', chat_size: 0, date_last_chat: 0, fav: false },
        ];
        host.fetch.setHandler(() => {
            throw new Error('the boot half of the landing handoff must issue no request');
        });
        // A selection that would fully succeed if it were attempted — the point
        // is that it is never attempted, and a stub that merely threw would be
        // swallowed by the landing's own error handling and prove nothing.
        const selections = [];
        host.registry.setActiveCharacter = () => {};
        host.registry.setActiveGroup = () => {};
        host.registry.saveSettingsDebounced = () => {};
        host.registry.selectCharacterById = async (index) => {
            selections.push(index);
            host.context.characterId = index;
            host.registry.getCurrentChatDetails = () => ({ sessionName: 'Bob - 2026-01-01 @00h00.jsonl' });
            await host.eventSource.emit('CHAT_CHANGED', 'Bob - 2026-01-01 @00h00');
        };

        const finalization = await host.importModule('adapter/chats/deletion-finalization.js');
        const sidebarActions = await host.importModule('store/sidebar-actions.js');
        const sessionCharacters = await host.importModule('store/session-characters.js');
        sessionCharacters.resetSessionCharacters();

        finalization.queueCharacterChatLanding('bob.png');
        // A stock host with ChatUI off: nobody on stage, and no ChatUI UI that
        // could be stranded by leaving it that way.
        liveChat(host, null);
        host.context.groupId = undefined;

        sidebarActions.finalizeChatuiChatTransaction({ completeLanding: false });
        await sidebarActions.waitForChatuiSidebarActionsIdle();
        await new Promise(resolve => setImmediate(resolve));

        assert.deepEqual(selections, [],
            'the reader switched ChatUI off: an extension with no interface on screen must not pick a '
            + 'character inside ST\'s own one');
        assert.equal(host.context.characterId, undefined, 'the empty stage ST chose stays ST\'s own doing');
        assert.equal(
            host.sessionStorage.length,
            0,
            'the credential is still spent, not left to fire on some later page: expiry is the point of arming',
        );
        assert.deepEqual(
            sessionCharacters.getSessionCharacterConversations(),
            ['bob.png'],
            'and the ledger entry is still made — if the reader switches ChatUI back on this page, the spine '
            + 'has to be able to show the character whose chat_size snapshot reads zero',
        );
    } finally {
        await host.dispose();
    }
});

test('a credential the bootstrap page spent is dead on the next boot, not waiting to seat somebody a page late', async () => {
    const host = await createFakeStHost();
    try {
        configureHost(host, { avatar: 'bob.png', cardChatName: 'chat-a' });
        host.context.characters = [
            { avatar: 'bob.png', name: 'Bob', chat: 'Bob - 2026-01-01 @00h00.jsonl', chat_size: 0, date_last_chat: 0, fav: false },
        ];
        host.fetch.setHandler(() => {
            throw new Error('the boot half of the landing handoff must issue no request');
        });
        const selections = [];
        host.registry.setActiveCharacter = () => {};
        host.registry.setActiveGroup = () => {};
        host.registry.saveSettingsDebounced = () => {};
        host.registry.selectCharacterById = async (index) => {
            selections.push(index);
            host.context.characterId = index;
            host.registry.getCurrentChatDetails = () => ({ sessionName: 'Bob - 2026-01-01 @00h00.jsonl' });
            await host.eventSource.emit('CHAT_CHANGED', 'Bob - 2026-01-01 @00h00');
        };

        const finalization = await host.importModule('adapter/chats/deletion-finalization.js');
        const sidebarActions = await host.importModule('store/sidebar-actions.js');

        // Page 1 — 关扩展: ChatUI is off, ST came back on nobody. The credential
        // is spent on the ledger entry and nothing else; the seating is the one
        // move bootstrap mode withholds.
        finalization.queueCharacterChatLanding('bob.png');
        liveChat(host, null);
        host.context.groupId = undefined;
        sidebarActions.finalizeChatuiChatTransaction({ completeLanding: false });
        await sidebarActions.waitForChatuiSidebarActionsIdle();
        assert.deepEqual(selections, [], 'the bootstrap page selects nobody');

        // 刷新 → 再开扩展. sessionStorage is what survives that reload; module
        // state does not.
        sidebarActions.finalizeChatuiChatTransaction({ completeLanding: true });
        await sidebarActions.waitForChatuiSidebarActionsIdle();
        await new Promise(resolve => setImmediate(resolve));

        assert.deepEqual(
            selections,
            [],
            'and the page after it selects nobody either: a credential the previous page owned is dead, '
            + 'because seating somebody a page late is a surprise rather than a repair',
        );
        assert.equal(host.context.characterId, undefined, 'the stage ST chose is still ST\'s');
        assert.equal(host.sessionStorage.length, 0, 'nothing is left to fire on a third page');
    } finally {
        await host.dispose();
    }
});

test("the boot landing enters ST through the same serialized lane as the reader's own clicks, never beside it", async () => {
    const host = await createFakeStHost();
    try {
        configureHost(host, { avatar: 'bob.png', cardChatName: 'chat-a' });
        host.context.characters = [
            { avatar: 'ann.png', name: 'Ann', chat: 'ann-chat.jsonl', chat_size: 1, date_last_chat: 0, fav: false },
            { avatar: 'bob.png', name: 'Bob', chat: 'Bob - 2026-01-01 @00h00.jsonl', chat_size: 0, date_last_chat: 0, fav: false },
        ];
        host.fetch.setHandler(() => {
            throw new Error('the boot half of the landing handoff must issue no request');
        });

        const finalization = await host.importModule('adapter/chats/deletion-finalization.js');
        const hostQueue = await host.importModule('store/host-operation-queue.js');
        const sidebarActions = await host.importModule('store/sidebar-actions.js');

        finalization.queueCharacterChatLanding('bob.png');
        liveChat(host, null);
        host.context.groupId = undefined;

        const order = [];
        host.registry.setActiveCharacter = () => {};
        host.registry.setActiveGroup = () => {};
        host.registry.saveSettingsDebounced = () => {};
        host.registry.selectCharacterById = async (index) => {
            order.push('landing');
            host.context.characterId = index;
            host.registry.getCurrentChatDetails = () => ({ sessionName: 'Bob - 2026-01-01 @00h00.jsonl' });
            await host.eventSource.emit('CHAT_CHANGED', 'Bob - 2026-01-01 @00h00');
        };

        // Something is already inside ST when the boot handoff runs — the same
        // shape as the reader's first click landing in the few hundred ms this
        // handoff lives in.
        let releaseEarlierWork = () => {};
        const earlierWork = new Promise(resolve => { releaseEarlierWork = resolve; });
        void hostQueue.enqueueHostTask(async () => {
            order.push('earlier-host-work');
            await earlierWork;
            order.push('earlier-host-work-done');
        });

        sidebarActions.finalizeChatuiChatTransaction();
        await new Promise(resolve => setImmediate(resolve));

        assert.deepEqual(
            order,
            ['earlier-host-work'],
            'selectCharacterById mutates the one live chat context: it must wait its turn like every other '
            + 'host mutation, not run beside whatever is already in there',
        );

        releaseEarlierWork();
        await sidebarActions.waitForChatuiSidebarActionsIdle();

        assert.deepEqual(order, ['earlier-host-work', 'earlier-host-work-done', 'landing']);
        assert.equal(host.sessionStorage.length, 0, 'the credential is consumed');
    } finally {
        await host.dispose();
    }
});

test('settling a delete against a file that is not there announces the vanished conversation, so the cached listing cannot go on serving it as ordinary history', async () => {
    const host = await createFakeStHost();
    try {
        configureHost(host, { avatar: 'bob.png', cardChatName: 'chat-a' });

        const router = createRouter(host);
        router.queue('/api/characters/chats', rawListing('chat-a'));

        const vanishedStore = await host.importModule('store/vanished-chat-store.js');
        const sidebarActions = await host.importModule('store/sidebar-actions.js');

        const announced = [];
        const unsubscribe = vanishedStore.subscribeVanishedChats(vanished => announced.push(vanished));

        assert.equal(vanishedStore.getLastVanishedChat(), null, 'nothing has vanished yet');

        await sidebarActions.deleteChatuiChat('bob.png', 'ghost-draft');
        unsubscribe();

        assert.deepEqual(
            announced,
            [{ avatar: 'bob.png', fileName: 'ghost-draft' }],
            'the settlement must be announced exactly once, naming the character whose listing is now lying',
        );
        assert.deepEqual(vanishedStore.getLastVanishedChat(), { avatar: 'bob.png', fileName: 'ghost-draft' });
    } finally {
        await host.dispose();
    }
});

test("openChatuiChatForCharacter's host-reported notfound announces the vanished conversation", async () => {
    const host = await createFakeStHost();
    try {
        configureHost(host, { avatar: 'bob.png', cardChatName: 'chat-a' });

        const toastStore = await host.importModule('store/toast-store.js');
        const vanishedStore = await host.importModule('store/vanished-chat-store.js');
        const sidebarActions = await host.importModule('store/sidebar-actions.js');

        const announced = [];
        const unsubscribe = vanishedStore.subscribeVanishedChats(vanished => announced.push(vanished));

        // The host itself reports the conversation does not exist — here
        // because the character card is gone. This used to be one of two exits;
        // the other was a pre-flight listing read that ran only for quarantined
        // drafts, and went with them (see openChatuiChatForCharacter).
        await sidebarActions.openChatuiChatForCharacter('gone.png', 'old-chat');
        unsubscribe();

        assert.deepEqual(
            announced,
            [{ avatar: 'gone.png', fileName: 'old-chat' }],
            'a row the host says does not exist must not survive the click that proved it',
        );
        assert.deepEqual(
            toastStore.getToasts().map(toast => [toast.kind, toast.text]),
            [['error', '角色或对话不存在']],
        );
    } finally {
        await host.dispose();
    }
});

test('a second ＋新对话 press creates a second chat instead of silently doing nothing', async () => {
    const host = await createFakeStHost();
    try {
        configureHost(host, { avatar: 'bob.png', cardChatName: 'chat-a' });
        host.fetch.setHandler(() => {
            throw new Error('creating a new chat must go through the host, not the chat API');
        });

        // ST's own doNewChat: materialize a fresh file and make it live. It has
        // no opinion about how many empty chats a character may hold — the cap
        // this test is about was ChatUI's, not the host's.
        const created = [];
        host.registry.doNewChat = async (options) => {
            assert.deepEqual(options, { deleteCurrentChat: false });
            const fileName = `Bob - new-${created.length + 1}`;
            created.push(fileName);
            liveChat(host, fileName);
        };

        const sidebarActions = await host.importModule('store/sidebar-actions.js');
        const sessionCharacters = await host.importModule('store/session-characters.js');
        sessionCharacters.resetSessionCharacters();

        // First press: this always worked.
        await sidebarActions.newChatuiChat();
        await sidebarActions.waitForChatuiSidebarActionsIdle();
        assert.deepEqual(created, ['Bob - new-1']);

        // Second press, from the unadopted chat the first one produced. This is
        // the regression under gate: _createTempDraft used to return here
        // without touching the host, because the ＋新对话 button was doubling
        // as that chat's own row and a second one had nowhere to be drawn
        // (DESIGN §4.2, 2026-08-02). Nothing renders a draft any more, so a
        // second press is an ordinary request.
        await sidebarActions.newChatuiChat();
        await sidebarActions.waitForChatuiSidebarActionsIdle();
        assert.deepEqual(
            created,
            ['Bob - new-1', 'Bob - new-2'],
            'pressing ＋新对话 again must reach the host a second time',
        );
        assert.deepEqual(
            sessionCharacters.getSessionCharacterConversations(),
            ['bob.png'],
            'and the character is on the spine either way, recorded once rather than per chat',
        );
    } finally {
        await host.dispose();
    }
});
