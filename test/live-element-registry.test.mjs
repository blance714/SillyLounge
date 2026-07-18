// test/live-element-registry.test.mjs
//
// dist/runtime/adapter/internals.js buildLiveElementRegistry() + the
// resolveLiveElement() fail-closed lookup it backs.
// Source: src/adapter/internals.ts (buildLiveElementRegistry,
// resolveLiveElement) and its consumers src/adapter/qr.ts (_qrItemMap /
// triggerQuickReply) and src/adapter/menu.ts (_wandItemMap /
// triggerWandItem).
//
// The bug: ids used to be purely positional (`${idPrefix}-${seq}`). ST
// rebuilds these containers (#qr--bar, #extensionsMenu) on chat/set change;
// buildLiveElementRegistry() clears the cache and hands out the exact same
// id strings again for whatever now occupies each position. An id the UI
// captured before the rebuild could therefore silently resolve to a
// *different* live element afterwards — clicking it would fire the wrong
// action. The fix stamps a per-rebuild generation into every id and makes
// resolveLiveElement() the single fail-closed gate every trigger path uses.
//
// Exercised here through adapter/qr.js: its candidate-selection fallback
// (plain `.children` filtering — see quickReplyCandidates in
// src/adapter/qr.ts) works against this harness's fake DOM, whose
// querySelector/querySelectorAll only resolve `#id` lookups (see
// test/helpers/fake-st-host.mjs's module doc comment); everything else
// (`.querySelectorAll('.qr--buttons')`) resolves to `[]`, which is exactly
// the fallback branch this file relies on. menu.ts's primary candidate path
// needs `.querySelectorAll('.extension_container')`, which the fake DOM
// can't drive — but triggerWandItem() calls the exact same
// buildLiveElementRegistry()/resolveLiveElement() pair, so this coverage
// pins the shared contract for both modules.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createFakeStHost } from './helpers/fake-st-host.mjs';

/** `<div id="qr--bar">` under `<body>`, found by qr.ts's plain #id lookup. */
function installQrBar() {
    const bar = document.createElement('div');
    bar.id = 'qr--bar';
    document.body.appendChild(bar);
    return bar;
}

/** A `.qr--button` child — recognized by quickReplyCandidates()'s fallback branch (see module doc comment). */
function addQrButton(bar, label) {
    const button = document.createElement('div');
    button.classList.add('qr--button');
    button.textContent = label;
    bar.appendChild(button);
    return button;
}

/** Counts 'click' events an element actually receives, via real EventTarget dispatch (FakeElement extends it). */
function countClicks(element) {
    const state = { count: 0 };
    element.addEventListener('click', () => { state.count += 1; });
    return state;
}

test('an id captured before a quick-reply bar rebuild can never trigger the element that now occupies its old position', async () => {
    const host = await createFakeStHost();
    try {
        const qr = await host.importModule('adapter/qr.js');

        const bar = installQrBar();
        const buttonA = addQrButton(bar, 'A');
        const clicksA = countClicks(buttonA);

        const [itemA] = qr.listQuickReplies();
        assert.equal(itemA.label, 'A');
        const staleId = itemA.id;

        // Simulate ST rebuilding the bar: the old node is gone and a
        // brand-new node (different content) now sits at the exact same
        // position (index 0).
        buttonA.remove();
        const buttonB = addQrButton(bar, 'B');
        const clicksB = countClicks(buttonB);
        const [itemB] = qr.listQuickReplies();
        assert.equal(itemB.label, 'B');

        assert.notEqual(
            staleId, itemB.id,
            'a rebuild must never reuse the previous generation\'s id string for the same position',
        );

        const triggered = qr.triggerQuickReply(staleId);
        assert.equal(triggered, false, 'a stale id must be rejected, not resolved to whatever now occupies its slot');
        assert.equal(clicksA.count, 0, 'the detached old element must not receive a click either');
        assert.equal(clicksB.count, 0, 'the new element at the same position must not receive the stale click');

        // The current id for the same slot still works correctly.
        assert.equal(qr.triggerQuickReply(itemB.id), true);
        assert.equal(clicksB.count, 1);
    } finally {
        await host.dispose();
    }
});

test('triggerQuickReply refuses to click an element that was detached from the document without a registry rebuild', async () => {
    const host = await createFakeStHost();
    try {
        const qr = await host.importModule('adapter/qr.js');

        const bar = installQrBar();
        const button = addQrButton(bar, 'Only');
        const clicks = countClicks(button);

        const [item] = qr.listQuickReplies();

        // Detached by something other than a registry rebuild (e.g. other
        // host code removing the node directly): same generation, the cache
        // still holds this exact mapping, but the element is no longer live.
        button.remove();
        assert.equal(button.isConnected, false);

        const triggered = qr.triggerQuickReply(item.id);
        assert.equal(triggered, false, 'a detached element must never be dispatched to, even within the same generation');
        assert.equal(clicks.count, 0);
    } finally {
        await host.dispose();
    }
});

test('an id that was never issued by the current registry is rejected without throwing', async () => {
    const host = await createFakeStHost();
    try {
        const qr = await host.importModule('adapter/qr.js');

        const bar = installQrBar();
        addQrButton(bar, 'Only');
        qr.listQuickReplies();

        assert.equal(qr.triggerQuickReply('not-a-real-id'), false, 'a malformed id must be rejected, not throw');
        assert.equal(
            qr.triggerQuickReply('qr-999-0'), false,
            'a well-formed id from a generation that never happened must still be rejected',
        );
    } finally {
        await host.dispose();
    }
});
