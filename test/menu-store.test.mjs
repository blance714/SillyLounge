// test/menu-store.test.mjs
//
// dist/runtime/store/menu-store.js — pure state, no ST host and no DOM, so this
// runs directly against the compiled module the way confirm-store.test.mjs does.
// Source: src/store/menu-store.ts.
//
// What is under test is DESIGN §6's 「打开任一菜单关闭其余」 and the two cleanup
// paths the lift of the message ⋯ menu created a need for. The mutual-exclusion
// assertions are written as an exhaustive sweep over CHATUI_MENU_IDS rather
// than a handful of pairs on purpose: the property being pinned is that the
// state *has* one slot, which a spot check of two menus would not distinguish
// from four flags that happen to agree today.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CHATUI_MENU_IDS,
    closeChatuiMenu,
    closeChatuiMenuById,
    closeChatuiMessageMenuFor,
    getActiveChatuiMenu,
    openChatuiMenu,
    openChatuiMessageMenu,
    resetChatuiMenuStore,
    subscribeChatuiMenu,
    toggleChatuiMenu,
    toggleChatuiMessageMenu,
} from '../dist/runtime/store/menu-store.js';

/** A stand-in anchor: an ordinary turn's ⋯ pressed halfway down a 800px viewport. */
function anchor(overrides = {}) {
    return {
        messageId: 12,
        chatKey: 'char:alice.png/chat-a',
        isSystem: false,
        trigger: { top: 400, bottom: 424, right: 900 },
        ...overrides,
    };
}

/** Open `id` through whichever entry point that id has. */
function open(id) {
    if (id === 'message') openChatuiMessageMenu(anchor());
    else openChatuiMenu(id);
}

test.beforeEach(() => {
    resetChatuiMenuStore();
});

test('the menu ids are a closed set, and every one of them is reachable', () => {
    assert.deepEqual(
        [...CHATUI_MENU_IDS],
        ['topbar', 'selector:preset', 'selector:model', 'selector:persona', 'plus', 'message'],
        'the topbar ⋯, the three selector chips, the ＋ menu and the message ⋯ — DESIGN §6\'s four kinds',
    );
    for (const id of CHATUI_MENU_IDS) {
        resetChatuiMenuStore();
        open(id);
        assert.equal(getActiveChatuiMenu()?.id, id, `${id} must be openable`);
    }
});

test('opening any menu closes whichever menu was open — mutual exclusion is the shape of the state, not a rule applied to it', () => {
    for (const first of CHATUI_MENU_IDS) {
        for (const second of CHATUI_MENU_IDS) {
            if (first === second) continue;
            resetChatuiMenuStore();
            open(first);
            open(second);
            const active = getActiveChatuiMenu();
            assert.equal(active?.id, second, `opening ${second} must leave ${second} open`);
            assert.notEqual(active?.id, first, `opening ${second} must have closed ${first}`);
        }
    }
});

test('a trigger toggles its own menu and switches to any other, never landing in a state where two are open', () => {
    toggleChatuiMenu('topbar');
    assert.equal(getActiveChatuiMenu()?.id, 'topbar');

    toggleChatuiMenu('topbar');
    assert.equal(getActiveChatuiMenu(), null, 'pressing the same trigger again closes it');

    toggleChatuiMenu('plus');
    toggleChatuiMenu('selector:persona');
    assert.equal(getActiveChatuiMenu()?.id, 'selector:persona', 'a different trigger switches rather than stacking');

    toggleChatuiMessageMenu(anchor());
    assert.equal(getActiveChatuiMenu()?.id, 'message');
    toggleChatuiMessageMenu(anchor());
    assert.equal(getActiveChatuiMenu(), null, 'the message ⋯ toggles on its own row identity too');

    toggleChatuiMessageMenu(anchor({ messageId: 12 }));
    toggleChatuiMessageMenu(anchor({ messageId: 13 }));
    assert.equal(
        getActiveChatuiMenu()?.anchor.messageId,
        13,
        'a different row is a different menu: it switches, it does not close',
    );
});

test('the message menu carries everything its root-level host needs: which row, which chat, and the rect the trigger was measured at', () => {
    const trigger = { top: 640, bottom: 664, right: 1180 };
    openChatuiMessageMenu(anchor({ messageId: 7, chatKey: 'group:g1/chat-b', isSystem: true, trigger }));

    const active = getActiveChatuiMenu();
    assert.equal(active?.id, 'message');
    assert.equal(active.anchor.messageId, 7);
    assert.equal(active.anchor.chatKey, 'group:g1/chat-b');
    assert.equal(active.anchor.isSystem, true, 'the host builds a shorter row list from this');
    assert.deepEqual(
        active.anchor.trigger,
        trigger,
        'the measured rect travels verbatim — the placement is derived from it by the host, not stored',
    );
});

test('an unmounting component closes only its own menu: closeChatuiMenuById never touches the menu that replaced it', () => {
    openChatuiMenu('plus');
    closeChatuiMenuById('topbar');
    assert.equal(getActiveChatuiMenu()?.id, 'plus', 'the topbar leaving must not close the ＋ sheet');

    closeChatuiMenuById('plus');
    assert.equal(getActiveChatuiMenu(), null, 'its own id does close it');

    closeChatuiMenuById('selector:model');
    assert.equal(getActiveChatuiMenu(), null, 'closing an id with nothing open is a no-op, not an error');
});

test('a virtualised row taking its menu with it matches on the chat as well as the message id', () => {
    openChatuiMessageMenu(anchor({ messageId: 12, chatKey: 'char:alice.png/chat-a' }));

    closeChatuiMessageMenuFor(11, 'char:alice.png/chat-a');
    assert.equal(getActiveChatuiMenu()?.id, 'message', 'a neighbouring row unmounting must not close this menu');

    // Message ids are per-chat indices, so id alone would let row 12 of the chat
    // the reader just left close a menu opened on row 12 of the chat they
    // arrived at — the two are different rows with the same number.
    closeChatuiMessageMenuFor(12, 'char:alice.png/chat-b');
    assert.equal(getActiveChatuiMenu()?.id, 'message', 'the same index in another chat is a different row');

    closeChatuiMessageMenuFor(12, 'char:alice.png/chat-a');
    assert.equal(getActiveChatuiMenu(), null, 'its own identity does close it');

    openChatuiMenu('topbar');
    closeChatuiMessageMenuFor(12, 'char:alice.png/chat-a');
    assert.equal(
        getActiveChatuiMenu()?.id,
        'topbar',
        'a stale row cleanup must never close a menu of another kind',
    );
});

test('only real transitions notify: re-opening the menu that is already open, and closing when nothing is, are silent', () => {
    const seen = [];
    const unsubscribe = subscribeChatuiMenu(menu => seen.push(menu === null ? null : menu.id));

    closeChatuiMenu();
    assert.deepEqual(seen, [], 'closing an empty slot notifies nobody');

    openChatuiMenu('topbar');
    openChatuiMenu('topbar');
    assert.deepEqual(seen, ['topbar'], 'opening the already-open menu is a no-op, not a re-render');

    closeChatuiMenuById('plus');
    assert.deepEqual(seen, ['topbar'], 'a scoped close that does not match notifies nobody');

    closeChatuiMenu();
    assert.deepEqual(seen, ['topbar', null]);

    unsubscribe();
    openChatuiMenu('plus');
    assert.deepEqual(seen, ['topbar', null], 'unsubscribe actually detaches');
});

test('re-pressing the message ⋯ on the same row with a fresh rect is an update, not a no-op — the row may have moved under the reader', () => {
    const seen = [];
    const unsubscribe = subscribeChatuiMenu(menu => seen.push(menu?.id ?? null));

    openChatuiMessageMenu(anchor({ trigger: { top: 400, bottom: 424, right: 900 } }));
    openChatuiMessageMenu(anchor({ trigger: { top: 120, bottom: 144, right: 900 } }));

    assert.deepEqual(seen, ['message', 'message']);
    assert.equal(getActiveChatuiMenu()?.anchor.trigger.top, 120, 'the newer measurement wins');
    unsubscribe();
});

test('resetChatuiMenuStore empties the slot so teardown cannot leave a menu open across a remount', () => {
    openChatuiMessageMenu(anchor());
    resetChatuiMenuStore();
    assert.equal(getActiveChatuiMenu(), null);
});
