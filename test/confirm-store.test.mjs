import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CHATUI_CONFIRM_KEY_GUARD_MS,
    cancelChatuiConfirm,
    decideConfirmKeyAction,
    getChatuiConfirmRequest,
    nextConfirmFocusIndex,
    requestChatuiConfirm,
    resetChatuiConfirmStore,
    resolveChatuiConfirm,
    shouldAcceptConfirmKey,
    subscribeChatuiConfirm,
} from '../dist/runtime/store/confirm-store.js';

// store/confirm-store.ts is pure state (no ST host dependency), so these run
// directly against the compiled module like message-edit-draft-store.test.mjs
// does — no fake host needed.

test.beforeEach(() => {
    resetChatuiConfirmStore();
});

test('a two-way request round-trips: getChatuiConfirmRequest() reflects it while pending, resolveChatuiConfirm settles its promise and clears the store', async () => {
    assert.equal(getChatuiConfirmRequest(), null);

    const pending = requestChatuiConfirm({
        title: 'Delete this?',
        variant: 'two-way',
        confirmLabel: 'Delete',
    });

    const request = getChatuiConfirmRequest();
    assert.ok(request);
    assert.equal(request.title, 'Delete this?');
    assert.equal(request.variant, 'two-way');
    assert.equal(request.confirmLabel, 'Delete');
    assert.equal(request.cancelLabel, '取消', 'cancelLabel defaults when omitted, in the UI\'s own language');
    assert.equal(request.danger, false, 'danger defaults to false when omitted');
    assert.equal(request.escalateLabel, undefined, 'a two-way request must never carry an escalate label');

    resolveChatuiConfirm(request.id, 'confirm');

    assert.equal(await pending, 'confirm');
    assert.equal(getChatuiConfirmRequest(), null, 'the store must clear once answered');
});

test('a three-way request carries its escalateLabel through, and each of the three outcomes settles the promise with exactly that value', async () => {
    for (const outcome of ['confirm', 'escalate', 'cancel']) {
        const pending = requestChatuiConfirm({
            title: 'Are you sure you want to delete this message?',
            variant: 'three-way',
            confirmLabel: 'Delete Swipe',
            escalateLabel: 'Delete Message',
            cancelLabel: 'Cancel',
            danger: true,
        });
        const request = getChatuiConfirmRequest();
        assert.equal(request.escalateLabel, 'Delete Message');
        assert.equal(request.danger, true);

        resolveChatuiConfirm(request.id, outcome);
        assert.equal(await pending, outcome, outcome);
        assert.equal(getChatuiConfirmRequest(), null, outcome);
    }
});

test('a variant: "two-way" request drops any escalateLabel the caller mistakenly passes — the dialog host must never render a third button for it', async () => {
    const pending = requestChatuiConfirm({
        title: 'x',
        variant: 'two-way',
        confirmLabel: 'OK',
        escalateLabel: 'should never appear',
    });
    const request = getChatuiConfirmRequest();
    assert.equal(request.escalateLabel, undefined);

    resolveChatuiConfirm(request.id, 'confirm');
    await pending;
});

test('cancelChatuiConfirm settles the promise with "cancel" and clears the store, same as resolveChatuiConfirm(id, "cancel")', async () => {
    const pending = requestChatuiConfirm({ title: 'x', variant: 'two-way', confirmLabel: 'OK' });
    const request = getChatuiConfirmRequest();

    cancelChatuiConfirm(request.id);

    assert.equal(await pending, 'cancel');
    assert.equal(getChatuiConfirmRequest(), null);
});

test('a second request while one is still pending pre-empts it: the first promise resolves "cancel" (never left dangling), and the store immediately reflects only the newer request', async () => {
    const firstPending = requestChatuiConfirm({ title: 'first', variant: 'two-way', confirmLabel: 'OK' });
    const firstRequest = getChatuiConfirmRequest();

    const secondPending = requestChatuiConfirm({ title: 'second', variant: 'two-way', confirmLabel: 'OK' });
    const secondRequest = getChatuiConfirmRequest();

    assert.notEqual(secondRequest.id, firstRequest.id);
    assert.equal(secondRequest.title, 'second', 'the store must reflect only the newer request');
    assert.equal(await firstPending, 'cancel', 'the pre-empted request must resolve, not hang forever');

    resolveChatuiConfirm(secondRequest.id, 'confirm');
    assert.equal(await secondPending, 'confirm');
});

test('resolving a stale id (already answered, or pre-empted by a newer request) is a silent no-op — it must never resolve a different, newer pending request out from under it', async () => {
    const firstPending = requestChatuiConfirm({ title: 'first', variant: 'two-way', confirmLabel: 'OK' });
    const firstRequest = getChatuiConfirmRequest();
    resolveChatuiConfirm(firstRequest.id, 'confirm');
    assert.equal(await firstPending, 'confirm');

    // firstRequest.id is now stale (already answered). A second request is
    // live; resolving the stale id must not touch it.
    const secondPending = requestChatuiConfirm({ title: 'second', variant: 'two-way', confirmLabel: 'OK' });
    const secondRequest = getChatuiConfirmRequest();

    resolveChatuiConfirm(firstRequest.id, 'escalate'); // stale id, must be a no-op
    assert.equal(getChatuiConfirmRequest().id, secondRequest.id, 'the live request must be untouched by a stale resolve');

    resolveChatuiConfirm(secondRequest.id, 'confirm');
    assert.equal(await secondPending, 'confirm');
});

test('resolving an id that was never requested at all is a silent no-op, not a throw', () => {
    assert.doesNotThrow(() => resolveChatuiConfirm('never-requested', 'confirm'));
    assert.doesNotThrow(() => cancelChatuiConfirm('never-requested'));
});

test('resetChatuiConfirmStore resolves any outstanding pending request with "cancel" and clears the store', async () => {
    const pending = requestChatuiConfirm({ title: 'x', variant: 'two-way', confirmLabel: 'OK' });
    assert.ok(getChatuiConfirmRequest());

    resetChatuiConfirmStore();

    assert.equal(await pending, 'cancel');
    assert.equal(getChatuiConfirmRequest(), null);
});

test('resetChatuiConfirmStore with nothing pending is a harmless no-op', () => {
    assert.doesNotThrow(() => resetChatuiConfirmStore());
    assert.equal(getChatuiConfirmRequest(), null);
});

test('subscribeChatuiConfirm notifies with the request on request and with null once answered; unsubscribing stops further notifications', async () => {
    const seen = [];
    const unsubscribe = subscribeChatuiConfirm((request) => seen.push(request));

    const pending = requestChatuiConfirm({ title: 'x', variant: 'two-way', confirmLabel: 'OK' });
    const request = getChatuiConfirmRequest();
    resolveChatuiConfirm(request.id, 'confirm');
    await pending;

    assert.equal(seen.length, 2);
    assert.equal(seen[0]?.id, request.id);
    assert.equal(seen[1], null);

    unsubscribe();
    const pending2 = requestChatuiConfirm({ title: 'y', variant: 'two-way', confirmLabel: 'OK' });
    resolveChatuiConfirm(getChatuiConfirmRequest().id, 'cancel');
    await pending2;
    assert.equal(seen.length, 2, 'no further notifications after unsubscribe');
});

test('sequential requests each get a distinct id, even across many round trips', async () => {
    const ids = new Set();
    for (let i = 0; i < 5; i += 1) {
        const pending = requestChatuiConfirm({ title: `req-${i}`, variant: 'two-way', confirmLabel: 'OK' });
        const request = getChatuiConfirmRequest();
        ids.add(request.id);
        resolveChatuiConfirm(request.id, 'confirm');
        await pending;
    }
    assert.equal(ids.size, 5, 'every request must get its own unique id');
});

// --- Enter guard -------------------------------------------------------------
// shouldAcceptConfirmKey() is the whole safety argument for focusing the
// *confirm* button instead of cancel, so it is pinned here rather than left to
// a component test: given when the dialog opened and when the key was pressed,
// is this Enter an answer or leftover typing?

const OPENED_AT = 1_700_000_000_000;

test('shouldAcceptConfirmKey refuses an activation keystroke for the whole guard window and accepts it from the boundary onward', () => {
    assert.equal(CHATUI_CONFIRM_KEY_GUARD_MS, 300, 'the design fixes the guard at 300ms');

    assert.equal(shouldAcceptConfirmKey(OPENED_AT, OPENED_AT), false, 'same instant');
    assert.equal(shouldAcceptConfirmKey(OPENED_AT, OPENED_AT + 1), false, '1ms in');
    assert.equal(
        shouldAcceptConfirmKey(OPENED_AT, OPENED_AT + CHATUI_CONFIRM_KEY_GUARD_MS - 1),
        false,
        'the last millisecond inside the window is still refused',
    );
    assert.equal(
        shouldAcceptConfirmKey(OPENED_AT, OPENED_AT + CHATUI_CONFIRM_KEY_GUARD_MS),
        true,
        'the boundary itself accepts — the window is closed-open, not open-open',
    );
    assert.equal(shouldAcceptConfirmKey(OPENED_AT, OPENED_AT + 5_000), true, 'long after');
});

test('shouldAcceptConfirmKey fails closed on a clock that ran backwards or on a timestamp that is not a finite number', () => {
    assert.equal(shouldAcceptConfirmKey(OPENED_AT, OPENED_AT - 1), false, 'now before opened');
    assert.equal(shouldAcceptConfirmKey(OPENED_AT, OPENED_AT - 60_000), false, 'now far before opened');

    // Infinity is the one that matters: it would otherwise satisfy any
    // elapsed-time comparison and authorize a deletion outright.
    assert.equal(shouldAcceptConfirmKey(OPENED_AT, Number.POSITIVE_INFINITY), false);
    assert.equal(shouldAcceptConfirmKey(Number.NEGATIVE_INFINITY, OPENED_AT), false);
    assert.equal(shouldAcceptConfirmKey(Number.NaN, OPENED_AT), false);
    assert.equal(shouldAcceptConfirmKey(OPENED_AT, Number.NaN), false);
    assert.equal(shouldAcceptConfirmKey(undefined, OPENED_AT), false);
    assert.equal(shouldAcceptConfirmKey(OPENED_AT, undefined), false);
});

test('shouldAcceptConfirmKey is pure: it reads nothing from the store, so an open dialog, a settled one and no dialog at all give the same answer', async () => {
    const before = shouldAcceptConfirmKey(OPENED_AT, OPENED_AT + 400);
    assert.equal(getChatuiConfirmRequest(), null);

    const pending = requestChatuiConfirm({ title: 'x', variant: 'two-way', confirmLabel: 'OK' });
    const during = shouldAcceptConfirmKey(OPENED_AT, OPENED_AT + 400);

    resolveChatuiConfirm(getChatuiConfirmRequest().id, 'confirm');
    await pending;
    const after = shouldAcceptConfirmKey(OPENED_AT, OPENED_AT + 400);

    assert.deepEqual([before, during, after], [true, true, true]);
    assert.equal(
        shouldAcceptConfirmKey(OPENED_AT, OPENED_AT + 100),
        false,
        'and the refusing answer is equally independent of store state',
    );
});

// --- The whole keyboard model ------------------------------------------------
// decideConfirmKeyAction() is the dialog's keyboard matrix as one pure
// function, so every cell of it — which key, from which focus, how long after
// the dialog opened, held or freshly pressed — is pinned here rather than
// living only in a component that needs a browser to observe.

const FOCUS_ZONES = ['inside', 'outside', 'none'];
const ACTIVATION_KEYS = ['Enter', ' '];
/** Comfortably past the guard window, so a cell only refuses for its own reason. */
const PAST_GUARD = OPENED_AT + 5_000;
/** Inside it, by the last millisecond that still counts as inside. */
const INSIDE_GUARD = OPENED_AT + CHATUI_CONFIRM_KEY_GUARD_MS - 1;

function decide(overrides) {
    return decideConfirmKeyAction({
        key: 'Enter',
        repeat: false,
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        focus: 'inside',
        openedAtMs: OPENED_AT,
        nowMs: PAST_GUARD,
        ...overrides,
    });
}

test('decideConfirmKeyAction cancels on Escape from every cell of the matrix — inside the guard window, from any focus, and while a held Escape auto-repeats', () => {
    for (const focus of FOCUS_ZONES) {
        for (const nowMs of [OPENED_AT, INSIDE_GUARD, PAST_GUARD]) {
            for (const repeat of [false, true]) {
                assert.equal(
                    decide({ key: 'Escape', focus, nowMs, repeat }),
                    'cancel',
                    `Escape / ${focus} / +${nowMs - OPENED_AT}ms / repeat=${repeat}`,
                );
            }
        }
    }
    // The guard exists to stop an accidental *confirmation*; delaying the way
    // out of a dialog would make it a hazard rather than a safety.
    assert.equal(decide({ key: 'Escape', nowMs: OPENED_AT }), 'cancel', 'even in the dialog\'s very first instant');
    // A modified Escape aimed at a modal still means "get me out".
    assert.equal(decide({ key: 'Escape', shiftKey: true }), 'cancel');
    assert.equal(decide({ key: 'Escape', ctrlKey: true }), 'cancel');
});

test('decideConfirmKeyAction keeps Tab and Shift+Tab on the dialog\'s own focus cycle whatever the guard window says, but leaves browser/OS-level modified Tab alone', () => {
    for (const focus of FOCUS_ZONES) {
        for (const nowMs of [OPENED_AT, INSIDE_GUARD, PAST_GUARD]) {
            // Moving focus is not an answer to anything, so the time guard has
            // no business refusing it — a dialog that cannot be tabbed for its
            // first 300ms would just be a broken dialog.
            assert.equal(decide({ key: 'Tab', focus, nowMs }), 'focus-next', `Tab / ${focus} / +${nowMs - OPENED_AT}ms`);
            assert.equal(
                decide({ key: 'Tab', shiftKey: true, focus, nowMs }),
                'focus-previous',
                `Shift+Tab / ${focus} / +${nowMs - OPENED_AT}ms`,
            );
        }
    }
    // Holding Tab to walk a dialog is ordinary keyboard use, so unlike an
    // activation key, an auto-repeated Tab still navigates.
    assert.equal(decide({ key: 'Tab', repeat: true }), 'focus-next');
    assert.equal(decide({ key: 'Tab', repeat: true, shiftKey: true }), 'focus-previous');

    // Ctrl/Alt/Meta+Tab belong to the browser or the window manager.
    assert.equal(decide({ key: 'Tab', ctrlKey: true }), 'ignore');
    assert.equal(decide({ key: 'Tab', altKey: true }), 'ignore');
    assert.equal(decide({ key: 'Tab', metaKey: true }), 'ignore');
    assert.equal(decide({ key: 'Tab', ctrlKey: true, shiftKey: true }), 'ignore');
});

test('decideConfirmKeyAction swallows an auto-repeated activation keystroke however long the dialog has been open — a held key is one physical press, not a stream of answers', () => {
    for (const key of ACTIVATION_KEYS) {
        for (const focus of FOCUS_ZONES) {
            assert.equal(
                decide({ key, focus, repeat: true, nowMs: PAST_GUARD }),
                'swallow',
                `held ${JSON.stringify(key)} / ${focus} / long past the guard window`,
            );
        }
    }

    // The contrast is the whole point: the *same* cells with repeat=false are
    // not swallowed, so it is the auto-repeat doing the refusing and not the
    // clock. Time alone cannot catch this case — hold Enter down and the 300ms
    // window expires underneath the held key, which is exactly the accident
    // the guard was written for ("a dialog appeared under hands already
    // typing"), just spelled with one long keypress instead of two short ones.
    assert.equal(decide({ key: 'Enter', focus: 'inside', repeat: false }), 'stand-down');
    assert.equal(decide({ key: 'Enter', focus: 'none', repeat: false }), 'confirm');
    assert.equal(decide({ key: ' ', focus: 'inside', repeat: false }), 'stand-down');
});

test('decideConfirmKeyAction swallows every activation keystroke inside the guard window, whoever it was aimed at', () => {
    for (const key of ACTIVATION_KEYS) {
        for (const focus of FOCUS_ZONES) {
            for (const nowMs of [OPENED_AT, OPENED_AT + 1, INSIDE_GUARD]) {
                assert.equal(
                    decide({ key, focus, nowMs }),
                    'swallow',
                    `${JSON.stringify(key)} / ${focus} / +${nowMs - OPENED_AT}ms`,
                );
            }
        }
    }
    // Swallowed, not ignored: the confirm button already has focus, so merely
    // declining to act would still leave its native activation to run.
    assert.equal(decide({ key: 'Enter', focus: 'inside', nowMs: OPENED_AT }), 'swallow');
    // A bad clock refuses too, inheriting shouldAcceptConfirmKey's fail-closed
    // reading rather than sailing past the comparison.
    assert.equal(decide({ nowMs: Number.POSITIVE_INFINITY }), 'swallow');
    assert.equal(decide({ nowMs: Number.NaN }), 'swallow');
    assert.equal(decide({ nowMs: OPENED_AT - 60_000 }), 'swallow');
});

test('decideConfirmKeyAction past the guard stands down for a control inside the dialog and swallows one aimed outside it, so one keystroke is never two answers', () => {
    for (const key of ACTIVATION_KEYS) {
        // The focused button activates itself natively; answering here as well
        // would fire the same answer twice.
        assert.equal(decide({ key, focus: 'inside' }), 'stand-down', `${JSON.stringify(key)} inside`);
        // Focus has left the modal (a body child that appeared after mount is
        // not covered by the background isolation). A keystroke aimed at a
        // control hidden under the veil answers nothing — and must not travel
        // on to that control either.
        assert.equal(decide({ key, focus: 'outside' }), 'swallow', `${JSON.stringify(key)} outside`);
    }
    // Modifiers do not turn an escaped keystroke back into somebody else's.
    assert.equal(decide({ focus: 'outside', ctrlKey: true }), 'swallow');
    assert.equal(decide({ focus: 'inside', shiftKey: true }), 'stand-down');
});

test('decideConfirmKeyAction answers confirm only for a bare Enter aimed at nothing: Space at nothing in particular, or a modified Enter, is not an answer', () => {
    assert.equal(decide({ key: 'Enter', focus: 'none' }), 'confirm');

    assert.equal(decide({ key: ' ', focus: 'none' }), 'ignore', 'Space at nothing is not an answer to anything');
    for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey']) {
        assert.equal(
            decide({ key: 'Enter', focus: 'none', [modifier]: true }),
            'ignore',
            `${modifier}+Enter is not "the answer" anywhere else in this app`,
        );
    }
});

test('decideConfirmKeyAction ignores every key that is no part of the dialog\'s model, in and out of the guard window', () => {
    for (const key of ['a', '1', 'ArrowDown', 'Home', 'F5', 'Shift', 'Backspace', 'Delete', 'Enterprise']) {
        for (const focus of FOCUS_ZONES) {
            for (const nowMs of [OPENED_AT, PAST_GUARD]) {
                assert.equal(
                    decide({ key, focus, nowMs }),
                    'ignore',
                    `${JSON.stringify(key)} / ${focus} / +${nowMs - OPENED_AT}ms`,
                );
            }
        }
    }
});

// --- Focus trap arithmetic ---------------------------------------------------

test('nextConfirmFocusIndex walks the dialog\'s controls forwards and backwards and wraps at both ends, so Tab can never walk out of the dialog', () => {
    // Three controls is the three-way delete dialog (escalate / cancel /
    // confirm) in source order; two is every other caller.
    assert.equal(nextConfirmFocusIndex(3, 0, false), 1);
    assert.equal(nextConfirmFocusIndex(3, 1, false), 2);
    assert.equal(nextConfirmFocusIndex(3, 2, false), 0, 'forwards off the last control wraps to the first');
    assert.equal(nextConfirmFocusIndex(3, 2, true), 1);
    assert.equal(nextConfirmFocusIndex(3, 1, true), 0);
    assert.equal(nextConfirmFocusIndex(3, 0, true), 2, 'backwards off the first control wraps to the last');

    assert.equal(nextConfirmFocusIndex(2, 1, false), 0);
    assert.equal(nextConfirmFocusIndex(2, 0, true), 1);

    // A single control cycles to itself rather than escaping.
    assert.equal(nextConfirmFocusIndex(1, 0, false), 0);
    assert.equal(nextConfirmFocusIndex(1, 0, true), 0);
});

test('nextConfirmFocusIndex pulls focus back in from outside the cycle at the end the browser itself would have entered from, and answers null when there is nothing to focus', () => {
    // -1 is what indexOf reports when focus is on the card, on <body>, or on
    // something that has already escaped the modal: Tab re-enters at the top,
    // Shift+Tab at the bottom.
    assert.equal(nextConfirmFocusIndex(3, -1, false), 0);
    assert.equal(nextConfirmFocusIndex(3, -1, true), 2);
    // Any other out-of-range index is the same situation (a stale index taken
    // before the dialog re-rendered, say) and must not throw or land nowhere.
    assert.equal(nextConfirmFocusIndex(3, 3, false), 0);
    assert.equal(nextConfirmFocusIndex(3, 99, true), 2);
    assert.equal(nextConfirmFocusIndex(3, -7, false), 0);
    assert.equal(nextConfirmFocusIndex(3, 1.5, false), 0);
    assert.equal(nextConfirmFocusIndex(3, Number.NaN, true), 2);

    // Nothing focusable in the dialog: the caller still swallows the keystroke,
    // so focus stays put instead of leaving the modal.
    assert.equal(nextConfirmFocusIndex(0, -1, false), null);
    assert.equal(nextConfirmFocusIndex(0, 0, true), null);
    assert.equal(nextConfirmFocusIndex(-1, 0, false), null);
    assert.equal(nextConfirmFocusIndex(2.5, 0, false), null);
    assert.equal(nextConfirmFocusIndex(Number.NaN, 0, false), null);
    assert.equal(nextConfirmFocusIndex(Number.POSITIVE_INFINITY, 0, false), null);
});
