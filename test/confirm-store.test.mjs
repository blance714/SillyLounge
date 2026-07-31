import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CHATUI_CONFIRM_KEY_GUARD_MS,
    cancelChatuiConfirm,
    getChatuiConfirmRequest,
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
    assert.equal(request.cancelLabel, 'Cancel', 'cancelLabel defaults when omitted');
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
