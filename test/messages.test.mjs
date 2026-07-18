// test/messages.test.mjs
//
// dist/runtime/adapter/messages.js delete/swipe/hide argument matrix.
// Source: src/adapter/messages.ts:187-256 (deleteMessage, swipeMessage,
// toggleHideMessage). These delegate to @st/script's exported
// deleteMessage/swipe and @st/chats's hideChatMessage/unhideChatMessage —
// wrong arguments here silently destroy the wrong swipe or the wrong
// message, so every branch of ST's native .mes_edit_delete policy
// (src/adapter/messages.ts:193-214) is pinned exactly, not just "was
// called".
//
// None of deleteMessage/swipeMessage/toggleHideMessage touch the DOM: the
// only DOM-shaped input they read is `mesEl.getAttribute('mesid')` (via
// _getMessageId in adapter/internals.js), so a plain object with a
// getAttribute method stands in for a real message element and the fake
// host's DOM gap (no compound CSS selectors) never comes into play for
// this file. triggerMessageActionById/swipeMessageById (the *ById variants)
// DO need a real `#chat .mes[mesid="X"]` lookup via getMessageElementById
// and are recorded as a gap instead of faked around.

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

test('deleteMessage: full {confirm} x {is_user} x {swipes>1} x {isLast} matrix drives exact stDeleteMessage args', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 3;
        const SELECTED_SWIPE = 2; // deliberately non-zero, to prove the real index is forwarded, not a hardcoded 0

        const booleans = [true, false];
        for (const confirm of booleans) {
            for (const isUser of booleans) {
                for (const swipesLen of [1, 2]) {
                    for (const isLast of booleans) {
                        const label = `confirm=${confirm} isUser=${isUser} swipes=${swipesLen} isLast=${isLast}`;

                        const chatLength = isLast ? TARGET_ID + 1 : TARGET_ID + 2;
                        const chat = buildChat(TARGET_ID, chatLength, {
                            swipes: Array.from({ length: swipesLen }, (_, i) => `swipe-${i}`),
                            swipe_id: SELECTED_SWIPE,
                            is_user: isUser,
                        });
                        host.context.chat = chat;
                        host.context.powerUserSettings = { confirm_message_delete: confirm };

                        let received;
                        host.registry.deleteMessage = (...args) => {
                            received = args;
                        };

                        await messages.deleteMessage(fakeMesEl(TARGET_ID));

                        const deleteOnlySwipe = confirm && !isUser && swipesLen > 1 && isLast;
                        const expected = [TARGET_ID, deleteOnlySwipe ? SELECTED_SWIPE : undefined, confirm];
                        assert.deepEqual(received, expected, label);
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
        // the whole message must be deleted instead of just the swipe.
        host.context.chat = buildChat(TARGET_ID, TARGET_ID + 1, {
            swipes: ['a', 'b', 'c'],
            swipe_id: undefined,
            is_user: false,
        });
        host.context.powerUserSettings = { confirm_message_delete: true };

        let received;
        host.registry.deleteMessage = (...args) => {
            received = args;
        };

        await messages.deleteMessage(fakeMesEl(TARGET_ID));

        assert.deepEqual(received, [TARGET_ID, undefined, true]);
    } finally {
        await host.dispose();
    }
});

test('deleteMessage: confirm_message_delete is coerced to a strict boolean, not forwarded as-is', async () => {
    const host = await createFakeStHost();
    try {
        const messages = await host.importModule('adapter/messages.js');
        const TARGET_ID = 0;
        host.context.chat = buildChat(TARGET_ID, 1, {});

        let received;
        host.registry.deleteMessage = (...args) => {
            received = args;
        };

        // Truthy non-boolean setting value.
        host.context.powerUserSettings = { confirm_message_delete: 'yes' };
        await messages.deleteMessage(fakeMesEl(TARGET_ID));
        assert.equal(received[2], true, 'truthy confirm_message_delete must coerce to boolean true');
        assert.notEqual(received[2], 'yes', 'the raw setting value must not be forwarded uncoerced');

        // powerUserSettings missing entirely — optional chaining must not throw.
        host.context.powerUserSettings = undefined;
        await messages.deleteMessage(fakeMesEl(TARGET_ID));
        assert.equal(received[2], false, 'missing powerUserSettings must coerce confirm to false, not throw');
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
            () => messages.deleteMessage(fakeMesEl('not-a-number')),
            /Invalid message id for delete/,
        );
        await assert.rejects(
            () => messages.deleteMessage(fakeMesEl(-1)),
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
            () => messages.deleteMessage(fakeMesEl(0)),
            /Message record not found for delete: 0/,
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

        await messages.toggleHideMessage(fakeMesEl(TARGET_ID));

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

        await messages.toggleHideMessage(fakeMesEl(TARGET_ID));

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
            () => messages.toggleHideMessage(fakeMesEl(-3)),
            /Invalid message id for hide/,
        );
    } finally {
        await host.dispose();
    }
});

// saveMessageEditById (src/adapter/messages.ts:125-154) is not drivable
// end-to-end through this harness: it needs getMessageElementById() to
// resolve `#chat .mes[mesid="X"]`, a compound selector the fake DOM
// deliberately doesn't support (see test/helpers/fake-st-host.mjs's module
// doc comment) — so getMessageElementById() always returns null here, the
// same gap noted at the top of this file for the *ById variants.
//
// _dispatchClickAndWait() (src/adapter/internals.ts:99-165) — the piece that
// changed and the one that can wedge the shared host-operation queue forever
// with zero diagnostics if it fails open — is exported standalone and needs
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
