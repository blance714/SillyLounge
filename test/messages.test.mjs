// test/messages.test.mjs
//
// dist/runtime/adapter/messages.js delete/swipe/hide/copy/branch/checkpoint/
// edit argument matrix. Source: src/adapter/messages.ts
// (getDeleteEligibility, getConfirmMessageDeleteSetting,
// deleteMessageWithIntent, _deleteSwipeById, swipeMessage,
// toggleHideMessage, copyMessageSource, createBranch, createCheckpoint,
// saveMessageEditById, triggerMessageActionById). These delegate to
// @st/script's exported saveChatDebounced/refreshSwipeButtons/
// updateEditArrowClasses/syncSwipeToMes/swipe/saveChatConditional/
// ensureSwipes/extractMessageBias/removeMacros/substituteParams/
// system_message_types/eventSource, @st/regex-engine's exported
// getRegexedString/regex_placement, @st/itemized-prompts's
// deleteItemizedPromptForMessage, @st/bookmarks's
// branchChat/createNewBookmark, @st/chats's
// hideChatMessage/unhideChatMessage, and @st/utils's copyText — wrong
// arguments here silently destroy the wrong swipe or the wrong message, so
// every branch of ST's native .mes_edit_delete policy is pinned exactly, not
// just "was called".
//
// DOM-DECOUPLING.md Tier 1: copySource / branch / checkpoint / hide never
// require a live `.mes` node and read nothing but `getContext().chat` (via
// getMessageById), so a plain numeric id — no `.mes` element, real or fake —
// drives every one of them, including through the shared
// triggerMessageActionById dispatch entry point. The plain 「复制」 does not
// pass through that entry point at all — it reduces the formatted HTML the row
// rendered from, which only the store holds — so what is pinned here is the
// reduction itself plus its clipboard hand-off. regen is unchanged this
// tier: it still resolves `#chat .mes[mesid="X"]` via getMessageElementById,
// a compound selector the fake DOM deliberately doesn't support (see
// test/helpers/fake-st-host.mjs's module doc comment), so it remains a
// Chromium e2e concern, not a unit-test one.
//
// DOM-DECOUPLING.md Tier 2 (2026-07-19): full-message delete is now a thin
// fork too (_deleteFullMessageById, tested below via deleteMessageWithIntent)
// — DOM-*tolerant*, not DOM-gated. `_deleteFullMessageById` still can't have
// its own `mesEl?.remove()` step exercised here — like regen above, that
// depends on `getMessageElementById`'s compound selector, which the fake DOM
// can't resolve, so it always finds nothing here (a real-browser-only
// concern; see the repro HTML files cited in messages.ts's doc comments). The
// *renumber* step is different: `_renumberRenderedRowsAfterDelete` walks
// `#chat`'s direct `.children` and a plain classList tree-walk instead of a
// compound selector, so it — and therefore the actual bug this tier's own
// review round caught (native `updateViewMessageIds`'s DOM-self-recomputing
// null-startIndex branch silently no-ops whenever the deleted row itself was
// never rendered) — genuinely is exercised below, by building a real `#chat`
// DOM directly with `document.createElement`. Confirmation UI is entirely
// out of the adapter: getDeleteEligibility()/getConfirmMessageDeleteSetting()
// are pure reads, deleteMessageWithIntent() only executes an already-decided
// intent and never shows any popup or dialog — the ChatUI-owned confirm
// dialog + orchestration policy (which mutation to run for which
// {confirm_message_delete, canDeleteSwipe, user choice} combination) is
// store/chat-actions.ts's job now, covered by test/chat-actions.test.mjs and
// test/confirm-store.test.mjs instead. triggerMessageActionById no longer
// dispatches 'delete' at all (see its own test below).
//
// DOM-DECOUPLING.md Tier 3 (2026-07-19): edit-save is now a thin fork too
// (saveMessageEditById, tested directly below) — fully DOM-free, unlike Tier
// 1/2's synthetic-click implementation. Because it never touches
// `getMessageElementById`'s compound selector at all, it is fully
// unit-testable for the first time; the one still-gated branch
// (_healRenderedMessageRow's "row is actually rendered" path) walks `#chat`
// .children directly, same technique as `_renumberRenderedRowsAfterDelete`,
// so a real (fake-DOM) `#chat` tree exercises it too, below. `edit` was also
// removed from triggerMessageActionById's dispatch entirely this tier — see
// its own test below — since nothing in the real UI ever routed through it
// (entering edit mode has always been local Preact state).

import assert from 'node:assert/strict';
import test from 'node:test';

import { createFakeStHost } from './helpers/fake-st-host.mjs';

/** A stand-in for a `.mes` element: only `.getAttribute('mesid')` is read. */
function fakeMesEl(mesId) {
    return {
        getAttribute(name) {
            return name === 'mesid' ? String(mesId) : null;
        },
    };
}

function fillerMessage() {
    return { mes: 'filler', swipes: ['filler'], is_user: false, is_system: false, extra: {} };
}

/** Builds a chat array of `chatLength` filler messages with a target message at `targetId`. */
function buildChat(targetId, chatLength, targetOverrides) {
    const chat = Array.from({ length: chatLength }, fillerMessage);
    chat[targetId] = { mes: 'target', swipes: ['s0'], is_user: false, is_system: false, extra: {}, ...targetOverrides };
    return chat;
}

/**
 * Registers and returns a real `#chat` container under document.body — the
 * fake DOM's getElementById resolves it just like a real browser would (see
 * test/helpers/fake-st-host.mjs). Mirrors native's own
 * `chatElement = $('#chat')` container (script.js:448).
 */
function createChatContainer() {
    const chatContainer = document.createElement('div');
    chatContainer.id = 'chat';
    document.body.appendChild(chatContainer);
    return chatContainer;
}

/**
 * Appends one rendered `.mes` row for `mesid` to `chatContainer`, shaped like
 * ST's real `#message_template` (public/index.html): `.mesIDDisplay` nested
 * two levels below `.mes` (`.mes > .mesAvatarWrapper > .mesIDDisplay`), not a
 * direct child — this is exactly the nesting
 * `_findDescendantByClass` (src/adapter/messages.ts) exists to walk without a
 * compound CSS selector. Returns `{ row, display }` so the test can assert
 * against the exact same node objects after the delete runs.
 */
function appendMesRow(chatContainer, mesid) {
    const row = document.createElement('div');
    row.className = 'mes';
    row.setAttribute('mesid', String(mesid));
    const wrapper = document.createElement('div');
    wrapper.className = 'mesAvatarWrapper';
    const display = document.createElement('div');
    display.className = 'mesIDDisplay';
    display.textContent = `#${mesid}`;
    wrapper.appendChild(display);
    row.appendChild(wrapper);
    chatContainer.appendChild(row);
    return { row, display };
}

/** Appends one rendered `.mes` row for each id in `mesids`, in order. */
function appendMesRows(chatContainer, mesids) {
    return mesids.map((mesid) => appendMesRow(chatContainer, mesid));
}

test('getDeleteEligibility: {is_user} x {swipes>1} x {isLast} x {swipe_id defined} matrix matches ST\'s own structural check (script.js:11922-11928) exactly, excluding confirm_message_delete — that gate is the caller\'s job now (store/chat-actions.ts)', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 3;

        const booleans = [true, false];
        for (const isUser of booleans) {
            for (const swipesLen of [1, 2]) {
                for (const isLast of booleans) {
                    for (const swipeIdDefined of booleans) {
                        const label = `isUser=${isUser} swipes=${swipesLen} isLast=${isLast} swipeIdDefined=${swipeIdDefined}`;
                        const chatLength = isLast ? TARGET_ID + 1 : TARGET_ID + 2;
                        host.context.chat = buildChat(TARGET_ID, chatLength, {
                            swipes: Array.from({ length: swipesLen }, (_, i) => `swipe-${i}`),
                            swipe_id: swipeIdDefined ? swipesLen - 1 : undefined,
                            is_user: isUser,
                        });

                        const expectedCanDeleteSwipe = !isUser && swipesLen > 1 && isLast && swipeIdDefined;
                        const result = messages.getDeleteEligibility(TARGET_ID);
                        assert.equal(result.canDeleteSwipe, expectedCanDeleteSwipe, label);
                        assert.equal(
                            result.swipeId,
                            expectedCanDeleteSwipe ? swipesLen - 1 : undefined,
                            label,
                        );
                    }
                }
            }
        }
    } finally {
        await host.dispose();
    }
});

test('getDeleteEligibility: rejects a negative or non-integer message id before reading the chat', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        assert.throws(() => messages.getDeleteEligibility('not-a-number'), /Invalid message id for delete/);
        assert.throws(() => messages.getDeleteEligibility(-1), /Invalid message id for delete/);
    } finally {
        await host.dispose();
    }
});

test('getDeleteEligibility: throws when the message record cannot be found at that id', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        host.context.chat = []; // id 0 is out of range
        assert.throws(() => messages.getDeleteEligibility(0), /Message record not found for delete: 0/);
    } finally {
        await host.dispose();
    }
});

test('getConfirmMessageDeleteSetting: coerces a truthy non-boolean setting to strict true, and a missing/empty powerUserSettings to false without throwing', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');

        host.context.powerUserSettings = { confirm_message_delete: 'yes' };
        assert.equal(messages.getConfirmMessageDeleteSetting(), true);

        host.context.powerUserSettings = { confirm_message_delete: false };
        assert.equal(messages.getConfirmMessageDeleteSetting(), false);

        host.context.powerUserSettings = undefined;
        assert.equal(messages.getConfirmMessageDeleteSetting(), false);

        host.context.powerUserSettings = {};
        assert.equal(messages.getConfirmMessageDeleteSetting(), false);
    } finally {
        await host.dispose();
    }
});

test('deleteMessageWithIntent: rejects a negative or non-integer message id before touching the host', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        host.registry.saveChatDebounced = () => {
            throw new Error('must not be reached for an invalid id');
        };

        await assert.rejects(
            () => messages.deleteMessageWithIntent('not-a-number', 'message'),
            /Invalid message id for delete/,
        );
        await assert.rejects(
            () => messages.deleteMessageWithIntent(-1, 'message'),
            /Invalid message id for delete/,
        );
    } finally {
        await host.dispose();
    }
});

test('deleteMessageWithIntent: "swipe" intent without a swipeId throws before mutating anything or calling the host', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 2;
        host.context.chat = buildChat(TARGET_ID, TARGET_ID + 1, { swipes: ['a', 'b'], swipe_id: 1 });
        host.registry.saveChatConditional = () => {
            throw new Error('must not be reached without a swipeId');
        };

        await assert.rejects(
            () => messages.deleteMessageWithIntent(TARGET_ID, 'swipe'),
            /Swipe id required for swipe-only delete/,
        );
        assert.deepEqual(host.context.chat[TARGET_ID].swipes, ['a', 'b']);
    } finally {
        await host.dispose();
    }
});

test('deleteMessageWithIntent: "swipe" intent forwards mesId/swipeId straight to _deleteSwipeById, never touching the full-delete host calls', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 2;
        host.context.chat = buildChat(TARGET_ID, TARGET_ID + 1, { swipes: ['a', 'b'], swipe_id: 1 });
        host.context.chatMetadata = {};
        host.registry.syncSwipeToMes = () => undefined;
        host.registry.saveChatConditional = () => undefined;
        host.registry.deleteItemizedPromptForMessage = () => {
            throw new Error('the full-delete fork must not run for a "swipe" intent');
        };
        host.registry.saveChatDebounced = () => {
            throw new Error('the full-delete fork must not run for a "swipe" intent');
        };

        await messages.deleteMessageWithIntent(TARGET_ID, 'swipe', 1);

        assert.deepEqual(host.context.chat[TARGET_ID].swipes, ['a'], 'the given swipeId must be the one deleted');
        assert.equal(host.context.chat.length, TARGET_ID + 1, 'a swipe-only delete must never touch chat.length');
    } finally {
        await host.dispose();
    }
});

test('deleteMessageWithIntent: "message" intent (the full-message fork) reproduces the exact native post-gate sequence — splice, tainted, itemized-prompt invalidation, DOM-tolerant renumber, debounced save, refreshSwipeButtons, MESSAGE_DELETED payload — in ST\'s exact order, entirely without a rendered .mes node', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 2;
        host.context.chat = buildChat(TARGET_ID, 5, {});
        host.context.chatMetadata = {};

        const calls = [];
        host.registry.deleteItemizedPromptForMessage = (id) => calls.push(['deleteItemizedPromptForMessage', id]);
        host.registry.updateEditArrowClasses = () => calls.push(['updateEditArrowClasses']);
        host.registry.saveChatDebounced = () => calls.push(['saveChatDebounced']);
        host.registry.refreshSwipeButtons = () => calls.push(['refreshSwipeButtons']);
        host.eventSource.on(host.event_types.MESSAGE_DELETED, (chatLength) => calls.push(['MESSAGE_DELETED', chatLength]));

        const beforeChatRef = host.context.chat;
        await messages.deleteMessageWithIntent(TARGET_ID, 'message');

        assert.equal(host.context.chat, beforeChatRef, 'the splice must mutate the live chat array in place, not replace it');
        assert.equal(host.context.chat.length, 4);
        assert.equal(host.context.chat[TARGET_ID].mes, 'filler', 'the deleted message must be gone; the next one shifts into its slot');
        assert.equal(host.context.chatMetadata.tainted, true);
        assert.deepEqual(calls, [
            ['deleteItemizedPromptForMessage', TARGET_ID],
            // _renumberRenderedRowsAfterDelete finds no `#chat` container at
            // all in this test (nothing rendered), so its own DOM loop is a
            // no-op — but it still unconditionally calls updateEditArrowClasses,
            // exactly like native updateViewMessageIds does even over zero
            // `.mes` rows.
            ['updateEditArrowClasses'],
            ['saveChatDebounced'],
            ['refreshSwipeButtons'],
            ['MESSAGE_DELETED', 4],
        ], 'every observable side effect must fire, in exactly this order');
    } finally {
        await host.dispose();
    }
});

// The mesid-renumber trap (2026-07-19 review round): native
// `updateViewMessageIds`'s null-startIndex branch re-derives its own
// baseline by re-scanning the *current* DOM for the minimum rendered
// `mesid` — correct only under native `deleteMessage()`'s own precondition
// that the deleted row's element was itself just physically removed from
// that DOM. `_deleteFullMessageById` (DOM-*tolerant*, no such precondition)
// dropped that assumption but, before this fix, still delegated to
// `updateViewMessageIds` unmodified — so whenever the deleted id was never
// rendered while later rows were, the DOM's own minimum never moved, the
// recomputation silently no-oped, and every rendered row downstream kept a
// `mesid` off by one from its true `chat[]` index (empirically proved with
// the verbatim native functions against a real DOM in a scratch repro from
// that review round, not checked into this repo).
// `_renumberRenderedRowsAfterDelete` fixes this
// by comparing each row's own stale `mesid` against the deleted id directly
// — see its doc comment in src/adapter/messages.ts for the full rule and
// proof sketch. The scenarios below pin that rule directly against a real
// (fake-DOM) `#chat` tree, covering every configuration the task called out.
test('deleteMessageWithIntent: "message" intent — rendered-row renumber (mesid-renumber trap fix): unrendered-deleted + later-rendered rows all shift down by exactly one (the truncation core case; also covers "deleted id === the pre-delete rendered minimum", since a still-rendered row\'s own DOM state after a delete cannot distinguish "this id was rendered and just got removed" from "this id was never rendered at all" — both leave an identical residual row set, which is exactly why comparing against the deleted id is the only correct rule)', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        host.registry.deleteItemizedPromptForMessage = () => undefined;
        host.registry.updateEditArrowClasses = () => undefined;
        host.registry.saveChatDebounced = () => undefined;
        host.registry.refreshSwipeButtons = () => undefined;

        const chatContainer = createChatContainer();
        // chat_truncation-shaped window: only the last 4 of 10 messages are
        // rendered; id 5 (unrendered) is deleted — the exact configuration
        // native-window truncation produces and the one the review round
        // proved was silently corrupted.
        const rendered = appendMesRows(chatContainer, [6, 7, 8, 9]);
        host.context.chat = buildChat(5, 10, {});

        await messages.deleteMessageWithIntent(5, 'message');

        const expectedMesids = ['5', '6', '7', '8'];
        rendered.forEach(({ row, display }, index) => {
            assert.equal(row.getAttribute('mesid'), expectedMesids[index], `row ${index}: mesid`);
            assert.equal(display.textContent, `#${expectedMesids[index]}`, `row ${index}: mesIDDisplay text`);
        });
        rendered.forEach(({ row }, index) => {
            assert.equal(row.classList.contains('last_mes'), index === rendered.length - 1, `row ${index}: last_mes membership`);
        });
    } finally {
        await host.dispose();
    }
});

test('deleteMessageWithIntent: "message" intent — rendered-row renumber: rows below the deleted id are left untouched, only rows above it shift down (post-removal DOM shape a rendered mid-list delete leaves behind — mesEl.remove() itself is a real-browser-only concern here, see the module doc comment)', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        host.registry.deleteItemizedPromptForMessage = () => undefined;
        host.registry.updateEditArrowClasses = () => undefined;
        host.registry.saveChatDebounced = () => undefined;
        host.registry.refreshSwipeButtons = () => undefined;

        const chatContainer = createChatContainer();
        // Rendered window was [5,6,7,8,9]; id 7 (mid-window) is the one being
        // deleted — its own row is omitted here to stand in for
        // `mesEl.remove()` already having run (the fake DOM can't resolve the
        // compound selector `getMessageElementById` uses to find it).
        const below = appendMesRows(chatContainer, [5, 6]);
        const above = appendMesRows(chatContainer, [8, 9]);
        host.context.chat = buildChat(7, 10, {});

        await messages.deleteMessageWithIntent(7, 'message');

        assert.equal(below[0].row.getAttribute('mesid'), '5', 'row below deletedId: untouched');
        assert.equal(below[1].row.getAttribute('mesid'), '6', 'row below deletedId: untouched');
        assert.equal(below[0].display.textContent, '#5');
        assert.equal(below[1].display.textContent, '#6');
        assert.equal(above[0].row.getAttribute('mesid'), '7', 'row above deletedId: decremented by one');
        assert.equal(above[1].row.getAttribute('mesid'), '8', 'row above deletedId: decremented by one');
        assert.equal(above[0].display.textContent, '#7');
        assert.equal(above[1].display.textContent, '#8');
        assert.equal(below[0].row.classList.contains('last_mes'), false);
        assert.equal(below[1].row.classList.contains('last_mes'), false);
        assert.equal(above[0].row.classList.contains('last_mes'), false);
        assert.equal(above[1].row.classList.contains('last_mes'), true, 'last_mes must land on the new final row');
    } finally {
        await host.dispose();
    }
});

test('deleteMessageWithIntent: "message" intent — rendered-row renumber: deleting the sole rendered row under chat_truncation=1 (its own element already removed) leaves nothing to renumber, without throwing', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        host.registry.deleteItemizedPromptForMessage = () => undefined;
        const arrowCalls = [];
        host.registry.updateEditArrowClasses = () => arrowCalls.push(1);
        host.registry.saveChatDebounced = () => undefined;
        host.registry.refreshSwipeButtons = () => undefined;

        // Only the last message (id 9 of 10) is rendered, and it is exactly
        // the one being deleted — production's default chat_truncation=1
        // shape (renumber-repro2.html). Its row is omitted to stand in for
        // mesEl.remove() already having run.
        createChatContainer();
        host.context.chat = buildChat(9, 10, {});

        await assert.doesNotReject(() => messages.deleteMessageWithIntent(9, 'message'));

        assert.equal(host.context.chat.length, 9);
        assert.deepEqual(arrowCalls, [1], 'updateEditArrowClasses must still run over zero rendered rows');
    } finally {
        await host.dispose();
    }
});

test('deleteMessageWithIntent: "message" intent — rendered-row renumber: deleting id 0 while it is itself unrendered still shifts every rendered row down by one (the id===0 edge case the old startIndex formula special-cased, but which is only ever safe under native\'s own DOM gate)', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        host.registry.deleteItemizedPromptForMessage = () => undefined;
        host.registry.updateEditArrowClasses = () => undefined;
        host.registry.saveChatDebounced = () => undefined;
        host.registry.refreshSwipeButtons = () => undefined;

        const chatContainer = createChatContainer();
        const rendered = appendMesRows(chatContainer, [3, 4, 5]);
        host.context.chat = buildChat(0, 6, {});

        await messages.deleteMessageWithIntent(0, 'message');

        const expectedMesids = ['2', '3', '4'];
        rendered.forEach(({ row, display }, index) => {
            assert.equal(row.getAttribute('mesid'), expectedMesids[index], `row ${index}: mesid`);
            assert.equal(display.textContent, `#${expectedMesids[index]}`, `row ${index}: mesIDDisplay text`);
        });
    } finally {
        await host.dispose();
    }
});

// The this_edit_mes_id-shadow-reset test that used to live here was removed
// along with the shadow mechanism itself (DOM-DECOUPLING.md Tier 3,
// 2026-07-19) — see _deleteFullMessageById's doc comment in
// src/adapter/messages.ts for why: saveMessageEditById() no longer opens a
// native edit session at all, so it is no longer the "one ChatUI path that
// sets the real this_edit_mes_id" the shadow existed to mirror, and nothing
// else in this repo ever calls setEditedMessageId() anymore either.

test('_deleteSwipeById: splices the deleted swipe out of the live chat entry, reassigns swipe_id, marks chat_metadata tainted, emits MESSAGE_SWIPE_DELETED, and resyncs mes via syncSwipeToMes when the deleted swipe was the message\'s active swipe', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 5;
        host.context.chat = buildChat(TARGET_ID, TARGET_ID + 1, {
            mes: 'stale',
            swipes: ['a', 'b', 'c'],
            swipe_id: 1,
            swipe_info: [{ n: 0 }, { n: 1 }, { n: 2 }],
        });
        host.context.chatMetadata = {};

        host.registry.deleteSwipe = () => {
            throw new Error('ST\'s deleteSwipe must never be called — this is a self-contained mini-fork');
        };
        host.registry.swipe = () => {
            throw new Error('ST\'s swipe must never be called — the mini-fork resyncs mes itself');
        };
        let syncCalled = 0;
        let syncArgs;
        host.registry.syncSwipeToMes = (...args) => {
            syncCalled += 1;
            syncArgs = args;
        };
        let saveCalled = 0;
        host.registry.saveChatConditional = () => {
            saveCalled += 1;
        };
        let emitted;
        host.eventSource.on(host.event_types.MESSAGE_SWIPE_DELETED, (payload) => { emitted = payload; });

        await messages._deleteSwipeById(TARGET_ID, 1); // deleting the active swipe (swipe_id === 1)

        assert.deepEqual(host.context.chat[TARGET_ID].swipes, ['a', 'c'], 'the deleted swipe must be spliced out in place');
        assert.deepEqual(host.context.chat[TARGET_ID].swipe_info, [{ n: 0 }, { n: 2 }], 'swipe_info must be spliced in lockstep');
        assert.equal(host.context.chat[TARGET_ID].swipe_id, 1, 'swipe_id must be reassigned to the new active swipe');
        assert.equal(host.context.chatMetadata.tainted, true, 'chat_metadata.tainted must be set, mirroring ST\'s deleteSwipe()');
        assert.equal(syncCalled, 1, 'the corruption guard must fire exactly once for the active swipe');
        assert.deepEqual(syncArgs, [TARGET_ID]);
        assert.equal(saveCalled, 1, 'saveChatConditional must persist the mutation exactly once');
        assert.deepEqual(emitted, { messageId: TARGET_ID, swipeId: 1, newSwipeId: 1 });
    } finally {
        await host.dispose();
    }
});

test('_deleteSwipeById: leaves mes untouched (no syncSwipeToMes call) when the deleted swipe was not the message\'s active swipe', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 5;
        host.context.chat = buildChat(TARGET_ID, TARGET_ID + 1, {
            swipes: ['a', 'b', 'c'],
            swipe_id: 0,
        });

        host.registry.deleteSwipe = () => {
            throw new Error('ST\'s deleteSwipe must never be called — this is a self-contained mini-fork');
        };
        host.registry.syncSwipeToMes = () => {
            throw new Error('syncSwipeToMes must not be called for a non-active swipe');
        };
        let saveCalled = 0;
        host.registry.saveChatConditional = () => {
            saveCalled += 1;
        };
        let emitted;
        host.eventSource.on(host.event_types.MESSAGE_SWIPE_DELETED, (payload) => { emitted = payload; });

        await messages._deleteSwipeById(TARGET_ID, 2); // swipe 2 is not the active swipe (swipe_id === 0)

        assert.deepEqual(host.context.chat[TARGET_ID].swipes, ['a', 'b'], 'the deleted swipe must still be spliced out');
        assert.equal(host.context.chat[TARGET_ID].swipe_id, 0, 'the active swipe_id must be unaffected by deleting a later swipe');
        assert.equal(saveCalled, 1, 'saveChatConditional must still persist the mutation');
        assert.deepEqual(emitted, { messageId: TARGET_ID, swipeId: 2, newSwipeId: 0 });
    } finally {
        await host.dispose();
    }
});

test('_deleteSwipeById: throws without mutating when the message has only one swipe left', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 5;
        host.context.chat = buildChat(TARGET_ID, TARGET_ID + 1, { swipes: ['only'] });
        host.registry.saveChatConditional = () => {
            throw new Error('saveChatConditional must not be called when the guard rejects up front');
        };

        await assert.rejects(
            () => messages._deleteSwipeById(TARGET_ID, 0),
            /Cannot delete the last swipe/,
        );
        assert.deepEqual(host.context.chat[TARGET_ID].swipes, ['only'], 'a rejected delete must not mutate swipes');
    } finally {
        await host.dispose();
    }
});

test('_deleteSwipeById: throws for an out-of-range swipe id, without mutating swipes', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 5;
        host.context.chat = buildChat(TARGET_ID, TARGET_ID + 1, { swipes: ['a', 'b'] });
        host.registry.saveChatConditional = () => {
            throw new Error('saveChatConditional must not be called when the guard rejects up front');
        };

        await assert.rejects(
            () => messages._deleteSwipeById(TARGET_ID, 5),
            /Invalid swipe id/,
        );
        assert.deepEqual(host.context.chat[TARGET_ID].swipes, ['a', 'b'], 'a rejected delete must not mutate swipes');
    } finally {
        await host.dispose();
    }
});

test('copyMessageSource: reads the live message by id and forwards its mes text to copyText, with no DOM element required', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 2;
        host.context.chat = buildChat(TARGET_ID, TARGET_ID + 1, { mes: 'copy this exact text' });

        let copied;
        host.registry.copyText = (text) => {
            copied = text;
        };

        await messages.copyMessageSource(TARGET_ID);

        assert.equal(copied, 'copy this exact text');
    } finally {
        await host.dispose();
    }
});

test('copyMessageSource: rejects a negative or non-integer message id before touching the host', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        host.registry.copyText = () => {
            throw new Error('copyText must not be called for an invalid id');
        };

        await assert.rejects(
            () => messages.copyMessageSource('not-a-number'),
            /Invalid message id for copy/,
        );
        await assert.rejects(
            () => messages.copyMessageSource(-1),
            /Invalid message id for copy/,
        );
    } finally {
        await host.dispose();
    }
});

test('copyMessageSource: throws when no message record exists at that id, without calling copyText', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        host.context.chat = []; // id 0 out of range
        host.registry.copyText = () => {
            throw new Error('copyText must not be called when the record is missing');
        };

        await assert.rejects(
            () => messages.copyMessageSource(0),
            /Message record not found for copy: 0/,
        );
    } finally {
        await host.dispose();
    }
});

// The plain 「复制」 reduction. Hand-built trees rather than parsed HTML: the
// fake host's DOM parses nothing (see its module doc comment), so `DOMParser`
// is a real-browser-only seam — but the reduction it feeds is pure, and the
// reduction is where every judgement call lives, so that is what gets pinned.
function textNode(value) {
    return { nodeType: 3, nodeValue: value, nodeName: '#text' };
}

function elementNode(nodeName, childNodes = []) {
    return { nodeType: 1, nodeName, childNodes };
}

test('_plainTextFromNode: block boundaries and <br> become the line breaks a reader sees, and inline markup contributes nothing but its text', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');

        const body = elementNode('BODY', [
            elementNode('P', [
                textNode('她'),
                elementNode('EM', [textNode('抬起头')]),
                textNode('。'),
                elementNode('BR'),
                textNode('「你来了。」'),
            ]),
            elementNode('P', [textNode('第二段。')]),
        ]);

        assert.equal(
            messages._plainTextFromNode(body),
            '她抬起头。\n「你来了。」\n\n第二段。',
        );
    } finally {
        await host.dispose();
    }
});

test('_plainTextFromNode: list items break per row, table cells separate along the row, and comment/attribute nodes are dropped entirely', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');

        const body = elementNode('BODY', [
            elementNode('UL', [
                elementNode('LI', [textNode('一')]),
                elementNode('LI', [textNode('二')]),
            ]),
            // nodeType 8 is a comment: neither element nor text, so the walk
            // must not reach into it at all.
            { nodeType: 8, nodeName: '#comment', nodeValue: ' hidden ' },
            elementNode('TABLE', [
                elementNode('TR', [
                    elementNode('TD', [textNode('左')]),
                    elementNode('TD', [textNode('右')]),
                ]),
            ]),
        ]);

        assert.equal(messages._plainTextFromNode(body), '一\n\n二\n\n左\t右');
    } finally {
        await host.dispose();
    }
});

test('_plainTextFromNode: a <style> block a character card carries is never read as prose, and the paragraphs around it still join normally', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');

        // Exactly the shape ST's own formatter produces for a card that ships
        // CSS: chats.js encodeStyleTags -> DOMPurify -> decodeStyleTags puts a
        // real <style> element back into the message HTML, and DOMParser keeps
        // it inside <body> whenever any content precedes it.
        const body = elementNode('BODY', [
            elementNode('P', [textNode('她抬起头。')]),
            elementNode('STYLE', [textNode('.mes_text .x{color:red;background:blue}')]),
            elementNode('P', [textNode('第二段。')]),
        ]);

        assert.equal(messages._plainTextFromNode(body), '她抬起头。\n\n第二段。');
    } finally {
        await host.dispose();
    }
});

test('plainTextFromMessageHtml: empty formatted HTML reduces to an empty string without reaching for a parser', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        // DOMParser does not exist in this harness at all, so this asserts the
        // early return as much as the value: reaching the parser would throw.
        assert.equal(messages.plainTextFromMessageHtml(''), '');
    } finally {
        await host.dispose();
    }
});

test('copyMessageAsPlainText: forwards the reduced text to copyText and never reads the chat array', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        host.context.chat = null; // the plain copy must not touch it

        let copied = 'never called';
        host.registry.copyText = (text) => {
            copied = text;
        };

        await messages.copyMessageAsPlainText('');

        assert.equal(copied, '');
    } finally {
        await host.dispose();
    }
});

test('createBranch: forwards the message id to branchChat, with no DOM element required', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 7;

        let received;
        host.registry.branchChat = (...args) => {
            received = args;
        };

        await messages.createBranch(TARGET_ID);

        assert.deepEqual(received, [TARGET_ID]);
    } finally {
        await host.dispose();
    }
});

test('createBranch: rejects a negative or non-integer message id before touching the host', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        host.registry.branchChat = () => {
            throw new Error('branchChat must not be called for an invalid id');
        };

        await assert.rejects(
            () => messages.createBranch('not-a-number'),
            /Invalid message id for branch/,
        );
        await assert.rejects(
            () => messages.createBranch(-1),
            /Invalid message id for branch/,
        );
    } finally {
        await host.dispose();
    }
});

test('createCheckpoint: forwards the message id to createNewBookmark, with no DOM element required', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 9;

        let received;
        host.registry.createNewBookmark = (...args) => {
            received = args;
        };

        await messages.createCheckpoint(TARGET_ID);

        assert.deepEqual(received, [TARGET_ID]);
    } finally {
        await host.dispose();
    }
});

test('createCheckpoint: rejects a negative or non-integer message id before touching the host', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        host.registry.createNewBookmark = () => {
            throw new Error('createNewBookmark must not be called for an invalid id');
        };

        await assert.rejects(
            () => messages.createCheckpoint('not-a-number'),
            /Invalid message id for checkpoint/,
        );
        await assert.rejects(
            () => messages.createCheckpoint(-1),
            /Invalid message id for checkpoint/,
        );
    } finally {
        await host.dispose();
    }
});

test('swipeMessage: forwards forceMesId, the exact raw message reference, and direction unmodified', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 2;
        const chat = buildChat(TARGET_ID, TARGET_ID + 1, { swipes: ['x', 'y'], swipe_id: 1 });
        host.context.chat = chat;

        let received;
        host.registry.swipe = (...args) => {
            received = args;
        };

        await messages.swipeMessage(fakeMesEl(TARGET_ID), 'left');
        assert.equal(received[0], null);
        assert.equal(received[1], 'left');
        assert.equal(received[2].forceMesId, TARGET_ID);
        assert.equal(received[2].message, chat[TARGET_ID], 'must forward the exact live chat-array object, not a copy');
        assert.deepEqual(Object.keys(received[2]).sort(), ['forceMesId', 'message']);

        await messages.swipeMessage(fakeMesEl(TARGET_ID), 'right');
        assert.equal(received[1], 'right', 'direction must pass through unmodified for the other swipe direction');
    } finally {
        await host.dispose();
    }
});

test('swipeMessage: rejects a negative or non-integer message id before touching the host', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        host.registry.swipe = () => {
            throw new Error('swipe must not be called for an invalid id');
        };

        await assert.rejects(
            () => messages.swipeMessage(fakeMesEl('nope'), 'left'),
            /Invalid message id for swipe/,
        );
    } finally {
        await host.dispose();
    }
});

test('swipeMessage: throws when no message record exists at that id, without calling stSwipe', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        host.context.chat = []; // id 0 out of range -> getMessageById returns null
        host.registry.swipe = () => {
            throw new Error('swipe must not be called when the record is missing');
        };

        await assert.rejects(
            () => messages.swipeMessage(fakeMesEl(0), 'left'),
            /Message record not found for swipe: 0/,
        );
    } finally {
        await host.dispose();
    }
});

test('toggleHideMessage: is_system true delegates to unhideChatMessage(mesId) only', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 4;
        host.context.chat = buildChat(TARGET_ID, TARGET_ID + 1, { is_system: true });

        let unhideArgs;
        let hideCalled = false;
        host.registry.unhideChatMessage = (...args) => {
            unhideArgs = args;
        };
        host.registry.hideChatMessage = () => {
            hideCalled = true;
        };

        await messages.toggleHideMessage(TARGET_ID);

        assert.deepEqual(unhideArgs, [TARGET_ID]);
        assert.equal(hideCalled, false, 'hideChatMessage must not fire for an already-hidden (is_system) message');
    } finally {
        await host.dispose();
    }
});

test('toggleHideMessage: is_system false delegates to hideChatMessage(mesId) only', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 4;
        host.context.chat = buildChat(TARGET_ID, TARGET_ID + 1, { is_system: false });

        let hideArgs;
        let unhideCalled = false;
        host.registry.hideChatMessage = (...args) => {
            hideArgs = args;
        };
        host.registry.unhideChatMessage = () => {
            unhideCalled = true;
        };

        await messages.toggleHideMessage(TARGET_ID);

        assert.deepEqual(hideArgs, [TARGET_ID]);
        assert.equal(unhideCalled, false, 'unhideChatMessage must not fire for a visible message');
    } finally {
        await host.dispose();
    }
});

test('toggleHideMessage: rejects a negative or non-integer message id before touching the host', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        host.registry.hideChatMessage = () => {
            throw new Error('hideChatMessage must not be called for an invalid id');
        };
        host.registry.unhideChatMessage = () => {
            throw new Error('unhideChatMessage must not be called for an invalid id');
        };

        await assert.rejects(
            () => messages.toggleHideMessage(-3),
            /Invalid message id for hide/,
        );
    } finally {
        await host.dispose();
    }
});

test('triggerMessageActionById: copySource/branch/checkpoint/hide all resolve with no #chat .mes element present in the DOM (Tier 1)', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 6;
        // Deliberately never create or register a `.mes[mesid="6"]` node —
        // getMessageElementById() always returns null in this harness anyway
        // (compound selectors are out of scope for the fake DOM), which is
        // exactly the "unrendered message" shape Tier 1 exists to survive.
        host.context.chat = buildChat(TARGET_ID, TARGET_ID + 1, {
            is_user: false,
            is_system: false,
        });

        host.registry.copyText = () => undefined;
        host.registry.branchChat = () => undefined;
        host.registry.createNewBookmark = () => undefined;
        host.registry.hideChatMessage = () => undefined;

        // None of these may throw "Message element not found" — that gate is
        // gone for exactly these four.
        await messages.triggerMessageActionById(TARGET_ID, 'copySource');
        await messages.triggerMessageActionById(TARGET_ID, 'branch');
        await messages.triggerMessageActionById(TARGET_ID, 'checkpoint');
        await messages.triggerMessageActionById(TARGET_ID, 'hide');
    } finally {
        await host.dispose();
    }
});

test('triggerMessageActionById: "delete" is not dispatched here at all (Tier 2) — a silent no-op, zero mutation, zero host calls; orchestration lives in store/chat-actions.ts now', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 6;
        host.context.chat = buildChat(TARGET_ID, TARGET_ID + 1, { is_user: true });
        const beforeLength = host.context.chat.length;

        host.registry.saveChatDebounced = () => {
            throw new Error('the full-delete fork must never run for a "delete" action dispatched through triggerMessageActionById');
        };
        host.registry.saveChatConditional = () => {
            throw new Error('the swipe-only mini-fork must never run for a "delete" action dispatched through triggerMessageActionById');
        };

        // Not a TypeScript-representable call (MessageAction no longer
        // includes 'delete'), but nothing stops a raw string reaching this
        // compiled JS function at runtime — the `default: return;` branch is
        // the deliberate, documented safe failure mode (see the doc comment
        // above triggerMessageActionById in src/adapter/messages.ts).
        await messages.triggerMessageActionById(TARGET_ID, 'delete');

        assert.equal(host.context.chat.length, beforeLength, 'no message may be deleted by this call');
    } finally {
        await host.dispose();
    }
});

test('triggerMessageActionById: "regen" still throws when no #chat .mes element is present (unchanged this tier — a generation-menu path, untouched by the edit fork)', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 6;
        host.context.chat = buildChat(TARGET_ID, TARGET_ID + 1, {});

        await assert.rejects(
            () => messages.triggerMessageActionById(TARGET_ID, 'regen'),
            /Message element not found for regen/,
        );
    } finally {
        await host.dispose();
    }
});

test('triggerMessageActionById: "edit" is not dispatched here at all (Tier 3) — never reachable from the real UI to begin with (entering edit mode is local Preact state), a runtime "edit" string falls through to the same silent default no-op "delete" already uses', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 6;
        host.context.chat = buildChat(TARGET_ID, TARGET_ID + 1, { is_user: false, is_system: false, extra: {} });
        const beforeMes = host.context.chat[TARGET_ID].mes;

        host.registry.saveChatConditional = () => {
            throw new Error('the edit-save fork must never run for an "edit" action dispatched through triggerMessageActionById');
        };

        // Not a TypeScript-representable call (MessageAction no longer
        // includes 'edit'), but nothing stops a raw string reaching this
        // compiled JS function at runtime.
        await messages.triggerMessageActionById(TARGET_ID, 'edit');

        assert.equal(host.context.chat[TARGET_ID].mes, beforeMes, 'no message may be edited by this call');
    } finally {
        await host.dispose();
    }
});

// saveMessageEditById (src/adapter/messages.ts) — DOM-DECOUPLING.md Tier 3
// (2026-07-19) contract-test list: fixed inputs + tagged registry stubs for
// every pure function (getRegexedString/substituteParams/extractMessageBias/
// removeMacros/ensureSwipes) so composition ORDER is directly observable in
// the final string, not just "was called". Unlike Tier 1/2's edit path, this
// one is now fully DOM-free — no `#chat .mes[mesid="X"]` dependency anywhere
// — so it is unit-testable end to end for the first time.

test('saveMessageEditById: regexPlacement selection matches ST\'s own 3-branch is_user / narrator-type switch exactly (regex_placement.USER_INPUT=1, SLASH_COMMAND=3, AI_OUTPUT=2 — public/scripts/extensions/regex/engine.js)', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const placements = [];
        host.registry.getRegexedString = (text, placement) => { placements.push(placement); return text; };
        host.registry.substituteParams = (text) => text;
        host.registry.extractMessageBias = () => '';
        host.registry.removeMacros = (text) => text;
        host.registry.ensureSwipes = () => true;
        host.registry.saveChatConditional = () => undefined;
        host.registry.refreshSwipeButtons = () => undefined;

        host.context.chat = [
            { mes: 'x', swipes: ['x'], is_user: true, is_system: false, extra: {} },
            { mes: 'x', swipes: ['x'], is_user: false, is_system: false, extra: { type: 'narrator' } },
            { mes: 'x', swipes: ['x'], is_user: false, is_system: false, extra: {} },
        ];

        await messages.saveMessageEditById(0, 'text'); // is_user -> USER_INPUT
        await messages.saveMessageEditById(1, 'text'); // narrator -> SLASH_COMMAND
        await messages.saveMessageEditById(2, 'text'); // else -> AI_OUTPUT

        assert.deepEqual(placements, [1, 3, 2]);
    } finally {
        await host.dispose();
    }
});

test('saveMessageEditById: characterOverride passed to getRegexedString is each message\'s own name field (the correct per-member override in group chats, not a shared default), and is explicitly undefined for narrator-typed messages regardless of their own name', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const overrides = [];
        host.registry.getRegexedString = (text, _placement, opts) => { overrides.push(opts.characterOverride); return text; };
        host.registry.substituteParams = (text) => text;
        host.registry.extractMessageBias = () => '';
        host.registry.removeMacros = (text) => text;
        host.registry.ensureSwipes = () => true;
        host.registry.saveChatConditional = () => undefined;
        host.registry.refreshSwipeButtons = () => undefined;

        // Two different group members' own messages in the same chat array —
        // each edit must read *that* record's own `.name`, never some
        // shared group-wide default.
        host.context.chat = [
            { mes: 'x', swipes: ['x'], is_user: false, is_system: false, name: 'Aria', extra: {} },
            { mes: 'x', swipes: ['x'], is_user: false, is_system: false, name: 'Beorn', extra: {} },
            { mes: 'x', swipes: ['x'], is_user: false, is_system: false, name: 'Narrator Voice', extra: { type: 'narrator' } },
        ];

        await messages.saveMessageEditById(0, 'text');
        await messages.saveMessageEditById(1, 'text');
        await messages.saveMessageEditById(2, 'text');

        assert.deepEqual(overrides, ['Aria', 'Beorn', undefined]);
    } finally {
        await host.dispose();
    }
});

test('saveMessageEditById: getRegexedString -> substituteParams -> removeMacros compose in ST\'s exact order, extractMessageBias runs on the post-regex/pre-main-substitution text, and mes.mes/swipes[swipe_id] end up byte-identical', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 4;
        // is_system so the computed bias also persists to extra.bias below,
        // while regexPlacement selection (which only checks is_user/narrator,
        // never is_system) still resolves to AI_OUTPUT — pinning that
        // is_system does not affect placement selection.
        host.context.chat = buildChat(TARGET_ID, 6, {
            is_user: false, is_system: true, name: 'System', extra: {}, swipe_id: 0, swipes: ['old'],
        });
        host.context.chatMetadata = {};

        host.registry.getRegexedString = (text, placement, opts) => `R[${placement}|${opts.characterOverride}|${opts.isEdit}](${text})`;
        host.registry.substituteParams = (text) => `S(${text})`;
        host.registry.extractMessageBias = (text) => `B(${text})`;
        host.registry.removeMacros = (text) => `M(${text})`;
        host.registry.ensureSwipes = () => true;
        host.registry.saveChatConditional = () => undefined;
        host.registry.refreshSwipeButtons = () => undefined;

        await messages.saveMessageEditById(TARGET_ID, 'RAW');

        const mes = host.context.chat[TARGET_ID];
        assert.equal(mes.mes, 'M(S(R[2|System|true](RAW)))', 'final text: regex, then substituteParams, then removeMacros (bias was truthy)');
        assert.equal(mes.swipes[0], mes.mes, 'the active swipe slot mirrors mes.mes exactly');
        assert.equal(mes.extra.bias, 'S(B(R[2|System|true](RAW)))', 'bias = substituteParams(extractMessageBias(...)) applied to the post-regex text, before that same text is fed through the main substituteParams call');
        assert.equal(host.context.chatMetadata.tainted, true);
    } finally {
        await host.dispose();
    }
});

test('saveMessageEditById: extra.bias is set to the computed bias only for is_system/is_user/narrator messages; every other message type gets extra.bias forced to null even though the same truthy bias still gated removeMacros for all of them', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        host.registry.getRegexedString = (text) => text;
        host.registry.substituteParams = (text) => text;
        host.registry.extractMessageBias = () => ' {{bias tagged}}';
        host.registry.removeMacros = (text) => text;
        host.registry.ensureSwipes = () => true;
        host.registry.saveChatConditional = () => undefined;
        host.registry.refreshSwipeButtons = () => undefined;

        const cases = [
            { label: 'is_user', overrides: { is_user: true, is_system: false, extra: {} } },
            { label: 'is_system', overrides: { is_user: false, is_system: true, extra: {} } },
            { label: 'narrator', overrides: { is_user: false, is_system: false, extra: { type: 'narrator' } } },
        ];

        for (const { label, overrides } of cases) {
            const TARGET_ID = 2;
            host.context.chat = buildChat(TARGET_ID, 5, overrides);
            await messages.saveMessageEditById(TARGET_ID, 'text');
            assert.equal(host.context.chat[TARGET_ID].extra.bias, ' {{bias tagged}}', `${label}: bias must persist`);
        }

        const TARGET_ID = 2;
        host.context.chat = buildChat(TARGET_ID, 5, { is_user: false, is_system: false, extra: {} });
        await messages.saveMessageEditById(TARGET_ID, 'text');
        assert.equal(host.context.chat[TARGET_ID].extra.bias, null, 'plain AI message: bias forced to null');
    } finally {
        await host.dispose();
    }
});

test('saveMessageEditById: ensureSwipes runs strictly before the swipes[swipe_id] write — the write must land on top of whatever ensureSwipes just created, not the other way around', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 3;
        host.context.chat = buildChat(TARGET_ID, 5, { is_user: false, is_system: false, extra: {}, swipe_id: 0 });
        delete host.context.chat[TARGET_ID].swipes;

        host.registry.getRegexedString = (text) => text;
        host.registry.substituteParams = (text) => text;
        host.registry.extractMessageBias = () => '';
        host.registry.removeMacros = (text) => text;
        host.registry.ensureSwipes = (mes) => { mes.swipes = ['not-yet-written']; return true; };
        host.registry.saveChatConditional = () => undefined;
        host.registry.refreshSwipeButtons = () => undefined;

        await messages.saveMessageEditById(TARGET_ID, 'edited');

        assert.equal(host.context.chat[TARGET_ID].swipes[0], 'edited', 'the write must overwrite the array ensureSwipes just created');
    } finally {
        await host.dispose();
    }
});

test('saveMessageEditById: trims text after regex, only when power_user.trim_spaces is truthy', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        host.registry.getRegexedString = (text) => text;
        host.registry.substituteParams = (text) => text;
        host.registry.extractMessageBias = () => '';
        host.registry.removeMacros = (text) => text;
        host.registry.ensureSwipes = () => true;
        host.registry.saveChatConditional = () => undefined;
        host.registry.refreshSwipeButtons = () => undefined;

        const TARGET_ID = 1;
        host.context.powerUserSettings = { trim_spaces: false };
        host.context.chat = buildChat(TARGET_ID, 4, { is_user: false, is_system: false, extra: {} });
        await messages.saveMessageEditById(TARGET_ID, '  padded  ');
        assert.equal(host.context.chat[TARGET_ID].mes, '  padded  ', 'trim_spaces off: whitespace preserved');

        host.context.powerUserSettings = { trim_spaces: true };
        host.context.chat = buildChat(TARGET_ID, 4, { is_user: false, is_system: false, extra: {} });
        await messages.saveMessageEditById(TARGET_ID, '  padded  ');
        assert.equal(host.context.chat[TARGET_ID].mes, 'padded', 'trim_spaces on: leading/trailing whitespace stripped');
    } finally {
        await host.dispose();
    }
});

test('saveMessageEditById: initializes a missing extra object before touching it, mirroring native\'s mes.extra ??= {} guard', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        host.registry.getRegexedString = (text) => text;
        host.registry.substituteParams = (text) => text;
        host.registry.extractMessageBias = () => '';
        host.registry.removeMacros = (text) => text;
        host.registry.ensureSwipes = () => true;
        host.registry.saveChatConditional = () => undefined;
        host.registry.refreshSwipeButtons = () => undefined;

        const TARGET_ID = 1;
        host.context.chat = buildChat(TARGET_ID, 3, { is_user: false, is_system: false, extra: undefined });
        await messages.saveMessageEditById(TARGET_ID, 'text');

        const extra = host.context.chat[TARGET_ID].extra;
        assert.ok(extra && typeof extra === 'object', 'extra must be initialized to an object');
        assert.equal(extra.bias, null);
    } finally {
        await host.dispose();
    }
});

test('saveMessageEditById: emits MESSAGE_EDITED strictly before MESSAGE_UPDATED, both with exactly the numeric message id as their sole argument', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 5;
        host.context.chat = buildChat(TARGET_ID, 7, { is_user: false, is_system: false, extra: {} });
        host.registry.getRegexedString = (text) => text;
        host.registry.substituteParams = (text) => text;
        host.registry.extractMessageBias = () => '';
        host.registry.removeMacros = (text) => text;
        host.registry.ensureSwipes = () => true;
        host.registry.saveChatConditional = () => undefined;
        host.registry.refreshSwipeButtons = () => undefined;

        const events = [];
        host.eventSource.on(host.event_types.MESSAGE_EDITED, (id) => events.push(['MESSAGE_EDITED', id]));
        host.eventSource.on(host.event_types.MESSAGE_UPDATED, (id) => events.push(['MESSAGE_UPDATED', id]));

        await messages.saveMessageEditById(TARGET_ID, 'text');

        assert.deepEqual(events, [
            ['MESSAGE_EDITED', TARGET_ID],
            ['MESSAGE_UPDATED', TARGET_ID],
        ]);
    } finally {
        await host.dispose();
    }
});

test('saveMessageEditById: saves via saveChatConditional (not saveChatDebounced), and refreshes swipe buttons afterward, in that exact order', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 2;
        host.context.chat = buildChat(TARGET_ID, 4, { is_user: false, is_system: false, extra: {} });
        host.registry.getRegexedString = (text) => text;
        host.registry.substituteParams = (text) => text;
        host.registry.extractMessageBias = () => '';
        host.registry.removeMacros = (text) => text;
        host.registry.ensureSwipes = () => true;

        const calls = [];
        host.registry.saveChatConditional = () => calls.push('saveChatConditional');
        host.registry.saveChatDebounced = () => calls.push('saveChatDebounced');
        host.registry.refreshSwipeButtons = () => calls.push('refreshSwipeButtons');

        await messages.saveMessageEditById(TARGET_ID, 'text');

        assert.deepEqual(calls, ['saveChatConditional', 'refreshSwipeButtons']);
    } finally {
        await host.dispose();
    }
});

test('saveMessageEditById: never calls getContext().updateMessageBlock when the message row is not currently rendered', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 3;
        host.context.chat = buildChat(TARGET_ID, 5, { is_user: false, is_system: false, extra: {} });
        host.registry.getRegexedString = (text) => text;
        host.registry.substituteParams = (text) => text;
        host.registry.extractMessageBias = () => '';
        host.registry.removeMacros = (text) => text;
        host.registry.ensureSwipes = () => true;
        host.registry.saveChatConditional = () => undefined;
        host.registry.refreshSwipeButtons = () => undefined;
        host.registry.updateMessageBlock = () => {
            throw new Error('updateMessageBlock must never be called when nothing renders this row (no #chat, or #chat with no matching row)');
        };

        // No #chat container at all this time.
        await messages.saveMessageEditById(TARGET_ID, 'text');
    } finally {
        await host.dispose();
    }
});

test('saveMessageEditById: heals a currently-rendered native row via getContext().updateMessageBlock — called with the id and the exact same live mes reference it just mutated, strictly between MESSAGE_EDITED and MESSAGE_UPDATED', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 3;
        host.context.chat = buildChat(TARGET_ID, 5, { is_user: false, is_system: false, extra: {} });
        const chatContainer = createChatContainer();
        appendMesRow(chatContainer, TARGET_ID);

        host.registry.getRegexedString = (text) => text;
        host.registry.substituteParams = (text) => text;
        host.registry.extractMessageBias = () => '';
        host.registry.removeMacros = (text) => text;
        host.registry.ensureSwipes = () => true;
        host.registry.saveChatConditional = () => undefined;
        host.registry.refreshSwipeButtons = () => undefined;

        const order = [];
        host.eventSource.on(host.event_types.MESSAGE_EDITED, () => order.push('MESSAGE_EDITED'));
        host.eventSource.on(host.event_types.MESSAGE_UPDATED, () => order.push('MESSAGE_UPDATED'));
        let healedWith = null;
        host.registry.updateMessageBlock = (id, mes) => { healedWith = [id, mes]; order.push('updateMessageBlock'); };

        await messages.saveMessageEditById(TARGET_ID, 'edited text');

        assert.deepEqual(order, ['MESSAGE_EDITED', 'updateMessageBlock', 'MESSAGE_UPDATED']);
        assert.equal(healedWith[0], TARGET_ID);
        assert.equal(healedWith[1], host.context.chat[TARGET_ID], 'must pass the exact same live mes reference, not a copy');
        assert.equal(healedWith[1].mes, 'edited text');
    } finally {
        await host.dispose();
    }
});

test('saveMessageEditById: rejects a non-finite message id before touching the host', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        await assert.rejects(
            () => messages.saveMessageEditById(Number.NaN, 'text'),
            /Invalid message id for edit/,
        );
    } finally {
        await host.dispose();
    }
});

test('saveMessageEditById: throws when no message record exists at that id, without tainting chat_metadata or emitting MESSAGE_EDITED', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        host.context.chat = [];
        host.context.chatMetadata = {};
        let emitted = false;
        host.eventSource.on(host.event_types.MESSAGE_EDITED, () => { emitted = true; });

        await assert.rejects(
            () => messages.saveMessageEditById(3, 'text'),
            /Message record not found for edit/,
        );

        assert.equal(host.context.chatMetadata.tainted, undefined);
        assert.equal(emitted, false);
    } finally {
        await host.dispose();
    }
});
