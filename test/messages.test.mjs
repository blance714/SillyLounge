// test/messages.test.mjs
//
// dist/runtime/adapter/messages.js delete/swipe/hide/copy/branch/checkpoint
// argument matrix. Source: src/adapter/messages.ts (deleteMessage,
// _deleteSwipeById, swipeMessage, toggleHideMessage, copyMessage,
// createBranch, createCheckpoint, triggerMessageActionById). These delegate
// to @st/script's exported deleteMessage/syncSwipeToMes/swipe/
// saveChatConditional/eventSource, @st/bookmarks's
// branchChat/createNewBookmark, @st/chats's
// hideChatMessage/unhideChatMessage, and @st/utils's copyText — wrong
// arguments here silently destroy the wrong swipe or the wrong message, so
// every branch of ST's native .mes_edit_delete policy
// (src/adapter/messages.ts's deleteMessage) is pinned exactly, not just
// "was called".
//
// DOM-DECOUPLING.md Tier 1: copy / branch / checkpoint / hide / delete(仅
// swipe) are id-based and read nothing but `getContext().chat` (via
// getMessageById), so a plain numeric id — no `.mes` element, real or fake —
// drives every one of them, including through the shared
// triggerMessageActionById dispatch entry point. edit and regen are
// unchanged this tier: they still resolve `#chat .mes[mesid="X"]` via
// getMessageElementById, a compound selector the fake DOM deliberately
// doesn't support (see test/helpers/fake-st-host.mjs's module doc comment),
// so those two remain a Chromium e2e concern, not a unit-test one.
//
// 2026-07-19 adversarial-review fixes (three high-severity findings closed):
//
// 1. delete(仅 swipe)'s `_deleteSwipeById` is now a full mini-fork of ST's
//    deleteSwipe() (splice/swipe_id/tainted/MESSAGE_SWIPE_DELETED/
//    syncSwipeToMes/saveChatConditional, all reimplemented directly against
//    the live chat[] entry) instead of calling ST's exported deleteSwipe()
//    at all — deleteSwipe()'s own active-swipe branch calls ST's swipe()
//    internally, which sets the module-global `swipeState = SWIPING` before
//    its own DOM gate can bail on an unrendered message, with no exported
//    reset path. Every test below that drives the swipe-only branch also
//    proves ST's `deleteSwipe`/`swipe` stubs are never invoked.
// 2. The swipe-only branch now shows the exact confirm popup ST's own
//    deleteMessage() used to show (getContext().callGenericPopup/
//    POPUP_TYPE/POPUP_RESULT/t — all reachable through the already-mapped
//    @st/st-context module, no new @st/* target needed) before mutating
//    anything; cancelling aborts with zero mutation, and the "Delete
//    Message" custom button escalates to the (still DOM-gated) full-message
//    path with no second popup.
// 3. Full-message delete regained an explicit DOM gate
//    (_deleteFullMessageById in src/adapter/messages.ts) that throws a
//    descriptive "...Tier 2 lands" error instead of the silent no-op ST's
//    own internal gate would otherwise produce — delete(仅 swipe) alone
//    stays gateless. The full {confirm}x{is_user}x{swipes}x{isLast} matrix
//    test below exercises both sides of that split explicitly.

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

test('deleteMessage: full {confirm} x {is_user} x {swipes>1} x {isLast} matrix routes to the swipe-only mini-fork (behind a confirm popup) or the DOM-gated full-message path exactly as ST\'s own policy would', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 3;

        const booleans = [true, false];
        for (const confirm of booleans) {
            for (const isUser of booleans) {
                for (const swipesLen of [1, 2]) {
                    for (const isLast of booleans) {
                        const label = `confirm=${confirm} isUser=${isUser} swipes=${swipesLen} isLast=${isLast}`;
                        // Last valid index — non-zero exactly when swipesLen===2, the
                        // only swipesLen value that can reach the swipe-only branch —
                        // proving the real index is forwarded, not a hardcoded 0.
                        const selectedSwipe = swipesLen - 1;

                        const chatLength = isLast ? TARGET_ID + 1 : TARGET_ID + 2;
                        const chat = buildChat(TARGET_ID, chatLength, {
                            swipes: Array.from({ length: swipesLen }, (_, i) => `swipe-${i}`),
                            swipe_id: selectedSwipe,
                            is_user: isUser,
                        });
                        host.context.chat = chat;
                        host.context.powerUserSettings = { confirm_message_delete: confirm };

                        let deleteMessageArgs;
                        host.registry.deleteMessage = (...args) => {
                            deleteMessageArgs = args;
                        };
                        let popupCalled = false;
                        host.registry.callGenericPopup = async () => {
                            popupCalled = true;
                            return host.context.POPUP_RESULT.AFFIRMATIVE;
                        };
                        host.registry.syncSwipeToMes = () => undefined;
                        host.registry.saveChatConditional = () => undefined;
                        host.registry.deleteSwipe = () => {
                            throw new Error(`${label}: ST's deleteSwipe must never be called — the mini-fork bypasses it`);
                        };
                        host.registry.swipe = () => {
                            throw new Error(`${label}: ST's swipe must never be called — it is the only path that can wedge swipeState`);
                        };

                        const canDeleteSwipe = confirm && !isUser && swipesLen > 1 && isLast;

                        if (canDeleteSwipe) {
                            let emitted;
                            const onSwipeDeleted = (payload) => { emitted = payload; };
                            host.eventSource.on(host.event_types.MESSAGE_SWIPE_DELETED, onSwipeDeleted);

                            await messages.deleteMessage(TARGET_ID);

                            host.eventSource.removeListener(host.event_types.MESSAGE_SWIPE_DELETED, onSwipeDeleted);

                            assert.equal(popupCalled, true, `${label}: confirm popup must be shown`);
                            assert.equal(deleteMessageArgs, undefined, `${label}: stDeleteMessage must not be called`);
                            assert.equal(chat[TARGET_ID].swipes.length, swipesLen - 1, `${label}: swipe array must shrink by one`);
                            // swipesLen is always 2 on this branch (swipes>1 required), so
                            // deleting the sole other swipe always collapses newSwipeId to 0.
                            assert.deepEqual(
                                emitted,
                                { messageId: TARGET_ID, swipeId: selectedSwipe, newSwipeId: 0 },
                                label,
                            );
                        } else {
                            // Full-message delete stays DOM-gated (Tier 2 pending); the
                            // fake DOM can never resolve a compound `.mes[mesid=X]`
                            // selector (see module doc comment), so every full-delete
                            // call here must throw the explicit gate error rather than
                            // silently no-op or proceed.
                            await assert.rejects(
                                () => messages.deleteMessage(TARGET_ID),
                                /Message element not found for delete/,
                                label,
                            );
                            assert.equal(popupCalled, false, `${label}: confirm popup must not be shown off the swipe-only branch`);
                            assert.equal(deleteMessageArgs, undefined, `${label}: stDeleteMessage must not be reached behind the gate`);
                        }
                    }
                }
            }
        }
    } finally {
        await host.dispose();
    }
});

test('deleteMessage: an undefined swipe_id blocks swipe-only delete even when every other condition aligns', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 1;

        // confirm=true, is_user=false, swipes.length>1, isLast=true — but no
        // swipe_id on the record, so `selectedSwipe !== undefined` fails and
        // the whole message must be deleted instead of just the swipe. That
        // full-message path is DOM-gated (Tier 2 pending), so it must throw
        // here rather than silently proceeding.
        host.context.chat = buildChat(TARGET_ID, TARGET_ID + 1, {
            swipes: ['a', 'b', 'c'],
            swipe_id: undefined,
            is_user: false,
        });
        host.context.powerUserSettings = { confirm_message_delete: true };

        host.registry.callGenericPopup = () => {
            throw new Error('the confirm popup must not be shown without a selected swipe');
        };
        host.registry.deleteMessage = () => {
            throw new Error('stDeleteMessage is unreachable behind the DOM gate in this harness');
        };

        await assert.rejects(
            () => messages.deleteMessage(TARGET_ID),
            /Message element not found for delete/,
        );
    } finally {
        await host.dispose();
    }
});

test('deleteMessage: confirm_message_delete is coerced to a strict boolean before gating the swipe-only branch on, not forwarded as-is', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 1;
        const buildEligibleChat = () => buildChat(TARGET_ID, TARGET_ID + 1, {
            swipes: ['a', 'b'],
            swipe_id: 1,
            is_user: false,
        });

        // Truthy non-boolean setting value must still gate the swipe-only
        // branch on — proving it was coerced to boolean true, not forwarded
        // as the raw string (a raw-string `&&` chain would also be truthy,
        // but a strict-boolean bug elsewhere in the chain would show up as
        // the popup never firing).
        host.context.chat = buildEligibleChat();
        host.context.powerUserSettings = { confirm_message_delete: 'yes' };
        let popupCalled = false;
        host.registry.callGenericPopup = async () => {
            popupCalled = true;
            return host.context.POPUP_RESULT.CANCELLED;
        };
        await messages.deleteMessage(TARGET_ID);
        assert.equal(popupCalled, true, 'a truthy non-boolean confirm_message_delete must still gate the swipe-only branch on');

        // powerUserSettings missing entirely — optional chaining must not
        // throw, and must coerce confirm to false, falling through to the
        // (DOM-gated) full-message path instead of the popup.
        host.context.chat = buildEligibleChat();
        host.context.powerUserSettings = undefined;
        popupCalled = false;
        await assert.rejects(
            () => messages.deleteMessage(TARGET_ID),
            /Message element not found for delete/,
        );
        assert.equal(popupCalled, false, 'missing powerUserSettings must coerce confirm to false, not throw, and must skip the popup');
    } finally {
        await host.dispose();
    }
});

test('deleteMessage: rejects a negative or non-integer message id before touching the host', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        host.registry.deleteMessage = () => {
            throw new Error('deleteMessage must not be called for an invalid id');
        };

        await assert.rejects(
            () => messages.deleteMessage('not-a-number'),
            /Invalid message id for delete/,
        );
        await assert.rejects(
            () => messages.deleteMessage(-1),
            /Invalid message id for delete/,
        );
    } finally {
        await host.dispose();
    }
});

test('deleteMessage: throws when the message record cannot be found at that id', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        host.context.chat = []; // id 0 is out of range
        host.registry.deleteMessage = () => {
            throw new Error('deleteMessage must not be called when the record is missing');
        };

        await assert.rejects(
            () => messages.deleteMessage(0),
            /Message record not found for delete: 0/,
        );
    } finally {
        await host.dispose();
    }
});

test('deleteMessage: the full-message DOM gate error explains the Tier 2 asymmetry, not just "not found"', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 0;
        host.context.chat = buildChat(TARGET_ID, TARGET_ID + 1, { is_user: true });

        await assert.rejects(
            () => messages.deleteMessage(TARGET_ID),
            (error) => {
                assert.match(error.message, /Message element not found for delete/);
                assert.match(error.message, /DOM-DECOUPLING\.md Tier 2/);
                return true;
            },
        );
    } finally {
        await host.dispose();
    }
});

test('deleteMessage: swipe-only branch aborts with zero mutation and no host call when the user cancels the confirm popup', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 2;
        host.context.chat = buildChat(TARGET_ID, TARGET_ID + 1, {
            swipes: ['a', 'b'],
            swipe_id: 1,
            is_user: false,
        });
        host.context.powerUserSettings = { confirm_message_delete: true };

        let popupArgs;
        host.registry.callGenericPopup = async (...args) => {
            popupArgs = args;
            return host.context.POPUP_RESULT.CANCELLED;
        };
        host.registry.deleteSwipe = () => {
            throw new Error('deleteSwipe must not be called when the popup is cancelled');
        };
        host.registry.deleteMessage = () => {
            throw new Error('stDeleteMessage must not be called when the popup is cancelled');
        };
        host.registry.saveChatConditional = () => {
            throw new Error('saveChatConditional must not be called when the popup is cancelled');
        };

        const beforeSwipes = [...host.context.chat[TARGET_ID].swipes];
        await messages.deleteMessage(TARGET_ID);

        assert.deepEqual(host.context.chat[TARGET_ID].swipes, beforeSwipes, 'cancelling must leave swipes untouched');
        // Mirrors ST's own wording exactly (script.js:1638-1647's
        // askConfirmation branch, canDeleteSwipe===true case).
        assert.equal(popupArgs[0], 'Are you sure you want to delete this message?');
        assert.equal(popupArgs[1], host.context.POPUP_TYPE.CONFIRM);
        assert.equal(popupArgs[2], null);
        assert.deepEqual(popupArgs[3], {
            okButton: 'Delete Swipe',
            cancelButton: 'Cancel',
            customButtons: ['Delete Message'],
        });
    } finally {
        await host.dispose();
    }
});

test('deleteMessage: swipe-only branch escalates to the DOM-gated full-message delete when the user picks "Delete Message" in the popup, with no second confirmation', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 2;
        host.context.chat = buildChat(TARGET_ID, TARGET_ID + 1, {
            swipes: ['a', 'b'],
            swipe_id: 1,
            is_user: false,
        });
        host.context.powerUserSettings = { confirm_message_delete: true };

        let popupCalls = 0;
        host.registry.callGenericPopup = async () => {
            popupCalls += 1;
            return host.context.POPUP_RESULT.CUSTOM1; // "Delete Message"
        };
        host.registry.deleteSwipe = () => {
            throw new Error('deleteSwipe must not be called once the user escalates to a full delete');
        };

        // Escalating still routes through the DOM-gated full-message path —
        // unrendered in this harness, so it must throw, not silently delete
        // or show a second popup.
        await assert.rejects(
            () => messages.deleteMessage(TARGET_ID),
            /Message element not found for delete/,
        );
        assert.equal(popupCalls, 1, 'escalating must not reopen the popup a second time');
    } finally {
        await host.dispose();
    }
});

test('deleteMessage: swipe-only branch never calls ST\'s deleteSwipe/swipe internals and leaves swipeState untouched (closes the swipeState-lockout corruption path)', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 4;
        host.context.chat = buildChat(TARGET_ID, TARGET_ID + 1, {
            swipes: ['a', 'b'],
            swipe_id: 1,
            is_user: false,
        });
        host.context.powerUserSettings = { confirm_message_delete: true };
        host.registry.callGenericPopup = async () => host.context.POPUP_RESULT.AFFIRMATIVE;
        host.registry.syncSwipeToMes = () => undefined;
        host.registry.saveChatConditional = () => undefined;
        host.registry.deleteSwipe = () => {
            throw new Error('deleteSwipe must never be called — the mini-fork bypasses it entirely');
        };
        host.registry.swipe = () => {
            throw new Error('swipe must never be called — it is the only path that can wedge swipeState');
        };
        host.state.setSwipeState('none');

        await messages.deleteMessage(TARGET_ID);

        assert.equal(host.state.swipeState, 'none', 'swipeState must be left exactly as it was — no code path here can touch it');
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

test('triggerMessageActionById: copy/branch/checkpoint/hide/delete(仅 swipe) all resolve with no #chat .mes element present in the DOM (Tier 1)', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 6;
        // Deliberately never create or register a `.mes[mesid="6"]` node —
        // getMessageElementById() always returns null in this harness anyway
        // (compound selectors are out of scope for the fake DOM), which is
        // exactly the "unrendered message" shape Tier 1 exists to survive.
        // delete specifically needs the swipe-only sub-case (multi-swipe,
        // not-user, last message, swipe_id set) to stay gateless — the
        // full-message sub-case is deliberately still DOM-gated (finding 3
        // of the 2026-07-19 review); see the dedicated negative test below.
        host.context.chat = buildChat(TARGET_ID, TARGET_ID + 1, {
            swipes: ['s0', 's1'],
            swipe_id: 1,
            is_user: false,
            is_system: false,
        });
        host.context.powerUserSettings = { confirm_message_delete: true };

        host.registry.copyText = () => undefined;
        host.registry.branchChat = () => undefined;
        host.registry.createNewBookmark = () => undefined;
        host.registry.hideChatMessage = () => undefined;
        host.registry.callGenericPopup = async () => host.context.POPUP_RESULT.AFFIRMATIVE;
        host.registry.syncSwipeToMes = () => undefined;
        host.registry.saveChatConditional = () => undefined;
        host.registry.deleteMessage = () => {
            throw new Error('stDeleteMessage must not be reached for the swipe-only sub-case');
        };

        // None of these may throw "Message element not found" — that gate is
        // gone for exactly these five (delete's swipe-only sub-case here).
        await messages.triggerMessageActionById(TARGET_ID, 'copy');
        await messages.triggerMessageActionById(TARGET_ID, 'branch');
        await messages.triggerMessageActionById(TARGET_ID, 'checkpoint');
        await messages.triggerMessageActionById(TARGET_ID, 'hide');
        await messages.triggerMessageActionById(TARGET_ID, 'delete');
    } finally {
        await host.dispose();
    }
});

test('triggerMessageActionById: delete throws "Message element not found" for the full-message sub-case when no #chat .mes element is present (stays DOM-gated this tier)', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 6;
        // is_user: true forces the full-message sub-case regardless of
        // confirm_message_delete/swipe count/isLast.
        host.context.chat = buildChat(TARGET_ID, TARGET_ID + 1, {
            swipes: ['s0'],
            is_user: true,
            is_system: false,
        });
        host.context.powerUserSettings = { confirm_message_delete: true };
        host.registry.deleteMessage = () => {
            throw new Error('stDeleteMessage must not be reached behind the gate');
        };

        await assert.rejects(
            () => messages.triggerMessageActionById(TARGET_ID, 'delete'),
            /Message element not found for delete/,
        );
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
