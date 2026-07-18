import assert from 'node:assert/strict';
import test from 'node:test';

import { createFakeStHost } from './helpers/fake-st-host.mjs';

// Mirrors chat-store.ts's MESSAGE_DTO_CACHE_LIMIT. Not imported from the
// compiled module (it is a private constant) -- kept in sync by the
// `materializedMessages` assertions below, which would fail loudly if the
// store's real limit ever drifted from this value.
const MESSAGE_DTO_CACHE_LIMIT = 96;

function makeMessage({
    isUser = false,
    name = 'Bob',
    mes = 'hello',
    isSystem = false,
    isSmallSys = false,
    isToolCall = false,
} = {}) {
    return {
        name,
        mes,
        is_user: isUser,
        is_system: isSystem,
        send_date: 0,
        swipe_id: 0,
        swipes: [mes],
        extra: {
            isSmallSys,
            tool_invocations: isToolCall ? [{ id: 'tool-call' }] : undefined,
        },
    };
}

/** Alternating user/character turns; index 0 is a user turn. */
function buildAlternatingChat(count, { prefix = 'message' } = {}) {
    const messages = [];
    for (let i = 0; i < count; i += 1) {
        const isUser = i % 2 === 0;
        messages.push(makeMessage({
            isUser,
            name: isUser ? 'User' : 'Bob',
            mes: `${prefix} ${i}`,
        }));
    }
    return messages;
}

async function setUpHost({
    messageCount = 10,
    chatFile = 'chat1.jsonl',
    avatar = 'bob.png',
    characterName = 'Bob',
    prefix = 'message',
} = {}) {
    const host = await createFakeStHost();
    const store = await host.importModule('store/chat-store.js');
    host.registry.isGenerating = () => false;
    // Deterministic stand-in for ST's real (macro-expanding, HTML-producing)
    // formatter: reflects the exact text it was asked to format so tests can
    // tell a fresh format from a stale/cached one just by reading `.html`.
    host.registry.messageFormatting = (text) => `<fmt>${text}</fmt>`;
    host.registry.getCurrentChatDetails = () => ({
        sessionName: chatFile,
        characterName,
        avatarImgURL: `${avatar}-thumb.png`,
    });
    host.context.characterId = 0;
    host.context.characters = [{ avatar, name: characterName }];
    host.context.chat = buildAlternatingChat(messageCount, { prefix });
    return { host, store };
}

// chat-store.js's own chat-change refresh (_scheduleDeferredRefresh) runs on
// a bare, real `setTimeout(fn, 0)` -- it is not routed through the fake
// host's deterministic window.setTimeout/requestAnimationFrame timer engine
// (that engine only intercepts calls made *through* `window` or the global
// requestAnimationFrame/cancelAnimationFrame). CHAT_CHANGED's handlers
// schedule two such independent zero-delay timers synchronously (the
// deferred refresh, and a transition-expiry cleanup); queueing behind two
// more real zero-delay timers reliably observes both having run.
async function flushDeferredTimers() {
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
}

test('lazy materialization: indexing a chat builds no message DTOs, and requesting more than the cache limit keeps the live cache at the limit', async () => {
    const { host, store } = await setUpHost({ messageCount: 200 });
    try {
        store.initChatuiStore();

        const afterIndex = store.getChatuiMessageCacheStats();
        assert.equal(afterIndex.indexedMessages, 200);
        assert.equal(afterIndex.materializedMessages, 0);

        for (let id = 0; id < 150; id += 1) store.getMessageDtoById(id);

        const afterMaterializing = store.getChatuiMessageCacheStats();
        assert.equal(afterMaterializing.indexedMessages, 200);
        assert.ok(
            afterMaterializing.materializedMessages <= MESSAGE_DTO_CACHE_LIMIT,
            `expected materializedMessages (${afterMaterializing.materializedMessages}) <= ${MESSAGE_DTO_CACHE_LIMIT}`,
        );
        assert.equal(afterMaterializing.materializedMessages, MESSAGE_DTO_CACHE_LIMIT);
    } finally {
        store.teardownChatuiStore();
        await host.dispose();
    }
});

test('subscriber pinning: a message with an active subscription is never evicted, and its DTO reference is stable across unrelated materializations', async () => {
    const { host, store } = await setUpHost({ messageCount: 200 });
    try {
        store.initChatuiStore();

        const unsubscribe = store.subscribeChatuiMessage(5, () => {});
        const pinnedDto = store.getMessageDtoById(5);
        assert.ok(pinnedDto);

        const earlyUnsubscribedDto = store.getMessageDtoById(10);

        // Materialize far more distinct ids than the cache can hold, all
        // unrelated to the pinned/early ids above.
        for (let id = 20; id < 199; id += 1) store.getMessageDtoById(id);

        const stats = store.getChatuiMessageCacheStats();
        assert.ok(
            stats.materializedMessages <= MESSAGE_DTO_CACHE_LIMIT,
            `expected materializedMessages (${stats.materializedMessages}) <= ${MESSAGE_DTO_CACHE_LIMIT}`,
        );

        // The subscribed message survived every eviction round and was never rebuilt.
        assert.strictEqual(store.getMessageDtoById(5), pinnedDto);

        // An ordinary (unsubscribed) message inserted just as early was evicted;
        // re-requesting it rebuilds a brand-new DTO object rather than serving
        // a cached one.
        const rebuiltDto = store.getMessageDtoById(10);
        assert.notStrictEqual(rebuiltDto, earlyUnsubscribedDto);
        assert.equal(rebuiltDto.id, earlyUnsubscribedDto.id);

        unsubscribe();
    } finally {
        store.teardownChatuiStore();
        await host.dispose();
    }
});

test('chat switch clears the previous chat DTO cache: no cross-chat leakage of materialized DTOs or formatted HTML', async () => {
    const { host, store } = await setUpHost({ messageCount: 20, chatFile: 'chat1.jsonl', prefix: 'chatA' });
    try {
        store.initChatuiStore();

        for (let id = 0; id < 10; id += 1) store.getMessageDtoById(id);
        const beforeSwitch = store.getChatuiMessageCacheStats();
        assert.ok(beforeSwitch.materializedMessages > 0);
        assert.ok(beforeSwitch.formattedEntries > 0);

        const dtoBefore = store.getMessageDtoById(0);
        assert.equal(dtoBefore.text, 'chatA 0');

        // ST loads the new chat's data before emitting CHAT_CHANGED -- update
        // the host's live state first, matching that ordering.
        host.registry.getCurrentChatDetails = () => ({
            sessionName: 'chat2.jsonl',
            characterName: 'Bob',
            avatarImgURL: 'bob.png-thumb.png',
        });
        host.context.chat = buildAlternatingChat(35, { prefix: 'chatB' });

        await host.eventSource.emit(host.event_types.CHAT_CHANGED);
        await flushDeferredTimers();

        const afterSwitch = store.getChatuiMessageCacheStats();
        assert.equal(afterSwitch.indexedMessages, 35);
        assert.equal(afterSwitch.materializedMessages, 0);
        assert.equal(afterSwitch.formattedEntries, 0);
        assert.equal(afterSwitch.materializationsSinceRefresh, 0);

        // Re-requesting the same slot id in the new chat reflects the new
        // chat's own content -- not a stale DTO or formatted HTML string
        // left over from the old chat's cache.
        const dtoAfter = store.getMessageDtoById(0);
        assert.equal(dtoAfter.text, 'chatB 0');
        assert.equal(dtoAfter.html, '<fmt>chatB 0</fmt>');
        assert.notEqual(dtoAfter.html, dtoBefore.html);
    } finally {
        store.teardownChatuiStore();
        await host.dispose();
    }
});

test('refreshChatuiMessage targets exactly the changed row: unrelated DTOs, the top-level state reference, and materialization counters are all left untouched', async () => {
    const { host, store } = await setUpHost({ messageCount: 30, prefix: 'chatA' });
    try {
        store.initChatuiStore();

        const lastId = 29;
        assert.equal(store.getChatuiState().chat.lastMessageId, lastId);
        // Last turn (index 29, odd) is the character's reply, not the user's.
        assert.equal(store.getChatuiState().chat.lastMessageNeedsGenerate, false);

        const stateBefore = store.getChatuiState();
        const dto0 = store.getMessageDtoById(0);
        const dto3 = store.getMessageDtoById(3);
        const dtoLastBefore = store.getMessageDtoById(lastId);

        const statsBefore = store.getChatuiMessageCacheStats();
        assert.equal(statsBefore.materializedMessages, 3);

        // Simulate one streamed token appended to the live last message.
        host.context.chat[lastId].mes += ' more';
        host.context.chat[lastId].swipes[0] = host.context.chat[lastId].mes;

        store.refreshChatuiMessage(lastId);

        const statsAfterRefresh = store.getChatuiMessageCacheStats();
        // Exactly the touched row's cached DTO was invalidated -- no mass rebuild.
        assert.equal(statsAfterRefresh.materializedMessages, statsBefore.materializedMessages - 1);
        assert.equal(statsAfterRefresh.materializationsSinceRefresh, statsBefore.materializationsSinceRefresh);
        assert.equal(statsAfterRefresh.indexedMessages, statsBefore.indexedMessages);

        // Untouched rows keep their exact DTO object -- refreshChatuiMessage
        // must not have cleared or rebuilt the whole cache.
        assert.strictEqual(store.getMessageDtoById(0), dto0);
        assert.strictEqual(store.getMessageDtoById(3), dto3);

        // A full refreshChatuiStore() always calls setState unconditionally;
        // the targeted path only does when a derived field (lastMessageNeedsGenerate)
        // actually changed. It did not here, so the top-level state object
        // must be the exact same reference a useSyncExternalStore consumer
        // would still be holding.
        assert.strictEqual(store.getChatuiState(), stateBefore);

        // The touched row itself rebuilds fresh, lazily, on the next request,
        // reflecting the new content.
        const dtoLastAfter = store.getMessageDtoById(lastId);
        assert.notStrictEqual(dtoLastAfter, dtoLastBefore);
        assert.equal(dtoLastAfter.text, host.context.chat[lastId].mes);
        assert.equal(
            store.getChatuiMessageCacheStats().materializationsSinceRefresh,
            statsBefore.materializationsSinceRefresh + 1,
        );
    } finally {
        store.teardownChatuiStore();
        await host.dispose();
    }
});

test('composer drafts for chats other than the one being switched away from survive a CHAT_CHANGED refresh', async () => {
    const { host, store } = await setUpHost({ messageCount: 5, chatFile: 'chat1.jsonl', prefix: 'chatA' });
    const composerDraftStore = await host.importModule('store/composer-draft-store.js');
    try {
        store.initChatuiStore();

        const otherChatKey = JSON.stringify(['character', 'other.png', 'session:other-chat']);
        composerDraftStore.setComposerDraft(otherChatKey, 'unsent draft for a different chat');
        const activeChatKeyBefore = store.getChatuiState().chat.chatKey;
        composerDraftStore.setComposerDraft(activeChatKeyBefore, 'unsent draft for the chat being left');

        host.registry.getCurrentChatDetails = () => ({
            sessionName: 'chat2.jsonl',
            characterName: 'Bob',
            avatarImgURL: 'bob.png-thumb.png',
        });
        host.context.chat = buildAlternatingChat(6, { prefix: 'chatB' });

        await host.eventSource.emit(host.event_types.CHAT_CHANGED);
        await flushDeferredTimers();

        // Confirm the switch actually happened before trusting the "survives" assertions below.
        assert.notEqual(store.getChatuiState().chat.chatKey, activeChatKeyBefore);

        assert.equal(
            composerDraftStore.getComposerDraft(otherChatKey),
            'unsent draft for a different chat',
        );
        assert.equal(
            composerDraftStore.getComposerDraft(activeChatKeyBefore),
            'unsent draft for the chat being left',
        );
    } finally {
        store.teardownChatuiStore();
        await host.dispose();
    }
});
