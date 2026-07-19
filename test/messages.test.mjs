// test/messages.test.mjs
//
// dist/runtime/adapter/messages.js delete/swipe/hide/copy/branch/checkpoint
// argument matrix. Source: src/adapter/messages.ts (getDeleteEligibility,
// getConfirmMessageDeleteSetting, deleteMessageWithIntent, _deleteSwipeById,
// swipeMessage, toggleHideMessage, copyMessage, createBranch,
// createCheckpoint, triggerMessageActionById). These delegate to @st/script's
// exported saveChatDebounced/setEditedMessageId/refreshSwipeButtons/
// updateEditArrowClasses/syncSwipeToMes/swipe/saveChatConditional/
// eventSource, @st/itemized-prompts's deleteItemizedPromptForMessage,
// @st/bookmarks's branchChat/createNewBookmark, @st/chats's
// hideChatMessage/unhideChatMessage, and @st/utils's copyText — wrong
// arguments here silently destroy the wrong swipe or the wrong message, so
// every branch of ST's native .mes_edit_delete policy is pinned exactly, not
// just "was called".
//
// DOM-DECOUPLING.md Tier 1: copy / branch / checkpoint / hide never require a
// live `.mes` node and read nothing but `getContext().chat` (via
// getMessageById), so a plain numeric id — no `.mes` element, real or fake —
// drives every one of them, including through the shared
// triggerMessageActionById dispatch entry point. edit and regen are
// unchanged this tier: they still resolve `#chat .mes[mesid="X"]` via
// getMessageElementById, a compound selector the fake DOM deliberately
// doesn't support (see test/helpers/fake-st-host.mjs's module doc comment),
// so those two remain a Chromium e2e concern, not a unit-test one.
//
// DOM-DECOUPLING.md Tier 2 (2026-07-19): full-message delete is now a thin
// fork too (_deleteFullMessageById, tested below via deleteMessageWithIntent)
// — DOM-*tolerant*, not DOM-gated. `_deleteFullMessageById` still can't have
// its own `mesEl?.remove()` step exercised here — like edit/regen above, that
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

test('deleteMessageWithIntent: "message" intent (the full-message fork) reproduces the exact native post-gate sequence — splice, tainted, itemized-prompt invalidation, DOM-tolerant renumber, debounced save, this_edit_mes_id reset, refreshSwipeButtons, MESSAGE_DELETED payload — in ST\'s exact order, entirely without a rendered .mes node', async () => {
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
        host.registry.setEditedMessageId = (value) => calls.push(['setEditedMessageId', value]);
        host.registry.refreshSwipeButtons = () => calls.push(['refreshSwipeButtons']);
        host.eventSource.on(host.event_types.MESSAGE_DELETED, (chatLength) => calls.push(['MESSAGE_DELETED', chatLength]));

        // A dangling shadow from a prior failed edit-save on this exact id —
        // see _shadowEditedMessageId's doc comment in src/adapter/messages.ts.
        messages.__setShadowEditedMessageIdForTesting(TARGET_ID);

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
            ['setEditedMessageId', undefined],
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
        host.registry.setEditedMessageId = () => undefined;
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
        host.registry.setEditedMessageId = () => undefined;
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
        host.registry.setEditedMessageId = () => undefined;
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
        host.registry.setEditedMessageId = () => undefined;
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

test('deleteMessageWithIntent: "message" intent resets the this_edit_mes_id shadow and calls setEditedMessageId(undefined) only when the shadow equals the deleted id, never for a different message', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        host.registry.deleteItemizedPromptForMessage = () => undefined;
        host.registry.updateEditArrowClasses = () => undefined;
        host.registry.saveChatDebounced = () => undefined;
        host.registry.refreshSwipeButtons = () => undefined;

        const setCalls = [];
        host.registry.setEditedMessageId = (value) => setCalls.push(value);

        // The shadow tracks a *different* message than the one being deleted.
        host.context.chat = buildChat(2, 5, {});
        messages.__setShadowEditedMessageIdForTesting(9);
        await messages.deleteMessageWithIntent(2, 'message');
        assert.deepEqual(setCalls, [], 'a shadow tracking a different id must be left untouched');

        // The shadow tracks exactly the message now being deleted.
        host.context.chat = buildChat(1, 5, {});
        messages.__setShadowEditedMessageIdForTesting(1);
        await messages.deleteMessageWithIntent(1, 'message');
        assert.deepEqual(setCalls, [undefined], 'the shadow tracking the deleted id must be reset via setEditedMessageId(undefined)');
    } finally {
        await host.dispose();
    }
});

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

test('copyMessage: reads the live message by id and forwards its mes text to copyText, with no DOM element required', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 2;
        host.context.chat = buildChat(TARGET_ID, TARGET_ID + 1, { mes: 'copy this exact text' });

        let copied;
        host.registry.copyText = (text) => {
            copied = text;
        };

        await messages.copyMessage(TARGET_ID);

        assert.equal(copied, 'copy this exact text');
    } finally {
        await host.dispose();
    }
});

test('copyMessage: rejects a negative or non-integer message id before touching the host', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        host.registry.copyText = () => {
            throw new Error('copyText must not be called for an invalid id');
        };

        await assert.rejects(
            () => messages.copyMessage('not-a-number'),
            /Invalid message id for copy/,
        );
        await assert.rejects(
            () => messages.copyMessage(-1),
            /Invalid message id for copy/,
        );
    } finally {
        await host.dispose();
    }
});

test('copyMessage: throws when no message record exists at that id, without calling copyText', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        host.context.chat = []; // id 0 out of range
        host.registry.copyText = () => {
            throw new Error('copyText must not be called when the record is missing');
        };

        await assert.rejects(
            () => messages.copyMessage(0),
            /Message record not found for copy: 0/,
        );
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

test('triggerMessageActionById: copy/branch/checkpoint/hide all resolve with no #chat .mes element present in the DOM (Tier 1)', async () => {
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
        await messages.triggerMessageActionById(TARGET_ID, 'copy');
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

test('triggerMessageActionById: edit and regen still throw when no #chat .mes element is present (unchanged this tier)', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 6;
        host.context.chat = buildChat(TARGET_ID, TARGET_ID + 1, {});

        await assert.rejects(
            () => messages.triggerMessageActionById(TARGET_ID, 'edit'),
            /Message element not found for edit/,
        );
        await assert.rejects(
            () => messages.triggerMessageActionById(TARGET_ID, 'regen'),
            /Message element not found for regen/,
        );
    } finally {
        await host.dispose();
    }
});

// saveMessageEditById (src/adapter/messages.ts, editMessage-saving path) is
// not drivable end-to-end through this harness: it needs
// getMessageElementById() to resolve `#chat .mes[mesid="X"]`, a compound
// selector the fake DOM deliberately doesn't support (see
// test/helpers/fake-st-host.mjs's module doc comment) — so
// getMessageElementById() always returns null here, the same gap noted above
// for triggerMessageActionById('edit'|'regen', ...).
//
// _dispatchClickAndWait() (src/adapter/internals.ts) — the piece that changed
// and the one that can wedge the shared host-operation queue forever with
// zero diagnostics if it fails open — is exported standalone and needs
// nothing but a fake jQuery, so it's driven directly here instead.
function installFakeJQuery(host, resultForClick) {
    host.window.$ = Object.assign(
        () => ({
            // Real jQuery's .trigger() runs the delegated handler chain
            // synchronously and leaves its return value on event.result
            // before returning, which is exactly what messages.ts relies on.
            trigger(event) {
                event.result = typeof resultForClick === 'function' ? resultForClick() : resultForClick;
            },
        }),
        { Event: (type) => ({ type, result: undefined }) },
    );
}

test('_dispatchClickAndWait rejects with a descriptive error instead of hanging forever when the delegated handler returns no awaitable result', async () => {
    const host = await createFakeStHost();
    try {
        const internals = await host.importModule('adapter/internals.js');
        installFakeJQuery(host, 'not-a-promise');

        const button = document.createElement('button');
        button.id = 'mes_edit_done';

        await assert.rejects(internals._dispatchClickAndWait(button), (error) => {
            assert.match(error.message, /did not return an awaitable result/);
            return true;
        });
    } finally {
        await host.dispose();
    }
});

test('_dispatchClickAndWait resolves with the delegated handler\'s settled value when it returns a real promise', async () => {
    const host = await createFakeStHost();
    try {
        const internals = await host.importModule('adapter/internals.js');
        installFakeJQuery(host, () => Promise.resolve('messageEditDone-result'));

        const button = document.createElement('button');
        const value = await internals._dispatchClickAndWait(button, 50);

        assert.equal(value, 'messageEditDone-result');
    } finally {
        await host.dispose();
    }
});

test('_dispatchClickAndWait rejects with a distinct timeout error instead of hanging forever when the delegated handler\'s promise never settles', async () => {
    const host = await createFakeStHost();
    try {
        const internals = await host.importModule('adapter/internals.js');
        // A promise that never resolves/rejects — the old code's failure-open
        // path (`new Promise(() => undefined)`) reproduced exactly this shape.
        installFakeJQuery(host, () => new Promise(() => undefined));

        const button = document.createElement('button');

        await assert.rejects(internals._dispatchClickAndWait(button, 20), (error) => {
            assert.match(error.message, /timed out after 20ms/);
            return true;
        });
    } finally {
        await host.dispose();
    }
});

test('_dispatchClickAndWait propagates a rejection from the delegated handler\'s promise', async () => {
    const host = await createFakeStHost();
    try {
        const internals = await host.importModule('adapter/internals.js');
        installFakeJQuery(host, () => Promise.reject(new Error('native save failed')));

        const button = document.createElement('button');

        await assert.rejects(internals._dispatchClickAndWait(button, 50), /native save failed/);
    } finally {
        await host.dispose();
    }
});
